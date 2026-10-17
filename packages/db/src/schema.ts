import { sql } from "drizzle-orm";
import {
  bigint,
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
 * Status starts at `candidate`; data-quality gates promote ranges to
 * `published` (milestone M3).
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
  },
  (t) => [
    primaryKey({ columns: [t.chainId, t.fromBlock] }),
    check("ranges_bounds_check", sql`${t.toBlock} >= ${t.fromBlock}`),
    check("ranges_status_check", sql`${t.status} in ('candidate', 'published', 'failed')`),
  ],
);
