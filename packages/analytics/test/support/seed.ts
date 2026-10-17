import { createDb, type Database, type Sql } from "@rsi/db";
import { resetDatabase } from "../../../../apps/indexer/test/support/db.ts";

export const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/indexer_test_m4_analytics";
export const CHAIN_ID = 1;
export const TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const OTHER_TOKEN = "0xdac17f958d2ee523a2206206994597c13d831ec7";
/** The default pool in DEFAULT_METADATA: token0 USDC (6 decimals), token1 WETH (18). */
export const POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
export const UINT256_MAX = 2n ** 256n - 1n;
export const Q96 = 2n ** 96n;

/** Block 1000 is this instant; blocks are `SPACING_SECONDS` apart, so 48 blocks make one UTC day. */
export const GENESIS = Date.UTC(2024, 0, 1);
export const SPACING_SECONDS = 1800;

export type RangeStatus = "published" | "candidate" | "failed";
export type RangeSpec = readonly [from: number, to: number, status: RangeStatus];

export const blockHash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
export const address = (i: number) => `0x${i.toString(16).padStart(40, "0")}`;
export const blockTime = (n: number) => new Date(GENESIS + (n - 1000) * SPACING_SECONDS * 1000);

export interface TransferSeed {
  blockNumber: number;
  logIndex: number;
  token: string;
  from: string;
  to: string;
  value: bigint;
}

export interface SwapSeed {
  blockNumber: number;
  logIndex: number;
  pool: string;
  sender: string;
  recipient: string;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
}

/**
 * Deterministic rows for block `n`: 0-3 transfers (two tokens, a uint256-max value every 17th block) and
 * 0-2 swaps (alternating signs, negative ticks). Varied enough that a day's aggregates are not a coincidence.
 */
export function rowsForBlock(n: number): { transfers: TransferSeed[]; swaps: SwapSeed[] } {
  const transfers = Array.from({ length: n % 4 }, (_, k): TransferSeed => ({
    blockNumber: n,
    logIndex: k * 2,
    token: n % 5 === 0 ? OTHER_TOKEN : TOKEN,
    from: address(1 + ((n + k) % 6)),
    to: address(1 + ((n * 3 + k + 1) % 7)),
    value: n % 17 === 0 && k === 0 ? UINT256_MAX : BigInt(n) * 10n ** 15n + BigInt(k),
  }));
  const swaps = Array.from({ length: (n + 1) % 3 }, (_, k): SwapSeed => {
    const sign = (n + k) % 2 === 0 ? 1n : -1n;
    return {
      blockNumber: n,
      logIndex: 100 + k,
      pool: POOL,
      sender: address(1 + (n % 4)),
      recipient: address(1 + ((n + 2) % 5)),
      amount0: sign * BigInt(n) * 10n ** 6n,
      amount1: -sign * BigInt(n) * 10n ** 14n,
      sqrtPriceX96: BigInt(19_000 + ((n * 37) % 2_000)) * Q96 + BigInt(n),
      liquidity: 10n ** 18n + BigInt(n),
      tick: ((n * 13) % 400) - 200,
    };
  });
  return { transfers, swaps };
}

const txHash = (n: number, logIndex: number) => `0x${n.toString(16).padStart(60, "0")}${logIndex.toString(16).padStart(4, "0")}`;

export async function insertBlocks(sql: Sql, from: number, to: number): Promise<void> {
  const rows = Array.from({ length: to - from + 1 }, (_, i) => ({
    chain_id: CHAIN_ID,
    number: from + i,
    hash: blockHash(from + i),
    parent_hash: blockHash(from + i - 1),
    timestamp: blockTime(from + i).toISOString(),
  }));
  await sql`insert into chain.blocks ${sql(rows)}`;
}

export async function insertTransfers(sql: Sql, transfers: TransferSeed[]): Promise<void> {
  if (transfers.length === 0) return;
  const rows = transfers.map((t) => ({
    chain_id: CHAIN_ID,
    block_number: t.blockNumber,
    block_hash: blockHash(t.blockNumber),
    log_index: t.logIndex,
    tx_hash: txHash(t.blockNumber, t.logIndex),
    token: t.token,
    from_address: t.from,
    to_address: t.to,
    value: t.value.toString(),
  }));
  await sql`insert into chain.erc20_transfers ${sql(rows)}`;
}

export async function insertSwaps(sql: Sql, swaps: SwapSeed[]): Promise<void> {
  if (swaps.length === 0) return;
  const rows = swaps.map((s) => ({
    chain_id: CHAIN_ID,
    block_number: s.blockNumber,
    block_hash: blockHash(s.blockNumber),
    log_index: s.logIndex,
    tx_hash: txHash(s.blockNumber, s.logIndex),
    pool: s.pool,
    sender: s.sender,
    recipient: s.recipient,
    amount0: s.amount0.toString(),
    amount1: s.amount1.toString(),
    sqrt_price_x96: s.sqrtPriceX96.toString(),
    liquidity: s.liquidity.toString(),
    tick: s.tick,
  }));
  await sql`insert into chain.uniswap_v3_swaps ${sql(rows)}`;
}

/** Counts are taken from the rows just inserted so the range row tells the truth about its data. */
export async function insertRange(sql: Sql, [from, to, status]: RangeSpec): Promise<void> {
  await sql`
    insert into ops.ranges (chain_id, from_block, to_block, status, block_count, log_count, transfer_count, swap_count, reject_count, payload_sha256, run_id, published_at)
    select ${CHAIN_ID}, ${from}, ${to}, ${status}, ${to - from + 1}, t.n + s.n, t.n, s.n, 0, ${`seed-${from}`}, 'seed-run', ${status === "published" ? sql`now()` : null}
    from (select count(*)::int n from chain.erc20_transfers where chain_id = ${CHAIN_ID} and block_number between ${from} and ${to}) t,
         (select count(*)::int n from chain.uniswap_v3_swaps where chain_id = ${CHAIN_ID} and block_number between ${from} and ${to}) s`;
}

/** Blocks, rows and a range row for each spec, all with the same seed rows as `rowsForBlock`. */
export async function seedRanges(sql: Sql, ranges: readonly RangeSpec[]): Promise<void> {
  await sql`insert into ops.runs (id, chain_id, status) values ('seed-run', ${CHAIN_ID}, 'succeeded') on conflict do nothing`;
  for (const range of ranges) {
    const [from, to] = range;
    await insertBlocks(sql, from, to);
    const rows = Array.from({ length: to - from + 1 }, (_, i) => rowsForBlock(from + i));
    await insertTransfers(sql, rows.flatMap((r) => r.transfers));
    await insertSwaps(sql, rows.flatMap((r) => r.swaps));
    await insertRange(sql, range);
  }
}

export async function freshDatabase(): Promise<Database> {
  await resetDatabase(TEST_DATABASE_URL);
  return createDb(TEST_DATABASE_URL, { max: 4 });
}
