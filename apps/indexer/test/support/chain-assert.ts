import { erc20Transfers, uniswapV3Swaps, type Database } from "@rsi/db";
import { expect } from "vitest";
import type { RawLog } from "../../src/types.ts";
import type { SyntheticChain } from "./synthetic-chain.ts";

const byPosition = (a: { blockNumber: number; logIndex: number }, b: { blockNumber: number; logIndex: number }) =>
  a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;

/** Every stored block, log and decoded row equals `chain` over [from, to], with nothing missing and nothing extra. */
export async function expectStoredChain(database: Database, chain: SyntheticChain, from: number, to: number): Promise<void> {
  const expected = chain.fetched(from, to);

  const blocks = await database.sql<{ number: string; hash: string; parent_hash: string; ts: number }[]>`
    select number, hash, parent_hash, extract(epoch from timestamp)::int as ts from chain.blocks order by number`;
  expect(blocks.map((b) => ({ number: Number(b.number), hash: b.hash, parentHash: b.parent_hash, timestamp: b.ts }))).toEqual(expected.blocks);

  const logs = await database.sql<{ block_number: string; block_hash: string; log_index: number; tx_hash: string; tx_index: number; address: string; topics: string[]; data: string }[]>`
    select block_number, block_hash, log_index, tx_hash, tx_index, address, topics, data from chain.logs order by block_number, log_index`;
  const storedLogs: RawLog[] = logs.map((r) => ({
    blockNumber: Number(r.block_number),
    blockHash: r.block_hash as RawLog["blockHash"],
    logIndex: r.log_index,
    txHash: r.tx_hash as RawLog["txHash"],
    txIndex: r.tx_index,
    address: r.address as RawLog["address"],
    topics: r.topics as RawLog["topics"],
    data: r.data as RawLog["data"],
  }));
  expect(storedLogs).toEqual(expected.logs);

  const decoded = chain.decoded(from, to);
  const transfers = (await database.db.select().from(erc20Transfers)).sort(byPosition);
  expect(transfers.map(({ chainId, fromAddress, toAddress, ...t }) => ({ ...t, from: fromAddress, to: toAddress }))).toEqual(decoded.transfers);
  const swaps = (await database.db.select().from(uniswapV3Swaps)).sort(byPosition);
  expect(swaps.map(({ chainId, ...s }) => s)).toEqual(decoded.swaps);
}
