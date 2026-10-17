import { lagSamples, type Database } from "@rsi/db";

export const LAG_RETENTION_MS = 14 * 24 * 3600 * 1000;

export interface LagSampleInput {
  chainId: number;
  headBlock: number;
  finalizedBlock: number;
  /** Highest stored block; null while nothing is stored yet. */
  storedTip: number | null;
  /** Defaults to the database clock; set by tests to seed history. */
  sampledAt?: Date;
}

export interface LagStats {
  p50: number | null;
  p95: number | null;
  p99: number | null;
  max: number | null;
}

/**
 * Head lag is `head_block - stored_tip`; finalized lag is `finalized_block - stored_tip`, i.e. how
 * far finality is ahead of what is stored (0 once storage has passed it). Both are clamped at zero.
 * Samples with no stored tip have no defined lag: they count in `samples` and `unknownTip` but not in the stats.
 */
export interface LagReport {
  samples: number;
  unknownTip: number;
  headLag: LagStats;
  finalizedLag: LagStats;
}

export async function recordLagSample(database: Database, input: LagSampleInput): Promise<void> {
  await database.db
    .insert(lagSamples)
    .values({
      chainId: input.chainId,
      sampledAt: input.sampledAt,
      headBlock: input.headBlock,
      finalizedBlock: input.finalizedBlock,
      storedTip: input.storedTip,
    })
    .onConflictDoNothing();
}

interface LagRow {
  samples: number;
  unknown_tip: number;
  [stat: string]: number | null;
}

// percentile_cont interpolates linearly between samples, so a JS reference needs the same rule.
export async function lagReport(database: Database, input: { chainId: number; since: Date }): Promise<LagReport> {
  const [row] = await database.sql<LagRow[]>`
    select
      count(*)::int as samples,
      (count(*) filter (where stored_tip is null))::int as unknown_tip,
      percentile_cont(0.5) within group (order by head_lag)::float8 as head_p50,
      percentile_cont(0.95) within group (order by head_lag)::float8 as head_p95,
      percentile_cont(0.99) within group (order by head_lag)::float8 as head_p99,
      max(head_lag)::float8 as head_max,
      percentile_cont(0.5) within group (order by finalized_lag)::float8 as fin_p50,
      percentile_cont(0.95) within group (order by finalized_lag)::float8 as fin_p95,
      percentile_cont(0.99) within group (order by finalized_lag)::float8 as fin_p99,
      max(finalized_lag)::float8 as fin_max
    from (
      select stored_tip,
        -- greatest() skips NULL arguments, so an unknown tip must be mapped to NULL explicitly rather than clamped to 0.
        case when stored_tip is not null then greatest(head_block - stored_tip, 0)::float8 end as head_lag,
        case when stored_tip is not null then greatest(finalized_block - stored_tip, 0)::float8 end as finalized_lag
      from ops.lag_samples
      where chain_id = ${input.chainId} and sampled_at >= ${input.since.toISOString()}::timestamptz
    ) s`;
  if (!row) throw new Error("lag report query returned no row");
  return {
    samples: row.samples,
    unknownTip: row.unknown_tip,
    headLag: { p50: row.head_p50 ?? null, p95: row.head_p95 ?? null, p99: row.head_p99 ?? null, max: row.head_max ?? null },
    finalizedLag: { p50: row.fin_p50 ?? null, p95: row.fin_p95 ?? null, p99: row.fin_p99 ?? null, max: row.fin_max ?? null },
  };
}

/** Deletes samples older than the retention window; returns how many were removed. */
export async function pruneLagSamples(database: Database, input: { chainId: number; retentionMs?: number; now?: number }): Promise<number> {
  const cutoff = new Date((input.now ?? Date.now()) - (input.retentionMs ?? LAG_RETENTION_MS));
  // postgres-js cannot infer a type for a bare Date parameter in a raw query, hence ISO text plus a cast.
  const result = await database.sql`delete from ops.lag_samples where chain_id = ${input.chainId} and sampled_at < ${cutoff.toISOString()}::timestamptz`;
  return result.count;
}
