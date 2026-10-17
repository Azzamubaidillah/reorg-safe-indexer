import { readFile } from "node:fs/promises";
import type { Database, Sql } from "@rsi/db";
import { z } from "zod";
import type { RangeRef } from "./quality.ts";

/** pg_type oid of int8, for binding block lists as bigint[] (an empty list has no element to infer from). */
const INT8_OID = 20;

/** The purge policy: how long each retention class is kept, and how much work one cycle may do. */
export interface RetentionPolicy {
  /** `chain.logs` of a range are purged once its last block is older than this. */
  landingRetentionMs: number;
  /** Decoded rows are purged once older than this; undefined keeps them forever. */
  decodedRetentionMs: number | undefined;
  /** `_manifest.json` of the Parquet store; decoded rows are only purged for blocks it proves were exported. Undefined keeps them forever. */
  analyticsManifestPath: string | undefined;
  /** Most ranges purged in one cycle, counting each purge step (landing, decoded) of a range. */
  maxRanges: number;
}

export interface RetentionInput extends RetentionPolicy {
  chainId: number;
  /** Clock for the age checks; default the current time. */
  now?: Date;
}

/** What a cycle would purge right now, oldest first (see `planRetention`). */
export interface RetentionPlan {
  landing: RangeRef[];
  decoded: RangeRef[];
  /** Why decoded purging cannot proceed although it is configured (manifest missing or for another chain); null otherwise. */
  manifestProblem: string | null;
}

export interface PurgedRange extends RangeRef {
  /** Rows deleted by this step; the other step's tables are 0. */
  deleted: { logs: number; transfers: number; swaps: number };
}

export interface RetentionSummary {
  landing: PurgedRange[];
  decoded: PurgedRange[];
  manifestProblem: string | null;
}

// The part of the analytics manifest the purge relies on. It mirrors `Manifest` in packages/analytics/src/layout.ts;
// it is not imported because the indexer image carries only @rsi/db (the analytics package pulls in DuckDB).
const manifestSchema = z.object({
  version: z.literal(1),
  chainId: z.number().int(),
  /** Merged, sorted, inclusive block intervals of the published ranges already in the Parquet files. */
  exported: z.array(z.tuple([z.number().int(), z.number().int()])),
});
type ExportedManifest = z.infer<typeof manifestSchema>;

type Loaded = { manifest: ExportedManifest; problem: null } | { manifest: null; problem: string | null };

async function loadManifest(input: RetentionInput): Promise<Loaded> {
  const { analyticsManifestPath: path, decodedRetentionMs } = input;
  if (decodedRetentionMs === undefined || path === undefined) return { manifest: null, problem: null };
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { manifest: null, problem: `no analytics manifest at ${path}` };
    throw err;
  }
  const manifest = manifestSchema.parse(JSON.parse(text));
  if (manifest.chainId !== input.chainId) return { manifest: null, problem: `analytics manifest holds chain ${manifest.chainId}, not ${input.chainId}` };
  return { manifest, problem: null };
}

interface CandidateRow {
  from_block: number;
  to_block: number;
}

const toRefs = (rows: CandidateRow[]): RangeRef[] => rows.map((r) => ({ fromBlock: r.from_block, toBlock: r.to_block }));

/**
 * Published ranges whose landing logs may go: old enough, and, once the reconciler has written anything for this
 * chain, confirmed by a second source. Fail-closed: a range with only a mismatch (or no row at all) stays.
 */
async function landingCandidates(sql: Sql, input: RetentionInput, now: Date, limit: number): Promise<RangeRef[]> {
  const cutoff = new Date(now.getTime() - input.landingRetentionMs).toISOString();
  const rows = await sql<CandidateRow[]>`
    select r.from_block::float8 as from_block, r.to_block::float8 as to_block
    from ops.ranges r
    join chain.blocks b on b.chain_id = r.chain_id and b.number = r.to_block
    where r.chain_id = ${input.chainId} and r.status = 'published' and r.landing_purged_at is null
      and b.timestamp < ${cutoff}::timestamptz
      and (
        not exists (select 1 from ops.reconciliations where chain_id = ${input.chainId})
        or exists (
          select 1 from ops.reconciliations x
          where x.chain_id = r.chain_id and x.from_block = r.from_block and x.to_block = r.to_block and x.status = 'match'))
    order by r.from_block
    limit ${limit}`;
  return toRefs(rows);
}

/**
 * Published ranges whose decoded rows may go: landing already purged (or in `alsoLandingPurged`, for the dry run),
 * old enough, and exported according to the manifest. The Parquet exporter rebuilds a whole UTC day from Postgres,
 * so a day that still has an unexported range could lose rows if its exported part were purged: a range is only
 * eligible when it ends before the UTC day of the lowest unexported range.
 */
async function decodedCandidates(sql: Sql, input: RetentionInput, manifest: ExportedManifest, now: Date, limit: number, alsoLandingPurged: number[]): Promise<RangeRef[]> {
  if (limit <= 0 || input.decodedRetentionMs === undefined) return [];
  const cutoff = new Date(now.getTime() - input.decodedRetentionMs).toISOString();
  const los = sql.array(manifest.exported.map(([from]) => from), INT8_OID);
  const his = sql.array(manifest.exported.map(([, to]) => to), INT8_OID);
  const planned = sql.array(alsoLandingPurged, INT8_OID);
  const rows = await sql<CandidateRow[]>`
    with covered as (select * from unnest(${los}::bigint[], ${his}::bigint[]) as m(lo, hi)),
    first_open as (
      select min(r.from_block) as block from ops.ranges r
      where r.chain_id = ${input.chainId} and not exists (select 1 from covered m where m.lo <= r.from_block and r.to_block <= m.hi)
    ),
    barrier as (
      -- null when the unexported range has no stored block: nothing compares below null, so nothing is purged
      select case when f.block is null then 'infinity'::timestamptz
        else (select date_trunc('day', b.timestamp at time zone 'UTC') at time zone 'UTC' from chain.blocks b where b.chain_id = ${input.chainId} and b.number = f.block)
      end as before
      from first_open f
    )
    select r.from_block::float8 as from_block, r.to_block::float8 as to_block
    from ops.ranges r
    join chain.blocks b on b.chain_id = r.chain_id and b.number = r.to_block
    cross join barrier
    where r.chain_id = ${input.chainId} and r.status = 'published' and r.decoded_purged_at is null
      and (r.landing_purged_at is not null or r.from_block = any(${planned}::bigint[]))
      and b.timestamp < ${cutoff}::timestamptz and b.timestamp < barrier.before
      and exists (select 1 from covered m where m.lo <= r.from_block and r.to_block <= m.hi)
    order by r.from_block
    limit ${limit}`;
  return toRefs(rows);
}

/**
 * What `runRetentionCycle` would purge now, without writing. Ranges that this plan would purge from the landing
 * table count as purged for the decoded step, as they would be when the cycle gets there.
 */
export async function planRetention(database: Database, input: RetentionInput): Promise<RetentionPlan> {
  const now = input.now ?? new Date();
  const landing = await landingCandidates(database.sql, input, now, input.maxRanges);
  const { manifest, problem } = await loadManifest(input);
  const decoded = manifest
    ? await decodedCandidates(database.sql, input, manifest, now, input.maxRanges - landing.length, landing.map((r) => r.fromBlock))
    : [];
  return { landing, decoded, manifestProblem: problem };
}

/** Rows of one range's step, or undefined when the range moved on since it was selected (a backfill or another purge won). */
type StepResult = PurgedRange["deleted"] | undefined;

/**
 * One transaction per range, holding the range row's lock: a backfill swaps data under the same lock, so a
 * range found published here cannot change until this commits. The status is re-read because the candidate
 * list is older than the lock.
 */
async function purgeLanding(sql: Sql, chainId: number, range: RangeRef): Promise<StepResult> {
  return sql.begin(async (tx) => {
    const [locked] = await tx<{ status: string; landing_purged_at: Date | null }[]>`
      select status, landing_purged_at from ops.ranges
      where chain_id = ${chainId} and from_block = ${range.fromBlock} and to_block = ${range.toBlock} for update`;
    if (locked?.status !== "published" || locked.landing_purged_at !== null) return undefined;
    const logs = await tx`delete from chain.logs where chain_id = ${chainId} and block_number between ${range.fromBlock} and ${range.toBlock}`;
    await tx`update ops.ranges set landing_purged_at = now() where chain_id = ${chainId} and from_block = ${range.fromBlock}`;
    return { logs: logs.count, transfers: 0, swaps: 0 };
  });
}

async function purgeDecoded(sql: Sql, chainId: number, range: RangeRef): Promise<StepResult> {
  return sql.begin(async (tx) => {
    const [locked] = await tx<{ status: string; landing_purged_at: Date | null; decoded_purged_at: Date | null }[]>`
      select status, landing_purged_at, decoded_purged_at from ops.ranges
      where chain_id = ${chainId} and from_block = ${range.fromBlock} and to_block = ${range.toBlock} for update`;
    if (locked?.status !== "published" || locked.landing_purged_at === null || locked.decoded_purged_at !== null) return undefined;
    const transfers = await tx`delete from chain.erc20_transfers where chain_id = ${chainId} and block_number between ${range.fromBlock} and ${range.toBlock}`;
    const swaps = await tx`delete from chain.uniswap_v3_swaps where chain_id = ${chainId} and block_number between ${range.fromBlock} and ${range.toBlock}`;
    await tx`update ops.ranges set decoded_purged_at = now() where chain_id = ${chainId} and from_block = ${range.fromBlock}`;
    return { logs: 0, transfers: transfers.count, swaps: swaps.count };
  });
}

/**
 * Deletes data that can be fetched or rebuilt again, oldest range first, at most `maxRanges` steps per cycle.
 * Landing logs go first; decoded rows only after that, and only for blocks the analytics manifest proves are
 * in the Parquet store. Blocks and every `ops` table are never touched. The caller must not run two cycles for
 * one chain at once.
 */
export async function runRetentionCycle(database: Database, input: RetentionInput): Promise<RetentionSummary> {
  const now = input.now ?? new Date();
  const { sql } = database;
  const summary: RetentionSummary = { landing: [], decoded: [], manifestProblem: null };

  for (const range of await landingCandidates(sql, input, now, input.maxRanges)) {
    const deleted = await purgeLanding(sql, input.chainId, range);
    if (deleted) summary.landing.push({ ...range, deleted });
  }

  const { manifest, problem } = await loadManifest(input);
  summary.manifestProblem = problem;
  if (!manifest) return summary;
  for (const range of await decodedCandidates(sql, input, manifest, now, input.maxRanges - summary.landing.length, [])) {
    const deleted = await purgeDecoded(sql, input.chainId, range);
    if (deleted) summary.decoded.push({ ...range, deleted });
  }
  return summary;
}
