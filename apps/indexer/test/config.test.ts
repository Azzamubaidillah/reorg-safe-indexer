import { describe, expect, it } from "vitest";
import { loadConfig, loadRetentionConfig } from "../src/config.ts";

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

describe("Etherscan spot-check settings", () => {
  it("is off without a key, and samples 20 ranges hourly at 2 calls/s with one", () => {
    expect(loadConfig(base).etherscan).toBeUndefined();
    expect(loadConfig({ ...base, ETHERSCAN_API_KEY: "  " }).etherscan).toBeUndefined();
    expect(loadConfig({ ...base, ETHERSCAN_API_KEY: "abc" }).etherscan).toEqual({ apiKey: "abc", sampleSize: 20, intervalMs: 3_600_000, rps: 2 });
  });

  it("refuses a call rate above Etherscan's per-second cap", () => {
    expect(() => loadConfig({ ...base, ETHERSCAN_API_KEY: "abc", ETHERSCAN_RPS: "6" })).toThrow();
    expect(loadConfig({ ...base, ETHERSCAN_API_KEY: "abc", ETHERSCAN_SAMPLE_SIZE: "5", ETHERSCAN_RPS: "3" }).etherscan).toMatchObject({ sampleSize: 5, rps: 3 });
  });
});

describe("retention settings", () => {
  const DAY = 86_400_000;

  it("defaults: 7 days of landing, decoded rows kept forever, hourly cycle of at most 500 ranges", () => {
    const expected = {
      retention: { landingRetentionMs: 7 * DAY, decodedRetentionMs: undefined, analyticsManifestPath: undefined, maxRanges: 500 },
      retentionIntervalMs: 3_600_000,
    };
    expect(loadConfig(base)).toMatchObject(expected);
    expect(loadRetentionConfig({})).toEqual(expected);
  });

  it("reads every override, in days for the retention periods", () => {
    const env = {
      LANDING_RETENTION_DAYS: "0.5",
      DECODED_RETENTION_DAYS: "14",
      ANALYTICS_MANIFEST_PATH: "/data/analytics/_manifest.json",
      RETENTION_INTERVAL_MS: "60000",
      RETENTION_MAX_RANGES: "10",
    };
    const expected = {
      retention: { landingRetentionMs: DAY / 2, decodedRetentionMs: 14 * DAY, analyticsManifestPath: "/data/analytics/_manifest.json", maxRanges: 10 },
      retentionIntervalMs: 60_000,
    };
    expect(loadConfig({ ...base, ...env })).toMatchObject(expected);
    expect(loadRetentionConfig(env)).toEqual(expected);
  });

  it("rejects non-positive values", () => {
    for (const bad of [{ LANDING_RETENTION_DAYS: "0" }, { DECODED_RETENTION_DAYS: "-1", ANALYTICS_MANIFEST_PATH: "/m" }, { RETENTION_INTERVAL_MS: "0" }, { RETENTION_MAX_RANGES: "0" }, { RETENTION_MAX_RANGES: "1.5" }]) {
      expect(() => loadConfig({ ...base, ...bad }), JSON.stringify(bad)).toThrow();
    }
  });

  it("refuses DECODED_RETENTION_DAYS without a manifest, which would silently keep decoded rows forever", () => {
    expect(() => loadConfig({ ...base, DECODED_RETENTION_DAYS: "14" })).toThrow(/needs ANALYTICS_MANIFEST_PATH/);
    expect(() => loadRetentionConfig({ DECODED_RETENTION_DAYS: "14" })).toThrow(/needs ANALYTICS_MANIFEST_PATH/);
    // A manifest alone is harmless: decoded rows are kept because no decoded retention is set.
    expect(loadConfig({ ...base, ANALYTICS_MANIFEST_PATH: "/m" }).retention.decodedRetentionMs).toBeUndefined();
  });
});
