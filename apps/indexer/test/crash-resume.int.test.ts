import { createDb, type Database } from "@rsi/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RawLog } from "../src/types.ts";
import { verifyIntegrity } from "../src/verify.ts";
import { resetDatabase, TEST_DATABASE_URL } from "./support/db.ts";
import { exitWithin, killAllIndexers, spawnIndexer, waitFor } from "./support/indexer-process.ts";
import { startMockRpc, type MockRpc } from "./support/mock-rpc.ts";
import { SyntheticChain } from "./support/synthetic-chain.ts";

const CHAIN_ID = 1;
const START = 1000;
const END = 1299;
const RANGE_SIZE = 10;
const TOTAL_RANGES = (END - START + 1) / RANGE_SIZE;

const chain = new SyntheticChain();
let rpc: MockRpc;
let database: Database;

const indexerConfig = () => ({ rpcUrl: rpc.url, maxSpan: RANGE_SIZE, startBlock: START, endBlock: END, rangeSize: RANGE_SIZE });

async function committedRanges(): Promise<number> {
  const [row] = await database.sql<{ n: number }[]>`select count(*)::int as n from ops.ranges`;
  return row?.n ?? 0;
}

/** Postgres releases the dead process's advisory lock when it notices the closed socket; wait for that. */
async function waitForLockRelease(): Promise<void> {
  await waitFor("advisory lock release", async () => {
    const [row] = await database.sql<{ n: number }[]>`
      select count(*)::int as n from pg_locks
      where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())`;
    return row?.n === 0 ? true : undefined;
  });
}

beforeEach(async () => {
  await resetDatabase();
  database = createDb(TEST_DATABASE_URL, { max: 2 });
  // Latency makes each range take long enough to kill the process while fetches are in flight.
  rpc = await startMockRpc({ chain, head: 10_000, maxSpan: RANGE_SIZE, latencyMs: 100 });
});

afterEach(async () => {
  killAllIndexers();
  await rpc.close();
  await database.sql.end();
});

describe("crash and resume", () => {
  it("resumes after SIGKILL mid-run with no gaps, no duplicates, and exactly the expected rows", async () => {
    const first = spawnIndexer(indexerConfig());
    await waitFor("some ranges committed", async () => ((await committedRanges()) >= 5 ? true : undefined), first.output);
    first.child.kill("SIGKILL");
    expect((await exitWithin(first, 10_000)).signal).toBe("SIGKILL");

    const committedBefore = await committedRanges();
    expect(committedBefore).toBeGreaterThanOrEqual(5);
    expect(committedBefore).toBeLessThan(TOTAL_RANGES);
    const [killedRun] = await database.sql<{ status: string }[]>`select status from ops.runs`;
    expect(killedRun?.status).toBe("running");
    // Whatever the kill interrupted must have been rolled back as a whole range.
    const partial = await verifyIntegrity(database, CHAIN_ID);
    expect(partial.problems).toEqual([]);
    expect(partial.lastBlock).toBe(START + committedBefore * RANGE_SIZE - 1);

    await waitForLockRelease();
    const second = spawnIndexer(indexerConfig());
    const exit = await exitWithin(second, 120_000);
    expect(exit.code, second.output()).toBe(0);

    const firstCommit = second.logs().find((l) => l.msg === "range committed");
    expect(firstCommit).toMatchObject({ from: START + committedBefore * RANGE_SIZE });

    const runs = await database.sql<{ status: string; failure_reason: string | null; last_block: string }[]>`
      select status, failure_reason, last_block from ops.runs order by started_at`;
    expect(runs.map((r) => [r.status, r.failure_reason])).toEqual([
      ["failed", "abandoned"],
      ["succeeded", null],
    ]);
    expect(Number(runs[1]?.last_block)).toBe(END);

    const report = await verifyIntegrity(database, CHAIN_ID);
    const expected = chain.totals(START, END);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.counts).toEqual({ ranges: TOTAL_RANGES, blocks: expected.blocks, logs: expected.logs, transfers: expected.transfers, swaps: expected.swaps, rejects: 0 });

    // Counts matching could still hide wrong content: compare every stored log with the chain's.
    const stored = await database.sql<{ block_number: string; block_hash: string; log_index: number; tx_hash: string; tx_index: number; address: string; topics: string[]; data: string }[]>`
      select block_number, block_hash, log_index, tx_hash, tx_index, address, topics, data
      from chain.logs order by block_number, log_index`;
    const storedLogs: RawLog[] = stored.map((r) => ({
      blockNumber: Number(r.block_number),
      blockHash: r.block_hash as RawLog["blockHash"],
      logIndex: r.log_index,
      txHash: r.tx_hash as RawLog["txHash"],
      txIndex: r.tx_index,
      address: r.address as RawLog["address"],
      topics: r.topics as RawLog["topics"],
      data: r.data as RawLog["data"],
    }));
    expect(storedLogs).toEqual(chain.fetched(START, END).logs);
  });

  it("refuses a second concurrent run, leaves the first untouched, and stops the first cleanly on SIGTERM", async () => {
    const first = spawnIndexer(indexerConfig());
    await waitFor("first range committed", async () => ((await committedRanges()) >= 1 ? true : undefined), first.output);

    const second = spawnIndexer(indexerConfig());
    const exit = await exitWithin(second, 30_000);
    expect(exit.code, second.output()).not.toBe(0);

    const runs = await database.sql<{ status: string }[]>`select status from ops.runs`;
    expect(runs).toEqual([{ status: "running" }]);

    first.child.kill("SIGTERM");
    expect((await exitWithin(first, 30_000)).code, first.output()).toBe(0);

    const [run] = await database.sql<{ status: string; failure_reason: string | null }[]>`select status, failure_reason from ops.runs`;
    expect(run).toEqual({ status: "failed", failure_reason: "interrupted" });
    expect((await verifyIntegrity(database, CHAIN_ID)).ok).toBe(true);
  });
});
