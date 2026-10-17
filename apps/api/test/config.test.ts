import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";

describe("loadConfig", () => {
  it("defaults to a loopback bind on 3200 for chain 1 and never exports on its own", () => {
    expect(loadConfig({ DATABASE_URL: "postgres://x/y" })).toEqual({
      databaseUrl: "postgres://x/y",
      chainId: 1,
      port: 3200,
      host: "127.0.0.1",
      corsOrigin: "*",
      analyticsDir: "data/analytics",
      analyticsExportIntervalMs: undefined,
      logLevel: "info",
    });
  });

  it("reads every override", () => {
    const config = loadConfig({
      DATABASE_URL: "postgres://x/y",
      CHAIN_ID: "11155111",
      API_PORT: "0",
      API_HOST: "0.0.0.0",
      API_CORS_ORIGIN: "https://dash.example",
      ANALYTICS_DIR: "/srv/parquet",
      ANALYTICS_EXPORT_INTERVAL_MS: "60000",
      LOG_LEVEL: "warn",
    });
    expect(config).toMatchObject({ chainId: 11155111, port: 0, host: "0.0.0.0", corsOrigin: "https://dash.example", analyticsDir: "/srv/parquet", analyticsExportIntervalMs: 60_000, logLevel: "warn" });
  });

  it("rejects a missing database URL and nonsense numbers", () => {
    expect(() => loadConfig({})).toThrow();
    expect(() => loadConfig({ DATABASE_URL: "x", API_PORT: "70000" })).toThrow();
    expect(() => loadConfig({ DATABASE_URL: "x", ANALYTICS_EXPORT_INTERVAL_MS: "0" })).toThrow();
  });
});
