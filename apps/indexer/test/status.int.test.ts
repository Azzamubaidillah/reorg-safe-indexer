import { backfillJobs, blocks, createDb, lagSamples, ranges, reconciliations, reorgs, type Database } from "@rsi/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Metrics } from "../src/metrics.ts";
import { startStatusServer, type StatusReport, type StatusServer } from "../src/status.ts";
import { resetDatabase, TEST_DATABASE_URL } from "./support/db.ts";
import { startRun } from "../src/store.ts";

const CHAIN_ID = 1;
const RUN_ID = "run-1";
const NOW = Date.parse("2026-10-01T12:00:00Z");
const STALE_AFTER_MS = 60_000;

let database: Database;
let server: StatusServer | undefined;
let clock = NOW;
let metrics: Metrics;

beforeEach(async () => {
  await resetDatabase();
  database = createDb(TEST_DATABASE_URL, { max: 4 });
  await startRun(database, RUN_ID, CHAIN_ID);
  await startRun(database, "run-2", 2);
  clock = NOW;
  metrics = new Metrics({ now: () => clock });
  server = await startStatusServer(database, metrics, { chainId: CHAIN_ID, port: 0, staleAfterMs: STALE_AFTER_MS });
});

afterEach(async () => {
  await server?.close();
  await database.sql.end();
});

const url = (path: string) => `http://127.0.0.1:${server!.port}${path}`;

const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

async function seed(): Promise<void> {
  const block = (chainId: number, number: number) => ({ chainId, number, hash: hex(chainId * 1_000_000 + number), parentHash: hex(number - 1), timestamp: new Date(NOW) });
  await database.db.insert(blocks).values([block(CHAIN_ID, 1000), block(CHAIN_ID, 1004), block(2, 5000)]);

  const range = (chainId: number, fromBlock: number, toBlock: number, status: string, logCount: number) => ({
    chainId,
    fromBlock,
    toBlock,
    status,
    blockCount: toBlock - fromBlock + 1,
    logCount,
    transferCount: 0,
    swapCount: 0,
    rejectCount: 0,
    payloadSha256: hex(fromBlock),
    runId: chainId === CHAIN_ID ? RUN_ID : "run-2",
  });
  await database.db.insert(ranges).values([
    range(CHAIN_ID, 0, 99, "published", 10),
    range(CHAIN_ID, 100, 199, "published", 20),
    range(CHAIN_ID, 200, 299, "candidate", 5),
    range(CHAIN_ID, 300, 349, "failed", 1),
    range(2, 0, 9999, "published", 777),
  ]);

  const job = (chainId: number, from: number, to: number, status: string, attempts: number, createdAt: string) => ({
    id: `${chainId}:${from}-${to}`,
    chainId,
    fromBlock: from,
    toBlock: to,
    status,
    failureReason: `gate failed for ${from}`,
    attempts,
    createdAt: new Date(createdAt),
  });
  await database.db.insert(backfillJobs).values([
    job(CHAIN_ID, 300, 349, "queued", 0, "2026-10-01T10:00:00Z"),
    job(CHAIN_ID, 200, 299, "running", 2, "2026-10-01T09:00:00Z"),
    job(CHAIN_ID, 100, 199, "resolved", 1, "2026-10-01T08:00:00Z"),
    job(2, 0, 9, "queued", 0, "2026-10-01T07:00:00Z"),
  ]);

  // Seven reorgs so the "last 5" cut and ordering are exercised; the oldest two must not appear.
  const reorgRows = Array.from({ length: 7 }, (_, i) => {
    const halted = i === 6;
    return {
      chainId: CHAIN_ID,
      runId: RUN_ID,
      detectedAt: new Date(NOW - (7 - i) * 60_000),
      action: halted ? "halted" : "rolled_back",
      ancestorBlock: halted ? null : 990 + i,
      forkBlock: 991 + i,
      depth: i + 1,
      rollbackFrom: halted ? null : 991 + i,
      finalizedBlock: 900,
      orphaned: [],
      canonical: [],
    };
  });
  await database.db.insert(reorgs).values([...reorgRows, { ...reorgRows[0]!, chainId: 2, runId: "run-2", detectedAt: new Date(NOW) }]);

  const recon = (chainId: number, status: string, explanation: string | null) => ({
    chainId,
    fromBlock: 0,
    toBlock: 99,
    provider: "second",
    status,
    blocksChecked: 100,
    hashMismatches: [],
    storedLogCount: 10,
    observedLogCount: 10,
    explanation,
  });
  await database.db.insert(reconciliations).values([
    recon(CHAIN_ID, "match", null),
    recon(CHAIN_ID, "match", null),
    recon(CHAIN_ID, "mismatch", null),
    recon(CHAIN_ID, "mismatch", "provider B served an orphaned block"),
    recon(CHAIN_ID, "mismatch", ""),
    recon(2, "mismatch", null),
  ]);

  const lag = (chainId: number, msAgo: number, storedTip: number) => ({ chainId, sampledAt: new Date(NOW - msAgo), headBlock: 1010, finalizedBlock: 950, storedTip });
  await database.db.insert(lagSamples).values([
    lag(CHAIN_ID, 10 * 60_000, 1010), // head lag 0
    lag(CHAIN_ID, 20 * 60_000, 1008), // 2
    lag(CHAIN_ID, 30 * 60_000, 1004), // 6
    lag(CHAIN_ID, 90 * 60_000, 900), // older than 1 h: excluded
    lag(2, 10 * 60_000, 0), // other chain: excluded
  ]);
}

describe("GET /status", () => {
  it("reports positions, range and job counts, reorgs, reconciliation and lag from the database", async () => {
    await seed();
    metrics.onHead(1010);
    metrics.onFinalized(250);

    const res = await fetch(url("/status"));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const status = (await res.json()) as StatusReport;

    expect(status.chainId).toBe(CHAIN_ID);
    expect(status.generatedAt).toBe(new Date(NOW).toISOString());
    expect(status).toMatchObject({ head: 1010, finalized: 250, storedTip: 1004, lastPublishedBlock: 199, headLag: 6, finalizedLag: 51 });
    expect(status.ranges).toEqual({
      candidate: { ranges: 1, blocks: 100, logs: 5 },
      published: { ranges: 2, blocks: 200, logs: 30 },
      failed: { ranges: 1, blocks: 50, logs: 1 },
    });
    expect(status.backfillJobs.open).toBe(2);
    expect(status.backfillJobs.jobs).toEqual([
      { id: "1:200-299", fromBlock: 200, toBlock: 299, status: "running", attempts: 2, failureReason: "gate failed for 200" },
      { id: "1:300-349", fromBlock: 300, toBlock: 349, status: "queued", attempts: 0, failureReason: "gate failed for 300" },
    ]);
    // Newest first; depth i+1 identifies the seeded row (i = 6 is the halt).
    expect(status.recentReorgs.map((r) => r.depth)).toEqual([7, 6, 5, 4, 3]);
    expect(status.recentReorgs[0]).toMatchObject({ action: "halted", ancestorBlock: null, forkBlock: 997, finalizedBlock: 900, detectedAt: new Date(NOW - 60_000).toISOString() });
    expect(status.recentReorgs[1]).toMatchObject({ action: "rolled_back", ancestorBlock: 995, forkBlock: 996 });
    expect(status.reconciliation).toEqual({ match: 2, mismatch: 3, unexplained: 2 });
    expect(status.lagLastHour.samples).toBe(3);
    // percentile_cont(0.95) over head lags [0, 2, 6]: 2 + 0.9 * 4.
    expect(status.lagLastHour.headLagP95).toBeCloseTo(5.6, 9);
    expect(status.lagLastHour.headLag.max).toBe(6);
    expect(status.lagLastHour.finalizedLagP95).toBe(0);
  });

  it("returns nulls and zeros on an empty database before any head poll", async () => {
    const status = (await (await fetch(url("/status"))).json()) as StatusReport;
    expect(status).toMatchObject({ head: null, finalized: null, storedTip: null, lastPublishedBlock: null, headLag: null, finalizedLag: null });
    expect(status.ranges.published).toEqual({ ranges: 0, blocks: 0, logs: 0 });
    expect(status.backfillJobs).toEqual({ open: 0, jobs: [] });
    expect(status.recentReorgs).toEqual([]);
    expect(status.reconciliation).toEqual({ match: 0, mismatch: 0, unexplained: 0 });
    expect(status.lagLastHour).toMatchObject({ samples: 0, headLagP95: null, finalizedLagP95: null });
  });

  it("is read-only", async () => {
    await seed();
    const count = async () => (await database.sql<{ n: number }[]>`select (select count(*) from ops.ranges)::int + (select count(*) from ops.reorgs)::int + (select count(*) from ops.lag_samples)::int as n`)[0]!.n;
    const before = await count();
    await fetch(url("/status"));
    expect(await count()).toBe(before);
  });
});

describe("GET /healthz", () => {
  it("flips to 503 once neither a head poll nor a commit happened within the threshold, and recovers", async () => {
    let res = await fetch(url("/healthz"));
    expect(res.status).toBe(200);

    clock += STALE_AFTER_MS;
    expect((await fetch(url("/healthz"))).status).toBe(200);

    clock += 1;
    res = await fetch(url("/healthz"));
    expect(res.status).toBe(503);
    const body = (await res.json()) as { ok: boolean; reason: string; idleMs: number };
    expect(body).toMatchObject({ ok: false, idleMs: STALE_AFTER_MS + 1 });
    expect(body.reason).toContain("no head poll or range commit");

    metrics.onHead(1);
    expect((await fetch(url("/healthz"))).status).toBe(200);

    clock += STALE_AFTER_MS + 1;
    expect((await fetch(url("/healthz"))).status).toBe(503);
    metrics.onRangeCommitted({ toBlock: 1, logCount: 0 });
    expect((await fetch(url("/healthz"))).status).toBe(200);
  });

  it("does not touch the database, so a database outage cannot fail the liveness probe", async () => {
    await database.sql.end();
    expect((await fetch(url("/healthz"))).status).toBe(200);
  });
});

describe("GET /metrics and routing", () => {
  it("serves Prometheus text with the series fed by events", async () => {
    metrics.onRangeCommitted({ toBlock: 99, logCount: 12 });
    const res = await fetch(url("/metrics"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("indexer_logs_committed_total 12");
    expect(text).toContain("indexer_stored_tip_block 99");
  });

  it("answers 404 for unknown paths and 405 for non-GET", async () => {
    expect((await fetch(url("/nope"))).status).toBe(404);
    expect((await fetch(url("/status"), { method: "POST" })).status).toBe(405);
  });

  it("answers 500 with a JSON error when the database fails", async () => {
    await database.sql.end();
    const res = await fetch(url("/status"));
    expect(res.status).toBe(500);
    expect(await res.json()).toHaveProperty("error");
  });

  it("frees the port on close", async () => {
    const port = server!.port;
    await server!.close();
    server = undefined;
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });
});
