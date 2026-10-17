import { and, asc, between, eq, lte, ne, sql } from "drizzle-orm";
import { backfillJobs, blocks, erc20Transfers, logs, qualityResults, ranges, uniswapV3Swaps, type Database, type Sql } from "@rsi/db";
import { decodeRange, SWAP_TOPIC, TRANSFER_TOPIC } from "./decode.ts";
import { fetchRangeRetrying } from "./fetcher.ts";
import { payloadSha256 } from "./payload.ts";
import type { RpcPool } from "./rpc/pool.ts";
import { insertRangeRows } from "./store.ts";
import type { TrackedContracts } from "./types.ts";

/** Gates in evaluation order; a range is published only when every one passes. */
export const GATES = [
  "decode_rejects_zero",
  "counts_consistent",
  "blocks_linked",
  "log_positions_unique",
  "log_block_hash_matches",
  "value_bounds",
  "decoded_matches_landing",
] as const;
export type GateName = (typeof GATES)[number];

export interface GateResult {
  gate: GateName;
  passed: boolean;
  rowsChecked: number;
  rowsFailed: number;
  /** Failing sub-checks as `name=rows`; null when the gate passed. */
  detail: string | null;
}

export interface RangeRef {
  fromBlock: number;
  toBlock: number;
}

export interface FailedRange extends RangeRef {
  gates: GateName[];
}

export interface BackfillOutcome extends RangeRef {
  jobId: string;
  /**
   * resolved: re-fetched, replaced and published. requeued: the job failed (fetch error, the re-fetched
   * headers do not link to the stored neighbours, or a gate still fails) and waits for the next cycle.
   * obsolete: the range is gone or no longer failed, so there is nothing to repair.
   */
  result: "resolved" | "requeued" | "obsolete";
  /** Why the job is not resolved; null when resolved. */
  reason: string | null;
}

export interface QualityCycleSummary {
  /** Candidates published by this cycle's publish pass (backfilled ranges are reported under `backfills`). */
  published: RangeRef[];
  failed: FailedRange[];
  backfills: BackfillOutcome[];
}

export interface QualityCycleInput {
  chainId: number;
  finalizedBlock: number;
  contracts: TrackedContracts;
  runId: string;
  /** Backfill jobs processed per cycle; default 2. */
  maxBackfills?: number;
}

type RangeRow = typeof ranges.$inferSelect;
type JobRow = typeof backfillJobs.$inferSelect;

interface GateCheck {
  checked: number;
  /** Failing sub-checks and how many rows each affects; zero entries are ignored. */
  failures: Record<string, number>;
}

const DEFAULT_MAX_BACKFILLS = 2;
const FETCH_RETRIES = 3;

const HASH_SHAPE = "^0x[0-9a-f]{64}$";
const ADDRESS_SHAPE = "^0x[0-9a-f]{40}$";
const DATA_SHAPE = "^0x([0-9a-f]{2})*$";
const U256 = (2n ** 256n).toString();
const I255 = (2n ** 255n).toString();
const NEG_I255 = (-(2n ** 255n)).toString();
const U160 = (2n ** 160n).toString();
const U128 = (2n ** 128n).toString();
const MAX_TICK = 887_272;
/** pg_type oid of text, for binding address lists as text[]. */
const TEXT_OID = 25;

/**
 * Each gate looks only at the rows stored for one range, so a check costs the same however much
 * history is stored. The range bounds appear directly in every table scan: hidden behind a CTE the
 * planner cannot see them and falls back to scanning whole tables.
 */
const CHECKS: Record<GateName, (sql: Sql, range: RangeRow, contracts: TrackedContracts) => Promise<GateCheck>> = {
  // Rejected logs are not stored per row, so the range's own counter is the evidence.
  decode_rejects_zero: async (_sql, range) => ({ checked: range.logCount, failures: { rejected_logs: range.rejectCount } }),

  counts_consistent: async (sql, range) => {
    const { chainId, fromBlock, toBlock } = range;
    const [stored] = await sql<{ blocks: number; logs: number; transfers: number; swaps: number }[]>`
      select
        (select count(*) from chain.blocks where chain_id = ${chainId} and number between ${fromBlock} and ${toBlock})::int as blocks,
        (select count(*) from chain.logs where chain_id = ${chainId} and block_number between ${fromBlock} and ${toBlock})::int as logs,
        (select count(*) from chain.erc20_transfers where chain_id = ${chainId} and block_number between ${fromBlock} and ${toBlock})::int as transfers,
        (select count(*) from chain.uniswap_v3_swaps where chain_id = ${chainId} and block_number between ${fromBlock} and ${toBlock})::int as swaps`;
    if (!stored) throw new Error("count query returned no row");
    const failures: Record<string, number> = {};
    const compare = (name: string, recorded: number, actual: number) => {
      if (recorded !== actual) failures[`${name}(recorded ${recorded}, stored ${actual})`] = Math.abs(recorded - actual);
    };
    compare("blocks", range.blockCount, stored.blocks);
    compare("block_span", toBlock - fromBlock + 1, range.blockCount);
    compare("logs", range.logCount, stored.logs);
    compare("transfers", range.transferCount, stored.transfers);
    compare("swaps", range.swapCount, stored.swaps);
    // Every fetched log was decoded or rejected, exactly once.
    compare("log_identity", range.logCount, range.transferCount + range.swapCount + range.rejectCount);
    return { checked: stored.blocks + stored.logs + stored.transfers + stored.swaps, failures };
  },

  blocks_linked: async (sql, { chainId, fromBlock, toBlock }) => {
    const [row] = await sql<{ checked: number; missing_blocks: number; broken_links: number; broken_boundary: number; missing_boundary_block: number }[]>`
      with b as (select number, hash, parent_hash from chain.blocks where chain_id = ${chainId} and number between ${fromBlock} and ${toBlock})
      select
        (select count(*) from b)::int as checked,
        (select count(*) from generate_series(${fromBlock}::bigint, ${toBlock}::bigint) g(n) where not exists (select 1 from b where b.number = g.n))::int as missing_blocks,
        (select count(*) from b join b p on p.number = b.number - 1 where p.hash <> b.parent_hash)::int as broken_links,
        -- the first block must extend whatever is stored just below the range
        (select count(*) from b, chain.blocks p
          where b.number = ${fromBlock} and p.chain_id = ${chainId} and p.number = ${fromBlock}::bigint - 1 and p.hash <> b.parent_hash)::int as broken_boundary,
        (select count(*) where
          exists (select 1 from ops.ranges q where q.chain_id = ${chainId} and q.to_block = ${fromBlock}::bigint - 1)
          and not exists (select 1 from chain.blocks p where p.chain_id = ${chainId} and p.number = ${fromBlock}::bigint - 1))::int as missing_boundary_block`;
    if (!row) throw new Error("link query returned no row");
    const { checked, ...failures } = row;
    return { checked, failures };
  },

  log_positions_unique: async (sql, { chainId, fromBlock, toBlock }) => {
    const [row] = await sql<{ checked: number; duplicate_logs: number; duplicate_decoded: number }[]>`
      with l as (select block_number, log_index from chain.logs where chain_id = ${chainId} and block_number between ${fromBlock} and ${toBlock}),
      d as (
        select block_number, log_index from chain.erc20_transfers where chain_id = ${chainId} and block_number between ${fromBlock} and ${toBlock}
        union all
        select block_number, log_index from chain.uniswap_v3_swaps where chain_id = ${chainId} and block_number between ${fromBlock} and ${toBlock}
      )
      select
        ((select count(*) from l) + (select count(*) from d))::int as checked,
        coalesce((select sum(n - 1) from (select count(*) n from l group by block_number, log_index having count(*) > 1) g), 0)::int as duplicate_logs,
        -- one log decodes to one row: a position in both decoded tables, or twice in one, is wrong
        coalesce((select sum(n - 1) from (select count(*) n from d group by block_number, log_index having count(*) > 1) g), 0)::int as duplicate_decoded`;
    if (!row) throw new Error("position query returned no row");
    const { checked, ...failures } = row;
    return { checked, failures };
  },

  log_block_hash_matches: async (sql, { chainId, fromBlock, toBlock }) => {
    const [row] = await sql<{ checked: number; no_block: number; wrong_hash: number }[]>`
      select
        count(*)::int as checked,
        (count(*) filter (where b.hash is null))::int as no_block,
        (count(*) filter (where b.hash <> l.block_hash))::int as wrong_hash
      from chain.logs l
      left join chain.blocks b on b.chain_id = l.chain_id and b.number = l.block_number
      where l.chain_id = ${chainId} and l.block_number between ${fromBlock} and ${toBlock}`;
    if (!row) throw new Error("hash query returned no row");
    const { checked, ...failures } = row;
    return { checked, failures };
  },

  value_bounds: async (sql, { chainId, fromBlock, toBlock }) => {
    const [b, l, t, s] = await Promise.all([
      sql<{ checked: number; bad: number }[]>`
        select count(*)::int as checked,
          (count(*) filter (where x.hash !~ ${HASH_SHAPE} or x.parent_hash !~ ${HASH_SHAPE}))::int as bad
        from chain.blocks x where x.chain_id = ${chainId} and x.number between ${fromBlock} and ${toBlock}`,
      sql<{ checked: number; bad: number }[]>`
        select count(*)::int as checked,
          (count(*) filter (where
            x.address !~ ${ADDRESS_SHAPE} or x.block_hash !~ ${HASH_SHAPE} or x.tx_hash !~ ${HASH_SHAPE} or x.data !~ ${DATA_SHAPE}
            or exists (select 1 from unnest(x.topics) topic where topic !~ ${HASH_SHAPE})))::int as bad
        from chain.logs x where x.chain_id = ${chainId} and x.block_number between ${fromBlock} and ${toBlock}`,
      sql<{ checked: number; bad: number }[]>`
        select count(*)::int as checked,
          (count(*) filter (where
            not (x.value >= 0 and x.value < ${U256}::numeric)
            or x.token !~ ${ADDRESS_SHAPE} or x.from_address !~ ${ADDRESS_SHAPE} or x.to_address !~ ${ADDRESS_SHAPE}
            or x.block_hash !~ ${HASH_SHAPE} or x.tx_hash !~ ${HASH_SHAPE}))::int as bad
        from chain.erc20_transfers x where x.chain_id = ${chainId} and x.block_number between ${fromBlock} and ${toBlock}`,
      sql<{ checked: number; bad: number }[]>`
        select count(*)::int as checked,
          (count(*) filter (where
            x.tick not between ${-MAX_TICK} and ${MAX_TICK}
            or not (x.amount0 >= ${NEG_I255}::numeric and x.amount0 < ${I255}::numeric)
            or not (x.amount1 >= ${NEG_I255}::numeric and x.amount1 < ${I255}::numeric)
            or not (x.sqrt_price_x96 >= 0 and x.sqrt_price_x96 < ${U160}::numeric)
            or not (x.liquidity >= 0 and x.liquidity < ${U128}::numeric)
            or x.pool !~ ${ADDRESS_SHAPE} or x.sender !~ ${ADDRESS_SHAPE} or x.recipient !~ ${ADDRESS_SHAPE}
            or x.block_hash !~ ${HASH_SHAPE} or x.tx_hash !~ ${HASH_SHAPE}))::int as bad
        from chain.uniswap_v3_swaps x where x.chain_id = ${chainId} and x.block_number between ${fromBlock} and ${toBlock}`,
    ]);
    const [blockRows, logRows, transferRows, swapRows] = [b[0], l[0], t[0], s[0]];
    if (!blockRows || !logRows || !transferRows || !swapRows) throw new Error("bounds query returned no row");
    return {
      checked: blockRows.checked + logRows.checked + transferRows.checked + swapRows.checked,
      failures: { bad_blocks: blockRows.bad, bad_logs: logRows.bad, bad_transfers: transferRows.bad, bad_swaps: swapRows.bad },
    };
  },

  decoded_matches_landing: async (sql, { chainId, fromBlock, toBlock, rejectCount }, contracts) => {
    const tokens = sql.array(contracts.tokens, TEXT_OID);
    const pools = sql.array(contracts.pools, TEXT_OID);
    const [row] = await sql<{ checked: number; transfers_without_log: number; swaps_without_log: number; undecoded: number }[]>`
      with tr as (select * from chain.erc20_transfers where chain_id = ${chainId} and block_number between ${fromBlock} and ${toBlock}),
      sw as (select * from chain.uniswap_v3_swaps where chain_id = ${chainId} and block_number between ${fromBlock} and ${toBlock}),
      tracked as (
        select * from chain.logs
        where chain_id = ${chainId} and block_number between ${fromBlock} and ${toBlock}
          and ((address = any(${tokens}::text[]) and topics[1] = ${TRANSFER_TOPIC}) or (address = any(${pools}::text[]) and topics[1] = ${SWAP_TOPIC}))
      )
      select
        ((select count(*) from tr) + (select count(*) from sw) + (select count(*) from tracked))::int as checked,
        -- the landing log must be the very log the row claims to come from; the block bounds on the
        -- probe change nothing (a matching log is in the same block) but keep the plan on the range
        (select count(*) from tr where not exists (
          select 1 from chain.logs g
          where g.chain_id = tr.chain_id and g.block_number between ${fromBlock} and ${toBlock}
            and g.block_hash = tr.block_hash and g.log_index = tr.log_index
            and g.block_number = tr.block_number and g.tx_hash = tr.tx_hash and g.address = tr.token and g.topics[1] = ${TRANSFER_TOPIC}))::int as transfers_without_log,
        (select count(*) from sw where not exists (
          select 1 from chain.logs g
          where g.chain_id = sw.chain_id and g.block_number between ${fromBlock} and ${toBlock}
            and g.block_hash = sw.block_hash and g.log_index = sw.log_index
            and g.block_number = sw.block_number and g.tx_hash = sw.tx_hash and g.address = sw.pool and g.topics[1] = ${SWAP_TOPIC}))::int as swaps_without_log,
        (select count(*) from tracked k
          where not exists (select 1 from chain.erc20_transfers x where x.chain_id = k.chain_id and x.block_number = k.block_number and x.block_hash = k.block_hash and x.log_index = k.log_index)
            and not exists (select 1 from chain.uniswap_v3_swaps x where x.chain_id = k.chain_id and x.block_number = k.block_number and x.block_hash = k.block_hash and x.log_index = k.log_index))::int as undecoded`;
    if (!row) throw new Error("landing query returned no row");
    // Logs that matched the filter but did not decode are legitimate only as counted rejects.
    return {
      checked: row.checked,
      failures: {
        transfers_without_log: row.transfers_without_log,
        swaps_without_log: row.swaps_without_log,
        undecoded_logs: Math.max(row.undecoded - rejectCount, 0),
      },
    };
  },
};

async function evaluateGates(database: Database, range: RangeRow, contracts: TrackedContracts): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const gate of GATES) {
    const { checked, failures } = await CHECKS[gate](database.sql, range, contracts);
    const failing = Object.entries(failures).filter(([, rows]) => rows > 0);
    results.push({
      gate,
      passed: failing.length === 0,
      rowsChecked: checked,
      rowsFailed: failing.reduce((sum, [, rows]) => sum + rows, 0),
      detail: failing.length === 0 ? null : failing.map(([name, rows]) => `${name}=${rows}`).join(", "),
    });
  }
  return results;
}

const jobId = (r: { chainId: number } & RangeRef) => `${r.chainId}:${r.fromBlock}-${r.toBlock}`;

/**
 * Records the gate results and moves the range: all passed -> published (and any open job resolved);
 * otherwise failed with exactly one queued backfill job for the range. One transaction, so a crash
 * never leaves a published range without its evidence.
 */
async function settleRange(database: Database, range: RangeRow, results: GateResult[]): Promise<GateResult[]> {
  const failing = results.filter((r) => !r.passed);
  const reason = `failed gates: ${failing.map((r) => `${r.gate} (${r.detail})`).join("; ")}`;
  const key = { chainId: range.chainId, fromBlock: range.fromBlock };
  await database.db.transaction(async (tx) => {
    await tx
      .insert(qualityResults)
      .values(results.map((r) => ({ ...key, gate: r.gate, passed: r.passed, rowsChecked: r.rowsChecked, rowsFailed: r.rowsFailed, detail: r.detail })))
      .onConflictDoUpdate({
        target: [qualityResults.chainId, qualityResults.fromBlock, qualityResults.gate],
        set: {
          passed: sql`excluded.passed`,
          rowsChecked: sql`excluded.rows_checked`,
          rowsFailed: sql`excluded.rows_failed`,
          detail: sql`excluded.detail`,
          checkedAt: sql`now()`,
        },
      });
    const rangeWhere = and(eq(ranges.chainId, range.chainId), eq(ranges.fromBlock, range.fromBlock));
    if (failing.length === 0) {
      await tx.update(ranges).set({ status: "published", publishedAt: sql`now()` }).where(rangeWhere);
      await tx
        .update(backfillJobs)
        .set({ status: "resolved", resolvedAt: sql`now()`, updatedAt: sql`now()` })
        .where(and(eq(backfillJobs.id, jobId(range)), ne(backfillJobs.status, "resolved")));
    } else {
      await tx.update(ranges).set({ status: "failed", publishedAt: null }).where(rangeWhere);
      await tx
        .insert(backfillJobs)
        .values({ id: jobId(range), chainId: range.chainId, fromBlock: range.fromBlock, toBlock: range.toBlock, status: "queued", failureReason: reason })
        .onConflictDoUpdate({
          target: backfillJobs.id,
          set: { status: "queued", failureReason: reason, updatedAt: sql`now()`, resolvedAt: null },
        });
    }
  });
  return failing;
}

async function setJob(database: Database, id: string, status: "queued" | "resolved", reason: string): Promise<void> {
  await database.db
    .update(backfillJobs)
    .set({ status, failureReason: reason, updatedAt: sql`now()`, resolvedAt: status === "resolved" ? sql`now()` : null })
    .where(eq(backfillJobs.id, id));
}

/**
 * Re-fetches the job's range and swaps it in, then re-runs the gates. The swap is one transaction and
 * only happens when the new headers link to the stored blocks on both sides, so a failed repair never
 * breaks the chain or loses data.
 */
async function runBackfill(database: Database, pool: RpcPool, job: JobRow, input: QualityCycleInput): Promise<BackfillOutcome> {
  const { chainId, contracts } = input;
  const ref = { jobId: job.id, fromBlock: job.fromBlock, toBlock: job.toBlock };
  const requeue = async (reason: string): Promise<BackfillOutcome> => {
    await setJob(database, job.id, "queued", reason);
    return { ...ref, result: "requeued", reason };
  };

  const [current] = await database.db
    .select()
    .from(ranges)
    .where(and(eq(ranges.chainId, chainId), eq(ranges.fromBlock, job.fromBlock)));
  if (!current || current.toBlock !== job.toBlock || current.status !== "failed") {
    const reason = `obsolete (${current ? `range is ${current.status} to ${current.toBlock}` : "range no longer exists"}); was: ${job.failureReason}`;
    await setJob(database, job.id, "resolved", reason);
    return { ...ref, result: "obsolete", reason };
  }

  let refusal: string | undefined;
  try {
    const fetched = await fetchRangeRetrying(
      pool,
      { from: job.fromBlock, to: job.toBlock, addresses: [...contracts.tokens, ...contracts.pools], topic0s: [TRANSFER_TOPIC, SWAP_TOPIC] },
      { retries: FETCH_RETRIES, backoffMs: (attempt) => Math.min(4_000, 250 * 2 ** (attempt - 1)) },
    );
    const decoded = decodeRange(fetched.logs, contracts);
    const first = fetched.blocks[0];
    const last = fetched.blocks.at(-1);
    if (!first || !last) throw new Error("provider returned an empty range");

    refusal = await database.db.transaction(async (tx) => {
      const [locked] = await tx
        .select({ status: ranges.status })
        .from(ranges)
        .where(and(eq(ranges.chainId, chainId), eq(ranges.fromBlock, job.fromBlock)))
        .for("update");
      if (locked?.status !== "failed") return `range is ${locked?.status ?? "gone"}, not replacing it`;

      const [below] = await tx.select({ hash: blocks.hash }).from(blocks).where(and(eq(blocks.chainId, chainId), eq(blocks.number, job.fromBlock - 1)));
      if (below && below.hash !== first.parentHash) {
        return `re-fetched block ${first.number} (parent ${first.parentHash}) does not link to stored block ${job.fromBlock - 1} (${below.hash})`;
      }
      const [above] = await tx.select({ parentHash: blocks.parentHash }).from(blocks).where(and(eq(blocks.chainId, chainId), eq(blocks.number, job.toBlock + 1)));
      if (above && above.parentHash !== last.hash) {
        return `re-fetched block ${last.number} (${last.hash}) does not link to stored block ${job.toBlock + 1} (parent ${above.parentHash})`;
      }

      await tx.delete(erc20Transfers).where(and(eq(erc20Transfers.chainId, chainId), between(erc20Transfers.blockNumber, job.fromBlock, job.toBlock)));
      await tx.delete(uniswapV3Swaps).where(and(eq(uniswapV3Swaps.chainId, chainId), between(uniswapV3Swaps.blockNumber, job.fromBlock, job.toBlock)));
      await tx.delete(logs).where(and(eq(logs.chainId, chainId), between(logs.blockNumber, job.fromBlock, job.toBlock)));
      await tx.delete(blocks).where(and(eq(blocks.chainId, chainId), between(blocks.number, job.fromBlock, job.toBlock)));
      await insertRangeRows(tx, chainId, fetched, decoded);
      await tx
        .update(ranges)
        .set({
          status: "candidate",
          blockCount: fetched.blocks.length,
          logCount: fetched.logs.length,
          transferCount: decoded.transfers.length,
          swapCount: decoded.swaps.length,
          rejectCount: decoded.rejects.length,
          payloadSha256: payloadSha256(fetched),
          runId: input.runId,
          committedAt: sql`now()`,
          publishedAt: null,
        })
        .where(and(eq(ranges.chainId, chainId), eq(ranges.fromBlock, job.fromBlock)));
      return undefined;
    });
  } catch (err) {
    return requeue(`backfill failed: ${(err as Error).message}`);
  }
  if (refusal) return requeue(`backfill refused: ${refusal}`);

  const [replaced] = await database.db
    .select()
    .from(ranges)
    .where(and(eq(ranges.chainId, chainId), eq(ranges.fromBlock, job.fromBlock)));
  if (!replaced) throw new Error(`range ${job.fromBlock} vanished during backfill`);
  const failing = await settleRange(database, replaced, await evaluateGates(database, replaced, contracts));
  return failing.length === 0
    ? { ...ref, result: "resolved", reason: null }
    : { ...ref, result: "requeued", reason: `still failing after backfill: ${failing.map((r) => r.gate).join(", ")}` };
}

/**
 * One quality pass for a chain: gate and publish every finalized candidate range (ascending), then
 * work off queued backfill jobs for finalized ranges, oldest-touched first so a stuck job cannot
 * starve the rest. Fail-closed: a range is published only when every gate passed, and never above
 * `finalizedBlock`. The caller must not run two cycles for one chain at once (a `running` job found
 * here belongs to a process that died, and is re-queued).
 */
export async function runQualityCycle(database: Database, pool: RpcPool, input: QualityCycleInput): Promise<QualityCycleSummary> {
  const { chainId, finalizedBlock, contracts } = input;
  const summary: QualityCycleSummary = { published: [], failed: [], backfills: [] };

  // Gates read the landing and decoded rows, which retention deletes, but only for published ranges
  // (ops.ranges check `ranges_purge_check`): candidates and failed ranges are always whole, so no purged
  // range is ever re-gated or backfilled.
  const candidates = await database.db
    .select()
    .from(ranges)
    .where(and(eq(ranges.chainId, chainId), eq(ranges.status, "candidate"), lte(ranges.toBlock, finalizedBlock)))
    .orderBy(asc(ranges.fromBlock));
  for (const range of candidates) {
    const failing = await settleRange(database, range, await evaluateGates(database, range, contracts));
    const ref = { fromBlock: range.fromBlock, toBlock: range.toBlock };
    if (failing.length === 0) summary.published.push(ref);
    else summary.failed.push({ ...ref, gates: failing.map((r) => r.gate) });
  }

  await database.db
    .update(backfillJobs)
    .set({ status: "queued" })
    .where(and(eq(backfillJobs.chainId, chainId), eq(backfillJobs.status, "running")));
  const jobs = await database.db
    .select()
    .from(backfillJobs)
    .where(and(eq(backfillJobs.chainId, chainId), eq(backfillJobs.status, "queued"), lte(backfillJobs.toBlock, finalizedBlock)))
    .orderBy(asc(backfillJobs.updatedAt), asc(backfillJobs.createdAt), asc(backfillJobs.fromBlock))
    .limit(input.maxBackfills ?? DEFAULT_MAX_BACKFILLS);
  for (const job of jobs) {
    const [claimed] = await database.db
      .update(backfillJobs)
      .set({ status: "running", attempts: sql`${backfillJobs.attempts} + 1`, updatedAt: sql`now()` })
      .where(and(eq(backfillJobs.id, job.id), eq(backfillJobs.status, "queued")))
      .returning();
    if (claimed) summary.backfills.push(await runBackfill(database, pool, claimed, input));
  }
  return summary;
}
