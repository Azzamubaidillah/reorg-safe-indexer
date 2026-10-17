import { createDb, type Database } from "@rsi/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lagReport, LAG_RETENTION_MS, pruneLagSamples, recordLagSample } from "../src/lag.ts";
import { resetDatabase, TEST_DATABASE_URL } from "./support/db.ts";

const CHAIN_ID = 1;
const NOW = Date.parse("2026-10-01T12:00:00Z");
const at = (msAgo: number) => new Date(NOW - msAgo);

let database: Database;

beforeEach(async () => {
  await resetDatabase();
  database = createDb(TEST_DATABASE_URL, { max: 2 });
});

afterEach(async () => {
  await database.sql.end();
});

/** Linear interpolation between closest ranks, the definition percentile_cont uses. */
function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

describe("lag samples", () => {
  it("computes exact percentiles and max in SQL, matching a JS reference", async () => {
    const head: number[] = [];
    const finalized: number[] = [];
    // Deterministic spread, including a stored tip ahead of head/finalized (clamped to 0) and a heavy tail.
    for (let i = 0; i < 97; i++) {
      const headBlock = 20_000 + i;
      const storedTip = headBlock - ((i * 37) % 11) + (i % 13 === 0 ? 4 : 0) - (i === 50 ? 400 : 0);
      const finalizedBlock = headBlock - 64 - (i % 5);
      await recordLagSample(database, { chainId: CHAIN_ID, headBlock, finalizedBlock, storedTip, sampledAt: at((i + 1) * 1000) });
      head.push(Math.max(0, headBlock - storedTip));
      finalized.push(Math.max(0, finalizedBlock - storedTip));
    }
    // Outside the window, other chain, and unknown tip: none may enter the stats.
    await recordLagSample(database, { chainId: CHAIN_ID, headBlock: 99_999, finalizedBlock: 1, storedTip: 1, sampledAt: at(10 * 3600_000) });
    await recordLagSample(database, { chainId: 2, headBlock: 99_999, finalizedBlock: 1, storedTip: 1, sampledAt: at(1000) });
    await recordLagSample(database, { chainId: CHAIN_ID, headBlock: 20_000, finalizedBlock: 19_936, storedTip: null, sampledAt: at(500) });

    const report = await lagReport(database, { chainId: CHAIN_ID, since: at(3600_000) });

    expect(report.samples).toBe(98);
    expect(report.unknownTip).toBe(1);
    for (const [stats, values] of [
      [report.headLag, head],
      [report.finalizedLag, finalized],
    ] as const) {
      expect(stats.p50).toBeCloseTo(percentile(values, 0.5), 9);
      expect(stats.p95).toBeCloseTo(percentile(values, 0.95), 9);
      expect(stats.p99).toBeCloseTo(percentile(values, 0.99), 9);
      expect(stats.max).toBe(Math.max(...values));
    }
    // Guard against a vacuous comparison: the tail and the clamping both occur.
    expect(report.headLag.max).toBeGreaterThan(100);
    expect(head).toContain(0);
    expect(report.headLag.p95).not.toBe(report.headLag.max);
  });

  it("returns nulls for an empty window", async () => {
    const report = await lagReport(database, { chainId: CHAIN_ID, since: at(3600_000) });
    expect(report).toEqual({
      samples: 0,
      unknownTip: 0,
      headLag: { p50: null, p95: null, p99: null, max: null },
      finalizedLag: { p50: null, p95: null, p99: null, max: null },
    });
  });

  it("includes a sample taken exactly at `since` and ignores a duplicate timestamp", async () => {
    await recordLagSample(database, { chainId: CHAIN_ID, headBlock: 110, finalizedBlock: 50, storedTip: 100, sampledAt: at(3600_000) });
    await recordLagSample(database, { chainId: CHAIN_ID, headBlock: 999, finalizedBlock: 50, storedTip: 100, sampledAt: at(3600_000) });
    const report = await lagReport(database, { chainId: CHAIN_ID, since: at(3600_000) });
    expect(report.samples).toBe(1);
    expect(report.headLag.max).toBe(10);
  });

  it("stamps samples with the database clock by default", async () => {
    await recordLagSample(database, { chainId: CHAIN_ID, headBlock: 5, finalizedBlock: 1, storedTip: 4 });
    const report = await lagReport(database, { chainId: CHAIN_ID, since: new Date(Date.now() - 60_000) });
    expect(report.samples).toBe(1);
    expect(report.headLag.p50).toBe(1);
  });

  it("prunes only this chain's samples older than the retention window", async () => {
    const sample = (chainId: number, sampledAt: Date) => recordLagSample(database, { chainId, headBlock: 10, finalizedBlock: 5, storedTip: 9, sampledAt });
    await sample(CHAIN_ID, at(LAG_RETENTION_MS + 1));
    await sample(CHAIN_ID, at(LAG_RETENTION_MS));
    await sample(CHAIN_ID, at(1000));
    await sample(2, at(LAG_RETENTION_MS + 1));

    expect(await pruneLagSamples(database, { chainId: CHAIN_ID, now: NOW })).toBe(1);

    const everything = new Date(0);
    expect((await lagReport(database, { chainId: CHAIN_ID, since: everything })).samples).toBe(2);
    expect((await lagReport(database, { chainId: 2, since: everything })).samples).toBe(1);
    expect(await pruneLagSamples(database, { chainId: CHAIN_ID, now: NOW })).toBe(0);
  });
});
