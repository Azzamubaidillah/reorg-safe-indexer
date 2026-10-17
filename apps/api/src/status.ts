import type { Database } from "@rsi/db";
import type { LagStats, RangeStatus, Status } from "@rsi/contracts";
import { iso } from "./sql.ts";
import { toJob, latestReorg } from "./ops.ts";

const OPEN_JOB_LIMIT = 20;
const LAG_WINDOW_MS = 3600 * 1000;

/** Days the indexer keeps landing logs / decoded rows, as told to this API; undefined when it was not told. */
export interface RetentionDays {
  landing?: number | undefined;
  decoded?: number | undefined;
}

const lagBetween = (ahead: number | null, behind: number | null): number | null => (ahead !== null && behind !== null ? Math.max(0, ahead - behind) : null);

/** DB-only status: unlike the indexer's in-process /status it works while the indexer is down. */
export async function buildStatus(database: Database, chainId: number, now: number, retentionDays: RetentionDays): Promise<Status> {
  const { sql } = database;
  const since = new Date(now - LAG_WINDOW_MS).toISOString();
  const [sample, positions, rangeRows, jobRows, recon, lag, run, lastReorg, purged] = await Promise.all([
    sql<{ head_block: number; finalized_block: number; sampled_at: string }[]>`
      select head_block::float8, finalized_block::float8, ${iso(sql, "s.sampled_at")} as sampled_at
      from ops.lag_samples s where s.chain_id = ${chainId} order by s.sampled_at desc limit 1`,
    // Ranges are contiguous and never overlap, so the newest published range holds the highest published block.
    sql<{ stored_tip: number | null; published_to: number | null }[]>`
      select
        (select max(number) from chain.blocks where chain_id = ${chainId})::float8 as stored_tip,
        (select to_block from ops.ranges where chain_id = ${chainId} and status = 'published' order by from_block desc limit 1)::float8 as published_to`,
    sql<{ status: RangeStatus; ranges: number; blocks: number; logs: number }[]>`
      select status, count(*)::int as ranges, sum(block_count)::float8 as blocks, sum(log_count)::float8 as logs
      from ops.ranges where chain_id = ${chainId} group by status`,
    sql<{ id: string; from_block: number; to_block: number; status: "queued" | "running" | "resolved"; attempts: number; failure_reason: string; updated_at: string; total: number }[]>`
      select id, from_block::float8, to_block::float8, status, attempts, failure_reason, ${iso(sql, "updated_at")} as updated_at, (count(*) over ())::int as total
      from ops.backfill_jobs where chain_id = ${chainId} and status <> 'resolved'
      order by created_at, id limit ${OPEN_JOB_LIMIT}`,
    sql<{ match: number; mismatch: number; unexplained: number }[]>`
      select
        (count(*) filter (where status = 'match'))::int as match,
        (count(*) filter (where status = 'mismatch'))::int as mismatch,
        (count(*) filter (where status = 'mismatch' and (explanation is null or explanation = '')))::int as unexplained
      from ops.reconciliations where chain_id = ${chainId}`,
    sql<LagStats[]>`
      select
        count(*)::int as samples,
        percentile_cont(0.5) within group (order by lag)::float8 as p50,
        percentile_cont(0.95) within group (order by lag)::float8 as p95,
        percentile_cont(0.99) within group (order by lag)::float8 as p99,
        max(lag)::float8 as max
      from (
        select greatest(head_block - stored_tip, 0)::float8 as lag
        from ops.lag_samples
        where chain_id = ${chainId} and stored_tip is not null and sampled_at >= ${since}::timestamptz
      ) s`,
    sql<{ id: string; status: "running" | "succeeded" | "failed"; started_at: string; rpc_calls: Record<string, Record<string, number>> }[]>`
      select r.id, r.status, ${iso(sql, "r.started_at")} as started_at, r.rpc_calls from ops.runs r where r.chain_id = ${chainId} order by r.started_at desc, r.id desc limit 1`,
    latestReorg(database, chainId),
    sql<{ landing: number | null; decoded: number | null }[]>`
      select (max(to_block) filter (where landing_purged_at is not null))::float8 as landing,
             (max(to_block) filter (where decoded_purged_at is not null))::float8 as decoded
      from ops.ranges where chain_id = ${chainId}`,
  ]);

  const head = sample[0];
  const storedTip = positions[0]?.stored_tip ?? null;
  const lastPublishedBlock = positions[0]?.published_to ?? null;
  const finalizedBlock = head?.finalized_block ?? null;
  const ranges: Status["ranges"] = {
    candidate: { ranges: 0, blocks: 0, logs: 0 },
    published: { ranges: 0, blocks: 0, logs: 0 },
    failed: { ranges: 0, blocks: 0, logs: 0 },
  };
  for (const r of rangeRows) ranges[r.status] = { ranges: r.ranges, blocks: r.blocks, logs: r.logs };
  const lastRun = run[0];
  const lag1h = lag[0] && lag[0].samples > 0 ? lag[0] : null;

  return {
    chainId,
    generatedAt: new Date(now).toISOString(),
    head: head ? { block: head.head_block, sampledAt: head.sampled_at } : null,
    finalizedBlock,
    storedTip,
    lastPublishedBlock,
    headLag: lagBetween(head?.head_block ?? null, storedTip),
    finalizedLag: lagBetween(finalizedBlock, lastPublishedBlock),
    ranges,
    backfill: { open: jobRows[0]?.total ?? 0, jobs: jobRows.map(toJob) },
    reconciliation: recon[0] ?? { match: 0, mismatch: 0, unexplained: 0 },
    lag1h,
    lastRun: lastRun ? { id: lastRun.id, status: lastRun.status, startedAt: lastRun.started_at, rpcCalls: lastRun.rpc_calls } : null,
    lastReorg,
    retention: {
      landingPurgedThroughBlock: purged[0]?.landing ?? null,
      decodedPurgedThroughBlock: purged[0]?.decoded ?? null,
      landingRetentionDays: retentionDays.landing ?? null,
      decodedRetentionDays: retentionDays.decoded ?? null,
    },
  };
}
