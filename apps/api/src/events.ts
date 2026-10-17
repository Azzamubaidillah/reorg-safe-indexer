import type { Database } from "@rsi/db";
import { iso } from "./sql.ts";
import type { Swap, SwapsQuery, Transfer, TransfersQuery } from "@rsi/contracts";
import { decodeCursor, encodeCursor, eventCursor, paginate } from "./http.ts";

// Event endpoints are fail-closed: a row is visible only when its block lies inside a `published`
// range. Both queries therefore carry two guards:
//  1. `block_number <= <highest published to_block>`: an uncorrelated bound that becomes an index
//     condition on (chain_id, block_number), so unpublished tip data is never even visited.
//  2. a per-row probe for "the range containing this block": ranges never overlap, so it is the one
//     with the greatest from_block <= block_number. That is a single backward step on the
//     (chain_id, from_block) primary key, not a scan of ops.ranges. Gaps and failed ranges fall out
//     here (no row, or status <> 'published', or the block lies past that range's to_block).
// Sorting by (block_number desc, log_index desc) is unique per chain because the canonical chain has
// one block hash per height; the same pair is the keyset cursor.

interface EventPosition {
  block_number: number;
  block_hash: string;
  timestamp: string;
  log_index: number;
  tx_hash: string;
}

const position = (r: EventPosition) => ({
  blockNumber: r.block_number,
  blockHash: r.block_hash,
  blockTimestamp: r.timestamp,
  logIndex: r.log_index,
  txHash: r.tx_hash,
});

const cursorOf = (last: { blockNumber: number; logIndex: number }) => encodeCursor({ b: last.blockNumber, l: last.logIndex });

interface TransferRow extends EventPosition {
  token: string;
  from_address: string;
  to_address: string;
  value: string;
}

export async function listTransfers(database: Database, chainId: number, query: TransfersQuery): Promise<{ items: Transfer[]; nextCursor: string | null }> {
  const { sql } = database;
  const cursor = decodeCursor(eventCursor, query.cursor);
  const rows = await sql<TransferRow[]>`
    select t.block_number::float8 as block_number, t.block_hash, ${iso(sql, "b.timestamp")} as timestamp, t.log_index, t.tx_hash,
           t.token, t.from_address, t.to_address, t.value::text as value
    from chain.erc20_transfers t
    join chain.blocks b on b.chain_id = t.chain_id and b.number = t.block_number
    where t.chain_id = ${chainId}
      and t.block_number <= (
        select to_block from ops.ranges
        where chain_id = ${chainId} and status = 'published' order by from_block desc limit 1)
      and (
        select r.status = 'published' and r.to_block >= t.block_number
        from ops.ranges r
        where r.chain_id = t.chain_id and r.from_block <= t.block_number
        order by r.from_block desc limit 1)
      ${query.token ? sql`and t.token = ${query.token}` : sql``}
      ${query.address ? sql`and (t.from_address = ${query.address} or t.to_address = ${query.address})` : sql``}
      ${query.fromBlock !== undefined ? sql`and t.block_number >= ${query.fromBlock}` : sql``}
      ${query.toBlock !== undefined ? sql`and t.block_number <= ${query.toBlock}` : sql``}
      ${cursor ? sql`and t.block_number <= ${cursor.b} and (t.block_number, t.log_index) < (${cursor.b}, ${cursor.l})` : sql``}
    order by t.block_number desc, t.log_index desc
    limit ${query.limit + 1}`;
  const items = rows.map((r) => ({ ...position(r), token: r.token, from: r.from_address, to: r.to_address, value: r.value }));
  return paginate(items, query.limit, cursorOf);
}

interface SwapRow extends EventPosition {
  pool: string;
  sender: string;
  recipient: string;
  amount0: string;
  amount1: string;
  sqrt_price_x96: string;
  liquidity: string;
  tick: number;
}

export async function listSwaps(database: Database, chainId: number, query: SwapsQuery): Promise<{ items: Swap[]; nextCursor: string | null }> {
  const { sql } = database;
  const cursor = decodeCursor(eventCursor, query.cursor);
  const rows = await sql<SwapRow[]>`
    select s.block_number::float8 as block_number, s.block_hash, ${iso(sql, "b.timestamp")} as timestamp, s.log_index, s.tx_hash,
           s.pool, s.sender, s.recipient, s.amount0::text as amount0, s.amount1::text as amount1,
           s.sqrt_price_x96::text as sqrt_price_x96, s.liquidity::text as liquidity, s.tick
    from chain.uniswap_v3_swaps s
    join chain.blocks b on b.chain_id = s.chain_id and b.number = s.block_number
    where s.chain_id = ${chainId}
      and s.block_number <= (
        select to_block from ops.ranges
        where chain_id = ${chainId} and status = 'published' order by from_block desc limit 1)
      and (
        select r.status = 'published' and r.to_block >= s.block_number
        from ops.ranges r
        where r.chain_id = s.chain_id and r.from_block <= s.block_number
        order by r.from_block desc limit 1)
      ${query.pool ? sql`and s.pool = ${query.pool}` : sql``}
      ${query.address ? sql`and (s.sender = ${query.address} or s.recipient = ${query.address})` : sql``}
      ${query.fromBlock !== undefined ? sql`and s.block_number >= ${query.fromBlock}` : sql``}
      ${query.toBlock !== undefined ? sql`and s.block_number <= ${query.toBlock}` : sql``}
      ${cursor ? sql`and s.block_number <= ${cursor.b} and (s.block_number, s.log_index) < (${cursor.b}, ${cursor.l})` : sql``}
    order by s.block_number desc, s.log_index desc
    limit ${query.limit + 1}`;
  const items = rows.map((r) => ({
    ...position(r),
    pool: r.pool,
    sender: r.sender,
    recipient: r.recipient,
    amount0: r.amount0,
    amount1: r.amount1,
    sqrtPriceX96: r.sqrt_price_x96,
    liquidity: r.liquidity,
    tick: r.tick,
  }));
  return paginate(items, query.limit, cursorOf);
}
