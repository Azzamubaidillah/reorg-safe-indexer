import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import type { Database } from "@rsi/db";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { chunkSelect } from "./amounts.ts";
import {
  dayBounds,
  fsyncFile,
  isCovered,
  KINDS,
  MANIFEST_VERSION,
  mergeIntervals,
  partitionPath,
  readManifest,
  sha256File,
  sha256FileIfExists,
  writeManifest,
  type DayEntry,
  type Kind,
  type Manifest,
  type PartitionEntry,
} from "./layout.ts";
import { publishedInDay, type DayWindow, type Tx } from "./published.ts";

export interface ExportOptions {
  chainId: number;
  /** Root of the Parquet store; created if missing. */
  dir: string;
}

/** What `exportSnapshot` accepts on top of `ExportOptions`; `exportPublished` never sets this. */
export interface SnapshotOptions extends ExportOptions {
  /**
   * Write days that contain ranges whose decoded rows retention deleted, from the rows that are left. Only the
   * verifier's scratch export sets it, because it throws that output away after comparing the retained days.
   */
  rebuildPurgedDays?: boolean;
}

export interface PartitionResult {
  kind: Kind;
  day: string;
  rows: number;
  /** False when the rebuilt file was byte-identical to the one already on disk, so nothing was replaced. */
  changed: boolean;
}

export interface ExportSummary {
  /** Published ranges that were not in the store before this run. */
  newRanges: number;
  /** Every partition rebuilt this run (a day is rebuilt whole, from Postgres). Empty when there was nothing new. */
  partitions: PartitionResult[];
  exportedThroughBlock: number | null;
  rowCounts: Record<Kind, number>;
}

/** Rows per Postgres round trip while streaming into DuckDB. */
const CURSOR_ROWS = 10_000;
/** Soft cap for DuckDB: a day is staged and sorted in memory, anything beyond this spills to disk. */
const DUCKDB_MEMORY_LIMIT = "1GB";
/** Repeatable read: the pending-range list and every day read from one snapshot, so a range published mid-export is seen whole or not at all. */
export const SNAPSHOT = "isolation level repeatable read read only";

interface KindSpec {
  /** Staging columns, in the order Postgres returns them. Everything is VARCHAR: casts happen once, in DuckDB, in `final`. */
  stage: string[];
  /**
   * Parquet row shape. Sorted by (block_number, log_index), which is unique among canonical rows,
   * so the same rows always produce the same bytes (`order by 1, 2`: ordinals, because the output
   * columns shadow the staging names). Amount columns: see amounts.ts.
   */
  final: string;
}

const BASE_STAGE = ["block_number", "log_index", "block_time", "tx_hash"];
const BASE_FINAL = "cast(block_number as bigint) as block_number, cast(log_index as integer) as log_index, epoch_ms(cast(block_time as bigint) * 1000) as block_time, tx_hash";

const SPECS: Record<Kind, KindSpec> = {
  transfers: {
    stage: [...BASE_STAGE, "token", "from_address", "to_address", "value"],
    final: `${BASE_FINAL}, token, from_address, to_address, value, ${chunkSelect("value", "value")} from stage order by 1, 2`,
  },
  swaps: {
    stage: [...BASE_STAGE, "pool", "sender", "recipient", "amount0", "amount1", "sqrt_price_x96", "liquidity", "tick"],
    // sqrt_price is sqrtPriceX96 / 2^96 as a double (division by a power of two is exact), so price queries never parse 49-digit strings.
    final: `${BASE_FINAL}, pool, sender, recipient, amount0, amount1, sqrt_price_x96, liquidity, cast(tick as integer) as tick,
      cast(sqrt_price_x96 as double) / pow(2.0::double, 96) as sqrt_price, ${chunkSelect("amount0", "abs0")}, ${chunkSelect("amount1", "abs1")}
      from stage order by 1, 2`,
  },
};

type RowSource = (sql: Tx, chainId: number, window: DayWindow) => AsyncIterable<string[][]>;

const ROW_SOURCES: Record<Kind, RowSource> = {
  transfers: (sql, chainId, window) =>
    sql`select t.block_number::text, t.log_index::text, extract(epoch from b.timestamp)::bigint::text, t.tx_hash,
          t.token, t.from_address, t.to_address, t.value::text
        ${publishedInDay(sql, chainId, "transfers", window)}`
      .values()
      .cursor(CURSOR_ROWS),
  swaps: (sql, chainId, window) =>
    sql`select t.block_number::text, t.log_index::text, extract(epoch from b.timestamp)::bigint::text, t.tx_hash,
          t.pool, t.sender, t.recipient, t.amount0::text, t.amount1::text, t.sqrt_price_x96::text, t.liquidity::text, t.tick::text
        ${publishedInDay(sql, chainId, "swaps", window)}`
      .values()
      .cursor(CURSOR_ROWS),
};

const quote = (path: string) => `'${path.replaceAll("'", "''")}'`;

/**
 * Exports every published range that is not yet in `dir`. Postgres stays the source of truth: the Parquet
 * store is a derived, rebuildable copy, so a day is never patched, it is rewritten whole from Postgres and
 * replaced atomically. Re-running with nothing new reads one small table and writes nothing.
 */
export function exportPublished(database: Database, options: ExportOptions): Promise<ExportSummary> {
  return database.sql.begin(SNAPSHOT, (tx) => exportSnapshot(tx, options));
}

/** `exportPublished` against a caller-owned snapshot transaction, so the verifier can export and compare in one consistent view. */
export async function exportSnapshot(sql: Tx, { chainId, dir, rebuildPurgedDays = false }: SnapshotOptions): Promise<ExportSummary> {
  await mkdir(dir, { recursive: true });
  const previous = await readManifest(dir);
  if (previous && previous.chainId !== chainId) throw new Error(`${dir} holds chain ${previous.chainId}, not ${chainId}`);
  const manifest: Manifest = previous ?? {
    version: MANIFEST_VERSION,
    chainId,
    exportedAt: new Date(0).toISOString(),
    exportedThroughBlock: 0,
    exported: [],
    days: {},
  };

  const published = await sql<{ from: string; to: string }[]>`
    select from_block::text as "from", to_block::text as "to" from ops.ranges
    where chain_id = ${chainId} and status = 'published' order by from_block`;
  const pending = published.map((r): [number, number] => [Number(r.from), Number(r.to)]).filter(([from, to]) => !isCovered(manifest.exported, from, to));

  const partitions: PartitionResult[] = [];
  if (pending.length > 0) {
    // Days touched by the new ranges, with the block span each contributes. Merged into the stored span so a
    // partly published day keeps covering its earlier ranges when it is rebuilt.
    const touched = await sql<{ day: string; min: string; max: string }[]>`
      select to_char(b.timestamp at time zone 'UTC', 'YYYY-MM-DD') as day, min(b.number)::text as min, max(b.number)::text as max
      from unnest(${sql.array(pending.map(([from]) => from))}::bigint[], ${sql.array(pending.map(([, to]) => to))}::bigint[]) as p(lo, hi)
      join chain.blocks b on b.chain_id = ${chainId} and b.number between p.lo and p.hi
      group by 1 order by 1`;
    for (const t of touched) {
      const old = manifest.days[t.day];
      manifest.days[t.day] = { ...old, minBlock: Math.min(old?.minBlock ?? Infinity, Number(t.min)), maxBlock: Math.max(old?.maxBlock ?? 0, Number(t.max)) };
    }

    if (!rebuildPurgedDays) await assertNoPurgedDays(sql, chainId, manifest, touched);

    const scratch = await mkdtemp(join(dir, ".duckdb-"));
    const instance = await DuckDBInstance.create(":memory:", { memory_limit: DUCKDB_MEMORY_LIMIT, temp_directory: scratch });
    const connection = await instance.connect();
    try {
      for (const { day } of touched) {
        const entry = manifest.days[day] as DayEntry;
        const window: DayWindow = { minBlock: entry.minBlock, maxBlock: entry.maxBlock, ...dayBounds(day) };
        for (const kind of KINDS) {
          const result = await buildPartition({ sql, connection, chainId, dir, kind, day, window });
          if (result.entry) entry[kind] = result.entry;
          else delete entry[kind];
          partitions.push({ kind, day, rows: result.entry?.rows ?? 0, changed: result.changed });
        }
      }
    } finally {
      connection.closeSync();
      instance.closeSync();
      await rm(scratch, { recursive: true, force: true });
    }

    manifest.exported = mergeIntervals([...manifest.exported, ...pending]);
    manifest.exportedThroughBlock = manifest.exported.at(-1)?.[1] ?? 0;
    manifest.exportedAt = new Date().toISOString();
    // Last, after every partition is in place: a crash before this line leaves files the next run rewrites identically.
    await writeManifest(dir, manifest);
  }

  const rowCounts: Record<Kind, number> = { transfers: 0, swaps: 0 };
  for (const entry of Object.values(manifest.days)) for (const kind of KINDS) rowCounts[kind] += entry[kind]?.rows ?? 0;
  return { newRanges: pending.length, partitions, exportedThroughBlock: manifest.exported.length > 0 ? manifest.exportedThroughBlock : null, rowCounts };
}

/**
 * A day is rewritten whole from Postgres, so a day that contains a range whose decoded rows were purged would lose
 * them: once purged, the Parquet file is the only copy. Refuse before anything is written (the manifest is only
 * written after every partition), and say which days, so an operator can restore the store instead of replacing it.
 */
async function assertNoPurgedDays(sql: Tx, chainId: number, manifest: Manifest, touched: { day: string }[]): Promise<void> {
  const blocked: string[] = [];
  for (const { day } of touched) {
    const { minBlock, maxBlock } = manifest.days[day] as DayEntry;
    const [purged] = await sql`
      select 1 from ops.ranges
      where chain_id = ${chainId} and decoded_purged_at is not null and to_block >= ${minBlock} and from_block <= ${maxBlock}
      limit 1`;
    if (purged) blocked.push(day);
  }
  if (blocked.length > 0) {
    throw new Error(
      `refusing to export: day(s) ${blocked.join(", ")} contain ranges whose decoded rows were purged from Postgres, so rewriting the partition would drop them; ` +
        "the existing Parquet files are the only copy (restore the manifest and files of those days)",
    );
  }
}

interface BuildInput {
  sql: Tx;
  connection: DuckDBConnection;
  chainId: number;
  dir: string;
  kind: Kind;
  day: string;
  window: DayWindow;
}

async function buildPartition({ sql, connection, chainId, dir, kind, day, window }: BuildInput): Promise<{ entry: PartitionEntry | undefined; changed: boolean }> {
  const spec = SPECS[kind];
  const final = partitionPath(dir, kind, day);
  const rows = await stage(connection, spec, ROW_SOURCES[kind](sql, chainId, window));
  if (rows === 0) {
    await rm(dirname(final), { recursive: true, force: true });
    return { entry: undefined, changed: false };
  }

  await mkdir(dirname(final), { recursive: true });
  const tmp = `${final}.tmp`;
  await connection.run(`copy (select ${spec.final}) to ${quote(tmp)} (format parquet, compression zstd)`);
  await fsyncFile(tmp);
  const sha256 = await sha256File(tmp);
  // Compare against the bytes on disk, not the manifest: a damaged file is replaced even when the data is "unchanged".
  const existing = await sha256FileIfExists(final);
  if (existing === sha256) {
    await rm(tmp);
    return { entry: { rows, sha256 }, changed: false };
  }
  await rename(tmp, final);
  return { entry: { rows, sha256 }, changed: true };
}

/** Streams Postgres rows into a fresh staging table with the Appender; memory is one cursor batch plus DuckDB's table. */
async function stage(connection: DuckDBConnection, spec: KindSpec, source: AsyncIterable<string[][]>): Promise<number> {
  await connection.run("drop table if exists stage");
  await connection.run(`create table stage (${spec.stage.map((c) => `${c} varchar`).join(", ")})`);
  const appender = await connection.createAppender("stage");
  let rows = 0;
  try {
    for await (const batch of source) {
      for (const row of batch) {
        for (const value of row) appender.appendVarchar(value);
        appender.endRow();
      }
      rows += batch.length;
    }
    appender.flushSync();
  } finally {
    appender.closeSync();
  }
  return rows;
}
