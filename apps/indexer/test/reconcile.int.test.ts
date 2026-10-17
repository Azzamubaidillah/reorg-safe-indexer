import { createDb, ranges, reconciliations, type Database } from "@rsi/db";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadSha256 } from "../src/payload.ts";
import { explainReconciliation, reconcileRanges, type ReconcileSummary } from "../src/reconcile.ts";
import { Provider } from "../src/rpc/provider.ts";
import { commitRange, startRun } from "../src/store.ts";
import type { TrackedContracts } from "../src/types.ts";
import { resetDatabase, tableFingerprints, TEST_DATABASE_URL } from "./support/db.ts";
import { startMockRpc, type MockRpc } from "./support/mock-rpc.ts";
import { SyntheticChain, TEST_POOL, TEST_TOKEN } from "./support/synthetic-chain.ts";

const CHAIN_ID = 1;
const RUN_ID = "run-1";
const START = 1000;
const SIZE = 10;
const LAST = 1049;
const contracts: TrackedContracts = { tokens: [TEST_TOKEN], pools: [TEST_POOL] };

const original = new SyntheticChain();
let database: Database;
let rpc: MockRpc;

interface WireResult {
  [key: string]: unknown;
}
type Tamper = (method: string, params: unknown[], result: unknown) => unknown;

/** A second source that is the mock RPC with its answers rewritten, or failing (throw). */
function provider(name = "second", tamper?: Tamper): Provider {
  const fetchFn: typeof fetch = async (url, init) => {
    const response = await fetch(url, init);
    if (!tamper) return response;
    const request = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
    const body = (await response.json()) as { result?: unknown };
    return Response.json({ ...body, result: tamper(request.method, request.params, body.result) });
  };
  return new Provider({ name, url: rpc.url, maxSpan: SIZE, rps: 10_000, batchSize: 1 }, fetchFn);
}

const heightOf = (tag: unknown) => Number.parseInt(String(tag), 16);
const reconcile = (p: Provider, finalizedBlock = LAST, limit = 100): Promise<ReconcileSummary> =>
  reconcileRanges(database, p, { chainId: CHAIN_ID, finalizedBlock, limit, contracts });
const rows = () => database.db.select().from(reconciliations).orderBy(reconciliations.fromBlock);

/** Logs of the mock's answer with one rewritten or removed; everything else passes through. */
function logTamper(edit: (log: WireResult) => WireResult | undefined): Tamper {
  return (method, _params, result) => (method === "eth_getLogs" ? (result as WireResult[]).flatMap((l) => edit(l) ?? []) : result);
}

beforeEach(async () => {
  await resetDatabase();
  database = createDb(TEST_DATABASE_URL, { max: 2 });
  await startRun(database, RUN_ID, CHAIN_ID);
  for (let from = START; from <= LAST; from += SIZE) {
    const range = original.fetched(from, from + SIZE - 1);
    await commitRange(database, {
      chainId: CHAIN_ID,
      runId: RUN_ID,
      range,
      decoded: original.decoded(from, from + SIZE - 1),
      payloadSha256: payloadSha256(range),
      rpcCalls: {},
    });
  }
  rpc = await startMockRpc({ chain: original, head: LAST + 20, finalized: LAST, maxSpan: SIZE });
});

afterEach(async () => {
  await rpc.close();
  await database.sql.end();
});

describe("reconcileRanges", () => {
  it("records a match row per range when the second source agrees, and costs one header plus one getLogs per range", async () => {
    const summary = await reconcile(provider());
    expect(summary).toEqual({
      rangesChecked: 5,
      matches: 5,
      mismatchIds: [],
      providerErrors: 0,
      failures: [],
      rpcCalls: { eth_getBlockByNumber: 5, eth_getLogs: 5 },
    });
    const stored = await rows();
    expect(stored.map((r) => [r.fromBlock, r.toBlock, r.status, r.provider, r.explanation])).toEqual(
      [1000, 1010, 1020, 1030, 1040].map((from) => [from, from + 9, "match", "second", null]),
    );
    for (const r of stored) {
      const totals = original.totals(r.fromBlock, r.toBlock);
      expect(r).toMatchObject({ chainId: CHAIN_ID, hashMismatches: [], storedLogCount: totals.logs, observedLogCount: totals.logs });
      expect(r.blocksChecked).toBeGreaterThanOrEqual(1);
    }
    // 1000-1009: heights with tracked logs, plus the last block if it has none.
    const heights = new Set([1009]);
    for (let n = 1000; n <= 1009; n++) if (original.entries(n).length > 0) heights.add(n);
    expect(stored[0]?.blocksChecked).toBe(heights.size);
  });

  it("splits a range wider than the second source's maxSpan into more getLogs calls", async () => {
    const narrow = new Provider({ name: "narrow", url: rpc.url, maxSpan: 4, rps: 10_000, batchSize: 1 });
    const summary = await reconcile(narrow, LAST, 1);
    expect(summary.rpcCalls).toEqual({ eth_getBlockByNumber: 1, eth_getLogs: 3 });
    expect(summary.matches).toBe(1);
  });

  it("flags a log the second source is missing, with both counts", async () => {
    // Drop the first tracked log of range 1020-1029 only.
    const victim = original.entries(1022).concat(original.entries(1023), original.entries(1024), original.entries(1025))[0]?.log;
    if (!victim) throw new Error("fixture has no log to drop");
    const summary = await reconcile(provider("second", logTamper((l) => (l.blockNumber === `0x${victim.blockNumber.toString(16)}` && l.logIndex === `0x${victim.logIndex.toString(16)}` ? undefined : l))));
    expect(summary).toMatchObject({ rangesChecked: 5, matches: 4, providerErrors: 0 });
    const mismatches = (await rows()).filter((r) => r.status === "mismatch");
    expect(mismatches).toHaveLength(1);
    const [row] = mismatches;
    const total = original.totals(row?.fromBlock ?? 0, row?.toBlock ?? 0).logs;
    expect(summary.mismatchIds).toEqual([row?.id]);
    expect(row).toMatchObject({ storedLogCount: total, observedLogCount: total - 1, explanation: null });
    expect(row?.fromBlock).toBeLessThanOrEqual(victim.blockNumber);
    expect(row?.toBlock).toBeGreaterThanOrEqual(victim.blockNumber);
  });

  it("lists the one height whose logs carry another block hash", async () => {
    const height = [1031, 1032, 1033].find((n) => original.entries(n).length > 0) as number;
    const fakeHash = `0x${"ab".repeat(32)}`;
    const summary = await reconcile(provider("second", logTamper((l) => (heightOf(l.blockNumber) === height ? { ...l, blockHash: fakeHash } : l))));
    expect(summary.mismatchIds).toHaveLength(1);
    const [row] = await database.db.select().from(reconciliations).where(eq(reconciliations.status, "mismatch"));
    expect(row).toMatchObject({ fromBlock: 1030, toBlock: 1039, storedLogCount: row?.observedLogCount });
    expect(row?.hashMismatches).toEqual([{ number: height, stored: original.header(height).hash, observed: fakeHash }]);
  });

  it("flags a differing last-block hash even when every log agrees", async () => {
    const fakeHash = `0x${"cd".repeat(32)}`;
    const tamper: Tamper = (method, params, result) =>
      method === "eth_getBlockByNumber" && heightOf(params[0]) === 1019 ? { ...(result as WireResult), hash: fakeHash } : result;
    const summary = await reconcile(provider("second", tamper));
    expect(summary).toMatchObject({ rangesChecked: 5, matches: 4 });
    const [row] = await database.db.select().from(reconciliations).where(eq(reconciliations.status, "mismatch"));
    expect(row).toMatchObject({ fromBlock: 1010, toBlock: 1019, storedLogCount: row?.observedLogCount });
    expect(row?.hashMismatches).toEqual([{ number: 1019, stored: original.header(1019).hash, observed: fakeHash }]);
  });

  it("flags a competing fork: every diverged height with logs, and the last block", async () => {
    const fork = original.fork(1025, "fork");
    rpc.setChain(fork);
    const summary = await reconcile(provider(), 1029);
    expect(summary).toMatchObject({ rangesChecked: 3, matches: 2 });
    const [row] = await database.db.select().from(reconciliations).where(eq(reconciliations.status, "mismatch"));
    expect(row).toMatchObject({ fromBlock: 1020, toBlock: 1029 });
    const heights = new Set([1029]);
    for (let n = 1025; n <= 1029; n++) if (original.entries(n).length > 0 || fork.entries(n).length > 0) heights.add(n);
    expect(row?.hashMismatches.map((m) => m.number)).toEqual([...heights].sort((a, b) => a - b));
    expect(row?.blocksChecked).toBe(
      new Set([1029, ...Array.from({ length: 10 }, (_, i) => 1020 + i).filter((n) => original.entries(n).length > 0 || fork.entries(n).length > 0)]).size,
    );
    const last = row?.hashMismatches.find((m) => m.number === 1029);
    expect(last).toEqual({ number: 1029, stored: original.header(1029).hash, observed: fork.header(1029).hash });
  });

  it("reports a stored height the second source has no logs for as observed=null", async () => {
    const height = [1041, 1042, 1043].find((n) => original.entries(n).length > 0) as number;
    await reconcile(provider("second", logTamper((l) => (heightOf(l.blockNumber) === height ? undefined : l))));
    const [row] = await database.db.select().from(reconciliations).where(eq(reconciliations.status, "mismatch"));
    expect(row?.hashMismatches).toEqual([{ number: height, stored: original.header(height).hash, observed: null }]);
    expect(row?.storedLogCount).toBe((row?.observedLogCount ?? 0) + original.entries(height).length);
  });

  it("skips ranges above the finalized block, ranges already reconciled by this provider, and failed ranges", async () => {
    // A range is due only once its last block is finalized: 1030-1039 waits for 1039.
    expect((await reconcile(provider(), 1029)).rangesChecked).toBe(3);
    expect((await reconcile(provider(), 1034)).rangesChecked).toBe(0);
    expect((await reconcile(provider(), 1038)).rangesChecked).toBe(0);

    await database.db.update(ranges).set({ status: "failed" }).where(eq(ranges.fromBlock, 1030));
    const next = await reconcile(provider(), LAST);
    expect(next.rangesChecked).toBe(1);
    expect((await rows()).map((r) => r.fromBlock)).toEqual([1000, 1010, 1020, 1040]);

    // Another provider has not checked anything yet.
    expect((await reconcile(provider("other"), 1009)).rangesChecked).toBe(1);
    expect((await rows()).filter((r) => r.provider === "other").map((r) => r.fromBlock)).toEqual([1000]);
  });

  it("takes the oldest unchecked ranges first, up to the limit, and leaves a published range's status alone", async () => {
    await database.db.update(ranges).set({ status: "published", publishedAt: new Date() }).where(eq(ranges.fromBlock, 1000));
    expect((await reconcile(provider(), LAST, 2)).rangesChecked).toBe(2);
    expect((await rows()).map((r) => r.fromBlock)).toEqual([1000, 1010]);
    expect((await reconcile(provider(), LAST, 2)).rangesChecked).toBe(2);
    expect((await rows()).map((r) => r.fromBlock)).toEqual([1000, 1010, 1020, 1030]);
    const [published] = await database.db.select({ status: ranges.status }).from(ranges).where(eq(ranges.fromBlock, 1000));
    expect(published?.status).toBe("published");
  });

  it("writes no row when the provider fails, reports it, and retries the range on the next call", async () => {
    let failures = 1;
    const flaky: Tamper = (method, params, result) => {
      if (method === "eth_getLogs" && heightOf((params[0] as { fromBlock: string }).fromBlock) === 1010 && failures-- > 0) {
        throw new Error("simulated provider outage");
      }
      return result;
    };
    const p = provider("second", flaky);
    const before = await tableFingerprints(database);
    const first = await reconcile(p, 1029);
    expect(first).toMatchObject({ rangesChecked: 2, matches: 2, providerErrors: 1 });
    expect(first.failures).toHaveLength(1);
    expect(first.failures[0]).toMatchObject({ fromBlock: 1010, toBlock: 1019 });
    expect(first.failures[0]?.message).toContain("simulated provider outage");
    expect((await rows()).map((r) => r.fromBlock)).toEqual([1000, 1020]);
    expect(await tableFingerprints(database)).toMatchObject({ "chain.logs": before["chain.logs"], "ops.ranges": before["ops.ranges"] });

    const second = await reconcile(p, 1029);
    expect(second).toMatchObject({ rangesChecked: 1, matches: 1, providerErrors: 0 });
    expect((await rows()).map((r) => r.fromBlock)).toEqual([1000, 1010, 1020]);
  });

  it("treats a second source that has not reached the range yet as an error, not a mismatch", async () => {
    rpc.setHead(1025);
    const summary = await reconcile(provider(), LAST);
    expect(summary).toMatchObject({ rangesChecked: 2, matches: 2, providerErrors: 3 });
    expect(summary.failures.every((f) => f.message.includes("has no block"))).toBe(true);
    expect(await rows()).toHaveLength(2);
  });
});

describe("explainReconciliation", () => {
  async function mismatchAndMatch(): Promise<{ mismatchId: number; matchId: number }> {
    const fakeHash = `0x${"ef".repeat(32)}`;
    const tamper: Tamper = (method, params, result) =>
      method === "eth_getBlockByNumber" && heightOf(params[0]) === 1009 ? { ...(result as WireResult), hash: fakeHash } : result;
    const summary = await reconcile(provider("second", tamper), 1019);
    const [matchRow] = await database.db.select().from(reconciliations).where(eq(reconciliations.status, "match"));
    const mismatchId = summary.mismatchIds[0];
    if (mismatchId === undefined || !matchRow) throw new Error("fixture should hold one mismatch and one match");
    return { mismatchId, matchId: matchRow.id };
  }

  it("stores the trimmed explanation on a mismatch row", async () => {
    const { mismatchId } = await mismatchAndMatch();
    await explainReconciliation(database, mismatchId, "  provider B served an uncle block  ");
    const [row] = await database.db.select().from(reconciliations).where(eq(reconciliations.id, mismatchId));
    expect(row?.explanation).toBe("provider B served an uncle block");
  });

  it("refuses a match row, empty text, and an unknown id, changing nothing", async () => {
    const { mismatchId, matchId } = await mismatchAndMatch();
    await expect(explainReconciliation(database, matchId, "why")).rejects.toThrow(/is a match/);
    await expect(explainReconciliation(database, mismatchId, "   ")).rejects.toThrow(/empty/);
    await expect(explainReconciliation(database, mismatchId, "")).rejects.toThrow(/empty/);
    await expect(explainReconciliation(database, 999_999, "why")).rejects.toThrow(/no reconciliation/);
    expect((await rows()).map((r) => r.explanation)).toEqual([null, null]);
  });
});
