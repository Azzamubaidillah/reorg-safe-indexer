import { createServer, type AddressInfo } from "node:net";
import { createDb, reorgs, type Database } from "@rsi/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RawLog } from "../src/types.ts";
import type { StatusReport } from "../src/status.ts";
import { expectStoredChain } from "./support/chain-assert.ts";
import { resetDatabase, TEST_DATABASE_URL } from "./support/db.ts";
import { exitWithin, killAllIndexers, spawnIndexer, waitFor, type IndexerProcess } from "./support/indexer-process.ts";
import { startMockRpc, type MockRpc } from "./support/mock-rpc.ts";
import { SyntheticChain } from "./support/synthetic-chain.ts";

const START = 1000;
const HEAD = 1099;
const FINALIZED = 1059;
const RANGE_SIZE = 10;
const FINALIZED_RANGES = (FINALIZED - START + 1) / RANGE_SIZE;
const CANDIDATE_RANGES = (HEAD - FINALIZED) / RANGE_SIZE;
const GATES_PER_RANGE = 7;
const SECOND_SOURCE = "second-source";

const original = new SyntheticChain();

/** The second source misses one log: everything else, block hashes included, equals `original`. */
class MissingLogChain extends SyntheticChain {
  constructor(
    private readonly missingBlock: number,
    private readonly missingLogIndex: number,
  ) {
    super();
  }

  override allLogs(n: number): RawLog[] {
    const logs = super.allLogs(n);
    return n === this.missingBlock ? logs.filter((l) => l.logIndex !== this.missingLogIndex) : logs;
  }
}

let rpc: MockRpc;
let secondSource: MockRpc;
let database: Database;
let indexer: IndexerProcess | undefined;
let port: number;

async function freePort(): Promise<number> {
  const probe = createServer();
  const listening = Promise.withResolvers<void>();
  probe.listen(0, "127.0.0.1", () => listening.resolve());
  await listening.promise;
  const free = (probe.address() as AddressInfo).port;
  const closed = Promise.withResolvers<void>();
  probe.close(() => closed.resolve());
  await closed.promise;
  return free;
}

const count = async (query: Promise<{ n: number }[]>) => (await query)[0]?.n ?? 0;

/** Postgres releases a dead indexer's advisory lock when it notices the closed socket; wait for that. */
async function waitForLockRelease(): Promise<void> {
  await waitFor("advisory lock release", async () => {
    const [row] = await database.sql<{ n: number }[]>`
      select count(*)::int as n from pg_locks
      where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())`;
    return row?.n === 0 ? true : undefined;
  });
}

function startIndexer(extraEnv: Record<string, string> = {}, endBlock?: number): IndexerProcess {
  indexer = spawnIndexer({
    rpcUrl: rpc.url,
    maxSpan: RANGE_SIZE,
    startBlock: START,
    rangeSize: RANGE_SIZE,
    endBlock,
    extraEnv: {
      METRICS_PORT: String(port),
      QUALITY_INTERVAL_MS: "100",
      LAG_SAMPLE_INTERVAL_MS: "50",
      RECONCILE_PROVIDER: JSON.stringify({ name: SECOND_SOURCE, url: secondSource.url, maxSpan: RANGE_SIZE, rps: 1000, batchSize: 50 }),
      RECONCILE_INTERVAL_MS: "100",
      RECONCILE_LIMIT: "10",
      ...extraEnv,
    },
  });
  return indexer;
}

/** Waits for `probe`, failing with the indexer's output instead of timing out if it dies early. */
async function until(description: string, probe: () => Promise<boolean>): Promise<void> {
  await waitFor(
    description,
    async () => {
      if (indexer && indexer.child.exitCode !== null) throw new Error(`indexer exited with ${indexer.child.exitCode}:\n${indexer.output()}`);
      return (await probe()) ? true : undefined;
    },
    () => indexer?.output() ?? "",
  );
}

/** SIGTERM must end the run cleanly: exit 0, nothing logged at error level except `expectedErrors`, status server gone. */
async function stopIndexer(expectedErrors: string[] = []): Promise<void> {
  const proc = indexer!;
  proc.child.kill("SIGTERM");
  expect((await exitWithin(proc, 30_000)).code, proc.output()).toBe(0);
  expect(proc.logs().filter((l) => (l.level as number) >= 50 && !expectedErrors.includes(l.msg as string))).toEqual([]);
  await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  const [run] = await database.sql<{ status: string; failure_reason: string | null }[]>`select status, failure_reason from ops.runs`;
  expect(run).toEqual({ status: "failed", failure_reason: "interrupted" });
}

async function cli(...args: string[]): Promise<{ code: number | null; stdout: string; output: string }> {
  await waitForLockRelease();
  const proc = spawnIndexer({ rpcUrl: rpc.url, maxSpan: RANGE_SIZE, startBlock: START, rangeSize: RANGE_SIZE, args });
  const { code } = await exitWithin(proc, 60_000);
  return { code, stdout: proc.stdout(), output: proc.output() };
}

const status = async () => (await (await fetch(`http://127.0.0.1:${port}/status`)).json()) as StatusReport;

const rangesByStatus = async () =>
  Object.fromEntries(
    (await database.sql<{ status: string; n: number }[]>`select status, count(*)::int as n from ops.ranges group by status`).map((r) => [r.status, r.n]),
  );

beforeEach(async () => {
  await resetDatabase();
  database = createDb(TEST_DATABASE_URL, { max: 2 });
  port = await freePort();
  rpc = await startMockRpc({ chain: original, head: HEAD, finalized: FINALIZED, maxSpan: RANGE_SIZE });
  secondSource = await startMockRpc({ chain: original, head: HEAD, finalized: FINALIZED, maxSpan: RANGE_SIZE });
});

afterEach(async () => {
  killAllIndexers();
  indexer = undefined;
  await Promise.all([rpc.close(), secondSource.close()]);
  await database.sql.end();
});

describe("M3 run loop", () => {
  it("publishes finalized ranges with 7 passing gates, reconciles them, samples lag and serves status, then stops cleanly", async () => {
    startIndexer();
    await until("finalized ranges published, reconciled and lag sampled", async () => {
      const lagSamples = await count(database.sql`select count(*)::int as n from ops.lag_samples`);
      const matches = await count(database.sql`select count(*)::int as n from ops.reconciliations where status = 'match'`);
      return (await rangesByStatus()).published === FINALIZED_RANGES && matches === FINALIZED_RANGES && lagSamples >= 2;
    });

    // Everything at or below finalized is published; everything above is still a candidate.
    expect(await rangesByStatus()).toEqual({ published: FINALIZED_RANGES, candidate: CANDIDATE_RANGES });
    const published = await database.sql<{ from_block: string; to_block: string }[]>`select from_block, to_block from ops.ranges where status = 'published' order by from_block`;
    expect(published.map((r) => Number(r.to_block))).toEqual(Array.from({ length: FINALIZED_RANGES }, (_, i) => START + (i + 1) * RANGE_SIZE - 1));
    expect(Math.max(...published.map((r) => Number(r.to_block)))).toBeLessThanOrEqual(FINALIZED);

    const gates = await database.sql<{ from_block: string; n: number; passed: number }[]>`
      select from_block, count(*)::int as n, (count(*) filter (where passed))::int as passed from ops.quality_results group by from_block order by from_block`;
    expect(gates.map((g) => [Number(g.from_block), g.n, g.passed])).toEqual(published.map((r) => [Number(r.from_block), GATES_PER_RANGE, GATES_PER_RANGE]));

    const reconciled = await database.sql<{ to_block: string; provider: string; status: string }[]>`select to_block, provider, status from ops.reconciliations order by from_block`;
    expect(reconciled).toHaveLength(FINALIZED_RANGES);
    expect(reconciled.every((r) => r.provider === SECOND_SOURCE && r.status === "match" && Number(r.to_block) <= FINALIZED)).toBe(true);

    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
    const metrics = await (await fetch(`http://127.0.0.1:${port}/metrics`)).text();
    expect(metrics).toContain(`indexer_head_block ${HEAD}`);
    expect(metrics).toContain(`indexer_finalized_block ${FINALIZED}`);
    expect(metrics).toContain(`indexer_stored_tip_block ${HEAD}`);
    expect(metrics).toContain(`indexer_ranges_committed_total ${(HEAD - START + 1) / RANGE_SIZE}`);
    expect(metrics).toContain("indexer_finalized_lag_blocks 0");
    expect(metrics).toMatch(/indexer_rpc_calls_total\{provider="mock",method="eth_getLogs"\} \d+/);
    const report = await status();
    expect(report).toMatchObject({
      head: HEAD,
      finalized: FINALIZED,
      storedTip: HEAD,
      lastPublishedBlock: FINALIZED,
      reconciliation: { match: FINALIZED_RANGES, mismatch: 0, unexplained: 0 },
    });
    expect(report.ranges.published.ranges).toBe(FINALIZED_RANGES);
    expect(report.ranges.candidate.ranges).toBe(CANDIDATE_RANGES);

    await stopIndexer();

    const lag = await cli("lag-report", "--since", "1h");
    expect(lag.code, lag.output).toBe(0);
    const lagJson = JSON.parse(lag.stdout) as { samples: number; headLag: { p95: number | null } };
    expect(lagJson.samples).toBeGreaterThanOrEqual(2);
    expect(lagJson.headLag.p95).not.toBeNull();
    expect((await cli("lag-report", "--since", "soon")).code).toBe(1);
  });

  it("rolls back a reorg inside the finalized window while the timers run, without touching published ranges", async () => {
    startIndexer();
    await until("finalized ranges published", async () => (await rangesByStatus()).published === FINALIZED_RANGES);
    const publishedAtBefore = await database.sql<{ from_block: string; published_at: Date }[]>`select from_block, published_at from ops.ranges where status = 'published' order by from_block`;

    // The last 10 blocks are replaced, 40 above finalized; two more blocks arrive on the new chain.
    const fork = original.fork(HEAD - 9, "fork-in-window");
    const newHead = HEAD + 2;
    rpc.setChain(fork);
    rpc.setHead(newHead);
    await until("fork ingested", async () => (await status()).storedTip === newHead);
    // Let several more quality, reconcile and lag ticks run against the rolled-back data.
    const checksBefore = await count(database.sql`select count(*)::int as n from ops.lag_samples`);
    await until("timers still ticking", async () => (await count(database.sql`select count(*)::int as n from ops.lag_samples`)) >= checksBefore + 3);

    const rows = await database.db.select().from(reorgs);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: "rolled_back", forkBlock: HEAD - 9, finalizedBlock: FINALIZED });
    expect(await rangesByStatus()).toMatchObject({ published: FINALIZED_RANGES });
    const publishedAtAfter = await database.sql<{ from_block: string; published_at: Date }[]>`select from_block, published_at from ops.ranges where status = 'published' order by from_block`;
    expect(publishedAtAfter).toEqual(publishedAtBefore);
    expect((await status()).recentReorgs).toHaveLength(1);
    expect(await (await fetch(`http://127.0.0.1:${port}/metrics`)).text()).toContain('indexer_reorgs_total{action="rolled_back"} 1');

    await stopIndexer();
    await expectStoredChain(database, fork, START, newHead);
  });

  it("records a mismatch when the second source misses a log, alerts, lists it as unexplained until explained", async () => {
    // Block 1005 must carry a tracked log for the second source to drop.
    const dropped = original.entries(1005)[0];
    expect(dropped).toBeDefined();
    await secondSource.close();
    secondSource = await startMockRpc({ chain: new MissingLogChain(1005, dropped!.log.logIndex), head: HEAD, finalized: FINALIZED, maxSpan: RANGE_SIZE });

    startIndexer();
    await until("all finalized ranges reconciled", async () => (await count(database.sql`select count(*)::int as n from ops.reconciliations`)) === FINALIZED_RANGES);
    await until("mismatch visible in status", async () => (await status()).reconciliation.unexplained === 1);
    expect(await (await fetch(`http://127.0.0.1:${port}/metrics`)).text()).toContain("indexer_reconciliation_mismatches_total 1");
    const alert = indexer!.logs().find((l) => l.alert === "reconciliation");
    expect(alert).toMatchObject({ msg: "Reconciliation mismatch in blocks 1000-1009" });
    await stopIndexer(["reconciliation mismatch"]);

    const listed = await cli("reconciliations", "--unexplained");
    expect(listed.code, listed.output).toBe(0);
    const unexplained = JSON.parse(listed.stdout) as { id: number; fromBlock: number; toBlock: number; status: string; provider: string; storedLogCount: number; observedLogCount: number }[];
    expect(unexplained).toHaveLength(1);
    expect(unexplained[0]).toMatchObject({ fromBlock: 1000, toBlock: 1009, status: "mismatch", provider: SECOND_SOURCE });
    expect(unexplained[0]!.storedLogCount).toBe(unexplained[0]!.observedLogCount + 1);
    // The matching ranges were not flagged.
    expect(await count(database.sql`select count(*)::int as n from ops.reconciliations where status = 'match'`)).toBe(FINALIZED_RANGES - 1);

    expect((await cli("explain-reconciliation", "999999", "no such row")).code).toBe(1);
    expect((await cli("explain-reconciliation", String(unexplained[0]!.id))).code).toBe(2);
    const explained = await cli("explain-reconciliation", String(unexplained[0]!.id), "second", "source", "node", "pruned", "one", "log");
    expect(explained.code, explained.output).toBe(0);
    const [row] = await database.sql<{ explanation: string }[]>`select explanation from ops.reconciliations where id = ${unexplained[0]!.id}`;
    expect(row?.explanation).toBe("second source node pruned one log");

    const after = await cli("reconciliations", "--unexplained");
    expect(after.code, after.output).toBe(0);
    expect(JSON.parse(after.stdout)).toEqual([]);
    expect((await cli("reconciliations")).code).toBe(2);
  });

  it("retention --dry-run lists what would be purged without writing, and refuses to run without the flag", async () => {
    startIndexer();
    await until("finalized ranges published and reconciled", async () => {
      const matches = await count(database.sql`select count(*)::int as n from ops.reconciliations where status = 'match'`);
      return (await rangesByStatus()).published === FINALIZED_RANGES && matches === FINALIZED_RANGES;
    });
    const logsBefore = await count(database.sql`select count(*)::int as n from chain.logs`);

    // The running indexer keeps everything (its retention is effectively unlimited); the CLI is told 1 day.
    const dryRun = spawnIndexer({ rpcUrl: rpc.url, maxSpan: RANGE_SIZE, startBlock: START, rangeSize: RANGE_SIZE, args: ["retention", "--dry-run"], extraEnv: { LANDING_RETENTION_DAYS: "1" } });
    expect((await exitWithin(dryRun, 60_000)).code, dryRun.output()).toBe(0);
    const plan = JSON.parse(dryRun.stdout()) as { landing: { fromBlock: number; toBlock: number }[]; decoded: unknown[]; manifestProblem: string | null };
    expect(plan.landing.map((r) => r.fromBlock)).toEqual(Array.from({ length: FINALIZED_RANGES }, (_, i) => START + i * RANGE_SIZE));
    expect(plan).toMatchObject({ decoded: [], manifestProblem: null });
    expect(await count(database.sql`select count(*)::int as n from chain.logs`)).toBe(logsBefore);
    expect(await count(database.sql`select count(*)::int as n from ops.ranges where landing_purged_at is not null`)).toBe(0);

    await stopIndexer();
    expect((await cli("retention")).code).toBe(2);
  });

  it("purges landing logs of published, reconciled ranges on its own timer; verify and rebuild-verify stay green", async () => {
    startIndexer({ LANDING_RETENTION_DAYS: "1", RETENTION_INTERVAL_MS: "100" });
    await until("every finalized range purged", async () => (await count(database.sql`select count(*)::int as n from ops.ranges where landing_purged_at is not null`)) === FINALIZED_RANGES);

    // Only published ranges lose logs: the candidates above finalized keep theirs, and every range keeps its decoded rows and blocks.
    const purged = await database.sql<{ status: string }[]>`select status from ops.ranges where landing_purged_at is not null`;
    expect(purged.every((r) => r.status === "published")).toBe(true);
    expect(await count(database.sql`select count(*)::int as n from chain.logs where block_number <= ${FINALIZED}`)).toBe(0);
    expect(await count(database.sql`select count(*)::int as n from chain.logs where block_number > ${FINALIZED}`)).toBe(original.totals(FINALIZED + 1, HEAD).logs);
    expect(await count(database.sql`select count(*)::int as n from chain.erc20_transfers`)).toBe(original.totals(START, HEAD).transfers);
    expect(await count(database.sql`select count(*)::int as n from chain.blocks`)).toBe(HEAD - START + 1);
    await stopIndexer();
    // Ranges become published and reconciled over several quality/reconcile cycles, so the purge is spread over several
    // retention cycles; their per-cycle counts must add up to exactly the purged set (no range counted twice). Read after
    // the graceful stop so the last cycle's log line has been written.
    const purgedByCycles = indexer!.logs().filter((l) => l.msg === "retention cycle").reduce((sum, l) => sum + (l.landingRanges as number), 0);
    expect(purgedByCycles).toBe(FINALIZED_RANGES);

    const verify = await cli("verify");
    expect(verify.code, verify.output).toBe(0);
    expect(JSON.parse(verify.stdout)).toMatchObject({ ok: true, purged: { landingRanges: FINALIZED_RANGES, decodedRanges: 0 } });
    const rebuild = await cli("rebuild-verify");
    expect(rebuild.code, rebuild.output).toBe(0);
    expect(JSON.parse(rebuild.stdout)).toMatchObject({ equal: true, skippedRanges: FINALIZED_RANGES, logsScanned: original.totals(FINALIZED + 1, HEAD).logs });
  });

  it("rebuild-verify exits 0 on clean data and 1 once a decoded row is tampered with", async () => {
    startIndexer({}, FINALIZED);
    expect((await exitWithin(indexer!, 60_000)).code, indexer!.output()).toBe(0);

    const clean = await cli("rebuild-verify");
    expect(clean.code, clean.output).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({ equal: true, tables: [{ table: "erc20_transfers", equal: true }, { table: "uniswap_v3_swaps", equal: true }] });

    const tampered = await database.sql`
      update chain.erc20_transfers set value = value + 1
      where (block_hash, log_index) = (select block_hash, log_index from chain.erc20_transfers order by block_number, log_index limit 1)`;
    expect(tampered.count).toBe(1);
    const broken = await cli("rebuild-verify");
    expect(broken.code, broken.output).toBe(1);
    const report = JSON.parse(broken.stdout) as { equal: boolean; tables: { table: string; equal: boolean; firstDifferences: { kind: string }[] }[] };
    expect(report.equal).toBe(false);
    const transfers = report.tables.find((t) => t.table === "erc20_transfers");
    expect(transfers).toMatchObject({ equal: false, firstDifferences: [{ kind: "different" }] });
    expect(report.tables.find((t) => t.table === "uniswap_v3_swaps")?.equal).toBe(true);
  });
});
