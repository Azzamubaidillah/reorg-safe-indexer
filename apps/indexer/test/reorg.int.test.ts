import { createDb, reorgs, type Database } from "@rsi/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ReorgBlockRef } from "@rsi/db";
import { verifyIntegrity } from "../src/verify.ts";
import { expectStoredChain } from "./support/chain-assert.ts";
import { contentFingerprints, resetDatabase, TEST_DATABASE_URL } from "./support/db.ts";
import { exitWithin, killAllIndexers, spawnIndexer, waitFor, type IndexerProcess } from "./support/indexer-process.ts";
import { startMockRpc, type MockRpc } from "./support/mock-rpc.ts";
import { SyntheticChain } from "./support/synthetic-chain.ts";

const CHAIN_ID = 1;
const START = 1000;
const HEAD = 1099;
const RANGE_SIZE = 10;

const original = new SyntheticChain();
let rpc: MockRpc;
let database: Database;
let indexer: IndexerProcess;

async function committedTo(): Promise<number> {
  const [row] = await database.sql<{ n: string | null }[]>`select max(to_block) as n from ops.ranges`;
  return Number(row?.n ?? 0);
}

/** Advisory locks of a SIGKILLed indexer outlive it until Postgres notices the closed socket. */
async function waitForLockRelease(): Promise<void> {
  await waitFor("advisory lock release", async () => {
    const [row] = await database.sql<{ n: number }[]>`
      select count(*)::int as n from pg_locks
      where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())`;
    return row?.n === 0 ? true : undefined;
  });
}

/** Fails fast with the indexer's output instead of timing out when it dies early. */
function indexerAlive(): void {
  if (indexer.child.exitCode !== null) throw new Error(`indexer exited with ${indexer.child.exitCode}:\n${indexer.output()}`);
}

async function until(description: string, probe: () => Promise<boolean>): Promise<void> {
  await waitFor(description, async () => {
    indexerAlive();
    return (await probe()) ? true : undefined;
  }, () => indexer.output());
}

async function startIndexer(options: { endBlock?: number; fetchConcurrency?: number } = {}): Promise<void> {
  await waitForLockRelease();
  indexer = spawnIndexer({ rpcUrl: rpc.url, maxSpan: RANGE_SIZE, startBlock: START, rangeSize: RANGE_SIZE, ...options });
}

/** Starts the indexer on the original chain and waits until it has committed up to `head`. */
async function follow(head: number, finalized: number, options: { latencyMs?: number; fetchConcurrency?: number } = {}): Promise<void> {
  rpc = await startMockRpc({ chain: original, head, finalized, maxSpan: RANGE_SIZE, ...options });
  await startIndexer({ fetchConcurrency: options.fetchConcurrency });
  await until(`committed to ${head}`, async () => (await committedTo()) >= head);
}

async function stopIndexer(): Promise<void> {
  indexer.child.kill("SIGTERM");
  expect((await exitWithin(indexer, 30_000)).code, indexer.output()).toBe(0);
}

const refs = (chain: SyntheticChain, from: number, to: number): ReorgBlockRef[] =>
  chain.fetched(from, to).blocks.map((b) => ({ number: b.number, hash: b.hash }));

/** First height of the committed range that holds `height` when ranges tile from START in RANGE_SIZE steps. */
const rangeStart = (height: number) => START + Math.floor((height - START) / RANGE_SIZE) * RANGE_SIZE;

beforeEach(async () => {
  await resetDatabase();
  database = createDb(TEST_DATABASE_URL, { max: 2 });
});

afterEach(async () => {
  killAllIndexers();
  await rpc?.close();
  await database.sql.end();
});

describe("following the head", () => {
  it("ingests up to latest rather than finalized, stops at END_BLOCK, and waits for the head to reach it", async () => {
    rpc = await startMockRpc({ chain: original, head: HEAD, finalized: 1050, maxSpan: RANGE_SIZE });
    await startIndexer({ endBlock: 1119 });
    await until("committed to latest", async () => (await committedTo()) === HEAD);

    // Everything up to latest is in, yet END_BLOCK is not reachable: the run must still be waiting.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(indexer.child.exitCode).toBeNull();
    expect(await committedTo()).toBe(HEAD);

    rpc.setHead(1200);
    expect((await exitWithin(indexer, 30_000)).code, indexer.output()).toBe(0);
    expect(await committedTo()).toBe(1119);
    await expectStoredChain(database, original, START, 1119);
    expect((await verifyIntegrity(database, CHAIN_ID)).ok).toBe(true);
  });
});

describe("reorg replay", () => {
  it.each([1, 3, 12])("a depth-%i fork inside the window converges to the new canonical chain", async (depth) => {
    await follow(HEAD, 1020);
    const forkHeight = HEAD - depth + 1;
    const fork = original.fork(forkHeight, `fork-${depth}`);
    const newHead = HEAD + 5;

    rpc.setChain(fork);
    rpc.setHead(newHead);
    await until(`committed to ${newHead}`, async () => (await committedTo()) === newHead);
    await stopIndexer();

    await expectStoredChain(database, fork, START, newHead);
    const report = await verifyIntegrity(database, CHAIN_ID);
    expect(report.problems).toEqual([]);
    expect(report.counts.blocks).toBe(newHead - START + 1);

    const rows = await database.db.select().from(reorgs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      chainId: CHAIN_ID,
      action: "rolled_back",
      depth,
      forkBlock: forkHeight,
      ancestorBlock: forkHeight - 1,
      rollbackFrom: rangeStart(forkHeight),
      finalizedBlock: 1020,
      orphaned: refs(original, forkHeight, HEAD),
      canonical: refs(fork, forkHeight, HEAD),
    });
    const logged = indexer.logs().filter((l) => l.msg === "reorg");
    expect(logged).toEqual([
      expect.objectContaining({ action: "rolled_back", depth, forkBlock: forkHeight, ancestorBlock: forkHeight - 1, rollbackFrom: rangeStart(forkHeight) }),
    ]);
  });

  it("rolls back when the common ancestor is exactly the finalized block", async () => {
    await follow(HEAD, 1050);
    const fork = original.fork(1051, "edge");

    rpc.setChain(fork);
    rpc.setHead(HEAD + 3);
    await until("reorg handled", async () => (await committedTo()) === HEAD + 3);
    await stopIndexer();

    await expectStoredChain(database, fork, START, HEAD + 3);
    const [row] = await database.db.select().from(reorgs);
    expect(row).toMatchObject({ action: "rolled_back", ancestorBlock: 1050, forkBlock: 1051, depth: 49, rollbackFrom: 1050, finalizedBlock: 1050 });
    expect((await verifyIntegrity(database, CHAIN_ID)).ok).toBe(true);
  });

  it("repairs a fork that happened while the indexer was down", async () => {
    rpc = await startMockRpc({ chain: original, head: HEAD, finalized: 1020, maxSpan: RANGE_SIZE });
    await startIndexer({ endBlock: HEAD });
    expect((await exitWithin(indexer, 60_000)).code, indexer.output()).toBe(0);

    const fork = original.fork(1095, "while-down");
    rpc.setChain(fork);
    rpc.setHead(1110);
    await startIndexer();
    await until("caught up", async () => (await committedTo()) === 1110);
    await stopIndexer();

    await expectStoredChain(database, fork, START, 1110);
    const [row] = await database.db.select().from(reorgs);
    expect(row).toMatchObject({ action: "rolled_back", depth: 5, forkBlock: 1095, ancestorBlock: 1094, rollbackFrom: 1090 });
    expect((await verifyIntegrity(database, CHAIN_ID)).ok).toBe(true);
  });

  it("a replayed range after rollback leaves the same database as a fresh ingest of the canonical chain", async () => {
    await follow(HEAD, 1020);
    const fork = original.fork(1088, "replay");
    rpc.setChain(fork);
    rpc.setHead(HEAD + 5);
    await until("reorg handled", async () => (await committedTo()) === HEAD + 5);
    await stopIndexer();
    const afterReorg = await contentFingerprints(database);
    expect((await database.db.select().from(reorgs)).length).toBe(1);

    await resetDatabase();
    await startIndexer({ endBlock: HEAD + 5 });
    expect((await exitWithin(indexer, 60_000)).code, indexer.output()).toBe(0);

    expect(await contentFingerprints(database)).toEqual(afterReorg);
  });

  it("survives a fork and a fork back: stale orphan hashes reappear legitimately and verify stays ok", async () => {
    await follow(HEAD, 1020);
    const fork = original.fork(1090, "flip");

    rpc.setChain(fork);
    rpc.setHead(1110);
    await until("first reorg", async () => (await committedTo()) === 1110);
    rpc.setChain(original);
    rpc.setHead(1120);
    await until("second reorg", async () => (await committedTo()) === 1120);
    await stopIndexer();

    await expectStoredChain(database, original, START, 1120);
    const rows = await database.db.select().from(reorgs);
    expect(rows.map((r) => [r.action, r.depth, r.forkBlock])).toEqual([
      ["rolled_back", 10, 1090],
      ["rolled_back", 21, 1090],
    ]);
    // The first reorg's orphaned hashes are canonical again, the second's are not stored.
    const report = await verifyIntegrity(database, CHAIN_ID);
    expect(report.problems).toEqual([]);
    const afterFlip = await contentFingerprints(database);

    await resetDatabase();
    await startIndexer({ endBlock: 1120 });
    expect((await exitWithin(indexer, 60_000)).code, indexer.output()).toBe(0);
    expect(await contentFingerprints(database)).toEqual(afterFlip);
  });
});

describe("fork below finalized", () => {
  it.each([
    ["exactly at the finalized block", 1050, 1050],
    ["far below the finalized block", 1010, 1050],
  ])("halts with exit code 2 when the fork starts %s and deletes nothing", async (_name, forkHeight, finalized) => {
    await follow(HEAD, finalized);
    const before = await contentFingerprints(database);
    const fork = original.fork(forkHeight, "deep");

    rpc.setChain(fork);
    rpc.setHead(HEAD + 5);
    const exit = await exitWithin(indexer, 30_000);

    expect(exit.code, indexer.output()).toBe(2);
    expect(await contentFingerprints(database)).toEqual(before);
    // Only stored blocks from the finalized block up are inspected; the stored chain below it is never compared.
    const [row] = await database.db.select().from(reorgs);
    expect(row).toMatchObject({
      action: "halted",
      ancestorBlock: null,
      rollbackFrom: null,
      forkBlock: finalized,
      depth: HEAD - finalized + 1,
      finalizedBlock: finalized,
      orphaned: refs(original, finalized, HEAD),
      canonical: refs(fork, finalized, HEAD),
    });
    const [run] = await database.sql<{ status: string; failure_reason: string }[]>`select status, failure_reason from ops.runs`;
    expect(run?.status).toBe("failed");
    expect(run?.failure_reason).toMatch(/^reorg below finalized/);
    expect(indexer.logs().filter((l) => l.msg === "reorg")).toEqual([expect.objectContaining({ level: 60, action: "halted", forkBlock: finalized })]);
    expect((await verifyIntegrity(database, CHAIN_ID)).ok).toBe(true);
  });

  it("judges the fork against finality as of detection, not the value from the last poll", async () => {
    // Finality and the fork change in one step, so the periodic poll cannot have seen the new value yet.
    await follow(HEAD, 1020);
    const fork = original.fork(1085, "late-finality");

    rpc.setFinalized(1095);
    rpc.setChain(fork);
    rpc.setHead(HEAD + 5);

    expect((await exitWithin(indexer, 30_000)).code, indexer.output()).toBe(2);
    const [row] = await database.db.select().from(reorgs);
    expect(row).toMatchObject({ action: "halted", finalizedBlock: 1095 });
  });
});

describe("reorg while ranges are in flight", () => {
  it("re-fetches ranges whose logs come from the old chain while headers are already new, then converges", async () => {
    await follow(HEAD, 1020);
    const fork = original.fork(1095, "stale");
    // Guard against a vacuous test: the stale logs must really differ from the new headers.
    expect(original.fetched(1100, 1129).logs.length).toBeGreaterThan(0);

    rpc.setChain(fork);
    rpc.setHead(1129);
    rpc.serveStaleLogs({ chain: original, fromHeight: 1100, times: 3 });
    await until("converged", async () => (await committedTo()) === 1129);
    await stopIndexer();

    expect(indexer.logs().filter((l) => l.msg === "inconsistent range, refetching").length).toBeGreaterThanOrEqual(1);
    await expectStoredChain(database, fork, START, 1129);
    const [row] = await database.db.select().from(reorgs);
    expect(row).toMatchObject({ action: "rolled_back", depth: 5, forkBlock: 1095, ancestorBlock: 1094 });
    expect((await verifyIntegrity(database, CHAIN_ID)).ok).toBe(true);
  });

  it("converges when the chain switches in the middle of a multi-range fetch", async () => {
    await follow(HEAD, 1020, { latencyMs: 20, fetchConcurrency: 3 });
    const fork = original.fork(1090, "mid-flight");
    let switched = false;
    rpc.beforeCall((call) => {
      const filter = call.method === "eth_getLogs" ? (call.params[0] as { fromBlock: string }) : undefined;
      if (switched || !filter || Number.parseInt(filter.fromBlock, 16) < 1100) return;
      switched = true;
      rpc.setChain(fork);
    });

    // Four ranges (1100..1139) are requested against the old chain; the first logs call flips it.
    rpc.setHead(1139);
    await until("converged", async () => switched && (await committedTo()) === 1139);
    await stopIndexer();

    await expectStoredChain(database, fork, START, 1139);
    const rows = await database.db.select().from(reorgs);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.action === "rolled_back")).toBe(true);
    expect((await verifyIntegrity(database, CHAIN_ID)).ok).toBe(true);
  });
});
