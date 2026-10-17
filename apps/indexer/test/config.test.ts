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
