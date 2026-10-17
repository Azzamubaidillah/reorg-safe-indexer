// Seeds a database with a synthetic chain (>= LOGS logs) and measures per-endpoint HTTP latency.
// Run: DATABASE_URL=postgres://postgres@127.0.0.1:54329/indexer_test_m4_api pnpm tsx apps/api/test/latency-bench.ts
// It DROPS and recreates the chain/ops schemas of DATABASE_URL, so point it at a scratch database.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnalyticsReader, exportPublished } from "@rsi/analytics";
import { backfillJobs, createDb, lagSamples, qualityResults, reconciliations, reorgs } from "@rsi/db";
import { startRun } from "../../indexer/src/store.ts";
import { resetDatabase, TEST_DATABASE_URL } from "../../indexer/test/support/db.ts";
import { SyntheticChain } from "../../indexer/test/support/synthetic-chain.ts";
import { buildApp } from "../src/app.ts";
import { CHAIN_ID, commitSpans, hex, POOLS, RUN_ID, setStatus, TOKENS } from "./support.ts";

const TARGET_LOGS = Number(process.env.BENCH_LOGS ?? 200_000);
const REQUESTS = Number(process.env.BENCH_REQUESTS ?? 100);
const RANGE_SIZE = 100;
const REORG_BASE = 17_000_000;
const FIRST_BLOCK = 18_000_000;

const database = createDb(TEST_DATABASE_URL, { max: 4 });
await resetDatabase();
await startRun(database, RUN_ID, CHAIN_ID);

const chain = new SyntheticChain({ tokens: TOKENS, pools: POOLS });
let logs = 0;
let from = FIRST_BLOCK;
const spans: [number, number][] = [];
const started = Date.now();
while (logs < TARGET_LOGS) {
  const to = from + RANGE_SIZE - 1;
  logs += chain.totals(from, to).logs;
  spans.push([from, to]);
  from = to + 1;
}
// Seed in a few batches so progress is visible.
for (let i = 0; i < spans.length; i += 50) {
  await commitSpans(database, chain, spans.slice(i, i + 50));
  process.stderr.write(`seeded ${Math.min(i + 50, spans.length)}/${spans.length} ranges\n`);
}
// Realistic shape: everything published except one failed range mid-chain and the newest five candidates.
await database.sql`update ops.ranges set status = 'published', published_at = now() where chain_id = ${CHAIN_ID}`;
await setStatus(database, spans[Math.floor(spans.length / 2)]![0], "failed");
for (const [f] of spans.slice(-5)) await setStatus(database, f, "candidate");
console.error(`seeded ${logs} logs in ${spans.length} ranges (${((Date.now() - started) / 1000).toFixed(0)}s)`);

const now = Date.now();
await database.db.insert(qualityResults).values(spans.flatMap(([f]) => ["row_counts", "continuity", "parent_hash"].map((gate) => ({ chainId: CHAIN_ID, fromBlock: f, gate, passed: true, rowsChecked: RANGE_SIZE, rowsFailed: 0 }))));
await database.db.insert(reconciliations).values(spans.map(([f, t], i) => ({ chainId: CHAIN_ID, fromBlock: f, toBlock: t, provider: "second", status: i % 50 === 0 ? "mismatch" : "match", blocksChecked: 30, hashMismatches: [], storedLogCount: 300, observedLogCount: 300 })));
await database.db.insert(backfillJobs).values(spans.slice(0, 40).map(([f, t]) => ({ id: `${CHAIN_ID}:${f}-${t}`, chainId: CHAIN_ID, fromBlock: f, toBlock: t, status: "queued", failureReason: "bench", attempts: 1 })));
await database.db.insert(reorgs).values(Array.from({ length: 30 }, (_, i) => ({ chainId: CHAIN_ID, runId: RUN_ID, detectedAt: new Date(now - i * 3600_000), action: "rolled_back", ancestorBlock: REORG_BASE + i, forkBlock: REORG_BASE + i + 1, depth: 2, rollbackFrom: REORG_BASE, finalizedBlock: REORG_BASE - 100, orphaned: [{ number: REORG_BASE + i + 1, hash: hex(i) }], canonical: [{ number: REORG_BASE + i + 1, hash: hex(i + 1000) }] })));
// A realistic lag sample every 12 s for two hours.
await database.db.insert(lagSamples).values(Array.from({ length: 600 }, (_, i) => ({ chainId: CHAIN_ID, sampledAt: new Date(now - i * 12_000), headBlock: from + 5, finalizedBlock: from - 60, storedTip: from - (i % 9) })));

const analyticsDir = await mkdtemp(join(tmpdir(), "rsi-bench-analytics-"));
const exportStarted = Date.now();
await exportPublished(database, { chainId: CHAIN_ID, dir: analyticsDir });
console.error(`exported Parquet in ${((Date.now() - exportStarted) / 1000).toFixed(1)}s`);
const analytics = new AnalyticsReader({ dir: analyticsDir });
const app = await buildApp({ database, analytics, chainId: CHAIN_ID });
const base = await app.listen({ port: 0, host: "127.0.0.1" });

const json = async (path: string) => {
  const res = await fetch(base + path);
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as { items?: Record<string, unknown>[]; nextCursor?: string | null };
};

const sample = (await json("/v1/transfers?limit=200")).items!;
const busy = sample[5]!.from as string;
const swapSample = (await json("/v1/swaps?limit=200")).items!;
const busyPool = swapSample[0]!.pool as string;
const busySwapper = swapSample[7]!.sender as string;
const absent = "0x000000000000000000000000000000000000dead";
const midBlock = FIRST_BLOCK + Math.floor((spans.length * RANGE_SIZE) / 4);

// A cursor deep in the data: walk 40 pages of 200 to get one.
let deep = "";
{
  let cursor = "";
  for (let i = 0; i < 40; i++) {
    const page = await json(`/v1/transfers?limit=200${cursor}`);
    if (!page.nextCursor) break;
    cursor = `&cursor=${page.nextCursor}`;
  }
  deep = cursor;
}

const endpoints: [string, string][] = [
  ["healthz", "/healthz"],
  ["status", "/v1/status"],
  ["reorgs", "/v1/reorgs"],
  ["ranges", "/v1/ranges"],
  ["ranges?status=failed", "/v1/ranges?status=failed"],
  ["ranges/:fromBlock", `/v1/ranges/${spans[Math.floor(spans.length / 3)]![0]}`],
  ["backfill-jobs", "/v1/backfill-jobs"],
  ["backfill-jobs?status=queued", "/v1/backfill-jobs?status=queued"],
  ["reconciliations", "/v1/reconciliations"],
  ["reconciliations?unexplained=true", "/v1/reconciliations?unexplained=true"],
  ["transfers", "/v1/transfers"],
  ["transfers limit=200", "/v1/transfers?limit=200"],
  ["transfers?token", `/v1/transfers?token=${TOKENS[1]}`],
  ["transfers?address (busy)", `/v1/transfers?address=${busy}`],
  ["transfers?address (absent, full scan)", `/v1/transfers?address=${absent}`],
  ["transfers?fromBlock&toBlock", `/v1/transfers?fromBlock=${midBlock}&toBlock=${midBlock + 500}`],
  ["transfers deep cursor", `/v1/transfers?limit=200${deep}`],
  ["swaps", "/v1/swaps"],
  ["swaps limit=200", "/v1/swaps?limit=200"],
  ["swaps?pool", `/v1/swaps?pool=${busyPool}`],
  ["swaps?address (busy)", `/v1/swaps?address=${busySwapper}`],
  ["swaps?address (absent, full scan)", `/v1/swaps?address=${absent}`],
  ["swaps?fromBlock&toBlock", `/v1/swaps?fromBlock=${midBlock}&toBlock=${midBlock + 500}`],
  ["analytics/meta", "/v1/analytics/meta"],
  ["analytics/daily-volume", `/v1/analytics/daily-volume?token=${TOKENS[0]}`],
  ["analytics/pool-ohlc 1h", `/v1/analytics/pool-ohlc?pool=${POOLS[0]}&interval=1h`],
  ["analytics/pool-ohlc 1d", `/v1/analytics/pool-ohlc?pool=${POOLS[0]}&interval=1d`],
];

const percentile = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
console.log(`logs=${logs} ranges=${spans.length} requests/endpoint=${REQUESTS}`);
console.log("endpoint".padEnd(40), "p50 ms".padStart(8), "p95 ms".padStart(8), "max ms".padStart(8));
for (const [name, path] of endpoints) {
  for (let i = 0; i < 5; i++) await json(path); // warm caches and the plan cache
  const times: number[] = [];
  for (let i = 0; i < REQUESTS; i++) {
    const t0 = performance.now();
    await json(path);
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  console.log(name.padEnd(40), percentile(times, 0.5).toFixed(1).padStart(8), percentile(times, 0.95).toFixed(1).padStart(8), times[times.length - 1]!.toFixed(1).padStart(8));
}

await app.close();
await analytics.close();
await database.sql.end();
await rm(analyticsDir, { recursive: true, force: true });
