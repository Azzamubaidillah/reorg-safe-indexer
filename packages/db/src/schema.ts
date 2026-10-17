import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";

// Two schemas: `chain` holds the indexed data, `ops` holds evidence about how
// it got there (runs and committed block ranges). Hashes and addresses are
// lowercase 0x-hex text; token amounts are NUMERIC(78,0), enough for uint256
// and int256 without precision loss.
export const chain = pgSchema("chain");
export const ops = pgSchema("ops");

const blockNumber = (name: string) => bigint(name, { mode: "number" });
const u256 = (name: string) => numeric(name, { precision: 78, scale: 0 });

/** Canonical block headers, one row per height. */
export const blocks = chain.table(
  "blocks",
  {
    chainId: integer("chain_id").notNull(),
    number: blockNumber("number").notNull(),
    hash: text("hash").notNull(),
    parentHash: text("parent_hash").notNull(),
    timestamp: timestamp("timestamp", { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.number] }), unique("blocks_hash_key").on(t.chainId, t.hash)],
);

/** Landing table: every fetched log exactly as the provider returned it. */
export const logs = chain.table(
  "logs",
  {
    chainId: integer("chain_id").notNull(),
    blockNumber: blockNumber("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    txHash: text("tx_hash").notNull(),
    txIndex: integer("tx_index").notNull(),
    address: text("address").notNull(),
    topics: text("topics").array().notNull(),
    data: text("data").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.chainId, t.blockHash, t.logIndex] }),
    index("logs_block_idx").on(t.chainId, t.blockNumber),
  ],
);

export const erc20Transfers = chain.table(
  "erc20_transfers",
  {
    chainId: integer("chain_id").notNull(),
    blockNumber: blockNumber("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    txHash: text("tx_hash").notNull(),
    token: text("token").notNull(),
    fromAddress: text("from_address").notNull(),
    toAddress: text("to_address").notNull(),
    value: u256("value").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.chainId, t.blockHash, t.logIndex] }),
    index("erc20_transfers_block_idx").on(t.chainId, t.blockNumber),
  ],
);

export const uniswapV3Swaps = chain.table(
  "uniswap_v3_swaps",
  {
    chainId: integer("chain_id").notNull(),
    blockNumber: blockNumber("block_number").notNull(),
    blockHash: text("block_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    txHash: text("tx_hash").notNull(),
    pool: text("pool").notNull(),
    sender: text("sender").notNull(),
    recipient: text("recipient").notNull(),
    amount0: u256("amount0").notNull(),
    amount1: u256("amount1").notNull(),
    sqrtPriceX96: u256("sqrt_price_x96").notNull(),
    liquidity: u256("liquidity").notNull(),
    tick: integer("tick").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.chainId, t.blockHash, t.logIndex] }),
    index("uniswap_v3_swaps_block_idx").on(t.chainId, t.blockNumber),
  ],
);

/** One row per indexer process run. `rpc_calls` counts JSON-RPC calls by provider and method. */
export const runs = ops.table(
  "runs",
  {
    id: text("id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status").notNull(),
    failureReason: text("failure_reason"),
    firstBlock: blockNumber("first_block"),
    lastBlock: blockNumber("last_block"),
    rpcCalls: jsonb("rpc_calls").$type<Record<string, Record<string, number>>>().notNull().default({}),
  },
  (t) => [check("runs_status_check", sql`${t.status} in ('running', 'succeeded', 'failed')`)],
);

/**
 * Block ranges are the unit of commit. A range row is written in the same
 * transaction as its data, so the set of rows is also the resume checkpoint.
 * `payload_sha256` hashes the canonicalised headers + logs as fetched.
 * Status starts at `candidate`. A range is `published` only once every block in
 * it is finalized AND every data-quality gate passed (fail-closed publish);
 * a failing gate sets `failed` and enqueues one deterministic backfill job.
 */
export const ranges = ops.table(
  "ranges",
  {
    chainId: integer("chain_id").notNull(),
    fromBlock: blockNumber("from_block").notNull(),
    toBlock: blockNumber("to_block").notNull(),
    status: text("status").notNull().default("candidate"),
    blockCount: integer("block_count").notNull(),
    logCount: integer("log_count").notNull(),
    transferCount: integer("transfer_count").notNull(),
    swapCount: integer("swap_count").notNull(),
    rejectCount: integer("reject_count").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.chainId, t.fromBlock] }),
    check("ranges_bounds_check", sql`${t.toBlock} >= ${t.fromBlock}`),
    check("ranges_status_check", sql`${t.status} in ('candidate', 'published', 'failed')`),
  ],
);

/** A block identity as recorded in `ops.reorgs`. */
export interface ReorgBlockRef {
  number: number;
  hash: string;
}

/**
 * Audit trail of every detected reorg. `rolled_back`: stored blocks above
 * `ancestor_block` were orphaned and removed together with every range that
 * reached past it (re-ingest restarts at `rollback_from`). `halted`: no common
 * ancestor at or above the finalized block; nothing was deleted, the run failed.
 * `fork_block` is the first stored height whose hash differs from the canonical
 * chain; when halted it is the lowest stored height inspected (the true fork is
 * at or below it) and `depth` counts only the heights inspected.
 */
export const reorgs = ops.table(
  "reorgs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    chainId: integer("chain_id").notNull(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id),
    detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
    action: text("action").notNull(),
    ancestorBlock: blockNumber("ancestor_block"),
    forkBlock: blockNumber("fork_block").notNull(),
    depth: integer("depth").notNull(),
    rollbackFrom: blockNumber("rollback_from"),
    finalizedBlock: blockNumber("finalized_block").notNull(),
    orphaned: jsonb("orphaned").$type<ReorgBlockRef[]>().notNull(),
    canonical: jsonb("canonical").$type<ReorgBlockRef[]>().notNull(),
  },
  (t) => [
    index("reorgs_chain_detected_idx").on(t.chainId, t.detectedAt),
    check("reorgs_action_check", sql`${t.action} in ('rolled_back', 'halted')`),
    check(
      "reorgs_shape_check",
      sql`(${t.action} = 'rolled_back' and ${t.ancestorBlock} is not null and ${t.rollbackFrom} is not null) or (${t.action} = 'halted' and ${t.ancestorBlock} is null and ${t.rollbackFrom} is null)`,
    ),
  ],
);

/** Latest result of each data-quality gate for each range (one row per range and gate). */
export const qualityResults = ops.table(
  "quality_results",
  {
    chainId: integer("chain_id").notNull(),
    fromBlock: blockNumber("from_block").notNull(),
    gate: text("gate").notNull(),
    passed: boolean("passed").notNull(),
    rowsChecked: integer("rows_checked").notNull(),
    rowsFailed: integer("rows_failed").notNull(),
    detail: text("detail"),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.fromBlock, t.gate] })],
);

/**
 * Work queue for ranges that failed a gate. The id is derived from the range
 * (`<chain>:<from>-<to>`), so repeated failures update one job instead of
 * creating duplicates.
 */
export const backfillJobs = ops.table(
  "backfill_jobs",
  {
    id: text("id").primaryKey(),
    chainId: integer("chain_id").notNull(),
    fromBlock: blockNumber("from_block").notNull(),
    toBlock: blockNumber("to_block").notNull(),
    status: text("status").notNull(),
    failureReason: text("failure_reason").notNull(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  (t) => [
    unique("backfill_jobs_range_key").on(t.chainId, t.fromBlock, t.toBlock),
    index("backfill_jobs_open_idx").on(t.chainId, t.status, t.createdAt),
    check("backfill_jobs_status_check", sql`${t.status} in ('queued', 'running', 'resolved')`),
    check("backfill_jobs_attempts_check", sql`${t.attempts} >= 0`),
  ],
);

/** A height whose stored hash disagrees with the second source. */
export interface ReconciliationMismatch {
  number: number;
  stored: string;
  observed: string | null;
}

/**
 * Second-source checks of finalized ranges: block hashes and per-range log
 * counts re-read from a provider other than the one that served the range.
 * Every `mismatch` needs an `explanation` before the M3 gate can pass.
 */
export const reconciliations = ops.table(
  "reconciliations",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    chainId: integer("chain_id").notNull(),
    fromBlock: blockNumber("from_block").notNull(),
    toBlock: blockNumber("to_block").notNull(),
    provider: text("provider").notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
    status: text("status").notNull(),
    blocksChecked: integer("blocks_checked").notNull(),
    hashMismatches: jsonb("hash_mismatches").$type<ReconciliationMismatch[]>().notNull(),
    storedLogCount: integer("stored_log_count").notNull(),
    observedLogCount: integer("observed_log_count").notNull(),
    explanation: text("explanation"),
  },
  (t) => [
    index("reconciliations_range_idx").on(t.chainId, t.fromBlock),
    check("reconciliations_status_check", sql`${t.status} in ('match', 'mismatch')`),
  ],
);

/** Periodic head/finality/storage positions, for lag percentiles without an external metrics store. */
export const lagSamples = ops.table(
  "lag_samples",
  {
    chainId: integer("chain_id").notNull(),
    sampledAt: timestamp("sampled_at", { withTimezone: true }).notNull().defaultNow(),
    headBlock: blockNumber("head_block").notNull(),
    finalizedBlock: blockNumber("finalized_block").notNull(),
    storedTip: blockNumber("stored_tip"),
  },
  (t) => [primaryKey({ columns: [t.chainId, t.sampledAt] })],
);
