import { createDb, type Database, type Sql } from "@rsi/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { payloadSha256 } from "../src/payload.ts";
import { GATES, runQualityCycle, type GateName, type QualityCycleInput } from "../src/quality.ts";
import { Provider } from "../src/rpc/provider.ts";
import { RpcPool } from "../src/rpc/pool.ts";
import { startRun } from "../src/store.ts";
import { expectStoredChain } from "./support/chain-assert.ts";
import { resetDatabase, tableFingerprints, TEST_DATABASE_URL } from "./support/db.ts";
import { startMockRpc, type MockRpc } from "./support/mock-rpc.ts";
import { CHAIN_ID, commitRanges, contractsOf, RANGES, RUN_ID } from "./support/ranges.ts";
import { SyntheticChain, TEST_TOKEN } from "./support/synthetic-chain.ts";

const [A, B, C] = RANGES;
const B_ID = `${CHAIN_ID}:${B[0]}-${B[1]}`;
const FINALIZED = C[1];
const BAD_HASH = `0x${"1".repeat(64)}`;
const OTHER_HASH = `0x${"a".repeat(64)}`;

const chain = new SyntheticChain();
const contracts = contractsOf(chain);
let database: Database;
let rpc: MockRpc | undefined;

function poolFor(url: string): RpcPool {
  return new RpcPool([new Provider({ name: "mock", url, maxSpan: 20, rps: 10_000, batchSize: 20 })], { maxAttempts: 1 });
}

/** Nothing listens on port 1: a pool that proves a cycle (or a backfill) does not need, or survives losing, the network. */
const deadPool = poolFor("http://127.0.0.1:1");

/** Publish pass only: no backfill job is processed unless the test asks for it. */
function cycle(finalizedBlock: number, extra: Partial<QualityCycleInput> = {}, pool: RpcPool = deadPool) {
  return runQualityCycle(database, pool, { chainId: CHAIN_ID, finalizedBlock, contracts, runId: RUN_ID, maxBackfills: 0, ...extra });
}

async function serve(servedChain: SyntheticChain): Promise<RpcPool> {
  rpc = await startMockRpc({ chain: servedChain, head: C[1], finalized: C[1], maxSpan: 20 });
  return poolFor(rpc.url);
}

async function rangeStates(): Promise<[number, string, boolean][]> {
  const rows = await database.sql<{ from_block: string; status: string; published: boolean }[]>`
    select from_block, status, published_at is not null as published from ops.ranges order by from_block`;
  return rows.map((r) => [Number(r.from_block), r.status, r.published]);
}

interface JobState {
  id: string;
  status: string;
  failure_reason: string;
  attempts: number;
  resolved: boolean;
  updated_at: string;
}

const jobs = () =>
  database.sql<JobState[]>`
    select id, status, failure_reason, attempts, resolved_at is not null as resolved, updated_at::text as updated_at from ops.backfill_jobs order by id`;

const gateRows = (fromBlock: number) =>
  database.sql<{ gate: string; passed: boolean; rows_checked: number; rows_failed: number; detail: string | null }[]>`
    select gate, passed, rows_checked, rows_failed, detail from ops.quality_results where chain_id = ${CHAIN_ID} and from_block = ${fromBlock} order by gate`;

const failedGates = async (fromBlock: number) => (await gateRows(fromBlock)).filter((g) => !g.passed).map((g) => g.gate);

interface Pos {
  block_hash: string;
  log_index: number;
  block_number: string;
}

/** The first `limit` decoded rows of range B, by position. */
const pick = (sql: Sql, table: "erc20_transfers" | "uniswap_v3_swaps", limit: number) =>
  sql<Pos[]>`
    select block_hash, log_index, block_number from ${sql(`chain.${table}`)}
    where block_number between ${B[0]} and ${B[1]} order by block_number, log_index limit ${limit}`;

interface Corruption {
  name: string;
  gate: GateName;
  /** The corruption is invisible to every other gate. */
  only: boolean;
  apply(sql: Sql): Promise<unknown>;
}

const CORRUPTIONS: Corruption[] = [
  {
    name: "a transfer log became a counted reject",
    gate: "decode_rejects_zero",
    only: true,
    apply: async (sql) => {
      // What commitRange stores when decodeRange rejects an ERC-721-shaped Transfer (4 topics).
      const [t] = await pick(sql, "erc20_transfers", 1);
      await sql`update chain.logs set topics = topics || ${BAD_HASH}::text where block_hash = ${t!.block_hash} and log_index = ${t!.log_index}`;
      await sql`delete from chain.erc20_transfers where block_hash = ${t!.block_hash} and log_index = ${t!.log_index}`;
      await sql`update ops.ranges set transfer_count = transfer_count - 1, reject_count = 1 where from_block = ${B[0]}`;
    },
  },
  {
    name: "the range row counts one log too many",
    gate: "counts_consistent",
    only: true,
    apply: (sql) => sql`update ops.ranges set log_count = log_count + 1 where from_block = ${B[0]}`,
  },
  {
    name: "a stored swap disappeared but the range row still counts it",
    gate: "counts_consistent",
    only: false,
    apply: async (sql) => {
      const [s] = await pick(sql, "uniswap_v3_swaps", 1);
      await sql`delete from chain.uniswap_v3_swaps where block_hash = ${s!.block_hash} and log_index = ${s!.log_index}`;
    },
  },
  {
    name: "a parent hash inside the range points elsewhere",
    gate: "blocks_linked",
    only: true,
    apply: (sql) => sql`update chain.blocks set parent_hash = ${BAD_HASH} where number = ${B[0] + 10}`,
  },
  {
    name: "the first block does not extend the previous range",
    gate: "blocks_linked",
    only: true,
    apply: (sql) => sql`update chain.blocks set parent_hash = ${BAD_HASH} where number = ${B[0]}`,
  },
  {
    name: "a block is missing",
    gate: "blocks_linked",
    only: false,
    apply: (sql) => sql`delete from chain.blocks where number = ${B[0] + 5}`,
  },
  {
    name: "a log position exists twice under different block hashes",
    gate: "log_positions_unique",
    only: false,
    apply: (sql) => sql`
      insert into chain.logs
      select chain_id, block_number, ${OTHER_HASH}, log_index, tx_hash, tx_index, address, topics, data
      from chain.logs where block_number = ${B[0] + 1} order by log_index limit 1`,
  },
  {
    name: "a log carries another block's hash (decoded row consistently follows it)",
    gate: "log_block_hash_matches",
    only: true,
    apply: async (sql) => {
      const [t] = await pick(sql, "erc20_transfers", 1);
      await sql`update chain.logs set block_hash = ${OTHER_HASH} where block_hash = ${t!.block_hash} and log_index = ${t!.log_index}`;
      await sql`update chain.erc20_transfers set block_hash = ${OTHER_HASH} where block_hash = ${t!.block_hash} and log_index = ${t!.log_index}`;
    },
  },
  {
    name: "decoded values outside their types",
    gate: "value_bounds",
    only: true,
    apply: async (sql) => {
      const swaps = await pick(sql, "uniswap_v3_swaps", 4);
      const transfers = await pick(sql, "erc20_transfers", 2);
      expect(swaps).toHaveLength(4);
      expect(transfers).toHaveLength(2);
      const at = (p: Pos | undefined) => sql`block_hash = ${p!.block_hash} and log_index = ${p!.log_index}`;
      await sql`update chain.uniswap_v3_swaps set tick = 887273 where ${at(swaps[0])}`;
      await sql`update chain.uniswap_v3_swaps set amount0 = ${(2n ** 255n).toString()}::numeric where ${at(swaps[1])}`;
      await sql`update chain.uniswap_v3_swaps set sqrt_price_x96 = ${(2n ** 160n).toString()}::numeric where ${at(swaps[2])}`;
      await sql`update chain.uniswap_v3_swaps set liquidity = ${(2n ** 128n).toString()}::numeric where ${at(swaps[3])}`;
      await sql`update chain.erc20_transfers set value = ${(2n ** 256n).toString()}::numeric where ${at(transfers[0])}`;
      await sql`update chain.erc20_transfers set from_address = upper(from_address) where ${at(transfers[1])}`;
    },
  },
  {
    name: "a landing log has no decoded row",
    gate: "decoded_matches_landing",
    only: false,
    apply: async (sql) => {
      const [t] = await pick(sql, "erc20_transfers", 1);
      await sql`delete from chain.erc20_transfers where block_hash = ${t!.block_hash} and log_index = ${t!.log_index}`;
    },
  },
  {
    name: "a decoded row claims a transaction its landing log does not have",
    gate: "decoded_matches_landing",
    only: true,
    apply: async (sql) => {
      const [t] = await pick(sql, "erc20_transfers", 1);
      await sql`update chain.erc20_transfers set tx_hash = ${OTHER_HASH} where block_hash = ${t!.block_hash} and log_index = ${t!.log_index}`;
    },
  },
];

beforeEach(async () => {
  await resetDatabase();
  database = createDb(TEST_DATABASE_URL, { max: 4 });
  await startRun(database, RUN_ID, CHAIN_ID);
  await commitRanges(database, chain);
});

afterEach(async () => {
  await rpc?.close();
  rpc = undefined;
  await database.sql.end();
});

describe("publish", () => {
  it("publishes every finalized candidate with all gates passing and leaves ranges above finalized alone", async () => {
    const summary = await cycle(B[1]);

    expect(summary).toEqual({
      published: [
        { fromBlock: A[0], toBlock: A[1] },
        { fromBlock: B[0], toBlock: B[1] },
      ],
      failed: [],
      backfills: [],
    });
    expect(await rangeStates()).toEqual([
      [A[0], "published", true],
      [B[0], "published", true],
      [C[0], "candidate", false],
    ]);
    for (const [from] of [A, B]) {
      const rows = await gateRows(from);
      expect(rows.map((r) => r.gate).sort()).toEqual([...GATES].sort());
      expect(rows.every((r) => r.passed && r.rows_failed === 0 && r.detail === null)).toBe(true);
    }
    // The gates actually looked at rows: a vacuous pass would hide a broken query.
    const checked = Object.fromEntries((await gateRows(A[0])).map((g) => [g.gate, g.rows_checked]));
    const totals = chain.totals(A[0], A[1]);
    // blocks + logs + transfers + swaps; every log decodes in this chain.
    expect(checked.counts_consistent).toBe(totals.blocks + 2 * totals.logs);
    expect(checked.blocks_linked).toBe(totals.blocks);
    expect(checked.log_block_hash_matches).toBe(totals.logs);
    expect(checked.decoded_matches_landing).toBe(2 * totals.logs);
    expect(await gateRows(C[0])).toEqual([]);
    expect(await jobs()).toEqual([]);
  });

  it("publishes a range ending exactly at the finalized block and not one ending a block above it", async () => {
    expect((await cycle(C[1] - 1)).published).toHaveLength(2);
    expect((await rangeStates())[2]).toEqual([C[0], "candidate", false]);

    expect((await cycle(C[1])).published).toEqual([{ fromBlock: C[0], toBlock: C[1] }]);
    expect((await rangeStates())[2]).toEqual([C[0], "published", true]);
  });

  it("is idempotent: published ranges are not re-gated or re-stamped", async () => {
    await cycle(FINALIZED);
    const [before] = await database.sql<{ published_at: string }[]>`select published_at::text from ops.ranges where from_block = ${A[0]}`;
    const summary = await cycle(FINALIZED);
    const [after] = await database.sql<{ published_at: string }[]>`select published_at::text from ops.ranges where from_block = ${A[0]}`;

    expect(summary).toEqual({ published: [], failed: [], backfills: [] });
    expect(after?.published_at).toEqual(before?.published_at);
  });
});

describe.each(CORRUPTIONS)("fail-closed publish: $name", ({ gate, only, apply }) => {
  it(`fails ${gate}, marks the range failed and queues exactly one job`, async () => {
    await apply(database.sql);
    const summary = await cycle(FINALIZED);

    expect(summary.published).toEqual([
      { fromBlock: A[0], toBlock: A[1] },
      { fromBlock: C[0], toBlock: C[1] },
    ]);
    expect(summary.failed).toHaveLength(1);
    expect(summary.failed[0]).toMatchObject({ fromBlock: B[0], toBlock: B[1] });
    if (only) expect(summary.failed[0]?.gates).toEqual([gate]);
    else expect(summary.failed[0]?.gates).toContain(gate);

    expect(await rangeStates()).toEqual([
      [A[0], "published", true],
      [B[0], "failed", false],
      [C[0], "published", true],
    ]);
    const result = (await gateRows(B[0])).find((g) => g.gate === gate);
    expect(result).toMatchObject({ passed: false });
    expect(result!.rows_failed).toBeGreaterThan(0);
    expect(result!.detail).toBeTruthy();

    const queued = await jobs();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ id: B_ID, status: "queued", attempts: 0, resolved: false });
    expect(queued[0]!.failure_reason).toContain(gate);
  });
});

describe("value_bounds", () => {
  it("counts each offending row once", async () => {
    await CORRUPTIONS.find((c) => c.gate === "value_bounds")!.apply(database.sql);
    await cycle(FINALIZED);

    const result = (await gateRows(B[0])).find((g) => g.gate === "value_bounds");
    expect(result?.rows_failed).toBe(6);
    expect(result?.detail).toBe("bad_transfers=2, bad_swaps=4");
  });

  it("accepts the extreme legal values", async () => {
    const [s] = await pick(database.sql, "uniswap_v3_swaps", 1);
    const [t] = await pick(database.sql, "erc20_transfers", 1);
    await database.sql`
      update chain.uniswap_v3_swaps set tick = -887272, amount0 = ${(-(2n ** 255n)).toString()}::numeric, amount1 = ${(2n ** 255n - 1n).toString()}::numeric,
        sqrt_price_x96 = ${(2n ** 160n - 1n).toString()}::numeric, liquidity = ${(2n ** 128n - 1n).toString()}::numeric
      where block_hash = ${s!.block_hash} and log_index = ${s!.log_index}`;
    await database.sql`update chain.erc20_transfers set value = ${(2n ** 256n - 1n).toString()}::numeric where block_hash = ${t!.block_hash} and log_index = ${t!.log_index}`;

    await cycle(FINALIZED);
    expect(await failedGates(B[0])).toEqual([]);
  });
});

describe("repeated failure", () => {
  it("keeps one job and one result row per gate, bumping updated_at", async () => {
    await CORRUPTIONS[1]!.apply(database.sql);
    await cycle(FINALIZED);
    const [first] = await jobs();

    // A re-ingested range comes back as a candidate and fails again.
    await database.sql`update ops.ranges set status = 'candidate' where from_block = ${B[0]}`;
    const summary = await cycle(FINALIZED);
    const after = await jobs();

    expect(summary.failed).toHaveLength(1);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: B_ID, status: "queued", attempts: 0 });
    expect(Date.parse(after[0]!.updated_at)).toBeGreaterThan(Date.parse(first!.updated_at));
    expect(await gateRows(B[0])).toHaveLength(GATES.length);
  });

  it("does not re-gate a failed range: only its backfill job can change it", async () => {
    await CORRUPTIONS[1]!.apply(database.sql);
    await cycle(FINALIZED);
    const before = await gateRows(B[0]);

    const summary = await cycle(FINALIZED);

    expect(summary).toEqual({ published: [], failed: [], backfills: [] });
    expect(await gateRows(B[0])).toEqual(before);
  });
});

describe("backfill", () => {
  it("re-fetches a corrupted range, replaces it and publishes it, resolving the job", async () => {
    const pool = await serve(chain);
    await CORRUPTIONS.find((c) => c.gate === "value_bounds")!.apply(database.sql);
    const [t] = await pick(database.sql, "erc20_transfers", 1);
    await database.sql`delete from chain.erc20_transfers where block_hash = ${t!.block_hash} and log_index = ${t!.log_index}`;
    await database.sql`delete from chain.blocks where number = ${B[0] + 5}`;

    const summary = await cycle(FINALIZED, { maxBackfills: undefined }, pool);

    expect(summary.published).toHaveLength(2);
    expect(summary.failed).toHaveLength(1);
    expect(summary.backfills).toEqual([{ jobId: B_ID, fromBlock: B[0], toBlock: B[1], result: "resolved", reason: null }]);

    await expectStoredChain(database, chain, A[0], C[1]);
    expect(await rangeStates()).toEqual([
      [A[0], "published", true],
      [B[0], "published", true],
      [C[0], "published", true],
    ]);
    const [range] = await database.sql<{ payload_sha256: string; log_count: number; transfer_count: number; swap_count: number; reject_count: number }[]>`
      select payload_sha256, log_count, transfer_count, swap_count, reject_count from ops.ranges where from_block = ${B[0]}`;
    const totals = chain.totals(B[0], B[1]);
    expect(range).toEqual({ payload_sha256: payloadSha256(chain.fetched(B[0], B[1])), log_count: totals.logs, transfer_count: totals.transfers, swap_count: totals.swaps, reject_count: 0 });
    expect(await failedGates(B[0])).toEqual([]);
    expect(await jobs()).toEqual([expect.objectContaining({ id: B_ID, status: "resolved", attempts: 1, resolved: true })]);
  });

  it("processes at most maxBackfills jobs per cycle, least recently touched first", async () => {
    const pool = await serve(chain);
    for (const [from] of RANGES) {
      await database.sql`
        update chain.uniswap_v3_swaps set tick = 900000
        where (block_hash, log_index) in (select block_hash, log_index from chain.uniswap_v3_swaps where block_number between ${from} and ${from + 19} limit 1)`;
    }
    const states = async () => (await jobs()).map((j) => j.status);

    const first = await cycle(FINALIZED, { maxBackfills: 1 }, pool);
    expect(first.failed).toHaveLength(3);
    expect(first.backfills.map((b) => b.fromBlock)).toEqual([A[0]]);
    expect(await states()).toEqual(["resolved", "queued", "queued"]);

    const second = await cycle(FINALIZED, { maxBackfills: 1 }, pool);
    expect(second.backfills.map((b) => b.fromBlock)).toEqual([B[0]]);
    expect(await states()).toEqual(["resolved", "resolved", "queued"]);

    const third = await cycle(FINALIZED, { maxBackfills: undefined }, pool);
    expect(third.backfills.map((b) => b.fromBlock)).toEqual([C[0]]);
    expect(await states()).toEqual(["resolved", "resolved", "resolved"]);
    await expectStoredChain(database, chain, A[0], C[1]);
  });

  it("refuses a re-fetch whose first header does not extend the stored block below, leaving data untouched", async () => {
    await CORRUPTIONS[1]!.apply(database.sql);
    await cycle(FINALIZED);
    const before = await tableFingerprints(database);

    // Same heights, but the chain forked at 1019: block 1020's parent is not the stored 1019.
    const pool = await serve(chain.fork(B[0] - 1, "other"));
    const summary = await cycle(FINALIZED, { maxBackfills: undefined }, pool);

    expect(summary.backfills).toHaveLength(1);
    expect(summary.backfills[0]).toMatchObject({ jobId: B_ID, result: "requeued" });
    expect(summary.backfills[0]!.reason).toMatch(new RegExp(`does not link to stored block ${B[0] - 1}`));
    expect(await tableFingerprints(database)).toEqual(before);
    expect(await jobs()).toEqual([expect.objectContaining({ id: B_ID, status: "queued", attempts: 1, resolved: false })]);
    expect((await jobs())[0]!.failure_reason).toMatch(/does not link to stored block 1019/);
  });

  it("refuses a re-fetch whose last header is not the parent of the stored block above", async () => {
    await CORRUPTIONS[1]!.apply(database.sql);
    await cycle(FINALIZED);
    const before = await tableFingerprints(database);

    const pool = await serve(chain.fork(B[1], "other"));
    const summary = await cycle(FINALIZED, { maxBackfills: undefined }, pool);

    expect(summary.backfills[0]).toMatchObject({ result: "requeued" });
    expect(summary.backfills[0]!.reason).toMatch(new RegExp(`does not link to stored block ${B[1] + 1}`));
    expect(await tableFingerprints(database)).toEqual(before);
    expect(await rangeStates()).toEqual([
      [A[0], "published", true],
      [B[0], "failed", false],
      [C[0], "published", true],
    ]);
  });

  it("re-queues the job when the provider is unreachable, without touching data", async () => {
    await CORRUPTIONS[1]!.apply(database.sql);
    await cycle(FINALIZED);
    const before = await tableFingerprints(database);

    const summary = await cycle(FINALIZED, { maxBackfills: undefined });

    expect(summary.backfills[0]).toMatchObject({ jobId: B_ID, result: "requeued" });
    expect(summary.backfills[0]!.reason).toMatch(/^backfill failed: /);
    expect(await tableFingerprints(database)).toEqual(before);
    expect(await jobs()).toEqual([expect.objectContaining({ status: "queued", attempts: 1 })]);
  });

  it("keeps the job queued, with the new reason, when the re-fetched data still fails a gate", async () => {
    // The provider's logs for one block contain an ERC-721-shaped Transfer: a genuine, persistent reject.
    const at = Array.from({ length: 20 }, (_, i) => B[0] + i).find((n) => chain.entries(n).some((e) => e.transfer))!;
    class RejectingChain extends SyntheticChain {
      override allLogs(n: number) {
        const logs = super.allLogs(n);
        const i = logs.findIndex((l) => l.address === TEST_TOKEN);
        return n !== at ? logs : logs.map((l, k) => (k === i ? { ...l, topics: [...l.topics, BAD_HASH as `0x${string}`] } : l));
      }
    }
    const pool = await serve(new RejectingChain());
    await CORRUPTIONS[1]!.apply(database.sql);

    const summary = await cycle(FINALIZED, { maxBackfills: undefined }, pool);

    expect(summary.backfills[0]).toMatchObject({ result: "requeued", reason: "still failing after backfill: decode_rejects_zero" });
    expect(await rangeStates()).toEqual([
      [A[0], "published", true],
      [B[0], "failed", false],
      [C[0], "published", true],
    ]);
    expect(await failedGates(B[0])).toEqual(["decode_rejects_zero"]);
    expect(await jobs()).toEqual([expect.objectContaining({ status: "queued", attempts: 1, resolved: false })]);
    expect((await jobs())[0]!.failure_reason).toMatch(/decode_rejects_zero \(rejected_logs=1\)/);
  });

  it("picks up a job left running by a crashed process", async () => {
    const pool = await serve(chain);
    await CORRUPTIONS[1]!.apply(database.sql);
    await cycle(FINALIZED);
    await database.sql`update ops.backfill_jobs set status = 'running', attempts = 1`;

    const summary = await cycle(FINALIZED, { maxBackfills: undefined }, pool);

    expect(summary.backfills[0]).toMatchObject({ result: "resolved" });
    expect(await jobs()).toEqual([expect.objectContaining({ status: "resolved", attempts: 2 })]);
    await expectStoredChain(database, chain, A[0], C[1]);
  });

  it("resolves a job whose range is no longer failed without rewriting it", async () => {
    await cycle(FINALIZED);
    await database.sql`
      insert into ops.backfill_jobs (id, chain_id, from_block, to_block, status, failure_reason)
      values (${B_ID}, ${CHAIN_ID}, ${B[0]}, ${B[1]}, 'queued', 'old failure')`;
    const before = await tableFingerprints(database);

    const summary = await cycle(FINALIZED, { maxBackfills: undefined });

    expect(summary.backfills[0]).toMatchObject({ result: "obsolete" });
    expect(await tableFingerprints(database)).toEqual(before);
    expect(await jobs()).toEqual([expect.objectContaining({ status: "resolved", resolved: true })]);
    expect((await jobs())[0]!.failure_reason).toMatch(/obsolete .*range is published.*old failure/);
  });
});
