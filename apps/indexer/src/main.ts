import { randomUUID } from "node:crypto";
import { createDb, type Database } from "@rsi/db";
import pino from "pino";
import { loadConfig } from "./config.ts";
import { runPipeline } from "./pipeline.ts";
import { ReorgBelowFinalizedError } from "./reorg.ts";
import { RpcPool } from "./rpc/pool.ts";
import { Provider } from "./rpc/provider.ts";
import { abandonStaleRuns, finishRun, resumePoint, startRun } from "./store.ts";
import { verifyIntegrity } from "./verify.ts";

// Namespace for the per-chain advisory lock: pg_try_advisory_lock(LOCK_NAMESPACE, chainId).
const LOCK_NAMESPACE = 0x72736900;

async function run(): Promise<number> {
  const config = loadConfig();
  const log = pino({ level: config.logLevel });
  const database = createDb(config.databaseUrl);
  // The lock lives on one dedicated connection and is released by Postgres if this process dies.
  const lockConn = await database.sql.reserve();
  try {
    const [lock] = await lockConn`select pg_try_advisory_lock(${LOCK_NAMESPACE}, ${config.chainId}) as locked`;
    if (!lock?.locked) {
      log.error({ chainId: config.chainId }, "another indexer holds the lock for this chain");
      return 1;
    }

    const abandoned = await abandonStaleRuns(database, config.chainId);
    if (abandoned > 0) log.warn({ abandoned }, "marked stale runs as abandoned");

    const nextBlock = await resumePoint(database, config.chainId, config.startBlock);
    const runId = randomUUID();
    await startRun(database, runId, config.chainId);
    log.info({ runId, chainId: config.chainId, nextBlock, endBlock: config.endBlock }, "run started");

    const pool = new RpcPool(
      config.providers.map((p) => new Provider(p)),
      { onRetry: (err, attempt) => log.warn({ provider: err.provider, kind: err.kind, attempt, err: err.message }, "rpc retry") },
    );
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    try {
      await runPipeline({
        database,
        pool,
        log,
        signal: controller.signal,
        runId,
        chainId: config.chainId,
        tokens: config.tokens,
        pools: config.pools,
        nextBlock,
        endBlock: config.endBlock,
        rangeSize: config.rangeSize,
        fetchConcurrency: config.fetchConcurrency,
        pollIntervalMs: config.pollIntervalMs,
        headPollIntervalMs: config.headPollIntervalMs,
      });
    } catch (err) {
      if (err instanceof ReorgBelowFinalizedError) {
        // Already logged at fatal level with the reorg details; exit code 2 tells the supervisor not to restart blindly.
        await finishRun(database, runId, { status: "failed", reason: err.message });
        return 2;
      }
      const reason = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      log.error({ err }, "run failed");
      await finishRun(database, runId, { status: "failed", reason });
      return 1;
    }

    if (controller.signal.aborted) {
      await finishRun(database, runId, { status: "failed", reason: "interrupted" });
      log.info({ runId }, "interrupted");
    } else {
      await finishRun(database, runId, { status: "succeeded" });
      log.info({ runId, rpcCalls: pool.callCounts() }, "run succeeded");
    }
    return 0;
  } finally {
    lockConn.release();
    await database.sql.end({ timeout: 5 });
  }
}

async function verify(): Promise<number> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const database: Database = createDb(databaseUrl, { max: 1 });
  try {
    const report = await verifyIntegrity(database, Number(process.env.CHAIN_ID ?? 1));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } finally {
    await database.sql.end({ timeout: 5 });
  }
}

const commands: Record<string, () => Promise<number>> = { run, verify };
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.error("usage: main.ts <run|verify>");
  process.exit(2);
}
// Exit explicitly: abandoned in-flight fetches must not keep the process alive.
command().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
