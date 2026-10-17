import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

const base = {
  DATABASE_URL: "postgres://localhost/x",
  RPC_PROVIDERS: JSON.stringify([{ name: "a", url: "http://localhost:8545", maxSpan: 10, rps: 1 }]),
  START_BLOCK: "1",
};

describe("loadConfig polling", () => {
  it("defaults to a 4 s head poll and a 60 s finalized poll", () => {
    expect(loadConfig(base)).toMatchObject({ headPollIntervalMs: 4_000, pollIntervalMs: 60_000 });
  });

  it("reads HEAD_POLL_INTERVAL_MS and rejects non-positive values", () => {
    expect(loadConfig({ ...base, HEAD_POLL_INTERVAL_MS: "250" }).headPollIntervalMs).toBe(250);
    expect(() => loadConfig({ ...base, HEAD_POLL_INTERVAL_MS: "0" })).toThrow();
  });
});

describe("loadConfig M3 settings", () => {
  const mock = { name: "second", url: "http://localhost:9545", maxSpan: 5, rps: 2 };

  it("defaults: quality 60 s / 2 backfills, reconcile off (5 ranges every 300 s), no status server, 10 s lag samples", () => {
    expect(loadConfig(base)).toMatchObject({
      qualityIntervalMs: 60_000,
      qualityMaxBackfills: 2,
      reconcileProvider: undefined,
      reconcileLimit: 5,
      reconcileIntervalMs: 300_000,
      metricsPort: undefined,
      metricsHost: "127.0.0.1",
      healthStaleAfterMs: 60_000,
      lagSampleIntervalMs: 10_000,
    });
  });

  it("treats METRICS_PORT 0 like unset and rejects ports out of range", () => {
    expect(loadConfig({ ...base, METRICS_PORT: "0" }).metricsPort).toBeUndefined();
    expect(loadConfig({ ...base, METRICS_PORT: "9100" }).metricsPort).toBe(9100);
    expect(() => loadConfig({ ...base, METRICS_PORT: "70000" })).toThrow();
  });

  it("parses RECONCILE_PROVIDER with the provider schema, including its defaults", () => {
    expect(loadConfig({ ...base, RECONCILE_PROVIDER: JSON.stringify(mock) }).reconcileProvider).toEqual({ ...mock, batchSize: 1 });
    expect(() => loadConfig({ ...base, RECONCILE_PROVIDER: "not json" })).toThrow(/RECONCILE_PROVIDER must be JSON/);
    expect(() => loadConfig({ ...base, RECONCILE_PROVIDER: JSON.stringify({ name: "x" }) })).toThrow();
  });

  it("rejects a RECONCILE_PROVIDER named like any RPC_PROVIDERS entry", () => {
    const rpc = JSON.stringify([
      { name: "a", url: "http://localhost:8545", maxSpan: 10, rps: 1 },
      { name: "second", url: "http://localhost:8546", maxSpan: 10, rps: 1 },
    ]);
    expect(() => loadConfig({ ...base, RPC_PROVIDERS: rpc, RECONCILE_PROVIDER: JSON.stringify(mock) })).toThrow(/must differ from every RPC_PROVIDERS name/);
  });
});
