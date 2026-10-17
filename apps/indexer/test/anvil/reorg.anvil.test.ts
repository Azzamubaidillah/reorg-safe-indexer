import { createDb, type Database } from "@rsi/db";
import { decodeEventLog, parseAbi, toEventSelector } from "viem";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BlockHeader, Hex, RawLog } from "../../src/types.ts";
import { verifyIntegrity } from "../../src/verify.ts";
import { resetDatabase, TEST_DATABASE_URL } from "../support/db.ts";
import { exitWithin, waitFor, type IndexerProcess } from "../support/indexer-process.ts";
import { ANVIL_CHAIN_ID, AnvilNode, deployFixtures, type Fixtures, type Replacement } from "./support/anvil.ts";
import { killAnvilIndexers, spawnAnvilIndexer } from "./support/indexer.ts";

/** `finalized` trails `latest` by twice this many blocks, so the reorg window (finalized, latest] is 2 * SLOTS wide. */
const SLOTS = 10;
const WINDOW = 2 * SLOTS;
/** Not a divisor of the reorg depths, so rollbacks cut through the middle of committed ranges. */
const RANGE_SIZE = 7;
/** Event blocks mined after the two deployments. 46 puts events in the head block (not a multiple of 5). */
const SEED_BLOCKS = 46;
const WAIT_MS = 30_000;

const ALICE: Hex = "0x00000000000000000000000000000000000a11ce";
const BOB: Hex = "0x0000000000000000000000000000000000000b0b";

const eventsAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);
const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
const SWAP_TOPIC = toEventSelector("Swap(address,address,int256,int256,uint160,uint128,int24)");

let node: AnvilNode;
let fx: Fixtures;
let database: Database;
let indexer: IndexerProcess;

interface StoredReorg {
  action: string;
  depth: number;
  forkBlock: number;
  ancestorBlock: number | null;
  rollbackFrom: number | null;
  finalizedBlock: number;
  runId: string;
  orphaned: { number: number; hash: string }[];
  canonical: { number: number; hash: string }[];
}

/** What a reorg should have recorded, captured from anvil around the moment it is triggered. */
interface ExpectedReorg {
  depth: number;
  forkBlock: number;
  ancestorBlock: number;
  rollbackFrom: number;
  orphaned: BlockHeader[];
  canonical: BlockHeader[];
}

const tail = (text: string) => text.slice(-4000);
const waitUntil = <T>(description: string, probe: () => Promise<T | undefined | false>) =>
  waitFor(description, probe, () => `indexer output (tail):\n${tail(indexer.output())}`, WAIT_MS);

beforeEach(async () => {
  await resetDatabase();
  database = createDb(TEST_DATABASE_URL, { max: 2 });
  node = await AnvilNode.start({ slotsInAnEpoch: SLOTS });
  fx = await deployFixtures(node);
});

afterEach(async () => {
  killAnvilIndexers();
  await node.stop();
  await database.sql.end();
});

/** Blocks 3.. carry a Transfer, every 3rd also a Swap, every 5th nothing: events and empty blocks on both sides of any fork. */
async function seedChain(): Promise<void> {
  for (let i = 1; i <= SEED_BLOCKS; i++) {
    const txs = [];
    if (i % 5 !== 0) txs.push(fx.transfer(ALICE, BOB, BigInt(1000 + i)));
    if (i % 3 === 0) {
      txs.push(fx.swap({ sender: ALICE, recipient: BOB, amount0: BigInt(-i), amount1: BigInt(2 * i), sqrtPriceX96: 79228162514264337593543950336n, liquidity: 1_000_000n + BigInt(i), tick: -i }));
    }
    await node.mineBlock(txs);
  }
}

/**
 * Replacement txs that change the event set at every fork depth: new Transfers, new Swaps, both in one block,
 * and empty blocks where the original had events. `tag` keeps successive reorgs distinguishable.
 */
function replacementsFor(depth: number, tag: number): Replacement[] {
  const out: Replacement[] = [];
  for (let k = 0; k < depth; k++) {
    const transfer = { offset: k, tx: fx.transfer(BOB, ALICE, BigInt(9_000_000 + tag * 1000 + k)) };
    const swap = {
      offset: k,
      tx: fx.swap({ sender: BOB, recipient: ALICE, amount0: BigInt(7_000_000 + k), amount1: BigInt(-(tag * 1000 + k)), sqrtPriceX96: 1n + BigInt(k), liquidity: 5n, tick: 100 + k }),
    };
    if (k % 4 === 0) out.push(transfer);
    else if (k % 4 === 1) out.push(swap);
    else if (k % 4 === 3) out.push(transfer, swap);
  }
  return out;
}

async function committedThrough(): Promise<number> {
  const [row] = await database.sql<{ last: string | null }[]>`select max(to_block) as last from ops.ranges where chain_id = ${ANVIL_CHAIN_ID}`;
  return Number(row?.last ?? -1);
}

/** The indexer has committed everything up to `head` and stored exactly head's hash. */
async function waitSynced(head: BlockHeader): Promise<void> {
  await waitUntil(`indexer to commit block ${head.number} (${head.hash})`, async () => {
    if ((await committedThrough()) !== head.number) return undefined;
    const [row] = await database.sql<{ hash: string }[]>`select hash from chain.blocks where chain_id = ${ANVIL_CHAIN_ID} and number = ${head.number}`;
    return row?.hash === head.hash ? true : undefined;
  });
}

async function startIndexerSynced(): Promise<BlockHeader> {
  await seedChain();
  indexer = spawnAnvilIndexer({ rpcUrl: node.url, fixtures: fx, rangeSize: RANGE_SIZE });
  const head = await node.header("latest");
  await waitSynced(head);
  return head;
}

/**
 * Reorgs `depth` blocks, mines `blocksOnTop` blocks on top (the reorg is invisible by height alone), and records what the
 * indexer must have seen. The fork is judged against `finalized` as of detection, which is head + blocksOnTop - WINDOW only
 * if the indexer cannot detect before the last block exists: tests that sit on that boundary mine exactly one block.
 */
async function triggerReorg(depth: number, tag: number, blocksOnTop = 2): Promise<ExpectedReorg> {
  const head = await node.header("latest");
  const ancestor = head.number - depth;
  const orphaned = await node.headers(ancestor + 1, head.number);
  const [firstDeleted] = await database.sql<{ from_block: string }[]>`
    select from_block from ops.ranges where chain_id = ${ANVIL_CHAIN_ID} and to_block > ${ancestor} order by from_block limit 1`;
  expect(firstDeleted, "a committed range must cover the fork").toBeDefined();

  await node.reorg(depth, replacementsFor(depth, tag));
  const canonical = await node.headers(ancestor + 1, head.number);
  for (const [i, block] of canonical.entries()) expect(block.hash, `anvil kept block ${block.number}`).not.toBe(orphaned[i]?.hash);

  await node.mineBlock([fx.transfer(ALICE, BOB, BigInt(5_000_000 + tag))]);
  if (blocksOnTop > 1) await node.mineBlock([fx.swap({ sender: ALICE, recipient: ALICE, amount0: 1n, amount1: -1n, sqrtPriceX96: 2n, liquidity: 3n, tick: 0 })]);
  return { depth, forkBlock: ancestor + 1, ancestorBlock: ancestor, rollbackFrom: Number(firstDeleted?.from_block), orphaned, canonical };
}

async function storedReorgs(): Promise<StoredReorg[]> {
  const rows = await database.sql<
    { action: string; depth: number; fork_block: string; ancestor_block: string | null; rollback_from: string | null; finalized_block: string; run_id: string; orphaned: StoredReorg["orphaned"]; canonical: StoredReorg["canonical"] }[]
  >`select action, depth, fork_block, ancestor_block, rollback_from, finalized_block, run_id, orphaned, canonical from ops.reorgs where chain_id = ${ANVIL_CHAIN_ID} order by id`;
  return rows.map((r) => ({
    action: r.action,
    depth: r.depth,
    forkBlock: Number(r.fork_block),
    ancestorBlock: r.ancestor_block === null ? null : Number(r.ancestor_block),
    rollbackFrom: r.rollback_from === null ? null : Number(r.rollback_from),
    finalizedBlock: Number(r.finalized_block),
    runId: r.run_id,
    orphaned: r.orphaned,
    canonical: r.canonical,
  }));
}

const byNumber = <T extends { number: number }>(rows: T[]) => [...rows].sort((a, b) => a.number - b.number);
const pick = (blocks: { number: number; hash: string }[]) => byNumber(blocks).map((b) => ({ number: b.number, hash: b.hash }));

function expectReorgRow(row: StoredReorg | undefined, expected: ExpectedReorg): void {
  expect(row).toBeDefined();
  if (!row) return;
  expect(row).toMatchObject({
    action: "rolled_back",
    depth: expected.depth,
    forkBlock: expected.forkBlock,
    ancestorBlock: expected.ancestorBlock,
    rollbackFrom: expected.rollbackFrom,
  });
  // The fork must have been inside the protocol's window, or the indexer should have halted instead.
  expect(row.finalizedBlock).toBeLessThanOrEqual(expected.ancestorBlock);
  expect(pick(row.orphaned)).toEqual(pick(expected.orphaned));
  expect(pick(row.canonical)).toEqual(pick(expected.canonical));
}

/** Every stored table equals what anvil's canonical chain returns now, using viem (not the indexer's decoder) for event values. */
async function expectDatabaseMatchesAnvil(head: BlockHeader): Promise<void> {
  const start = fx.startBlock;
  const canonicalBlocks = await node.headers(start, head.number);
  const canonicalLogs = await node.logs(start, head.number, [fx.token, fx.pool], [TRANSFER_TOPIC, SWAP_TOPIC]);

  const blocks = await database.sql<{ number: string; hash: string; parent_hash: string; ts: string }[]>`
    select number, hash, parent_hash, extract(epoch from timestamp)::text as ts from chain.blocks where chain_id = ${ANVIL_CHAIN_ID} order by number`;
  expect(blocks.map((b) => ({ number: Number(b.number), hash: b.hash, parentHash: b.parent_hash, timestamp: Number(b.ts) }))).toEqual(canonicalBlocks);

  const logs = await database.sql<{ block_number: string; block_hash: string; log_index: number; tx_hash: string; tx_index: number; address: string; topics: string[]; data: string }[]>`
    select block_number, block_hash, log_index, tx_hash, tx_index, address, topics, data from chain.logs where chain_id = ${ANVIL_CHAIN_ID} order by block_number, log_index`;
  const storedLogs: RawLog[] = logs.map((r) => ({
    blockNumber: Number(r.block_number),
    blockHash: r.block_hash as Hex,
    logIndex: r.log_index,
    txHash: r.tx_hash as Hex,
    txIndex: r.tx_index,
    address: r.address as Hex,
    topics: r.topics as Hex[],
    data: r.data as Hex,
  }));
  expect(storedLogs).toEqual(canonicalLogs);

  const expectedTransfers: unknown[] = [];
  const expectedSwaps: unknown[] = [];
  for (const log of canonicalLogs) {
    const position = { blockNumber: log.blockNumber, blockHash: log.blockHash, logIndex: log.logIndex, txHash: log.txHash };
    const event = decodeEventLog({ abi: eventsAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data });
    if (event.eventName === "Transfer") {
      expectedTransfers.push({ ...position, token: log.address, from: event.args.from.toLowerCase(), to: event.args.to.toLowerCase(), value: event.args.value.toString() });
    } else {
      const a = event.args;
      expectedSwaps.push({
        ...position,
        pool: log.address,
        sender: a.sender.toLowerCase(),
        recipient: a.recipient.toLowerCase(),
        amount0: a.amount0.toString(),
        amount1: a.amount1.toString(),
        sqrtPriceX96: a.sqrtPriceX96.toString(),
        liquidity: a.liquidity.toString(),
        tick: a.tick,
      });
    }
  }
  expect(expectedTransfers.length, "chain must contain transfers").toBeGreaterThan(0);
  expect(expectedSwaps.length, "chain must contain swaps").toBeGreaterThan(0);

  const transfers = await database.sql<{ block_number: string; block_hash: string; log_index: number; tx_hash: string; token: string; from_address: string; to_address: string; value: string }[]>`
    select block_number, block_hash, log_index, tx_hash, token, from_address, to_address, value::text as value
    from chain.erc20_transfers where chain_id = ${ANVIL_CHAIN_ID} order by block_number, log_index`;
  expect(
    transfers.map((r) => ({ blockNumber: Number(r.block_number), blockHash: r.block_hash, logIndex: r.log_index, txHash: r.tx_hash, token: r.token, from: r.from_address, to: r.to_address, value: r.value })),
  ).toEqual(expectedTransfers);

  const swaps = await database.sql<{ block_number: string; block_hash: string; log_index: number; tx_hash: string; pool: string; sender: string; recipient: string; amount0: string; amount1: string; sqrt_price_x96: string; liquidity: string; tick: number }[]>`
    select block_number, block_hash, log_index, tx_hash, pool, sender, recipient, amount0::text as amount0, amount1::text as amount1,
           sqrt_price_x96::text as sqrt_price_x96, liquidity::text as liquidity, tick
    from chain.uniswap_v3_swaps where chain_id = ${ANVIL_CHAIN_ID} order by block_number, log_index`;
  expect(
    swaps.map((r) => ({
      blockNumber: Number(r.block_number),
      blockHash: r.block_hash,
      logIndex: r.log_index,
      txHash: r.tx_hash,
      pool: r.pool,
      sender: r.sender,
      recipient: r.recipient,
      amount0: r.amount0,
      amount1: r.amount1,
      sqrtPriceX96: r.sqrt_price_x96,
      liquidity: r.liquidity,
      tick: r.tick,
    })),
  ).toEqual(expectedSwaps);

  const report = await verifyIntegrity(database, ANVIL_CHAIN_ID);
  expect(report.problems).toEqual([]);
  expect(report.ok).toBe(true);
  expect(report.lastBlock).toBe(head.number);
}

async function expectNoRowsForHashes(hashes: string[]): Promise<void> {
  const tables = ["chain.blocks", "chain.logs", "chain.erc20_transfers", "chain.uniswap_v3_swaps"];
  for (const table of tables) {
    const column = table === "chain.blocks" ? "hash" : "block_hash";
    const [row] = await database.sql<{ n: number }[]>`select count(*)::int as n from ${database.sql(table)} where ${database.sql(column)} in ${database.sql(hashes)}`;
    expect(row?.n, `${table} still holds rows of orphaned blocks`).toBe(0);
  }
}

describe("reorgs against a real anvil node", () => {
  // Depth 19 with one block on top puts the common ancestor exactly on the finalized block, which is still repairable.
  it.each([
    [1, 2],
    [3, 2],
    [12, 2],
    [WINDOW - 1, 1],
  ])("rolls back a depth-%i reorg with %i new block(s) on top and converges to anvil's canonical chain", async (depth, blocksOnTop) => {
    const head = await startIndexerSynced();
    const logsBefore = await node.logs(fx.startBlock, head.number, [fx.token, fx.pool], [TRANSFER_TOPIC, SWAP_TOPIC]);
    const expected = await triggerReorg(depth, 1, blocksOnTop);
    expect(logsBefore.filter((l) => l.blockNumber > expected.ancestorBlock).length, "the orphaned blocks must have carried events").toBeGreaterThan(0);

    const newHead = await node.header("latest");
    expect(newHead.number).toBe(head.number + blocksOnTop);
    await waitSynced(newHead);

    expect(indexer.child.exitCode, "indexer must keep running after a rollback").toBeNull();
    expectReorgRow((await storedReorgs())[0], expected);
    expect(await storedReorgs()).toHaveLength(1);
    expect(indexer.logs().find((l) => l.msg === "reorg")).toMatchObject({
      action: "rolled_back",
      depth,
      forkBlock: expected.forkBlock,
      ancestorBlock: expected.ancestorBlock,
      rollbackFrom: expected.rollbackFrom,
    });
    await expectNoRowsForHashes(expected.orphaned.map((b) => b.hash));
    await expectDatabaseMatchesAnvil(newHead);

    const [run] = await database.sql<{ status: string }[]>`select status from ops.runs`;
    expect(run?.status).toBe("running");
    indexer.child.kill("SIGTERM");
    expect((await exitWithin(indexer, 15_000)).code, indexer.output()).toBe(0);
  });

  it("handles two successive reorgs, the second cutting into the first one's replacement blocks", async () => {
    const head = await startIndexerSynced();
    const first = await triggerReorg(3, 1);
    const afterFirst = await node.header("latest");
    expect(afterFirst.number).toBe(head.number + 2);
    await waitSynced(afterFirst);

    // Depth 5 reaches back over the two blocks mined on top plus all three replacement blocks.
    const second = await triggerReorg(5, 2);
    expect(second.orphaned.map((b) => b.hash)).toEqual(expect.arrayContaining(first.canonical.map((b) => b.hash)));
    const afterSecond = await node.header("latest");
    await waitSynced(afterSecond);

    const rows = await storedReorgs();
    expect(rows).toHaveLength(2);
    expectReorgRow(rows[0], first);
    expectReorgRow(rows[1], second);
    await expectNoRowsForHashes([...first.orphaned, ...second.orphaned].map((b) => b.hash));
    await expectDatabaseMatchesAnvil(afterSecond);
  });

  // Depth WINDOW with one block on top puts the ancestor one block below finalized: the smallest unrepairable fork.
  it.each([WINDOW, WINDOW + 10])("halts with exit code 2 on a depth-%i reorg, which reaches below the finalized block", async (depth) => {
    const head = await startIndexerSynced();
    const ancestor = head.number - depth;
    expect((await node.header("finalized")).number).toBe(head.number - WINDOW);

    await node.reorg(depth, replacementsFor(depth, 1));
    await node.mineBlock([fx.transfer(ALICE, BOB, 1n)]);

    const exit = await exitWithin(indexer, WAIT_MS);
    expect(exit.code, tail(indexer.output())).toBe(2);

    const rows = await storedReorgs();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.action).toBe("halted");
    expect(row.rollbackFrom).toBeNull();
    // Finality as of detection: the new head is one block past the old one.
    expect(row.finalizedBlock).toBe(head.number + 1 - WINDOW);
    expect(row.ancestorBlock === null || row.ancestorBlock === ancestor, `ancestor ${row.ancestorBlock}`).toBe(true);
    // The indexer may stop walking back at the finalized block, so the fork it reports is somewhere in [true fork, finalized + 1].
    expect(row.forkBlock).toBeGreaterThanOrEqual(ancestor + 1);
    expect(row.forkBlock).toBeLessThanOrEqual(row.finalizedBlock + 1);

    const [run] = await database.sql<{ status: string; failure_reason: string | null; id: string }[]>`select id, status, failure_reason from ops.runs`;
    expect(run?.status).toBe("failed");
    expect(run?.failure_reason?.startsWith("reorg below finalized"), `failure_reason: ${run?.failure_reason}`).toBe(true);
    expect(row.runId).toBe(run?.id);

    const lines = indexer.logs();
    expect(lines.find((l) => l.msg === "reorg")).toMatchObject({ action: "halted" });
    expect(lines.some((l) => l.level === 60), "a fatal-level log line").toBe(true);
  });
});
