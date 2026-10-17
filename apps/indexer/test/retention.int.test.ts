import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDb, type Database } from "@rsi/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runQualityCycle } from "../src/quality.ts";
import { reconcileRanges } from "../src/reconcile.ts";
import { verifyRebuild } from "../src/rebuild.ts";
import { planRetention, runRetentionCycle, type RetentionInput, type RetentionSummary } from "../src/retention.ts";
import { RpcPool } from "../src/rpc/pool.ts";
import { Provider } from "../src/rpc/provider.ts";
import { startRun } from "../src/store.ts";
import { verifyIntegrity } from "../src/verify.ts";
import { resetDatabase, tableFingerprints, TEST_DATABASE_URL } from "./support/db.ts";
import { waitFor } from "./support/indexer-process.ts";
import { startMockRpc, type MockRpc } from "./support/mock-rpc.ts";
import { CHAIN_ID, commitRanges, contractsOf, RANGES, RUN_ID } from "./support/ranges.ts";
import { SyntheticChain } from "./support/synthetic-chain.ts";

const [A, B, C] = RANGES;
const chain = new SyntheticChain();
const contracts = contractsOf(chain);

/** Block n of the synthetic chain is stamped 1_600_000_000 + 12n seconds. */
const at = (block: number) => (1_600_000_000 + 12 * block) * 1000;
const LANDING_MS = 1_000_000;
const DECODED_MS = 2_000_000;
/** A and B ended more than LANDING_MS ago, C did not. */
const NOW = new Date(at(B[1]) + LANDING_MS + 1_000);
/** Every range is older than both retentions. */
const LATE = new Date(at(C[1]) + DECODED_MS + 1_000);

let database: Database;
let dir: string;

beforeEach(async () => {
  await resetDatabase();
  database = createDb(TEST_DATABASE_URL, { max: 4 });
  dir = await mkdtemp(join(tmpdir(), "retention-test-"));
  await startRun(database, RUN_ID, CHAIN_ID);
});

afterEach(async () => {
  await database.sql.end();
  await rm(dir, { recursive: true, force: true });
});

/** Commits the three ranges and publishes them with the real gates, as the indexer would. */
async function commitAndPublish(spans: readonly (readonly [number, number])[] = RANGES): Promise<void> {
  await commitRanges(database, chain, spans);
  const summary = await runQualityCycle(database, deadPool, { chainId: CHAIN_ID, finalizedBlock: spans.at(-1)![1], contracts, runId: RUN_ID, maxBackfills: 0 });
  expect(summary.failed).toEqual([]);
  expect(summary.published).toHaveLength(spans.length);
}

/** Nothing listens on port 1: the quality cycles in these tests must not need the network. */
const deadPool = new RpcPool([new Provider({ name: "dead", url: "http://127.0.0.1:1", maxSpan: 20, rps: 10_000, batchSize: 1 })], { maxAttempts: 1 });

function input(extra: Partial<RetentionInput> = {}): RetentionInput {
  return { chainId: CHAIN_ID, now: NOW, landingRetentionMs: LANDING_MS, decodedRetentionMs: undefined, analyticsManifestPath: undefined, maxRanges: 100, ...extra };
}

const cycle = (extra: Partial<RetentionInput> = {}) => runRetentionCycle(database, input(extra));

/** A manifest in the analytics store's format; only the fields retention reads matter. */
async function manifest(exported: [number, number][], chainId = CHAIN_ID): Promise<string> {
  const path = join(dir, "_manifest.json");
  await writeFile(path, JSON.stringify({ version: 1, chainId, exportedAt: new Date(0).toISOString(), exportedThroughBlock: exported.at(-1)?.[1] ?? 0, exported, days: {} }));
  return path;
}

const everything = (extra: Partial<RetentionInput> = {}) => ({ now: LATE, decodedRetentionMs: DECODED_MS, ...extra });

const refs = (ranges: readonly { fromBlock: number; toBlock: number }[]) => ranges.map((r) => [r.fromBlock, r.toBlock]);

async function reconciliation(range: readonly [number, number], status: "match" | "mismatch"): Promise<void> {
  await database.sql`
    insert into ops.reconciliations (chain_id, from_block, to_block, provider, status, blocks_checked, hash_mismatches, stored_log_count, observed_log_count)
    values (${CHAIN_ID}, ${range[0]}, ${range[1]}, 'second', ${status}, ${range[1] - range[0] + 1}, '[]'::jsonb, 1, ${status === "match" ? 1 : 2})`;
}

interface Stored {
  blocks: number;
  logs: number;
  transfers: number;
  swaps: number;
}

async function stored(from: number, to: number): Promise<Stored> {
  const [row] = await database.sql<Stored[]>`
    select
      (select count(*) from chain.blocks where number between ${from} and ${to})::int as blocks,
      (select count(*) from chain.logs where block_number between ${from} and ${to})::int as logs,
      (select count(*) from chain.erc20_transfers where block_number between ${from} and ${to})::int as transfers,
      (select count(*) from chain.uniswap_v3_swaps where block_number between ${from} and ${to})::int as swaps`;
  return row!;
}

async function flags(): Promise<[number, boolean, boolean][]> {
  const rows = await database.sql<{ from_block: string; landing: boolean; decoded: boolean }[]>`
    select from_block, landing_purged_at is not null as landing, decoded_purged_at is not null as decoded from ops.ranges order by from_block`;
  return rows.map((r) => [Number(r.from_block), r.landing, r.decoded]);
}

const whole = (from: number, to: number): Stored => chain.totals(from, to);

describe("landing purge", () => {
  beforeEach(() => commitAndPublish());

  it("deletes the logs of old published ranges and nothing else", async () => {
    const before = await tableFingerprints(database);
    const logsOfC = await database.sql`select * from chain.logs where block_number between ${C[0]} and ${C[1]} order by block_number, log_index`;

    const summary = await cycle();

    expect(refs(summary.landing)).toEqual([A, B]);
    expect(summary.landing.map((r) => r.deleted)).toEqual([
      { logs: whole(...A).logs, transfers: 0, swaps: 0 },
      { logs: whole(...B).logs, transfers: 0, swaps: 0 },
    ]);
    expect(summary.decoded).toEqual([]);
    expect(await flags()).toEqual([[A[0], true, false], [B[0], true, false], [C[0], false, false]]);
    // Blocks and decoded rows of every range, and the logs of the young one, are untouched.
    expect(await stored(...A)).toEqual({ ...whole(...A), logs: 0 });
    expect(await stored(...B)).toEqual({ ...whole(...B), logs: 0 });
    expect(await stored(...C)).toEqual(whole(...C));
    expect(await database.sql`select * from chain.logs where block_number between ${C[0]} and ${C[1]} order by block_number, log_index`).toEqual(logsOfC);
    const after = await tableFingerprints(database);
    for (const table of ["chain.blocks", "chain.erc20_transfers", "chain.uniswap_v3_swaps", "ops.runs", "ops.reorgs"]) expect(after[table], table).toBe(before[table]);
    expect(after["chain.logs"]).not.toBe(before["chain.logs"]);
  });

  it("is idempotent: a second cycle finds nothing and writes nothing", async () => {
    await cycle();
    const before = await tableFingerprints(database);

    expect(await cycle()).toEqual({ landing: [], decoded: [], manifestProblem: null });
    expect(await tableFingerprints(database)).toEqual(before);
  });

  it("measures age from the last block of the range: exactly the limit is not old enough", async () => {
    expect((await cycle({ now: new Date(at(A[1]) + LANDING_MS) })).landing).toEqual([]);
    expect(refs((await cycle({ now: new Date(at(B[1]) + LANDING_MS) })).landing)).toEqual([A]);
  });

  it.each(["candidate", "failed"])("never purges a %s range", async (status) => {
    await database.sql`update ops.ranges set status = ${status}, published_at = null where from_block = ${A[0]}`;

    expect(refs((await cycle()).landing)).toEqual([B]);
    expect(await stored(...A)).toEqual(whole(...A));
  });

  it("stops at maxRanges and continues oldest first on the next cycle", async () => {
    expect(refs((await cycle({ now: LATE, maxRanges: 1 })).landing)).toEqual([A]);
    expect(refs((await cycle({ now: LATE, maxRanges: 1 })).landing)).toEqual([B]);
    expect(refs((await cycle({ now: LATE, maxRanges: 1 })).landing)).toEqual([C]);
    expect(await cycle({ now: LATE, maxRanges: 1 })).toMatchObject({ landing: [] });
  });

  describe("with the reconciler active", () => {
    it("needs a match row: a mismatch or no row at all blocks the range", async () => {
      await reconciliation(A, "match");
      await reconciliation(B, "mismatch");

      expect(refs((await cycle({ now: LATE })).landing)).toEqual([A]);
      expect(await flags()).toEqual([[A[0], true, false], [B[0], false, false], [C[0], false, false]]);
      expect(await stored(...B)).toEqual(whole(...B));
      expect(await stored(...C)).toEqual(whole(...C));

      await reconciliation(B, "match");
      await reconciliation(C, "match");
      expect(refs((await cycle({ now: LATE })).landing)).toEqual([B, C]);
    });

    it("accepts a range with a match row even if another source disagreed once", async () => {
      await reconciliation(A, "mismatch");
      await reconciliation(A, "match");
      expect(refs((await cycle({ now: LATE })).landing)).toEqual([A]);
    });

    it("ignores reconciliation rows of other chains", async () => {
      await database.sql`
        insert into ops.reconciliations (chain_id, from_block, to_block, provider, status, blocks_checked, hash_mismatches, stored_log_count, observed_log_count)
        values (2, 1, 2, 'second', 'match', 2, '[]'::jsonb, 1, 1)`;
      expect(refs((await cycle()).landing)).toEqual([A, B]);
    });
  });

  it("re-checks the status under the range lock: a range that stopped being published meanwhile is skipped", async () => {
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    // Like a backfill: takes the range lock and moves the range out of `published` before the cycle can.
    const holder = database.sql.begin(async (tx) => {
      await tx`update ops.ranges set status = 'failed', published_at = null where chain_id = ${CHAIN_ID} and from_block = ${A[0]}`;
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const running = cycle();
    await waitFor("the purge of the first range to wait on its lock", async () => {
      const [row] = await database.sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query like '%landing_purged_at%'`;
      return row?.n ? true : undefined;
    });
    release.resolve();
    await holder;

    const summary = await running;
    expect(refs(summary.landing)).toEqual([B]);
    expect(await flags()).toEqual([[A[0], false, false], [B[0], true, false], [C[0], false, false]]);
    expect(await stored(...A)).toEqual(whole(...A));
  });
});

describe("decoded purge", () => {
  beforeEach(() => commitAndPublish());

  it("deletes decoded rows only after landing, only with a manifest that covers the range", async () => {
    const path = await manifest([[A[0], C[1]]]);

    const summary = await cycle(everything({ analyticsManifestPath: path }));

    expect(refs(summary.landing)).toEqual([A, B, C]);
    expect(refs(summary.decoded)).toEqual([A, B, C]);
    expect(summary.decoded.map((r) => r.deleted)).toEqual(RANGES.map(([from, to]) => ({ logs: 0, transfers: whole(from, to).transfers, swaps: whole(from, to).swaps })));
    expect(await flags()).toEqual([[A[0], true, true], [B[0], true, true], [C[0], true, true]]);
    expect(await stored(1000, 1059)).toEqual({ blocks: 60, logs: 0, transfers: 0, swaps: 0 });
    expect(summary.manifestProblem).toBeNull();
  });

  it("never purges decoded rows when decoded retention or the manifest path is unset", async () => {
    const path = await manifest([[A[0], C[1]]]);

    expect(refs((await cycle({ now: LATE, analyticsManifestPath: path })).decoded)).toEqual([]);
    expect(refs((await cycle({ now: LATE, decodedRetentionMs: DECODED_MS })).decoded)).toEqual([]);
    expect(await flags()).toEqual([[A[0], true, false], [B[0], true, false], [C[0], true, false]]);
    expect((await stored(1000, 1059)).transfers).toBe(whole(1000, 1059).transfers);
  });

  it("purges exactly the decoded rows of the old range and keeps those younger than their retention", async () => {
    const path = await manifest([[A[0], C[1]]]);
    // Only A is older than DECODED_MS.
    const summary = await cycle({ now: new Date(at(A[1]) + DECODED_MS + 1_000), landingRetentionMs: 1, decodedRetentionMs: DECODED_MS, analyticsManifestPath: path });

    expect(refs(summary.landing)).toEqual([A, B, C]);
    expect(refs(summary.decoded)).toEqual([A]);
    expect(await flags()).toEqual([[A[0], true, true], [B[0], true, false], [C[0], true, false]]);
    expect(await stored(...A)).toEqual({ blocks: 20, logs: 0, transfers: 0, swaps: 0 });
    expect(await stored(...B)).toEqual({ ...whole(...B), logs: 0 });
    expect(await stored(...C)).toEqual({ ...whole(...C), logs: 0 });
  });

  it("reports a missing or foreign manifest and keeps the decoded rows", async () => {
    const missing = join(dir, "nope", "_manifest.json");
    const summary = await cycle(everything({ analyticsManifestPath: missing }));
    expect(refs(summary.landing)).toEqual([A, B, C]);
    expect(summary.decoded).toEqual([]);
    expect(summary.manifestProblem).toBe(`no analytics manifest at ${missing}`);

    const foreign = await manifest([[A[0], C[1]]], 2);
    expect((await cycle(everything({ analyticsManifestPath: foreign }))).manifestProblem).toBe("analytics manifest holds chain 2, not 1");
    expect((await stored(1000, 1059)).transfers).toBe(whole(1000, 1059).transfers);
  });

  it("fails loudly on a manifest it cannot read", async () => {
    const path = join(dir, "_manifest.json");
    await writeFile(path, JSON.stringify({ version: 2, chainId: CHAIN_ID, exported: [] }));
    await expect(cycle(everything({ analyticsManifestPath: path }))).rejects.toThrow();
    await writeFile(path, "{ not json");
    await expect(cycle(everything({ analyticsManifestPath: path }))).rejects.toThrow();
  });

  it("needs the manifest to cover the range, and a range sharing its UTC day with an unexported one waits", async () => {
    // Nothing exported: nothing goes.
    expect(refs((await cycle(everything({ analyticsManifestPath: await manifest([]) }))).decoded)).toEqual([]);

    // A and B exported, C not. All three end on the same UTC day, and the exporter rebuilds a day from Postgres whole,
    // so purging the exported part of that day could cost rows when C is exported: nothing goes yet.
    expect(refs((await cycle(everything({ analyticsManifestPath: await manifest([[A[0], B[1]]]) }))).decoded)).toEqual([]);

    expect(refs((await cycle(everything({ analyticsManifestPath: await manifest([[A[0], C[1]]]) }))).decoded)).toEqual([A, B, C]);
  });

  it("does not wait for an unexported range on a later UTC day", async () => {
    // About 2.6 days after the others: a different UTC day, and the lowest unexported range.
    const far = [20_000, 20_019] as const;
    await commitRanges(database, chain, [far]);
    await database.sql`update ops.ranges set status = 'published', published_at = now() where from_block = ${far[0]}`;

    const summary = await cycle({
      now: new Date(at(far[1]) + DECODED_MS + 1_000),
      landingRetentionMs: 1,
      decodedRetentionMs: DECODED_MS,
      analyticsManifestPath: await manifest([[A[0], C[1]]]),
    });

    expect(refs(summary.decoded)).toEqual([A, B, C]);
    expect((await stored(...far)).transfers).toBe(whole(...far).transfers);
  });

  it("is blocked while landing is not purged, because decoded rows are rebuilt from landing", async () => {
    await reconciliation(A, "mismatch");
    await reconciliation(B, "match");
    await reconciliation(C, "match");

    const summary = await cycle(everything({ analyticsManifestPath: await manifest([[A[0], C[1]]]) }));

    expect(refs(summary.landing)).toEqual([B, C]);
    expect(refs(summary.decoded)).toEqual([B, C]);
    expect(await flags()).toEqual([[A[0], false, false], [B[0], true, true], [C[0], true, true]]);
    expect(await stored(...A)).toEqual(whole(...A));
  });

  it("shares maxRanges with the landing step", async () => {
    const path = await manifest([[A[0], C[1]]]);
    const run = (): Promise<RetentionSummary> => cycle(everything({ analyticsManifestPath: path, maxRanges: 2 }));

    const first = await run();
    expect([refs(first.landing), refs(first.decoded)]).toEqual([[A, B], []]);
    const second = await run();
    expect([refs(second.landing), refs(second.decoded)]).toEqual([[C], [A]]);
    const third = await run();
    expect([refs(third.landing), refs(third.decoded)]).toEqual([[], [B, C]]);
    expect(await cycle(everything({ analyticsManifestPath: path }))).toEqual({ landing: [], decoded: [], manifestProblem: null });
  });
});

describe("dry run", () => {
  beforeEach(() => commitAndPublish());

  it("lists what a cycle would purge, writes nothing, and matches what the cycle then does", async () => {
    const options = everything({ analyticsManifestPath: await manifest([[A[0], C[1]]]) });
    const before = await tableFingerprints(database);

    const plan = await planRetention(database, input(options));

    expect(await tableFingerprints(database)).toEqual(before);
    expect(await flags()).toEqual([[A[0], false, false], [B[0], false, false], [C[0], false, false]]);
    expect([refs(plan.landing), refs(plan.decoded), plan.manifestProblem]).toEqual([[A, B, C], [A, B, C], null]);

    const summary = await cycle(options);
    expect([refs(summary.landing), refs(summary.decoded)]).toEqual([refs(plan.landing), refs(plan.decoded)]);
  });

  it("plans with the same budget as the cycle", async () => {
    const options = everything({ analyticsManifestPath: await manifest([[A[0], C[1]]]), maxRanges: 4 });
    const plan = await planRetention(database, input(options));
    expect([plan.landing.length, plan.decoded.length]).toEqual([3, 1]);
  });
});

describe("consumers of purged ranges", () => {
  beforeEach(() => commitAndPublish());

  it("verifyIntegrity stays ok and skips only the purged parts", async () => {
    await cycle();
    const afterLanding = await verifyIntegrity(database, CHAIN_ID);
    expect(afterLanding).toMatchObject({ ok: true, problems: [], purged: { landingRanges: 2, decodedRanges: 0 } });
    expect(afterLanding.counts).toMatchObject({ ranges: 3, blocks: 60, logs: whole(...C).logs, transfers: whole(1000, 1059).transfers });

    await cycle(everything({ analyticsManifestPath: await manifest([[A[0], C[1]]]) }));
    const afterDecoded = await verifyIntegrity(database, CHAIN_ID);
    expect(afterDecoded).toMatchObject({ ok: true, problems: [], purged: { landingRanges: 3, decodedRanges: 3 } });
    expect(afterDecoded.counts).toMatchObject({ blocks: 60, logs: 0, transfers: 0, swaps: 0 });
  });

  it("verifyIntegrity still checks logs of ranges that were not purged, and blocks of all", async () => {
    await cycle();
    const [log] = await database.sql<{ block_number: string; log_index: number }[]>`
      select block_number, log_index from chain.logs where block_number between ${C[0]} and ${C[1]} order by block_number, log_index limit 1`;
    await database.sql`delete from chain.logs where block_number = ${log!.block_number} and log_index = ${log!.log_index}`;
    await database.sql`delete from chain.blocks where number = ${A[0] + 5}`;

    const report = await verifyIntegrity(database, CHAIN_ID);

    expect(report.ok).toBe(false);
    const problems = Object.fromEntries(report.problems.map((p) => [p.check, p.count]));
    expect(problems).toMatchObject({ range_log_count: 1, missing_block: 1, range_block_count: 1 });
    expect(report.problems.find((p) => p.check === "range_log_count")?.sample).toEqual([expect.objectContaining({ from_block: C[0] })]);
  });

  it("verifyIntegrity still flags a decoded row without a log in a range whose landing was not purged", async () => {
    await cycle();
    await database.sql`
      delete from chain.logs
      where (block_hash, log_index) = (select block_hash, log_index from chain.erc20_transfers where block_number between ${C[0]} and ${C[1]} order by block_number, log_index limit 1)`;

    const report = await verifyIntegrity(database, CHAIN_ID);

    // Ranges A and B have decoded rows without logs too, but those logs were purged on purpose.
    expect(Object.fromEntries(report.problems.map((p) => [p.check, p.count]))).toEqual({ range_log_count: 1, transfer_without_log: 1 });
  });

  it("a quality cycle after a purge changes nothing and keeps gating new ranges", async () => {
    await cycle(everything({ analyticsManifestPath: await manifest([[A[0], C[1]]]) }));
    const gateRows = () => database.sql`select * from ops.quality_results order by from_block, gate`;
    const jobs = () => database.sql`select * from ops.backfill_jobs`;
    const [gates, backfills, ranges] = [await gateRows(), await jobs(), await flags()];

    const summary = await runQualityCycle(database, deadPool, { chainId: CHAIN_ID, finalizedBlock: C[1], contracts, runId: RUN_ID, maxBackfills: 2 });

    expect(summary).toEqual({ published: [], failed: [], backfills: [] });
    expect(await gateRows()).toEqual(gates);
    expect(await jobs()).toEqual(backfills);
    expect(await flags()).toEqual(ranges);

    // The next range still extends the chain across the purged one and passes every gate.
    await commitRanges(database, chain, [[1060, 1079]]);
    const next = await runQualityCycle(database, deadPool, { chainId: CHAIN_ID, finalizedBlock: 1079, contracts, runId: RUN_ID, maxBackfills: 2 });
    expect(next.published).toEqual([{ fromBlock: 1060, toBlock: 1079 }]);
    expect(next.failed).toEqual([]);
  });

  it("rebuild-verify covers ranges with landing present, equal to the stored decoded rows, and counts the skipped ones", async () => {
    await cycle();
    const report = await verifyRebuild(database, { chainId: CHAIN_ID, contracts });

    expect(report.equal).toBe(true);
    expect(report.skippedRanges).toBe(2);
    expect(report.logsScanned).toBe(whole(...C).logs);
    expect(report.tables.map((t) => [t.table, t.storedRows, t.rebuiltRows])).toEqual([
      ["erc20_transfers", whole(...C).transfers, whole(...C).transfers],
      ["uniswap_v3_swaps", whole(...C).swaps, whole(...C).swaps],
    ]);
    expect(report.rejects).toEqual({ rebuilt: 0, recorded: 0 });
  });

  it("rebuild-verify still sees tampering in the ranges it covers, and is trivially equal when everything is purged", async () => {
    await cycle();
    await database.sql`
      update chain.erc20_transfers set value = value + 1
      where (block_hash, log_index) = (select block_hash, log_index from chain.erc20_transfers where block_number between ${C[0]} and ${C[1]} order by block_number, log_index limit 1)`;
    const tampered = await verifyRebuild(database, { chainId: CHAIN_ID, contracts });
    expect(tampered.equal).toBe(false);
    expect(tampered.skippedRanges).toBe(2);

    await database.sql`
      update chain.erc20_transfers set value = value - 1
      where (block_hash, log_index) = (select block_hash, log_index from chain.erc20_transfers where block_number between ${C[0]} and ${C[1]} order by block_number, log_index limit 1)`;
    await cycle({ now: LATE });
    const allPurged = await verifyRebuild(database, { chainId: CHAIN_ID, contracts });
    expect(allPurged).toMatchObject({ equal: true, skippedRanges: 3, logsScanned: 0 });
    // Decoded rows of purged ranges are outside the comparison too, whatever they hold.
    await database.sql`update chain.erc20_transfers set value = value + 1`;
    expect((await verifyRebuild(database, { chainId: CHAIN_ID, contracts })).equal).toBe(true);
  });

  describe("reconciler", () => {
    let rpc: MockRpc;

    beforeEach(async () => {
      rpc = await startMockRpc({ chain, head: C[1] + 20, finalized: C[1], maxSpan: 20 });
    });

    afterEach(async () => {
      await rpc.close();
    });

    it("skips landing-purged ranges instead of recording a mismatch against their missing logs", async () => {
      await cycle();
      const second = new Provider({ name: "second", url: rpc.url, maxSpan: 20, rps: 10_000, batchSize: 1 });

      const summary = await reconcileRanges(database, second, { chainId: CHAIN_ID, finalizedBlock: C[1], limit: 10, contracts });

      expect(summary).toMatchObject({ rangesChecked: 1, matches: 1, mismatchIds: [], providerErrors: 0 });
      const rows = await database.sql<{ from_block: string; status: string }[]>`select from_block, status from ops.reconciliations order by from_block`;
      expect(rows.map((r) => [Number(r.from_block), r.status])).toEqual([[C[0], "match"]]);
    });
  });
});
