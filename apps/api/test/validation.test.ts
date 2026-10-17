import { ApiError, DailyVolumeQuery, PoolOhlcQuery, SwapsQuery, TransfersQuery } from "@rsi/contracts";
import type { Database } from "@rsi/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp, type AnalyticsSource } from "../src/app.ts";

// Validation happens before any query, so a database that throws on use proves requests are rejected without touching it.
const unused = (): never => {
  throw new Error("database must not be used for invalid input");
};
const untouchable = { sql: unused, db: undefined } as unknown as Database;
const analytics: AnalyticsSource = {
  dailyVolume: async () => { throw new Error("analytics must not be used for invalid input") },
  poolOhlc: async () => { throw new Error("analytics must not be used for invalid input") },
  meta: async () => { throw new Error("unused") },
};

let app: FastifyInstance;
beforeAll(async () => {
  app = await buildApp({ database: untouchable, analytics, chainId: 1 });
});
afterAll(async () => app.close());

const ADDRESS = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

describe("query schemas", () => {
  it("normalises addresses and applies the page defaults", () => {
    const q = TransfersQuery.parse({ token: ADDRESS.toUpperCase().replace("0X", "0x"), fromBlock: "5" });
    expect(q).toEqual({ limit: 50, token: ADDRESS, fromBlock: 5 });
    expect(SwapsQuery.parse({ limit: "200" }).limit).toBe(200);
  });

  it("rejects out-of-range pages, malformed numbers and addresses, and unknown keys", () => {
    for (const q of [{ limit: "0" }, { limit: "201" }, { limit: "-1" }, { limit: "1e2" }, { fromBlock: "0x10" }, { token: ADDRESS.slice(2) }, { token: `${ADDRESS}00` }, { nope: "1" }, { cursor: "" }]) {
      expect(TransfersQuery.safeParse(q).success, JSON.stringify(q)).toBe(false);
    }
    expect(TransfersQuery.safeParse({ fromBlock: "9", toBlock: "9" }).success).toBe(true);
    expect(TransfersQuery.safeParse({ fromBlock: "10", toBlock: "9" }).success).toBe(false);
  });

  it("validates analytics days as real calendar dates in order, and defaults the interval", () => {
    expect(PoolOhlcQuery.parse({ pool: ADDRESS })).toEqual({ pool: ADDRESS, interval: "1h" });
    expect(DailyVolumeQuery.safeParse({ token: ADDRESS, from: "2024-02-29", to: "2024-02-29" }).success).toBe(true);
    for (const day of ["2023-02-29", "2024-13-01", "2024-1-1", "20240101", "2024-01-01T00:00:00Z"]) {
      expect(DailyVolumeQuery.safeParse({ token: ADDRESS, from: day }).success, day).toBe(false);
    }
    expect(DailyVolumeQuery.safeParse({ token: ADDRESS, from: "2024-03-02", to: "2024-03-01" }).success).toBe(false);
  });
});

describe("rejection before any I/O", () => {
  it("answers invalid requests with the error envelope and never reaches the database or analytics", async () => {
    const paths = [
      "/v1/transfers?limit=0",
      "/v1/swaps?cursor=%25%25",
      "/v1/ranges?status=bogus",
      "/v1/ranges/not-a-number",
      "/v1/reorgs?cursor=e30",
      `/v1/analytics/daily-volume?token=${ADDRESS}&from=2024-02-30`,
      "/v1/analytics/pool-ohlc?interval=1h",
    ];
    for (const url of paths) {
      const res = await app.inject({ url });
      expect(res.statusCode, url).toBe(400);
      expect(ApiError.parse(res.json()).error.message.length).toBeGreaterThan(0);
    }
  });

  it("allows cross-origin reads and exposes only read methods", async () => {
    const res = await app.inject({ method: "OPTIONS", url: "/v1/status", headers: { origin: "https://dash.example", "access-control-request-method": "GET" } });
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toBe("GET, HEAD, OPTIONS");
  });
});
