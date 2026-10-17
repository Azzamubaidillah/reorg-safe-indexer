import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnalyticsReader, exportPublished } from "@rsi/analytics";
import { AnalyticsMeta, ApiError, DailyVolume, PoolOhlc } from "@rsi/contracts";
import { createDb, type Database } from "@rsi/db";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startRun } from "../../indexer/src/store.ts";
import { resetDatabase, TEST_DATABASE_URL } from "../../indexer/test/support/db.ts";
import { SyntheticChain } from "../../indexer/test/support/synthetic-chain.ts";
import { buildApp } from "../src/app.ts";
import { CHAIN_ID, commitSpans, POOLS, RUN_ID, setStatus, TOKENS } from "./support.ts";

// Blocks are 12 s apart from 2020-09-13T12:26:40Z, so block 3467 is the first of 2020-09-14 (UTC):
// the three spans below straddle midnight.
const SPANS = [
  [3440, 3459],
  [3460, 3479],
  [3480, 3499],
] as const;
const chain = new SyntheticChain({ tokens: TOKENS, pools: POOLS });
const dayOf = (block: number) => new Date((1_600_000_000 + 12 * block) * 1000).toISOString().slice(0, 10);

let database: Database;
let dir: string;
let reader: AnalyticsReader;
let app: FastifyInstance;

beforeEach(async () => {
  await resetDatabase();
  database = createDb(TEST_DATABASE_URL, { max: 4 });
  await startRun(database, RUN_ID, CHAIN_ID);
  dir = await mkdtemp(join(tmpdir(), "rsi-api-analytics-"));
  reader = new AnalyticsReader({ dir });
  app = await buildApp({ database, analytics: reader, chainId: CHAIN_ID });
});

afterEach(async () => {
  await app.close();
  await reader.close();
  await database.sql.end();
  await rm(dir, { recursive: true, force: true });
});

const get = async (path: string) => {
  const res = await app.inject({ url: path });
  return { status: res.statusCode, body: res.json() as unknown };
};

/** Published rows only: the first two spans, with the third committed but still a candidate. */
async function seedAndExport(): Promise<void> {
  await commitSpans(database, chain, SPANS);
  await setStatus(database, 3440, "published");
  await setStatus(database, 3460, "published");
  await exportPublished(database, { chainId: CHAIN_ID, dir });
}

describe("analytics endpoints over a real Parquet export", () => {
  it("answers empty before the first export", async () => {
    await commitSpans(database, chain, SPANS);
    expect(await get(`/v1/analytics/daily-volume?token=${TOKENS[0]}`)).toEqual({ status: 200, body: [] });
    expect(await get(`/v1/analytics/pool-ohlc?pool=${POOLS[0]}`)).toEqual({ status: 200, body: [] });
    expect(AnalyticsMeta.parse((await get("/v1/analytics/meta")).body)).toMatchObject({ exportedThroughBlock: null, exportedAt: null, partitions: 0 });
  });

  it("reports how far the export reached and exports only published ranges", async () => {
    await seedAndExport();
    const meta = AnalyticsMeta.parse((await get("/v1/analytics/meta")).body);
    expect(meta.exportedThroughBlock).toBe(3479);
    expect(meta.partitions).toBeGreaterThan(0);
    const published = chain.totals(3440, 3479);
    expect(meta.rowCounts).toMatchObject({ transfers: published.transfers, swaps: published.swaps });
  });

  it("serves daily volume equal to the published transfers, split at UTC midnight, and honours from/to", async () => {
    await seedAndExport();
    const token = TOKENS[0]!;
    const expected = new Map<string, { transfers: number; volume: bigint; addresses: Set<string> }>();
    for (const t of chain.decoded(3440, 3479).transfers) {
      if (t.token !== token) continue;
      const day = dayOf(t.blockNumber);
      const row = expected.get(day) ?? { transfers: 0, volume: 0n, addresses: new Set<string>() };
      row.transfers++;
      row.volume += BigInt(t.value);
      row.addresses.add(t.from).add(t.to);
      expected.set(day, row);
    }
    expect(expected.size).toBe(2);

    const all = DailyVolume.parse((await get(`/v1/analytics/daily-volume?token=${token.toUpperCase().replace("0X", "0x")}`)).body);
    expect(all).toEqual([...expected].map(([day, r]) => ({ day, transfers: r.transfers, volume: r.volume.toString(), activeAddresses: r.addresses.size })));

    const [, second] = [...expected.keys()];
    const from = DailyVolume.parse((await get(`/v1/analytics/daily-volume?token=${token}&from=${second}`)).body);
    expect(from.map((r) => r.day)).toEqual([second]);
    const to = DailyVolume.parse((await get(`/v1/analytics/daily-volume?token=${token}&to=${[...expected.keys()][0]}`)).body);
    expect(to.map((r) => r.day)).toEqual([[...expected.keys()][0]]);
  });

  it("serves pool OHLC with exact swap counts and volumes per bucket", async () => {
    await seedAndExport();
    const pool = POOLS[0]!;
    const perDay = new Map<string, { swaps: number; v0: bigint; v1: bigint }>();
    for (const s of chain.decoded(3440, 3479).swaps) {
      if (s.pool !== pool) continue;
      const day = dayOf(s.blockNumber);
      const row = perDay.get(day) ?? { swaps: 0, v0: 0n, v1: 0n };
      row.swaps++;
      row.v0 += BigInt(s.amount0) < 0n ? -BigInt(s.amount0) : BigInt(s.amount0);
      row.v1 += BigInt(s.amount1) < 0n ? -BigInt(s.amount1) : BigInt(s.amount1);
      perDay.set(day, row);
    }

    const daily = PoolOhlc.parse((await get(`/v1/analytics/pool-ohlc?pool=${pool}&interval=1d`)).body);
    expect(daily.map((r) => [r.bucket.slice(0, 10), r.swaps, r.volumeToken0, r.volumeToken1])).toEqual([...perDay].map(([day, r]) => [day, r.swaps, r.v0.toString(), r.v1.toString()]));
    for (const r of daily) {
      expect(r.low).toBeLessThanOrEqual(r.high);
      for (const price of [r.open, r.close]) {
        expect(price).toBeGreaterThanOrEqual(r.low);
        expect(price).toBeLessThanOrEqual(r.high);
      }
    }

    const hourly = PoolOhlc.parse((await get(`/v1/analytics/pool-ohlc?pool=${pool}`)).body);
    expect(hourly.reduce((n, r) => n + r.swaps, 0)).toBe([...perDay.values()].reduce((n, r) => n + r.swaps, 0));
    expect(hourly.map((r) => r.bucket)).toEqual([...hourly.map((r) => r.bucket)].sort());
  });

  it("answers 404 for a pool the analytics metadata does not describe", async () => {
    await seedAndExport();
    const res = await get(`/v1/analytics/pool-ohlc?pool=${POOLS[1]}`);
    expect(res.status).toBe(404);
    expect(ApiError.parse(res.body).error.code).toBe("unknown_pool");
  });
});
