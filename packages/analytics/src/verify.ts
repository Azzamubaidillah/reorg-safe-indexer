import { DuckDBInstance } from "@duckdb/node-api";
import type { Database } from "@rsi/db";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { exportSnapshot, SNAPSHOT } from "./export.ts";
import { dayBounds, isCovered, KINDS, partitionPath, readManifest, sha256FileIfExists, type DayEntry, type Kind, type Manifest } from "./layout.ts";
import { DEFAULT_METADATA, sqrtPriceToPrice, type AnalyticsMetadata } from "./metadata.ts";
import { countPublished, publishedInDay, type DayWindow, type Tx } from "./published.ts";
import { AnalyticsReader } from "./reader.ts";

export interface VerifyOptions {
  chainId: number;
  dir: string;
  /** How many days get the full aggregate comparison, spread evenly over the exported span (first and last included). */
  sampleDays: number;
  metadata?: AnalyticsMetadata;
}

export interface AnalyticsCheck {
  name: string;
  passed: boolean;
  /** Summary when passed; the first few offenders when not. */
  detail: string;
}

export interface AnalyticsVerifyReport {
  ok: boolean;
  sampledDays: string[];
  checks: AnalyticsCheck[];
}

/** Doubles from two engines agree to far better than this; looser would hide a wrong decimals or direction. */
const PRICE_TOLERANCE = 1e-12;
const MAX_LISTED = 5;

function result(name: string, problems: string[], summary: string): AnalyticsCheck {
  const extra = problems.length > MAX_LISTED ? ` (+${problems.length - MAX_LISTED} more)` : "";
  return { name, passed: problems.length === 0, detail: problems.length === 0 ? summary : `${problems.slice(0, MAX_LISTED).join("; ")}${extra}` };
}

/**
 * Proves the Parquet store still says what Postgres says, in one repeatable-read snapshot:
 *  - `manifest`/`coverage`: the store exists and includes every published range;
 *  - `files`: each partition's bytes still hash to the manifest and hold the recorded rows, with nothing stray;
 *  - `row-counts`: published rows in Postgres equal rows in Parquet (independent of any day window);
 *  - `aggregates:<day>`: for sampled days, DuckDB answers (through `AnalyticsReader`) equal SQL run on the chain tables;
 *  - `rebuild`: re-exporting from Postgres into a scratch directory reproduces every partition's content hash.
 * The scratch copy is deleted afterwards. Run it while the indexer is idle or accept that ranges published
 * mid-run show up as failures of the next export, not as corruption.
 */
export async function verifyAnalytics(database: Database, options: VerifyOptions): Promise<AnalyticsVerifyReport> {
  return database.sql.begin(SNAPSHOT, async (tx) => {
    const checks: AnalyticsCheck[] = [];
    const manifest = await readManifest(options.dir);
    const published = await tx<{ from: string; to: string }[]>`
      select from_block::text as "from", to_block::text as "to" from ops.ranges where chain_id = ${options.chainId} and status = 'published'`;

    if (!manifest || manifest.chainId !== options.chainId) {
      const problem = manifest ? `store holds chain ${manifest.chainId}` : published.length > 0 ? `${published.length} published ranges but no manifest` : "";
      // An empty store is correct only while nothing is published.
      checks.push(result("manifest", problem ? [problem] : [], "no manifest, nothing published"));
      return { ok: checks.every((c) => c.passed), sampledDays: [], checks };
    }
    checks.push(result("manifest", [], `chain ${manifest.chainId}, ${Object.keys(manifest.days).length} days, through block ${manifest.exportedThroughBlock}`));

    const missing = published.filter((r) => !isCovered(manifest.exported, Number(r.from), Number(r.to)));
    checks.push(result("coverage", missing.length > 0 ? [`${missing.length} published ranges not exported, first from block ${missing[0]?.from}`] : [], `${published.length} published ranges exported`));

    const liveHashes = await hashLive(options.dir, manifest);
    checks.push(await checkFiles(options.dir, manifest, liveHashes));
    checks.push(await checkRowCounts(tx, options.chainId, manifest));

    const sampledDays = sampleEvenly(Object.keys(manifest.days).sort(), options.sampleDays);
    const reader = new AnalyticsReader({ dir: options.dir, metadata: options.metadata ?? DEFAULT_METADATA });
    try {
      for (const day of sampledDays) {
        // A damaged file makes DuckDB throw; that is a finding, not a reason to stop checking.
        checks.push(await checkDay(tx, reader, options, day, manifest.days[day] as DayEntry).catch((error: unknown) => result(`aggregates:${day}`, [String(error)], "")));
      }
    } finally {
      await reader.close();
    }

    checks.push(await checkRebuild(tx, options, liveHashes));
    return { ok: checks.every((c) => c.passed), sampledDays, checks };
  });
}

const key = (kind: Kind, day: string) => `${kind}/${day}`;

/** What is actually on disk, keyed `kind/day`: null for a manifest entry whose file is gone. */
async function hashLive(dir: string, manifest: Manifest): Promise<Map<string, string | null>> {
  const hashes = new Map<string, string | null>();
  for (const [day, entry] of Object.entries(manifest.days)) {
    for (const kind of KINDS) if (entry[kind]) hashes.set(key(kind, day), await sha256FileIfExists(partitionPath(dir, kind, day)));
  }
  return hashes;
}

async function checkFiles(dir: string, manifest: Manifest, liveHashes: Map<string, string | null>): Promise<AnalyticsCheck> {
  const problems: string[] = [];
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    for (const [day, entry] of Object.entries(manifest.days)) {
      for (const kind of KINDS) {
        const expected = entry[kind];
        if (!expected) continue;
        const actual = liveHashes.get(key(kind, day));
        if (actual === null) problems.push(`${key(kind, day)} missing`);
        else if (actual !== expected.sha256) problems.push(`${key(kind, day)} bytes differ from manifest`);
        else {
          // Hash matches, so this guards the manifest itself being wrong about what the file holds.
          const [row] = (await connection.runAndReadAll("select count(*)::varchar as n from read_parquet(?)", [partitionPath(dir, kind, day)])).getRowObjectsJson();
          if (Number(row?.n) !== expected.rows) problems.push(`${key(kind, day)} holds ${String(row?.n)} rows, manifest says ${expected.rows}`);
        }
      }
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  for (const kind of KINDS) {
    const onDisk = await readdir(join(dir, kind)).catch(() => [] as string[]);
    for (const name of onDisk) if (name.startsWith("day=") && !manifest.days[name.slice(4)]?.[kind]) problems.push(`${kind}/${name} is not in the manifest`);
  }
  return result("files", problems, `${liveHashes.size} partitions match the manifest`);
}

async function checkRowCounts(sql: Tx, chainId: number, manifest: Manifest): Promise<AnalyticsCheck> {
  const problems: string[] = [];
  const parts: string[] = [];
  for (const kind of KINDS) {
    const postgres = await countPublished(sql, chainId, kind);
    const parquet = Object.values(manifest.days).reduce((sum, entry) => sum + (entry[kind]?.rows ?? 0), 0);
    parts.push(`${kind} ${parquet}`);
    if (postgres !== parquet) problems.push(`${kind}: postgres ${postgres}, parquet ${parquet}`);
  }
  return result("row-counts", problems, parts.join(", "));
}

async function checkDay(sql: Tx, reader: AnalyticsReader, options: VerifyOptions, day: string, entry: DayEntry): Promise<AnalyticsCheck> {
  const { chainId } = options;
  const window: DayWindow = { minBlock: entry.minBlock, maxBlock: entry.maxBlock, ...dayBounds(day) };
  const problems: string[] = [];
  const transfers = publishedInDay(sql, chainId, "transfers", window);
  const swaps = publishedInDay(sql, chainId, "swaps", window);

  const tokenRows = await sql<{ token: string; n: string; volume: string }[]>`
    select t.token, count(*)::text as n, sum(t.value)::text as volume ${transfers} group by t.token`;
  const activeRows = await sql<{ token: string; n: string }[]>`
    select token, count(distinct address)::text as n
    from (select t.token, t.from_address as address ${transfers} union all select t.token, t.to_address as address ${transfers}) x group by token`;
  const active = new Map(activeRows.map((r) => [r.token, Number(r.n)]));
  const transferTotal = tokenRows.reduce((sum, r) => sum + Number(r.n), 0);
  if (transferTotal !== (entry.transfers?.rows ?? 0)) problems.push(`transfers: postgres ${transferTotal} rows, parquet ${entry.transfers?.rows ?? 0}`);
  for (const row of tokenRows) {
    const [duck] = await reader.dailyVolume({ token: row.token, from: day, to: day });
    const expected = { transfers: Number(row.n), volume: row.volume, activeAddresses: active.get(row.token) };
    if (!duck || duck.transfers !== expected.transfers || duck.volume !== expected.volume || duck.activeAddresses !== expected.activeAddresses) {
      problems.push(`token ${row.token}: postgres ${JSON.stringify(expected)}, duckdb ${JSON.stringify(duck)}`);
    }
  }

  const poolRows = await sql<{ pool: string; n: string; v0: string; v1: string; hi: string; lo: string; open: string; close: string }[]>`
    select t.pool, count(*)::text as n, sum(abs(t.amount0))::text as v0, sum(abs(t.amount1))::text as v1,
           max(t.sqrt_price_x96)::text as hi, min(t.sqrt_price_x96)::text as lo,
           (array_agg(t.sqrt_price_x96 order by t.block_number, t.log_index))[1]::text as open,
           (array_agg(t.sqrt_price_x96 order by t.block_number desc, t.log_index desc))[1]::text as close
    ${swaps} group by t.pool`;
  const swapTotal = poolRows.reduce((sum, r) => sum + Number(r.n), 0);
  if (swapTotal !== (entry.swaps?.rows ?? 0)) problems.push(`swaps: postgres ${swapTotal} rows, parquet ${entry.swaps?.rows ?? 0}`);
  const metadata = options.metadata ?? DEFAULT_METADATA;
  for (const row of poolRows) {
    const pool = metadata.pools[row.pool];
    if (!pool) {
      problems.push(`pool ${row.pool}: no decimals metadata, cannot check prices`);
      continue;
    }
    const [duck] = await reader.poolOhlc({ pool: row.pool, interval: "1d", from: day, to: day, direction: "token1PerToken0" });
    // Direction is fixed so the comparison does not depend on the pool's display preference. sqrtPrice is monotonic in price,
    // so Postgres picks high/low exactly on the integers and only the final conversion to double is approximate.
    const price = (sqrt: string) => sqrtPriceToPrice(BigInt(sqrt), pool, "token1PerToken0");
    const close = (a: number, b: number | undefined) => b !== undefined && Math.abs(a - b) <= PRICE_TOLERANCE * Math.abs(a);
    const exact = duck?.swaps === Number(row.n) && duck.volumeToken0 === row.v0 && duck.volumeToken1 === row.v1;
    const prices = close(price(row.open), duck?.open) && close(price(row.hi), duck?.high) && close(price(row.lo), duck?.low) && close(price(row.close), duck?.close);
    if (!exact || !prices) problems.push(`pool ${row.pool}: postgres swaps ${row.n} v0 ${row.v0} v1 ${row.v1} open ${row.open} high ${row.hi} low ${row.lo} close ${row.close}, duckdb ${JSON.stringify(duck)}`);
  }
  return result(`aggregates:${day}`, problems, `${tokenRows.length} tokens, ${poolRows.length} pools match`);
}

async function checkRebuild(sql: Tx, options: VerifyOptions, liveHashes: Map<string, string | null>): Promise<AnalyticsCheck> {
  // Next to the live store, not in /tmp: it is as large as the store and must be on a volume that can hold it.
  const scratch = await mkdtemp(join(dirname(resolve(options.dir)), ".analytics-verify-"));
  try {
    await exportSnapshot(sql, { chainId: options.chainId, dir: scratch });
    const rebuilt = await readManifest(scratch);
    const problems: string[] = [];
    const fresh = new Map<string, string>();
    for (const [day, entry] of Object.entries(rebuilt?.days ?? {})) for (const kind of KINDS) if (entry[kind]) fresh.set(key(kind, day), entry[kind].sha256);
    for (const [name, hash] of fresh) {
      if (!liveHashes.has(name)) problems.push(`${name} missing from live store`);
      else if (liveHashes.get(name) !== hash) problems.push(`${name} differs from a rebuild`);
    }
    for (const name of liveHashes.keys()) if (!fresh.has(name)) problems.push(`${name} is not in a rebuild`);
    return result("rebuild", problems, `${fresh.size} partitions identical to a rebuild from Postgres`);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/** `count` items spread over `days` (sorted), always including the first and last. */
function sampleEvenly(days: string[], count: number): string[] {
  if (count >= days.length) return days;
  if (count <= 1) return days.slice(0, count);
  const picked = new Set<string>();
  for (let i = 0; i < count; i++) picked.add(days[Math.round((i * (days.length - 1)) / (count - 1))] as string);
  return [...picked];
}
