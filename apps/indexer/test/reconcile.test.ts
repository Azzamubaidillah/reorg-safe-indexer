import { describe, expect, it } from "vitest";
import { compareRange, type LogIdentity, type RangeSides } from "../src/reconcile.ts";

const log = (blockNumber: number, logIndex: number, blockHash = `0xh${blockNumber}`, txHash = `0xt${blockNumber}`): LogIdentity => ({
  blockNumber,
  blockHash,
  logIndex,
  txHash,
});

/** Range 10-14 with logs at 11 (two) and 13 (one); stored hash of height n is `0xh<n>`. */
function sides(overrides: { observedLogs?: LogIdentity[]; lastBlockHash?: string; storedLogs?: LogIdentity[] } = {}): RangeSides {
  return {
    from: 10,
    to: 14,
    stored: {
      logs: overrides.storedLogs ?? [log(11, 0), log(11, 1), log(13, 0)],
      blockHashes: new Map([10, 11, 12, 13, 14].map((n) => [n, `0xh${n}`])),
    },
    observed: { logs: overrides.observedLogs ?? [log(11, 0), log(11, 1), log(13, 0)], lastBlockHash: overrides.lastBlockHash ?? "0xh14" },
  };
}

describe("compareRange", () => {
  it("matches identical sides and counts the heights with logs plus the last block", () => {
    expect(compareRange(sides())).toEqual({
      status: "match",
      blocksChecked: 3,
      hashMismatches: [],
      storedLogCount: 3,
      observedLogCount: 3,
      logDifferences: 0,
    });
  });

  it("matches an empty range by its last block alone", () => {
    const r = compareRange(sides({ storedLogs: [], observedLogs: [] }));
    expect(r).toMatchObject({ status: "match", blocksChecked: 1, storedLogCount: 0, observedLogCount: 0 });
  });

  it("flags a log the second source lacks: counts differ, hash check is silent while the height still has another log", () => {
    const r = compareRange(sides({ observedLogs: [log(11, 0), log(13, 0)] }));
    expect(r).toMatchObject({ status: "mismatch", storedLogCount: 3, observedLogCount: 2, logDifferences: 1, hashMismatches: [] });
  });

  it("reports a height only the stored side has logs for as observed=null", () => {
    const r = compareRange(sides({ observedLogs: [log(11, 0), log(11, 1)] }));
    expect(r.status).toBe("mismatch");
    expect(r.hashMismatches).toEqual([{ number: 13, stored: "0xh13", observed: null }]);
  });

  it("reports a height only the second source has logs for against the stored hash", () => {
    const r = compareRange(sides({ observedLogs: [log(11, 0), log(11, 1), log(12, 0, "0xh12"), log(13, 0)] }));
    expect(r.status).toBe("mismatch");
    expect(r.blocksChecked).toBe(4);
    // The hashes agree at 12; the extra log alone makes it a mismatch.
    expect(r.hashMismatches).toEqual([]);
    expect(r).toMatchObject({ storedLogCount: 3, observedLogCount: 4, logDifferences: 1 });
  });

  it("lists every height whose logs carry a different block hash, including the last block's header", () => {
    const r = compareRange(sides({ observedLogs: [log(11, 0, "0xother"), log(11, 1, "0xother"), log(13, 0)], lastBlockHash: "0xtip" }));
    expect(r.hashMismatches).toEqual([
      { number: 11, stored: "0xh11", observed: "0xother" },
      { number: 14, stored: "0xh14", observed: "0xtip" },
    ]);
    expect(r.status).toBe("mismatch");
  });

  it("a differing last-block hash alone is a mismatch with equal counts", () => {
    const r = compareRange(sides({ lastBlockHash: "0xtip" }));
    expect(r).toMatchObject({ status: "mismatch", storedLogCount: 3, observedLogCount: 3, hashMismatches: [{ number: 14, stored: "0xh14", observed: "0xtip" }] });
  });

  it("catches equal counts and hashes but a log that moved (log index or tx hash)", () => {
    const moved = compareRange(sides({ observedLogs: [log(11, 0), log(11, 2), log(13, 0)] }));
    expect(moved).toMatchObject({ status: "mismatch", hashMismatches: [], storedLogCount: 3, observedLogCount: 3, logDifferences: 2 });
    const otherTx = compareRange(sides({ observedLogs: [log(11, 0), log(11, 1), log(13, 0, "0xh13", "0xelse")] }));
    expect(otherTx).toMatchObject({ status: "mismatch", logDifferences: 2 });
  });

  it("does not let a duplicated observed log hide a missing one", () => {
    const r = compareRange(sides({ observedLogs: [log(11, 0), log(11, 0), log(13, 0)] }));
    expect(r.status).toBe("mismatch");
    expect(r).toMatchObject({ storedLogCount: 3, observedLogCount: 3, logDifferences: 1 });
  });

  it("marks a stored height with no block row as unmatched", () => {
    const s = sides();
    (s.stored.blockHashes as Map<number, string>).delete(13);
    expect(compareRange(s).hashMismatches).toEqual([{ number: 13, stored: "", observed: "0xh13" }]);
  });
});
