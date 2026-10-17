import { createDb, erc20Transfers, reorgs, uniswapV3Swaps, type Database } from "@rsi/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadSha256 } from "../src/payload.ts";
import { commitRange, ContinuityError, PayloadMismatchError, recordHalt, resumePoint, rollbackTo, startRun, type RollbackInput } from "../src/store.ts";
import type { DecodedRange, FetchedRange } from "../src/types.ts";
import { verifyIntegrity, type IntegrityReport } from "../src/verify.ts";
import { resetDatabase, tableFingerprints, TEST_DATABASE_URL } from "./support/db.ts";
import { SyntheticChain } from "./support/synthetic-chain.ts";

const CHAIN_ID = 1;
const RUN_ID = "run-1";
const START = 1000;
const SIZE = 20;
const RANGES = [
  [1000, 1019],
  [1020, 1039],
  [1040, 1059],
] as const;

const chain = new SyntheticChain();
let database: Database;

function commit(range: FetchedRange, decoded: DecodedRange, runId = RUN_ID) {
  return commitRange(database, {
    chainId: CHAIN_ID,
    runId,
    range,
    decoded,
    payloadSha256: payloadSha256(range),
    rpcCalls: { mock: { eth_getLogs: 1 } },
  });
}

async function commitAll(): Promise<void> {
  for (const [from, to] of RANGES) await commit(chain.fetched(from, to), chain.decoded(from, to));
}

function failedChecks(report: IntegrityReport): string[] {
  return report.problems.map((p) => p.check);
}

beforeEach(async () => {
  await resetDatabase();
  database = createDb(TEST_DATABASE_URL, { max: 2 });
  await startRun(database, RUN_ID, CHAIN_ID);
});

afterEach(async () => {
  await database.sql.end();
});

describe("test chain", () => {
  it("covers the shapes the indexer has to handle", () => {
    // Guards the fixtures themselves: a chain without these would let the suite pass vacuously.
    const d = chain.decoded(START, 1059);
    expect(d.transfers.length).toBeGreaterThan(20);
    expect(d.swaps.length).toBeGreaterThan(20);
    expect(d.swaps.some((s) => s.amount0.startsWith("-"))).toBe(true);
    expect(d.swaps.some((s) => s.tick < 0)).toBe(true);
    expect(d.transfers.some((t) => t.value === (2n ** 256n - 1n).toString())).toBe(true);
    const perBlock = Array.from({ length: 60 }, (_, i) => chain.entries(START + i).length);
    expect(perBlock).toContain(0);
    expect(new Set(perBlock).size).toBeGreaterThan(3);
  });
});

describe("commitRange", () => {
  it("round-trips decoded rows exactly, including negative amounts and uint256 values", async () => {
    await commitAll();
    const byPosition = (a: { blockNumber: number; logIndex: number }, b: { blockNumber: number; logIndex: number }) =>
      a.blockNumber - b.blockNumber || a.logIndex - b.logIndex;

    const expected = chain.decoded(START, 1059);
    const transfers = (await database.db.select().from(erc20Transfers)).sort(byPosition);
    const swaps = (await database.db.select().from(uniswapV3Swaps)).sort(byPosition);

    expect(transfers.map(({ chainId, fromAddress, toAddress, ...t }) => ({ ...t, from: fromAddress, to: toAddress }))).toEqual(
      expected.transfers.map((t) => ({ ...t })),
    );
    expect(swaps.map(({ chainId, ...s }) => s)).toEqual(expected.swaps);
  });

  it("recommitting an identical range reports already_committed and changes nothing", async () => {
    await commitAll();
    const before = await tableFingerprints(database);

    const [from, to] = RANGES[1];
    const result = await commit(chain.fetched(from, to), chain.decoded(from, to));

    expect(result).toBe("already_committed");
    expect(await tableFingerprints(database)).toEqual(before);
    const report = await verifyIntegrity(database, CHAIN_ID);
    expect(report.ok).toBe(true);
    expect(report.counts.ranges).toBe(3);
  });

  it("rejects a different payload for an already committed first range", async () => {
    const [from, to] = RANGES[0];
    await commit(chain.fetched(from, to), chain.decoded(from, to));
    const before = await tableFingerprints(database);

    const fork = new SyntheticChain({ seed: "fork" });
    await expect(commit(fork.fetched(from, to), fork.decoded(from, to))).rejects.toThrow(PayloadMismatchError);

    expect(await tableFingerprints(database)).toEqual(before);
  });

  it("rejects a mid-chain range whose logs differ by one row, even though headers still link", async () => {
    await commitAll();
    const before = await tableFingerprints(database);

    const [from, to] = RANGES[1];
    const range = chain.fetched(from, to);
    const dropped = range.logs.at(-1)!;
    const truncated: FetchedRange = { ...range, logs: range.logs.slice(0, -1) };
    const decoded = chain.decoded(from, to);
    const survivors: DecodedRange = {
      transfers: decoded.transfers.filter((t) => t.logIndex !== dropped.logIndex || t.blockNumber !== dropped.blockNumber),
      swaps: decoded.swaps.filter((s) => s.logIndex !== dropped.logIndex || s.blockNumber !== dropped.blockNumber),
      rejects: [],
    };

    await expect(commit(truncated, survivors)).rejects.toThrow(PayloadMismatchError);
    expect(await tableFingerprints(database)).toEqual(before);
  });

  it("rejects a range that does not extend the stored block and writes nothing", async () => {
    await commitAll();
    const before = await tableFingerprints(database);

    // A competing fork with an internally consistent range right after the stored tip.
    const fork = new SyntheticChain({ seed: "fork" });
    const next = SIZE * RANGES.length + START;
    await expect(commit(fork.fetched(next, next + SIZE - 1), fork.decoded(next, next + SIZE - 1))).rejects.toThrow(ContinuityError);

    expect(await tableFingerprints(database)).toEqual(before);
  });

  it("is atomic: a failure after the data inserts leaves no partial range behind", async () => {
    const before = await tableFingerprints(database);

    const [from, to] = RANGES[0];
    // The unknown run id violates the ops.ranges foreign key, the last write of the transaction.
    await expect(commit(chain.fetched(from, to), chain.decoded(from, to), "no-such-run")).rejects.toThrow();

    expect(await tableFingerprints(database)).toEqual(before);
    expect(await resumePoint(database, CHAIN_ID, START)).toBe(START);
  });

  it("records run progress and rpc call counts", async () => {
    await commitAll();
    const [run] = await database.sql<{ first_block: string; last_block: string; rpc_calls: unknown }[]>`
      select first_block, last_block, rpc_calls from ops.runs where id = ${RUN_ID}`;
    expect(Number(run?.first_block)).toBe(START);
    expect(Number(run?.last_block)).toBe(1059);
    expect(run?.rpc_calls).toEqual({ mock: { eth_getLogs: 1 } });
  });
});

describe("resumePoint", () => {
  it("starts at START_BLOCK on an empty chain and continues after the last committed range", async () => {
    expect(await resumePoint(database, CHAIN_ID, START)).toBe(START);
    await commit(chain.fetched(1000, 1019), chain.decoded(1000, 1019));
    await commit(chain.fetched(1020, 1039), chain.decoded(1020, 1039));
    expect(await resumePoint(database, CHAIN_ID, START)).toBe(1040);
  });

  it("refuses to resume when the committed ranges start somewhere else", async () => {
    await commit(chain.fetched(1000, 1019), chain.decoded(1000, 1019));
    await expect(resumePoint(database, CHAIN_ID, 500)).rejects.toThrow(/1000/);
  });
});

describe("verifyIntegrity", () => {
  it("reports clean data as ok with exact counts", async () => {
    await commitAll();
    const report = await verifyIntegrity(database, CHAIN_ID);
    const totals = chain.totals(START, 1059);

    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report).toMatchObject({ firstBlock: START, lastBlock: 1059 });
    expect(report.counts).toEqual({ ranges: 3, blocks: totals.blocks, logs: totals.logs, transfers: totals.transfers, swaps: totals.swaps, rejects: 0 });
  });

  it("reports an empty chain as ok", async () => {
    const report = await verifyIntegrity(database, CHAIN_ID);
    expect(report).toMatchObject({ ok: true, firstBlock: null, lastBlock: null });
  });

  it("flags a deleted log row", async () => {
    await commitAll();
    const victim = chain.fetched(1020, 1039).logs[0]!;
    await database.sql`delete from chain.logs where block_hash = ${victim.blockHash} and log_index = ${victim.logIndex}`;

    const report = await verifyIntegrity(database, CHAIN_ID);

    expect(report.ok).toBe(false);
    expect(report.problems.find((p) => p.check === "range_log_count")).toMatchObject({ count: 1, sample: [{ from_block: 1020, log_count: expect.any(Number) }] });
    // The decoded row that lost its landing log is a separate symptom.
    expect(failedChecks(report).some((c) => c === "transfer_without_log" || c === "swap_without_log")).toBe(true);
  });

  it("flags a deleted middle range row as a gap", async () => {
    await commitAll();
    await database.sql`delete from ops.ranges where from_block = 1020`;

    const report = await verifyIntegrity(database, CHAIN_ID);

    expect(report.ok).toBe(false);
    expect(report.problems.find((p) => p.check === "range_gap")).toMatchObject({ count: 1, sample: [{ from_block: 1040, prev_to_block: 1019 }] });
  });

  it.each([
    ["inside a range", 1030],
    ["at a range boundary", 1040],
  ])("flags a tampered parent hash %s", async (_name, height) => {
    await commitAll();
    await database.sql`update chain.blocks set parent_hash = ${`0x${"ab".repeat(32)}`} where number = ${height}`;

    const report = await verifyIntegrity(database, CHAIN_ID);

    expect(report.ok).toBe(false);
    expect(report.problems.find((p) => p.check === "broken_parent_link")).toMatchObject({ count: 1, sample: [{ block_number: height }] });
  });

  it("flags a missing block height", async () => {
    await commitAll();
    await database.sql`delete from chain.blocks where number = 1030`;

    const report = await verifyIntegrity(database, CHAIN_ID);

    expect(report.ok).toBe(false);
    expect(failedChecks(report)).toEqual(expect.arrayContaining(["missing_block", "range_block_count"]));
  });

  it("flags two logs at the same position under different block hashes", async () => {
    await commitAll();
    const victim = chain.fetched(1000, 1019).logs[0]!;
    await database.sql`
      insert into chain.logs (chain_id, block_number, block_hash, log_index, tx_hash, tx_index, address, topics, data)
      select chain_id, block_number, ${`0x${"cd".repeat(32)}`}, log_index, tx_hash, tx_index, address, topics, data
      from chain.logs where block_hash = ${victim.blockHash} and log_index = ${victim.logIndex}`;

    const report = await verifyIntegrity(database, CHAIN_ID);

    expect(report.ok).toBe(false);
    expect(failedChecks(report)).toEqual(expect.arrayContaining(["duplicate_log_position"]));
  });

  it("flags a range whose decoded rows no longer add up to its logs", async () => {
    await commitAll();
    await database.sql`delete from chain.erc20_transfers where (block_hash, log_index) in (
      select block_hash, log_index from chain.erc20_transfers where block_number between 1000 and 1019 limit 1)`;

    const report = await verifyIntegrity(database, CHAIN_ID);

    expect(report.ok).toBe(false);
    expect(failedChecks(report)).toContain("range_decode_balance");
  });
});

describe("rollbackTo", () => {
  const rollback = (ancestorBlock: number, overrides: Partial<RollbackInput> = {}) => {
    const orphaned = chain.fetched(ancestorBlock + 1, 1059).blocks.map((b) => ({ number: b.number, hash: b.hash }));
    return rollbackTo(database, { chainId: CHAIN_ID, runId: RUN_ID, finalizedBlock: 1000, ancestorBlock, forkBlock: ancestorBlock + 1, depth: orphaned.length, orphaned, canonical: [], ...overrides });
  };

  it("drops whole ranges past the ancestor, including their still-canonical blocks, and nothing else", async () => {
    await commitAll();

    // 1025 sits inside the second range: that range is re-ingested whole, so its blocks 1020..1025 go too.
    expect(await rollback(1025)).toEqual({ rollbackFrom: 1020 });

    const kept = new SyntheticChain();
    const expected = kept.totals(1000, 1019);
    const report = await verifyIntegrity(database, CHAIN_ID);
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({ lastBlock: 1019 });
    expect(report.counts).toEqual({ ranges: 1, blocks: expected.blocks, logs: expected.logs, transfers: expected.transfers, swaps: expected.swaps, rejects: 0 });
    expect(await resumePoint(database, CHAIN_ID, START)).toBe(1020);

    const [row] = await database.db.select().from(reorgs);
    expect(row).toMatchObject({ action: "rolled_back", ancestorBlock: 1025, rollbackFrom: 1020, forkBlock: 1026, depth: 34, finalizedBlock: 1000, runId: RUN_ID });
    const [run] = await database.sql<{ last_block: string }[]>`select last_block from ops.runs where id = ${RUN_ID}`;
    expect(Number(run?.last_block)).toBe(1019);
  });

  it("keeps a range that ends exactly at the ancestor", async () => {
    await commitAll();
    expect(await rollback(1039)).toEqual({ rollbackFrom: 1040 });
    expect((await verifyIntegrity(database, CHAIN_ID)).counts.ranges).toBe(2);
  });

  it("accepts the canonical replacement afterwards, which proves the stored tip links to it", async () => {
    await commitAll();
    await rollback(1025);

    const fork = chain.fork(1026, "fork");
    await commit(fork.fetched(1020, 1039), fork.decoded(1020, 1039));
    await commit(fork.fetched(1040, 1059), fork.decoded(1040, 1059));

    const report = await verifyIntegrity(database, CHAIN_ID);
    expect(report.problems).toEqual([]);
    expect(report.counts.blocks).toBe(60);
  });

  it("is atomic: a failed audit insert undoes the deletes", async () => {
    await commitAll();
    const before = await tableFingerprints(database);

    await expect(rollback(1025, { runId: "no-such-run" })).rejects.toThrow();

    expect(await tableFingerprints(database)).toEqual(before);
  });

  it("refuses an ancestor at or above the stored tip and writes nothing", async () => {
    await commitAll();
    const before = await tableFingerprints(database);

    await expect(rollback(1059)).rejects.toThrow(/no committed range/);

    expect(await tableFingerprints(database)).toEqual(before);
  });
});

describe("recordHalt", () => {
  it("writes the audit row and leaves all data alone", async () => {
    await commitAll();
    const before = await tableFingerprints(database);

    await recordHalt(database, { chainId: CHAIN_ID, runId: RUN_ID, finalizedBlock: 1050, forkBlock: 1050, depth: 10, orphaned: [{ number: 1050, hash: chain.header(1050).hash }], canonical: [] });

    const [row] = await database.db.select().from(reorgs);
    expect(row).toMatchObject({ action: "halted", ancestorBlock: null, rollbackFrom: null, forkBlock: 1050 });
    const after = await tableFingerprints(database);
    expect({ ...after, "ops.reorgs": "" }).toEqual({ ...before, "ops.reorgs": "" });
  });
});

describe("verifyIntegrity: reorg audit", () => {
  const claimOrphaned = (height: number, detectedAt: Date) =>
    database.db.insert(reorgs).values({
      chainId: CHAIN_ID,
      runId: RUN_ID,
      detectedAt,
      action: "rolled_back",
      ancestorBlock: height - 1,
      forkBlock: height,
      depth: 1,
      rollbackFrom: height,
      finalizedBlock: 1000,
      orphaned: [{ number: height, hash: chain.header(height).hash }],
      canonical: [],
    });

  it("flags an orphaned hash that is still stored with no later re-ingest", async () => {
    await commitAll();
    await claimOrphaned(1030, new Date(Date.now() + 60_000));

    const report = await verifyIntegrity(database, CHAIN_ID);

    expect(report.ok).toBe(false);
    expect(report.problems.find((p) => p.check === "orphaned_block_still_stored")).toMatchObject({ count: 1, sample: [{ block_number: "1030", hash: chain.header(1030).hash }] });
  });

  it("accepts an orphaned hash that was re-ingested after the reorg (the chain forked back)", async () => {
    await commitAll();
    await claimOrphaned(1030, new Date(Date.now() - 60_000));

    expect((await verifyIntegrity(database, CHAIN_ID)).ok).toBe(true);
  });

  it("ignores halted rows, whose orphaned blocks are deliberately kept", async () => {
    await commitAll();
    await recordHalt(database, { chainId: CHAIN_ID, runId: RUN_ID, finalizedBlock: 1050, forkBlock: 1050, depth: 1, orphaned: [{ number: 1050, hash: chain.header(1050).hash }], canonical: [] });

    expect((await verifyIntegrity(database, CHAIN_ID)).ok).toBe(true);
  });
});
