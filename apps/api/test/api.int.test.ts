import {
  AnalyticsMeta,
  ApiError,
  BackfillJobsPage,
  Health,
  RangeDetail,
  RangesPage,
  ReconciliationsPage,
  ReorgsPage,
  Status,
  SwapsPage,
  TransfersPage,
  type Swap,
  type Transfer,
} from "@rsi/contracts";
import { backfillJobs, createDb, lagSamples, qualityResults, reconciliations, reorgs, type Database } from "@rsi/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRun } from "../../indexer/src/store.ts";
import { resetDatabase, TEST_DATABASE_URL } from "../../indexer/test/support/db.ts";
import { SyntheticChain } from "../../indexer/test/support/synthetic-chain.ts";
import { buildApp, type AnalyticsSource } from "../src/app.ts";
import { CHAIN_ID, commitSpans, hex, POOLS, RUN_ID, setStatus, TOKENS } from "./support.ts";

const NOW = Date.parse("2026-10-01T12:00:00Z");
const SPANS = [
  [1000, 1019],
  [1020, 1039],
  [1040, 1059],
] as const;
const chain = new SyntheticChain({ tokens: TOKENS, pools: POOLS });

const fakeAnalytics: AnalyticsSource = {
  dailyVolume: async (q) => [{ day: q.from ?? "2026-01-01", transfers: 3, volume: "12345678901234567890", activeAddresses: 2 }],
  poolOhlc: async () => [{ bucket: "2026-01-01T00:00:00.000Z", open: 1, high: 2, low: 0.5, close: 1.5, swaps: 4, volumeToken0: "10", volumeToken1: "-20" }],
  meta: async () => ({ exportedThroughBlock: 1019, exportedAt: "2026-10-01T11:00:00.000Z", partitions: 1, rowCounts: { transfers: 5 } }),
};

let database: Database;
let app: FastifyInstance;

beforeEach(async () => {
  await resetDatabase();
  database = createDb(TEST_DATABASE_URL, { max: 4 });
  await startRun(database, RUN_ID, CHAIN_ID);
  await startRun(database, "run-2", 2);
  app = await buildApp({ database, analytics: fakeAnalytics, chainId: CHAIN_ID, now: () => NOW, logger: { level: process.env.API_TEST_LOG ?? "silent" } });
});

afterEach(async () => {
  await app.close();
  await database.sql.end();
});

async function get(path: string): Promise<{ status: number; body: unknown }> {
  const res = await app.inject({ method: "GET", url: path });
  return { status: res.statusCode, body: res.json() };
}

const ok = async (path: string) => {
  const res = await get(path);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body;
};

const rejected = async (path: string, status: number): Promise<ApiError> => {
  const res = await get(path);
  expect(res.status, path).toBe(status);
  return ApiError.parse(res.body);
};

const timestampOf = (block: number) => new Date((1_600_000_000 + 12 * block) * 1000).toISOString();

const byNewest = <T extends { blockNumber: number; logIndex: number }>(rows: T[]) => [...rows].sort((a, b) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex);

function expectedTransfers(from: number, to: number): Transfer[] {
  return byNewest(
    chain.decoded(from, to).transfers.map((t) => ({
      blockNumber: t.blockNumber,
      blockHash: t.blockHash,
      blockTimestamp: timestampOf(t.blockNumber),
      logIndex: t.logIndex,
      txHash: t.txHash,
      token: t.token,
      from: t.from,
      to: t.to,
      value: t.value,
    })),
  );
}

function expectedSwaps(from: number, to: number): Swap[] {
  return byNewest(chain.decoded(from, to).swaps.map((s) => ({ ...s, blockTimestamp: timestampOf(s.blockNumber) })));
}

/** First range published, second still a candidate, third failed. */
async function seedMixed(): Promise<void> {
  await commitSpans(database, chain, SPANS);
  await setStatus(database, 1000, "published");
  await setStatus(database, 1040, "failed");
}

async function walk<T>(path: string, limit: number, startCursor: string | null = null): Promise<T[]> {
  const items: T[] = [];
  let cursor = startCursor;
  for (let page = 0; page < 200; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const res = (await ok(`${path}${sep}limit=${limit}${cursor ? `&cursor=${cursor}` : ""}`)) as { items: T[]; nextCursor: string | null };
    items.push(...res.items);
    if (!res.nextCursor) return items;
    cursor = res.nextCursor;
  }
  throw new Error("pagination did not terminate");
}

describe("fail-closed event endpoints", () => {
  it("returns only rows inside published ranges, with exact decoded fields", async () => {
    await seedMixed();
    const transfers = TransfersPage.parse(await ok("/v1/transfers?limit=200"));
    const swaps = SwapsPage.parse(await ok("/v1/swaps?limit=200"));

    expect(transfers.items).toEqual(expectedTransfers(1000, 1019));
    expect(swaps.items).toEqual(expectedSwaps(1000, 1019));
    expect(transfers.items.length).toBeGreaterThan(0);
    expect(swaps.items.length).toBeGreaterThan(0);
    // The seed really has rows in the hidden ranges, otherwise the assertions above prove nothing.
    expect(chain.totals(1020, 1059).transfers).toBeGreaterThan(0);
    expect(chain.totals(1020, 1059).swaps).toBeGreaterThan(0);
  });

  it("hides rows of a range the moment it leaves published and shows them once it is published", async () => {
    await seedMixed();
    await setStatus(database, 1020, "published");
    expect((TransfersPage.parse(await ok("/v1/transfers?limit=200"))).items).toEqual(expectedTransfers(1000, 1039));
    await setStatus(database, 1000, "failed");
    expect((TransfersPage.parse(await ok("/v1/transfers?limit=200"))).items).toEqual(expectedTransfers(1020, 1039));
    await setStatus(database, 1020, "candidate");
    expect((await ok("/v1/transfers")) as unknown).toEqual({ items: [], nextCursor: null });
    expect((await ok("/v1/swaps")) as unknown).toEqual({ items: [], nextCursor: null });
  });

  it("serves nothing when no range is published, and never another chain's rows", async () => {
    await seedMixed();
    await setStatus(database, 1000, "candidate");
    expect(await ok("/v1/transfers")).toEqual({ items: [], nextCursor: null });

    const other = new SyntheticChain({ seed: "other", tokens: TOKENS, pools: POOLS });
    await commitSpans(database, other, [[1000, 1019]], 2, "run-2");
    await setStatus(database, 1000, "published", 2);
    expect(await ok("/v1/transfers")).toEqual({ items: [], nextCursor: null });
  });

  it("filters by token, pool, address (either side) and block window, case-insensitively", async () => {
    await seedMixed();
    await setStatus(database, 1020, "published");
    await setStatus(database, 1040, "published");
    const all = expectedTransfers(1000, 1059);
    const token = TOKENS[1]!;
    expect(all.some((t) => t.token === token)).toBe(true);
    expect(all.some((t) => t.token !== token)).toBe(true);

    const byToken = TransfersPage.parse(await ok(`/v1/transfers?limit=200&token=${token.toUpperCase().replace("0X", "0x")}`));
    expect(byToken.items).toEqual(all.filter((t) => t.token === token));

    const someone = all[3]!;
    const asSender = TransfersPage.parse(await ok(`/v1/transfers?limit=200&address=${someone.from}`));
    expect(asSender.items).toEqual(all.filter((t) => t.from === someone.from || t.to === someone.from));
    const asRecipient = TransfersPage.parse(await ok(`/v1/transfers?limit=200&address=${someone.to}`));
    expect(asRecipient.items).toEqual(all.filter((t) => t.from === someone.to || t.to === someone.to));

    const windowed = TransfersPage.parse(await ok("/v1/transfers?limit=200&fromBlock=1010&toBlock=1030"));
    expect(windowed.items).toEqual(all.filter((t) => t.blockNumber >= 1010 && t.blockNumber <= 1030));

    const swaps = expectedSwaps(1000, 1059);
    const pool = POOLS[0]!;
    expect(swaps.some((s) => s.pool === pool)).toBe(true);
    const byPool = SwapsPage.parse(await ok(`/v1/swaps?limit=200&pool=${pool}`));
    expect(byPool.items).toEqual(swaps.filter((s) => s.pool === pool));
    const swapper = swaps[2]!;
    const byRecipient = SwapsPage.parse(await ok(`/v1/swaps?limit=200&address=${swapper.recipient}`));
    expect(byRecipient.items).toEqual(swaps.filter((s) => s.sender === swapper.recipient || s.recipient === swapper.recipient));
    const bySender = SwapsPage.parse(await ok(`/v1/swaps?limit=200&address=${swapper.sender}&fromBlock=1000&toBlock=1059`));
    expect(bySender.items).toEqual(swaps.filter((s) => s.sender === swapper.sender || s.recipient === swapper.sender));
  });
});

describe("cursor pagination", () => {
  it("walks every row exactly once in newest-first order for any page size", async () => {
    await seedMixed();
    await setStatus(database, 1020, "published");
    await setStatus(database, 1040, "published");
    const expected = expectedTransfers(1000, 1059);
    expect(expected.length).toBeGreaterThan(30);
    for (const limit of [1, 7, 50, expected.length, 200]) {
      expect(await walk<Transfer>("/v1/transfers", limit), `limit ${limit}`).toEqual(expected);
    }
    expect(await walk<Swap>("/v1/swaps", 5)).toEqual(expectedSwaps(1000, 1059));
  });

  it("is stable while newer ranges are committed and published mid-walk", async () => {
    await commitSpans(database, chain, SPANS);
    for (const [from] of SPANS) await setStatus(database, from, "published");
    const before = expectedTransfers(1000, 1059);

    const firstPage = TransfersPage.parse(await ok("/v1/transfers?limit=10"));
    expect(firstPage.nextCursor).not.toBeNull();

    // A new range lands (and is published) between page 1 and page 2, plus a candidate above it.
    await commitSpans(database, chain, [
      [1060, 1079],
      [1080, 1099],
    ]);
    await setStatus(database, 1060, "published");

    const rest = await walk<Transfer>("/v1/transfers", 10, firstPage.nextCursor);
    expect([...firstPage.items, ...rest]).toEqual(before);

    const fresh = await walk<Transfer>("/v1/transfers", 50);
    expect(fresh).toEqual(expectedTransfers(1000, 1079));
  });
});

describe("input validation", () => {
  it("rejects malformed and foreign cursors with 400 invalid_cursor", async () => {
    await seedMixed();
    const forged = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const bad = ["!!!", "abc", forged({ b: "1; drop table", l: 1 }), forged({ b: -1, l: 0 }), forged({ b: 5 }), forged({ b: 5, l: 1, extra: 1 }), forged([1, 2]), Buffer.from("not json").toString("base64url")];
    for (const cursor of bad) {
      for (const path of ["transfers", "swaps"]) expect((await rejected(`/v1/${path}?cursor=${cursor}`, 400)).error.code, `${path} ${cursor}`).toBe("invalid_cursor");
    }
    // A cursor minted by one endpoint is not valid on an endpoint with a different sort key.
    const rangesCursor = RangesPage.parse(await ok("/v1/ranges?limit=1")).nextCursor!;
    expect((await rejected(`/v1/transfers?cursor=${rangesCursor}`, 400)).error.code).toBe("invalid_cursor");
    const eventCursor = TransfersPage.parse(await ok("/v1/transfers?limit=1")).nextCursor!;
    for (const path of ["ranges", "reorgs", "backfill-jobs", "reconciliations"]) {
      expect((await rejected(`/v1/${path}?cursor=${eventCursor}`, 400)).error.code, path).toBe("invalid_cursor");
    }
  });

  it("rejects bad query parameters with 400 bad_request", async () => {
    const bad = [
      "/v1/transfers?limit=0",
      "/v1/transfers?limit=201",
      "/v1/transfers?limit=abc",
      "/v1/transfers?limit=1.5",
      "/v1/transfers?limit=1&limit=2",
      "/v1/transfers?token=0x123",
      "/v1/transfers?address=not-an-address",
      "/v1/transfers?fromBlock=-1",
      "/v1/transfers?fromBlock=10&toBlock=5",
      "/v1/transfers?unknown=1",
      "/v1/swaps?pool=0xzz",
      "/v1/ranges?status=bogus",
      "/v1/backfill-jobs?status=done",
      "/v1/reconciliations?status=bogus",
      "/v1/reconciliations?unexplained=yes",
      "/v1/ranges/abc",
      "/v1/ranges/-5",
      "/v1/analytics/daily-volume",
      "/v1/analytics/daily-volume?token=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&from=2026-13-01",
      "/v1/analytics/daily-volume?token=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48&from=2026-02-02&to=2026-02-01",
      "/v1/analytics/pool-ohlc?pool=0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640&interval=5m",
      "/v1/analytics/pool-ohlc",
    ];
    for (const path of bad) expect((await rejected(path, 400)).error.code, path).toBe("bad_request");
  });

  it("answers unknown endpoints and unsupported methods with the error envelope", async () => {
    expect((await rejected("/v1/nope", 404)).error.code).toBe("not_found");
    const res = await app.inject({ method: "POST", url: "/v1/transfers" });
    expect(res.statusCode).toBe(404);
    ApiError.parse(res.json());
  });
});

describe("ranges, jobs, reconciliations", () => {
  async function seedEvidence(): Promise<void> {
    await seedMixed();
    await database.db.insert(qualityResults).values([
      { chainId: CHAIN_ID, fromBlock: 1000, gate: "row_counts", passed: true, rowsChecked: 20, rowsFailed: 0, detail: null },
      { chainId: CHAIN_ID, fromBlock: 1000, gate: "continuity", passed: true, rowsChecked: 20, rowsFailed: 0, detail: "ok" },
      { chainId: CHAIN_ID, fromBlock: 1040, gate: "row_counts", passed: false, rowsChecked: 20, rowsFailed: 3, detail: "3 rows missing" },
    ]);
    await database.db.insert(backfillJobs).values([
      { id: "1:1040-1059", chainId: CHAIN_ID, fromBlock: 1040, toBlock: 1059, status: "queued", failureReason: "row_counts", attempts: 1 },
      { id: "1:1020-1039", chainId: CHAIN_ID, fromBlock: 1020, toBlock: 1039, status: "resolved", failureReason: "continuity", attempts: 2 },
      { id: "2:1040-1059", chainId: 2, fromBlock: 1040, toBlock: 1059, status: "queued", failureReason: "other chain", attempts: 0 },
    ]);
    const mismatch = [{ number: 1025, stored: hex(1), observed: null }];
    await database.db.insert(reconciliations).values([
      { chainId: CHAIN_ID, fromBlock: 1000, toBlock: 1019, provider: "b", status: "match", blocksChecked: 12, hashMismatches: [], storedLogCount: 30, observedLogCount: 30 },
      { chainId: CHAIN_ID, fromBlock: 1020, toBlock: 1039, provider: "b", status: "mismatch", blocksChecked: 12, hashMismatches: mismatch, storedLogCount: 30, observedLogCount: 29 },
      { chainId: CHAIN_ID, fromBlock: 1040, toBlock: 1059, provider: "b", status: "mismatch", blocksChecked: 12, hashMismatches: mismatch, storedLogCount: 30, observedLogCount: 29, explanation: "provider lag" },
      { chainId: 2, fromBlock: 1000, toBlock: 1019, provider: "b", status: "mismatch", blocksChecked: 1, hashMismatches: mismatch, storedLogCount: 1, observedLogCount: 0 },
    ]);
  }

  it("lists ranges newest first, filters by status and paginates", async () => {
    await seedEvidence();
    const all = RangesPage.parse(await ok("/v1/ranges"));
    expect(all.items.map((r) => [r.fromBlock, r.toBlock, r.status])).toEqual([
      [1040, 1059, "failed"],
      [1020, 1039, "candidate"],
      [1000, 1019, "published"],
    ]);
    expect(all.nextCursor).toBeNull();
    const published = all.items[2]!;
    expect(published.blockCount).toBe(20);
    expect(published.transferCount).toBe(chain.totals(1000, 1019).transfers);
    expect(published.swapCount).toBe(chain.totals(1000, 1019).swaps);
    expect(published.logCount).toBe(chain.totals(1000, 1019).logs);
    expect(published.publishedAt).not.toBeNull();
    expect(all.items[1]!.publishedAt).toBeNull();

    expect(RangesPage.parse(await ok("/v1/ranges?status=failed")).items.map((r) => r.fromBlock)).toEqual([1040]);
    expect(await walk("/v1/ranges", 1)).toEqual(all.items);
  });

  it("returns range detail with gates, backfill job and reconciliations, and 404 for an unknown range", async () => {
    await seedEvidence();
    const published = RangeDetail.parse(await ok("/v1/ranges/1000"));
    expect(published.gates.map((g) => [g.gate, g.passed, g.detail])).toEqual([
      ["continuity", true, "ok"],
      ["row_counts", true, null],
    ]);
    expect(published.backfillJob).toBeNull();
    expect(published.reconciliations.map((r) => r.status)).toEqual(["match"]);

    const failed = RangeDetail.parse(await ok("/v1/ranges/1040"));
    expect(failed.status).toBe("failed");
    expect(failed.gates).toMatchObject([{ gate: "row_counts", passed: false, rowsFailed: 3, detail: "3 rows missing" }]);
    expect(failed.backfillJob).toMatchObject({ id: "1:1040-1059", status: "queued", attempts: 1, failureReason: "row_counts" });
    expect(failed.reconciliations).toMatchObject([{ explanation: "provider lag", hashMismatches: 1 }]);

    for (const path of ["/v1/ranges/1001", "/v1/ranges/999999"]) expect((await rejected(path, 404)).error.code).toBe("not_found");
    // Only an exact range start identifies a range.
    expect((await rejected("/v1/ranges/1019", 404)).error.code).toBe("not_found");
  });

  it("lists backfill jobs for this chain, filters by status and paginates", async () => {
    await seedEvidence();
    const all = BackfillJobsPage.parse(await ok("/v1/backfill-jobs"));
    expect(all.items.map((j) => j.id)).toEqual(["1:1040-1059", "1:1020-1039"]);
    expect(BackfillJobsPage.parse(await ok("/v1/backfill-jobs?status=queued")).items.map((j) => j.id)).toEqual(["1:1040-1059"]);
    expect(await walk("/v1/backfill-jobs", 1)).toEqual(all.items);
  });

  it("lists reconciliations for this chain, with the unexplained filter", async () => {
    await seedEvidence();
    const all = ReconciliationsPage.parse(await ok("/v1/reconciliations"));
    expect(all.items.map((r) => [r.fromBlock, r.status, r.explanation])).toEqual([
      [1040, "mismatch", "provider lag"],
      [1020, "mismatch", null],
      [1000, "match", null],
    ]);
    expect(all.items[1]).toMatchObject({ hashMismatches: 1, storedLogCount: 30, observedLogCount: 29, provider: "b", blocksChecked: 12 });
    expect(ReconciliationsPage.parse(await ok("/v1/reconciliations?status=mismatch")).items).toHaveLength(2);
    expect(ReconciliationsPage.parse(await ok("/v1/reconciliations?unexplained=true")).items.map((r) => r.fromBlock)).toEqual([1020]);
    expect(ReconciliationsPage.parse(await ok("/v1/reconciliations?unexplained=false")).items).toHaveLength(3);
    expect(await walk("/v1/reconciliations", 1)).toEqual(all.items);
  });
});

describe("reorgs and status", () => {
  const ref = (n: number) => ({ number: n, hash: hex(n) });

  async function seedReorgs(): Promise<void> {
    await database.db.insert(reorgs).values([
      {
        chainId: CHAIN_ID,
        runId: RUN_ID,
        detectedAt: new Date(NOW - 3600_000),
        action: "rolled_back",
        ancestorBlock: 1010,
        forkBlock: 1011,
        depth: 2,
        rollbackFrom: 1000,
        finalizedBlock: 900,
        orphaned: [ref(1011), ref(1012)],
        canonical: [ref(2011), ref(2012)],
      },
      {
        chainId: CHAIN_ID,
        runId: RUN_ID,
        detectedAt: new Date(NOW - 60_000),
        action: "halted",
        ancestorBlock: null,
        forkBlock: 950,
        depth: 70,
        rollbackFrom: null,
        finalizedBlock: 960,
        orphaned: [ref(950)],
        canonical: [ref(3950)],
      },
      { chainId: 2, runId: "run-2", detectedAt: new Date(NOW), action: "halted", ancestorBlock: null, forkBlock: 1, depth: 1, rollbackFrom: null, finalizedBlock: 1, orphaned: [], canonical: [] },
    ]);
  }

  it("lists reorgs newest first with both actions and block lists", async () => {
    await seedReorgs();
    const page = ReorgsPage.parse(await ok("/v1/reorgs"));
    expect(page.items.map((r) => [r.action, r.forkBlock, r.ancestorBlock, r.rollbackFrom, r.depth])).toEqual([
      ["halted", 950, null, null, 70],
      ["rolled_back", 1011, 1010, 1000, 2],
    ]);
    expect(page.items[1]).toMatchObject({ detectedAt: new Date(NOW - 3600_000).toISOString(), finalizedBlock: 900, orphaned: [ref(1011), ref(1012)], canonical: [ref(2011), ref(2012)] });
    expect(await walk("/v1/reorgs", 1)).toEqual(page.items);
    // Neither has been acknowledged: the halt still blocks a restart, and a rollback never takes an acknowledgement.
    expect(page.items.map((r) => [r.acknowledgedAt, r.acknowledgement])).toEqual([[null, null], [null, null]]);
  });

  it("shows when and why a halt was acknowledged, in the list and as the last reorg of the status", async () => {
    await seedReorgs();
    await database.sql`
      update ops.reorgs set acknowledged_at = ${new Date(NOW - 30_000).toISOString()}, acknowledgement = 'provider reorged inside finality, checked against two others'
      where chain_id = ${CHAIN_ID} and action = 'halted'`;

    const page = ReorgsPage.parse(await ok("/v1/reorgs"));
    expect(page.items[0]).toMatchObject({ action: "halted", acknowledgedAt: new Date(NOW - 30_000).toISOString(), acknowledgement: "provider reorged inside finality, checked against two others" });
    expect(page.items[1]).toMatchObject({ action: "rolled_back", acknowledgedAt: null, acknowledgement: null });
    expect(Status.parse(await ok("/v1/status")).lastReorg).toEqual(page.items[0]);
  });

  it("reports an empty database without nulls where numbers are promised", async () => {
    const status = Status.parse(await ok("/v1/status"));
    expect(status).toMatchObject({
      chainId: CHAIN_ID,
      generatedAt: new Date(NOW).toISOString(),
      head: null,
      finalizedBlock: null,
      storedTip: null,
      lastPublishedBlock: null,
      headLag: null,
      finalizedLag: null,
      backfill: { open: 0, jobs: [] },
      reconciliation: { match: 0, mismatch: 0, unexplained: 0 },
      lag1h: null,
      lastReorg: null,
      retention: { landingPurgedThroughBlock: null, decodedPurgedThroughBlock: null, landingRetentionDays: null, decodedRetentionDays: null },
    });
    expect(status.ranges.published).toEqual({ ranges: 0, blocks: 0, logs: 0 });
    expect(status.lastRun).toMatchObject({ id: RUN_ID, status: "running" });
  });

  it("derives positions, lag and evidence from the database alone", async () => {
    await seedMixed();
    await seedReorgs();
    await database.db.insert(backfillJobs).values([
      { id: "1:1040-1059", chainId: CHAIN_ID, fromBlock: 1040, toBlock: 1059, status: "queued", failureReason: "row_counts", attempts: 1 },
      { id: "1:900-999", chainId: CHAIN_ID, fromBlock: 900, toBlock: 999, status: "resolved", failureReason: "x", attempts: 1 },
    ]);
    await database.db.insert(reconciliations).values([
      { chainId: CHAIN_ID, fromBlock: 1000, toBlock: 1019, provider: "b", status: "match", blocksChecked: 1, hashMismatches: [], storedLogCount: 1, observedLogCount: 1 },
      { chainId: CHAIN_ID, fromBlock: 1020, toBlock: 1039, provider: "b", status: "mismatch", blocksChecked: 1, hashMismatches: [], storedLogCount: 1, observedLogCount: 2 },
    ]);
    const sample = (agoMs: number, head: number, finalized: number, tip: number | null) => ({
      chainId: CHAIN_ID,
      sampledAt: new Date(NOW - agoMs),
      headBlock: head,
      finalizedBlock: finalized,
      storedTip: tip,
    });
    await database.db.insert(lagSamples).values([
      sample(90 * 60_000, 2000, 1900, 1000), // outside the hour
      sample(30 * 60_000, 1100, 1000, 1050), // lag 50
      sample(20 * 60_000, 1110, 1010, 1059), // lag 51
      sample(10 * 60_000, 1120, 1030, null), // newest, tip unknown: counts as head/finalized, not in stats
    ]);

    const status = Status.parse(await ok("/v1/status"));
    expect(status.head).toEqual({ block: 1120, sampledAt: new Date(NOW - 10 * 60_000).toISOString() });
    expect(status.finalizedBlock).toBe(1030);
    expect(status.storedTip).toBe(1059);
    expect(status.lastPublishedBlock).toBe(1019);
    expect(status.headLag).toBe(61);
    expect(status.finalizedLag).toBe(11);
    const totals = (from: number, to: number) => ({ ranges: 1, blocks: 20, logs: chain.totals(from, to).logs });
    expect(status.ranges).toEqual({ published: totals(1000, 1019), candidate: totals(1020, 1039), failed: totals(1040, 1059) });
    expect(status.backfill.open).toBe(1);
    expect(status.backfill.jobs.map((j) => j.id)).toEqual(["1:1040-1059"]);
    expect(status.reconciliation).toEqual({ match: 1, mismatch: 1, unexplained: 1 });
    expect(status.lag1h).toMatchObject({ samples: 2, p50: 50.5, max: 51 });
    expect(status.lag1h!.p95).toBeCloseTo(50.95, 9);
    expect(status.lastReorg).toMatchObject({ action: "halted", forkBlock: 950 });
  });
});

describe("retention", () => {
  /** What the indexer's retention leaves behind: landing logs of two ranges gone, decoded rows of the first gone too. */
  async function purge(): Promise<void> {
    await commitSpans(database, chain, SPANS);
    for (const [from] of SPANS) await setStatus(database, from, "published");
    await database.sql`delete from chain.logs where block_number between 1000 and 1039`;
    await database.sql`delete from chain.erc20_transfers where block_number between 1000 and 1019`;
    await database.sql`delete from chain.uniswap_v3_swaps where block_number between 1000 and 1019`;
    await database.sql`update ops.ranges set landing_purged_at = now() where from_block in (1000, 1020)`;
    await database.sql`update ops.ranges set decoded_purged_at = now() where from_block = 1000`;
  }

  it("reports how far each class is purged, and the configured days when the API was told them", async () => {
    await purge();
    expect(Status.parse(await ok("/v1/status")).retention).toEqual({ landingPurgedThroughBlock: 1039, decodedPurgedThroughBlock: 1019, landingRetentionDays: null, decodedRetentionDays: null });

    const configured = await buildApp({ database, analytics: fakeAnalytics, chainId: CHAIN_ID, now: () => NOW, retentionDays: { landing: 7, decoded: 14 } });
    try {
      const res = await configured.inject({ method: "GET", url: "/v1/status" });
      expect(Status.parse(res.json()).retention).toEqual({ landingPurgedThroughBlock: 1039, decodedPurgedThroughBlock: 1019, landingRetentionDays: 7, decodedRetentionDays: 14 });
    } finally {
      await configured.close();
    }
  });

  it("serves the rows that still exist and keeps describing purged ranges by their counts", async () => {
    await purge();

    expect(TransfersPage.parse(await ok("/v1/transfers?limit=200")).items).toEqual(expectedTransfers(1020, 1059));
    expect(SwapsPage.parse(await ok("/v1/swaps?limit=200")).items).toEqual(expectedSwaps(1020, 1059));
    const { transfers, swaps, logs } = chain.totals(1000, 1019);
    expect(RangeDetail.parse(await ok("/v1/ranges/1000"))).toMatchObject({ status: "published", logCount: logs, transferCount: transfers, swapCount: swaps });
    expect(RangesPage.parse(await ok("/v1/ranges?limit=10")).items.map((r) => [r.fromBlock, r.status])).toEqual([[1040, "published"], [1020, "published"], [1000, "published"]]);
  });
});

describe("health and analytics passthrough", () => {
  it("reports ok while the database answers and 503 once it does not", async () => {
    expect(Health.parse(await ok("/healthz"))).toEqual({ ok: true });
    await database.sql.end();
    expect((await rejected("/healthz", 503)).error.code).toBe("unavailable");
    database = createDb(TEST_DATABASE_URL, { max: 1 }); // so afterEach can close something
  });

  it("serves analytics from the injected source and forwards normalised parameters", async () => {
    const seen: unknown[] = [];
    const recording: AnalyticsSource = {
      dailyVolume: async (q) => (seen.push(q), []),
      poolOhlc: async (q) => (seen.push(q), []),
      meta: fakeAnalytics.meta,
    };
    const local = await buildApp({ database, analytics: recording, chainId: CHAIN_ID });
    try {
      const token = "0xA0B86991C6218B36C1D19D4A2E9EB0CE3606EB48";
      expect((await local.inject({ url: `/v1/analytics/daily-volume?token=${token}&from=2026-01-01&to=2026-01-31` })).json()).toEqual([]);
      expect((await local.inject({ url: `/v1/analytics/pool-ohlc?pool=${POOLS[0]}` })).json()).toEqual([]);
      expect(seen).toEqual([
        { token: token.toLowerCase(), from: "2026-01-01", to: "2026-01-31" },
        { pool: POOLS[0], interval: "1h" },
      ]);
    } finally {
      await local.close();
    }
    expect(AnalyticsMeta.parse(await ok("/v1/analytics/meta"))).toMatchObject({ exportedThroughBlock: 1019 });
  });

  it("does not leak internals when a handler fails", async () => {
    const failing = await buildApp({
      database,
      chainId: CHAIN_ID,
      analytics: { ...fakeAnalytics, meta: async () => { throw new Error("secret path /var/db") } },
    });
    try {
      const res = await failing.inject({ url: "/v1/analytics/meta" });
      expect(res.statusCode).toBe(500);
      expect(ApiError.parse(res.json())).toEqual({ error: { code: "internal_error", message: "internal error" } });
    } finally {
      await failing.close();
    }
  });
});
