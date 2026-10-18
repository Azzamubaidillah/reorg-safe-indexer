import { createDb, ranges, reconciliations, type Database } from "@rsi/db";
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EtherscanSource } from "../src/etherscan.ts";
import { payloadSha256 } from "../src/payload.ts";
import { reconcileRanges, type ReconcileSummary } from "../src/reconcile.ts";
import { commitRange, startRun } from "../src/store.ts";
import type { RawLog, TrackedContracts } from "../src/types.ts";
import { resetDatabase, TEST_DATABASE_URL } from "./support/db.ts";
import { SyntheticChain, TEST_POOL, TEST_TOKEN } from "./support/synthetic-chain.ts";

const CHAIN_ID = 1;
const RUN_ID = "run-1";
const START = 1000;
const SIZE = 10;
const LAST = 1099; // 10 committed ranges
const FINALIZED = 1079; // the top two ranges are not finalized
const contracts: TrackedContracts = { tokens: [TEST_TOKEN], pools: [TEST_POOL] };
const chain = new SyntheticChain();
let database: Database;

/** Etherscan answering from the synthetic chain in its own wire format ("0x" for zero, explorer envelopes). */
function fakeEtherscan(edit: (logs: RawLog[]) => RawLog[] = (l) => l, outage = false): typeof fetch {
  const hex = (n: number) => (n === 0 ? "0x" : `0x${n.toString(16)}`);
  return (async (input: string | URL | Request) => {
    if (outage) return Response.json({ status: "0", message: "NOTOK", result: "Max calls per sec rate limit reached (3/sec)" });
    const p = new URL(String(input)).searchParams;
    if (p.get("module") === "proxy") {
      const number = Number(p.get("tag"));
      const [block] = chain.fetched(number, number).blocks;
      return Response.json({ jsonrpc: "2.0", id: 1, result: { number: p.get("tag"), hash: block!.hash } });
    }
    const from = Number(p.get("fromBlock"));
    const to = Number(p.get("toBlock"));
    const found = edit(chain.fetched(from, to).logs).filter((l) => l.address === p.get("address") && l.topics[0] === p.get("topic0"));
    if (found.length === 0) return Response.json({ status: "0", message: "No records found", result: [] });
    return Response.json({
      status: "1",
      message: "OK",
      result: found.map((l) => ({ blockNumber: hex(l.blockNumber), blockHash: l.blockHash, logIndex: hex(l.logIndex), transactionHash: l.txHash, address: l.address, topics: l.topics, data: l.data })),
    });
  }) as typeof fetch;
}

const etherscan = (fetchFn: typeof fetch) => new EtherscanSource({ apiKey: "k", chainId: CHAIN_ID, rps: 1_000 }, fetchFn);
const sample = (fetchFn: typeof fetch, limit = 3): Promise<ReconcileSummary> =>
  reconcileRanges(database, etherscan(fetchFn), { chainId: CHAIN_ID, finalizedBlock: FINALIZED, limit, contracts, order: "random" });
const etherscanRows = () => database.db.select().from(reconciliations).where(eq(reconciliations.provider, "etherscan"));

beforeEach(async () => {
  await resetDatabase();
  database = createDb(TEST_DATABASE_URL, { max: 2 });
  await startRun(database, RUN_ID, CHAIN_ID);
  for (let from = START; from <= LAST; from += SIZE) {
    const range = chain.fetched(from, from + SIZE - 1);
    await commitRange(database, { chainId: CHAIN_ID, runId: RUN_ID, range, decoded: chain.decoded(from, from + SIZE - 1), payloadSha256: payloadSha256(range), rpcCalls: {} });
  }
});

afterEach(async () => {
  await database.sql.end();
});

describe("Etherscan spot checks (random sample of finalized ranges)", () => {
  it("checks a sample, never repeats a range until all are checked, and never touches ranges above finalized", async () => {
    // 8 finalized ranges, 3 per cycle: each cycle checks only ranges not yet checked, so 3 + 3 + 2.
    const perCycle: number[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      const summary = await sample(fakeEtherscan());
      expect(summary).toMatchObject({ matches: summary.rangesChecked, mismatchIds: [], providerErrors: 0 });
      perCycle.push(summary.rangesChecked);
    }
    expect(perCycle).toEqual([3, 3, 2]);
    const rows = await etherscanRows();
    expect(rows.map((r) => r.fromBlock).sort((a, b) => a - b)).toEqual([1000, 1010, 1020, 1030, 1040, 1050, 1060, 1070]);
    expect(rows.every((r) => r.status === "match" && r.toBlock <= FINALIZED)).toBe(true);
    expect(await sample(fakeEtherscan())).toMatchObject({ rangesChecked: 0 });
  });

  it("costs one header and one getLogs per tracked contract per range", async () => {
    const summary = await sample(fakeEtherscan(), 2);
    expect(summary.rpcCalls).toEqual({ "proxy.eth_getBlockByNumber": 2, "logs.getLogs": 4 });
  });

  it("records a mismatch when Etherscan is missing a log the store has", async () => {
    const dropped = chain.fetched(START, START + SIZE - 1).logs[0]!;
    const fetchFn = fakeEtherscan((logs) => logs.filter((l) => !(l.blockHash === dropped.blockHash && l.logIndex === dropped.logIndex)));
    await sample(fetchFn, 8);
    const [row] = (await etherscanRows()).filter((r) => r.fromBlock === START);
    expect(row).toMatchObject({ status: "mismatch", storedLogCount: row!.observedLogCount + 1 });
    expect((await etherscanRows()).filter((r) => r.status === "mismatch")).toHaveLength(1);
  });

  it("writes nothing when Etherscan cannot answer, so the ranges stay due", async () => {
    const summary = await sample(fakeEtherscan(undefined, true));
    expect(summary).toMatchObject({ rangesChecked: 0, providerErrors: 3 });
    expect(summary.failures[0]?.message).toMatch(/rate limit reached/);
    expect(await etherscanRows()).toEqual([]);
  });

  it("skips ranges whose landing logs were purged: there is nothing left to compare", async () => {
    await database.db
      .update(ranges)
      .set({ status: "published", publishedAt: new Date(), landingPurgedAt: new Date() })
      .where(and(eq(ranges.chainId, CHAIN_ID), eq(ranges.fromBlock, START)));
    await database.sql`delete from chain.logs where block_number between ${START} and ${START + SIZE - 1}`;
    await sample(fakeEtherscan(), 8);
    expect((await etherscanRows()).map((r) => r.fromBlock)).not.toContain(START);
    expect(await etherscanRows()).toHaveLength(7);
  });
});
