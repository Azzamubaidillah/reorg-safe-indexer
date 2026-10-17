import { randomUUID } from "node:crypto";
import { createDb, reconciliations, type Database } from "@rsi/db";
import { inArray } from "drizzle-orm";
import pino, { type Logger } from "pino";
import { Alerter } from "./alerts.ts";
import { parseSince } from "./cli.ts";
import { loadConfig, loadRetentionConfig, type Config } from "./config.ts";
import { lagReport, pruneLagSamples, recordLagSample } from "./lag.ts";
import { Metrics } from "./metrics.ts";
import { runPipeline } from "./pipeline.ts";
import { runQualityCycle } from "./quality.ts";
import { verifyRebuild } from "./rebuild.ts";
import { explainReconciliation, reconcileRanges, unexplainedMismatches } from "./reconcile.ts";
import { ReorgBelowFinalizedError } from "./reorg.ts";
import { planRetention, runRetentionCycle } from "./retention.ts";
import { RpcPool } from "./rpc/pool.ts";
import { Provider } from "./rpc/provider.ts";
import { startStatusServer, type StatusServer } from "./status.ts";
import { abandonStaleRuns, acknowledgeHalt, finishRun, resumePoint, startRun, unacknowledgedHalt } from "./store.ts";
import { runEvery } from "./ticker.ts";
import { verifyIntegrity } from "./verify.ts";

// Namespace for the per-chain advisory lock: pg_try_advisory_lock(LOCK_NAMESPACE, chainId).
const LOCK_NAMESPACE = 0x72736900;
// Lock connection + pipeline + quality + reconcile + retention + lag/status queries each need one connection at a time.
const RUN_POOL_SIZE = 7;
const HOUR_MS = 3_600_000;
const DEFAULT_LAG_REPORT_WINDOW = "24h";

const printJson = (value: unknown) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const messageOf = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err));

async function run(): Promise<number> {
  const config = loadConfig();
  const log = pino({ level: config.logLevel });
  const alerter = Alerter.fromEnv(process.env, log);
  const metrics = new Metrics();
  const database = createDb(config.databaseUrl, { max: RUN_POOL_SIZE });
  // The lock lives on one dedicated connection and is released by Postgres if this process dies.
  const lockConn = await database.sql.reserve();
  let statusServer: StatusServer | undefined;
  try {
    const [lock] = await lockConn`select pg_try_advisory_lock(${LOCK_NAMESPACE}, ${config.chainId}) as locked`;
    if (!lock?.locked) {
      log.error({ chainId: config.chainId }, "another indexer holds the lock for this chain");
      return 1;
    }

    const abandoned = await abandonStaleRuns(database, config.chainId);
    if (abandoned > 0) log.warn({ abandoned }, "marked stale runs as abandoned");

    // A halt stays in force until acknowledged: Docker restarts a failed container whatever its exit code, and a
    // restart would only detect the same fork again. Checked before the status server or any RPC call.
    const halt = await unacknowledgedHalt(database, config.chainId);
    if (halt) {
      const reason = `halted: unacknowledged reorg #${halt.id}`;
      const refusedRun = randomUUID();
      await startRun(database, refusedRun, config.chainId);
      await finishRun(database, refusedRun, { status: "failed", reason });
      log.fatal(
        { chainId: config.chainId, reorgId: halt.id, forkBlock: halt.forkBlock, finalizedBlock: halt.finalizedBlock, detectedAt: halt.detectedAt },
        `${reason}; after checking the cause run: ack-halt ${halt.id} "<why it is safe to continue>"`,
      );
      await alerter.haltUnacknowledged({ chainId: config.chainId, reorgId: halt.id });
      return 2;
    }

    if (config.metricsPort !== undefined) {
      statusServer = await startStatusServer(database, metrics, {
        chainId: config.chainId,
        port: config.metricsPort,
        host: config.metricsHost,
        staleAfterMs: config.healthStaleAfterMs,
      });
      log.info({ host: config.metricsHost, port: statusServer.port }, "status server listening");
    }

    const nextBlock = await resumePoint(database, config.chainId, config.startBlock);
    const runId = randomUUID();
    await startRun(database, runId, config.chainId);
    metrics.onStoredTip(nextBlock - 1);
    log.info({ runId, chainId: config.chainId, nextBlock, endBlock: config.endBlock }, "run started");

    const pool = new RpcPool(
      config.providers.map((p) => new Provider(p)),
      {
        onRetry: (err, attempt) => {
          log.warn({ provider: err.provider, kind: err.kind, attempt, err: err.message }, "rpc retry");
          metrics.onRetry(err);
        },
      },
    );
    metrics.trackRpcCalls(() => pool.callCounts());
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    const timers = new AbortController();
    const background = startBackground({ config, database, pool, metrics, alerter, log, runId, signal: timers.signal });

    let code = 0;
    let outcome: { status: "succeeded" } | { status: "failed"; reason: string } = { status: "succeeded" };
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
        events: {
          onHead: (latest) => metrics.onHead(latest),
          onFinalized: (finalized) => metrics.onFinalized(finalized),
          onCommitted: (range) => metrics.onRangeCommitted(range),
          onReorg: async (reorg) => {
            metrics.onReorg(reorg);
            if (reorg.action === "halted") await alerter.halt({ chainId: config.chainId, forkBlock: reorg.forkBlock, finalizedBlock: reorg.finalizedBlock });
          },
        },
      });
      if (controller.signal.aborted) {
        outcome = { status: "failed", reason: "interrupted" };
        log.info({ runId }, "interrupted");
      } else {
        log.info({ runId, rpcCalls: pool.callCounts() }, "run succeeded");
      }
    } catch (err) {
      if (err instanceof ReorgBelowFinalizedError) {
        // Already logged at fatal level with the reorg details; exit code 2 tells the supervisor not to restart blindly.
        outcome = { status: "failed", reason: err.message };
        code = 2;
      } else {
        const reason = messageOf(err);
        log.error({ err }, "run failed");
        await alerter.runCrash(reason);
        outcome = { status: "failed", reason };
        code = 1;
      }
    } finally {
      timers.abort();
      await background;
      await statusServer?.close();
      statusServer = undefined;
    }
    await finishRun(database, runId, outcome);
    return code;
  } finally {
    await statusServer?.close();
    lockConn.release();
    await database.sql.end({ timeout: 5 });
  }
}

interface BackgroundInput {
  config: Config;
  database: Database;
  pool: RpcPool;
  metrics: Metrics;
  alerter: Alerter;
  log: Logger;
  runId: string;
  /** Aborting stops the timers; the returned promise resolves once every in-flight task has finished. */
  signal: AbortSignal;
}

/** Quality gates, reconciliation, retention, lag samples and pruning, each on its own timer beside the pipeline. */
function startBackground(input: BackgroundInput): Promise<unknown> {
  const { config, database, pool, metrics, alerter, log, runId, signal } = input;
  const { chainId } = config;
  const contracts = { tokens: config.tokens, pools: config.pools };
  // A failing task is logged and alerted, then retried on its next tick; it never reaches the pipeline.
  const every = (name: string, intervalMs: number, task: () => Promise<void>) =>
    runEvery(intervalMs, signal, task, async (err) => {
      log.error({ err, task: name }, "background task failed, retrying next tick");
      await alerter.alert(`task:${name}`, `${name} task failed: ${messageOf(err)}`);
    });
  const loops: Promise<void>[] = [];

  loops.push(
    every("quality", config.qualityIntervalMs, async () => {
      const { finalizedBlock } = metrics.snapshot();
      if (finalizedBlock === null) return;
      const summary = await runQualityCycle(database, pool, { chainId, finalizedBlock, contracts, runId, maxBackfills: config.qualityMaxBackfills });
      for (const range of summary.failed) {
        const failed = await database.sql<{ gate: string; detail: string | null }[]>`
          select gate, detail from ops.quality_results where chain_id = ${chainId} and from_block = ${range.fromBlock} and not passed`;
        for (const { gate, detail } of failed) {
          metrics.onGateFailure(gate);
          log.error({ gate, fromBlock: range.fromBlock, toBlock: range.toBlock, detail }, "quality gate failed");
          await alerter.gateFailure({ gate, fromBlock: range.fromBlock, toBlock: range.toBlock, detail: detail ?? undefined });
        }
      }
      // Backfills publish ranges too, so ask the database rather than summing this cycle's summary.
      const [published] = await database.sql<{ to_block: number | null }[]>`
        select max(to_block)::float8 as to_block from ops.ranges where chain_id = ${chainId} and status = 'published'`;
      if (published?.to_block != null) metrics.onPublished(published.to_block);
      if (summary.published.length + summary.failed.length + summary.backfills.length > 0) {
        log.info({ published: summary.published.length, failed: summary.failed.length, backfills: summary.backfills }, "quality cycle");
      }
    }),
  );

  if (config.reconcileProvider) {
    const secondSource = new Provider(config.reconcileProvider);
    loops.push(
      every("reconcile", config.reconcileIntervalMs, async () => {
        const { finalizedBlock } = metrics.snapshot();
        if (finalizedBlock === null) return;
        const summary = await reconcileRanges(database, secondSource, { chainId, finalizedBlock, limit: config.reconcileLimit, contracts });
        metrics.onReconciliation({ mismatches: summary.mismatchIds.length });
        if (summary.providerErrors > 0) log.warn({ failures: summary.failures }, "second source could not answer for some ranges");
        if (summary.mismatchIds.length === 0) return;
        const mismatched = await database.db
          .select({ fromBlock: reconciliations.fromBlock, toBlock: reconciliations.toBlock })
          .from(reconciliations)
          .where(inArray(reconciliations.id, summary.mismatchIds));
        for (const range of mismatched) {
          log.error({ ...range, provider: secondSource.name }, "reconciliation mismatch");
          await alerter.reconciliationMismatch(range);
        }
      }),
    );
  }

  loops.push(
    every("retention", config.retentionIntervalMs, async () => {
      const summary = await runRetentionCycle(database, { chainId, ...config.retention });
      if (summary.manifestProblem) log.warn({ problem: summary.manifestProblem }, "decoded rows not purged");
      if (summary.landing.length + summary.decoded.length > 0) {
        // Counts and the newest purged block, not one entry per range: a first cycle can purge hundreds.
        log.info(
          {
            landingRanges: summary.landing.length,
            landingPurgedThrough: summary.landing.at(-1)?.toBlock,
            logsDeleted: summary.landing.reduce((sum, r) => sum + r.deleted.logs, 0),
            decodedRanges: summary.decoded.length,
            decodedPurgedThrough: summary.decoded.at(-1)?.toBlock,
            decodedRowsDeleted: summary.decoded.reduce((sum, r) => sum + r.deleted.transfers + r.deleted.swaps, 0),
          },
          "retention cycle",
        );
      }
    }),
  );

  loops.push(
    every("lag", config.lagSampleIntervalMs, async () => {
      const { headBlock, finalizedBlock, storedTip } = metrics.snapshot();
      if (headBlock === null || finalizedBlock === null) return;
      await recordLagSample(database, { chainId, headBlock, finalizedBlock, storedTip });
      if (storedTip !== null) await alerter.headLag(Math.max(0, headBlock - storedTip));
    }),
    every("prune", HOUR_MS, async () => {
      const pruned = await pruneLagSamples(database, { chainId });
      if (pruned > 0) log.info({ pruned }, "pruned old lag samples");
    }),
  );
  return Promise.all(loops);
}

async function withDatabase<T>(work: (database: Database, chainId: number) => Promise<T>): Promise<T> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const database = createDb(databaseUrl, { max: 1 });
  try {
    return await work(database, Number(process.env.CHAIN_ID ?? 1));
  } finally {
    await database.sql.end({ timeout: 5 });
  }
}

async function retentionCommand(args: string[]): Promise<number> {
  if (args.length !== 1 || args[0] !== "--dry-run") {
    console.error("usage: main.ts retention --dry-run");
    return 2;
  }
  const { retention } = loadRetentionConfig();
  printJson(await withDatabase((database, chainId) => planRetention(database, { chainId, ...retention })));
  return 0;
}

const verify = () =>
  withDatabase(async (database, chainId) => {
    const report = await verifyIntegrity(database, chainId);
    printJson(report);
    return report.ok ? 0 : 1;
  });

async function rebuildVerify(): Promise<number> {
  const { tokens, pools } = loadConfig();
  return withDatabase(async (database, chainId) => {
    const report = await verifyRebuild(database, { chainId, contracts: { tokens, pools } });
    printJson(report);
    return report.equal ? 0 : 1;
  });
}

async function ackHalt([id, ...words]: string[]): Promise<number> {
  const reorgId = Number(id);
  if (!Number.isInteger(reorgId) || reorgId <= 0 || words.join(" ").trim() === "") {
    console.error("usage: main.ts ack-halt <reorgId> <text>");
    return 2;
  }
  await withDatabase((database, chainId) => acknowledgeHalt(database, chainId, reorgId, words.join(" ")));
  printJson({ id: reorgId, acknowledged: true });
  return 0;
}

async function explain([id, ...words]: string[]): Promise<number> {
  const reconciliationId = Number(id);
  if (!Number.isInteger(reconciliationId) || reconciliationId <= 0 || words.length === 0) {
    console.error("usage: main.ts explain-reconciliation <id> <text>");
    return 2;
  }
  await withDatabase((database) => explainReconciliation(database, reconciliationId, words.join(" ")));
  printJson({ id: reconciliationId, explained: true });
  return 0;
}

async function reconciliationsCommand(args: string[]): Promise<number> {
  if (args.length !== 1 || args[0] !== "--unexplained") {
    console.error("usage: main.ts reconciliations --unexplained");
    return 2;
  }
  printJson(await withDatabase((database, chainId) => unexplainedMismatches(database, chainId)));
  return 0;
}

async function lagReportCommand(args: string[]): Promise<number> {
  const flag = args.indexOf("--since");
  if (args.length !== 0 && (flag !== 0 || args.length !== 2)) {
    console.error("usage: main.ts lag-report [--since <ISO timestamp|duration such as 72h>]");
    return 2;
  }
  const since = parseSince(args[1] ?? DEFAULT_LAG_REPORT_WINDOW, Date.now());
  printJson({ since: since.toISOString(), ...(await withDatabase((database, chainId) => lagReport(database, { chainId, since }))) });
  return 0;
}

const commands: Record<string, (args: string[]) => Promise<number>> = {
  run,
  verify,
  "rebuild-verify": rebuildVerify,
  retention: retentionCommand,
  "ack-halt": ackHalt,
  "explain-reconciliation": explain,
  reconciliations: reconciliationsCommand,
  "lag-report": lagReportCommand,
};
const command = commands[process.argv[2] ?? ""];
if (!command) {
  console.error(`usage: main.ts <${Object.keys(commands).join("|")}>`);
  process.exit(2);
}
// Exit explicitly: abandoned in-flight fetches must not keep the process alive.
command(process.argv.slice(3)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
