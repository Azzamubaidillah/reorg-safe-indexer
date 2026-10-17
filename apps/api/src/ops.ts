import type { Database } from "@rsi/db";
import { iso } from "./sql.ts";
import type {
  BackfillJob,
  BackfillJobsQuery,
  PageQuery,
  QualityGate,
  Range,
  RangeDetail,
  RangesQuery,
  Reconciliation,
  ReconciliationsQuery,
  Reorg,
  RangeStatus,
  BackfillStatus,
  ReconciliationStatus,
} from "@rsi/contracts";
import { blockCursor, decodeCursor, encodeCursor, idCursor, jobCursor, paginate } from "./http.ts";

// Everything here reads ops.* through primary keys or their prefixes. Lists page by a unique key
// (from_block, (from_block, to_block) or identity id) so a page boundary never depends on
// timestamps or on rows being committed concurrently.

interface RangeRow {
  from_block: number;
  to_block: number;
  status: RangeStatus;
  block_count: number;
  log_count: number;
  transfer_count: number;
  swap_count: number;
  reject_count: number;
  committed_at: string;
  published_at: string | null;
}

const toRange = (r: RangeRow): Range => ({
  fromBlock: r.from_block,
  toBlock: r.to_block,
  status: r.status,
  blockCount: r.block_count,
  logCount: r.log_count,
  transferCount: r.transfer_count,
  swapCount: r.swap_count,
  rejectCount: r.reject_count,
  committedAt: r.committed_at,
  publishedAt: r.published_at,
});

export async function listRanges(database: Database, chainId: number, query: RangesQuery): Promise<{ items: Range[]; nextCursor: string | null }> {
  const { sql } = database;
  const cursor = decodeCursor(blockCursor, query.cursor);
  const rows = await sql<RangeRow[]>`
    select from_block::float8, to_block::float8, status, block_count, log_count, transfer_count, swap_count, reject_count, ${iso(sql, "committed_at")} as committed_at, ${iso(sql, "published_at")} as published_at
    from ops.ranges
    where chain_id = ${chainId}
      ${query.status ? sql`and status = ${query.status}` : sql``}
      ${cursor ? sql`and from_block < ${cursor.b}` : sql``}
    order by from_block desc
    limit ${query.limit + 1}`;
  return paginate(rows.map(toRange), query.limit, (last) => encodeCursor({ b: last.fromBlock }));
}

interface JobRow {
  id: string;
  from_block: number;
  to_block: number;
  status: BackfillStatus;
  attempts: number;
  failure_reason: string;
  updated_at: string;
}

export const toJob = (j: JobRow): BackfillJob => ({
  id: j.id,
  fromBlock: j.from_block,
  toBlock: j.to_block,
  status: j.status,
  attempts: j.attempts,
  failureReason: j.failure_reason,
  updatedAt: j.updated_at,
});

export async function listBackfillJobs(database: Database, chainId: number, query: BackfillJobsQuery): Promise<{ items: BackfillJob[]; nextCursor: string | null }> {
  const { sql } = database;
  const cursor = decodeCursor(jobCursor, query.cursor);
  const rows = await sql<JobRow[]>`
    select id, from_block::float8, to_block::float8, status, attempts, failure_reason, ${iso(sql, "updated_at")} as updated_at
    from ops.backfill_jobs
    where chain_id = ${chainId}
      ${query.status ? sql`and status = ${query.status}` : sql``}
      ${cursor ? sql`and (from_block, to_block) < (${cursor.f}, ${cursor.t})` : sql``}
    order by from_block desc, to_block desc
    limit ${query.limit + 1}`;
  return paginate(rows.map(toJob), query.limit, (last) => encodeCursor({ f: last.fromBlock, t: last.toBlock }));
}

interface ReconciliationRow {
  id: number;
  from_block: number;
  to_block: number;
  provider: string;
  checked_at: string;
  status: ReconciliationStatus;
  blocks_checked: number;
  /** Count of mismatching heights; the heights themselves are in ops.reconciliations. */
  hash_mismatches: number;
  stored_log_count: number;
  observed_log_count: number;
  explanation: string | null;
}

const reconciliationColumns = (sql: Database["sql"]) => sql`
  id::float8, from_block::float8, to_block::float8, provider, ${iso(sql, "checked_at")} as checked_at, status, blocks_checked,
  jsonb_array_length(hash_mismatches) as hash_mismatches, stored_log_count, observed_log_count, explanation`;

const toReconciliation = (r: ReconciliationRow): Reconciliation => ({
  id: r.id,
  fromBlock: r.from_block,
  toBlock: r.to_block,
  provider: r.provider,
  checkedAt: r.checked_at,
  status: r.status,
  blocksChecked: r.blocks_checked,
  hashMismatches: r.hash_mismatches,
  storedLogCount: r.stored_log_count,
  observedLogCount: r.observed_log_count,
  explanation: r.explanation,
});

export async function listReconciliations(database: Database, chainId: number, query: ReconciliationsQuery): Promise<{ items: Reconciliation[]; nextCursor: string | null }> {
  const { sql } = database;
  const cursor = decodeCursor(idCursor, query.cursor);
  const rows = await sql<ReconciliationRow[]>`
    select ${reconciliationColumns(sql)}
    from ops.reconciliations
    where chain_id = ${chainId}
      ${query.status ? sql`and status = ${query.status}` : sql``}
      ${query.unexplained ? sql`and status = 'mismatch' and (explanation is null or explanation = '')` : sql``}
      ${cursor ? sql`and id < ${cursor.id}` : sql``}
    order by ops.reconciliations.id desc
    limit ${query.limit + 1}`;
  return paginate(rows.map(toReconciliation), query.limit, (last) => encodeCursor({ id: last.id }));
}

/** null when no range starts at `fromBlock`. */
export async function getRangeDetail(database: Database, chainId: number, fromBlock: number): Promise<RangeDetail | null> {
  const { sql } = database;
  const [range] = await sql<RangeRow[]>`
    select from_block::float8, to_block::float8, status, block_count, log_count, transfer_count, swap_count, reject_count, ${iso(sql, "committed_at")} as committed_at, ${iso(sql, "published_at")} as published_at
    from ops.ranges where chain_id = ${chainId} and from_block = ${fromBlock}`;
  if (!range) return null;
  const [gates, jobs, reconciliations] = await Promise.all([
    sql<{ gate: string; passed: boolean; rows_checked: number; rows_failed: number; detail: string | null; checked_at: string }[]>`
      select gate, passed, rows_checked, rows_failed, detail, ${iso(sql, "checked_at")} as checked_at
      from ops.quality_results where chain_id = ${chainId} and from_block = ${fromBlock} order by gate`,
    sql<JobRow[]>`
      select id, from_block::float8, to_block::float8, status, attempts, failure_reason, ${iso(sql, "updated_at")} as updated_at
      from ops.backfill_jobs where chain_id = ${chainId} and from_block = ${fromBlock} and to_block = ${range.to_block}`,
    sql<ReconciliationRow[]>`
      select ${reconciliationColumns(sql)}
      from ops.reconciliations where chain_id = ${chainId} and from_block = ${fromBlock} order by ops.reconciliations.id desc`,
  ]);
  const detail: QualityGate[] = gates.map((g) => ({
    gate: g.gate,
    passed: g.passed,
    rowsChecked: g.rows_checked,
    rowsFailed: g.rows_failed,
    detail: g.detail,
    checkedAt: g.checked_at,
  }));
  return { ...toRange(range), gates: detail, backfillJob: jobs[0] ? toJob(jobs[0]) : null, reconciliations: reconciliations.map(toReconciliation) };
}

interface ReorgRow {
  id: number;
  detected_at: string;
  action: Reorg["action"];
  depth: number;
  fork_block: number;
  ancestor_block: number | null;
  rollback_from: number | null;
  finalized_block: number;
  orphaned: Reorg["orphaned"];
  canonical: Reorg["canonical"];
  acknowledged_at: string | null;
  acknowledgement: string | null;
}

const reorgColumns = (sql: Database["sql"]) => sql`
  id::float8, ${iso(sql, "detected_at")} as detected_at, action, depth, fork_block::float8, ancestor_block::float8, rollback_from::float8, finalized_block::float8, orphaned, canonical, ${iso(sql, "acknowledged_at")} as acknowledged_at, acknowledgement`;

const toReorg = (r: ReorgRow): Reorg => ({
  id: r.id,
  detectedAt: r.detected_at,
  action: r.action,
  depth: r.depth,
  forkBlock: r.fork_block,
  ancestorBlock: r.ancestor_block,
  rollbackFrom: r.rollback_from,
  finalizedBlock: r.finalized_block,
  orphaned: r.orphaned,
  canonical: r.canonical,
  acknowledgedAt: r.acknowledged_at,
  acknowledgement: r.acknowledgement,
});

export async function listReorgs(database: Database, chainId: number, input: PageQuery): Promise<{ items: Reorg[]; nextCursor: string | null }> {
  const { sql } = database;
  const cursor = decodeCursor(idCursor, input.cursor);
  const rows = await sql<ReorgRow[]>`
    select ${reorgColumns(sql)}
    from ops.reorgs
    where chain_id = ${chainId}
      ${cursor ? sql`and id < ${cursor.id}` : sql``}
    order by ops.reorgs.id desc
    limit ${input.limit + 1}`;
  return paginate(rows.map(toReorg), input.limit, (last) => encodeCursor({ id: last.id }));
}

export async function latestReorg(database: Database, chainId: number): Promise<Reorg | null> {
  const { sql } = database;
  const [row] = await sql<ReorgRow[]>`
    select ${reorgColumns(sql)}
    from ops.reorgs where chain_id = ${chainId} order by ops.reorgs.id desc limit 1`;
  return row ? toReorg(row) : null;
}
