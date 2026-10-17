import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { TEST_DATABASE_URL } from "./db.ts";
import { TEST_POOL, TEST_TOKEN } from "./synthetic-chain.ts";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

export interface IndexerEnv {
  rpcUrl: string;
  maxSpan: number;
  startBlock: number;
  endBlock?: number;
  rangeSize: number;
  fetchConcurrency?: number;
  /** Defaults are short so tests following a moving head do not wait on real-world polling cadence. */
  headPollIntervalMs?: number;
  pollIntervalMs?: number;
}

export interface IndexerProcess {
  child: ChildProcess;
  /** Resolves when the process exits; never rejects. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Parsed pino JSON lines written to stdout so far. */
  logs(): Record<string, unknown>[];
  /** Raw stdout + stderr, for failure messages. */
  output(): string;
}

const running = new Set<ChildProcess>();

/**
 * Runs the CLI as `node --import tsx main.ts run` so a SIGKILL hits the indexer
 * itself rather than a pnpm or tsx wrapper that would leave it orphaned.
 */
export function spawnIndexer(options: IndexerEnv): IndexerProcess {
  const env = {
    ...process.env,
    DATABASE_URL: TEST_DATABASE_URL,
    CHAIN_ID: "1",
    RPC_PROVIDERS: JSON.stringify([{ name: "mock", url: options.rpcUrl, maxSpan: options.maxSpan, rps: 1000, batchSize: 50 }]),
    ERC20_TOKENS: TEST_TOKEN,
    UNISWAP_V3_POOLS: TEST_POOL,
    START_BLOCK: String(options.startBlock),
    RANGE_SIZE: String(options.rangeSize),
    FETCH_CONCURRENCY: String(options.fetchConcurrency ?? 2),
    HEAD_POLL_INTERVAL_MS: String(options.headPollIntervalMs ?? 50),
    POLL_INTERVAL_MS: String(options.pollIntervalMs ?? 200),
    LOG_LEVEL: "info",
    ...(options.endBlock === undefined ? {} : { END_BLOCK: String(options.endBlock) }),
  };
  const child = spawn(process.execPath, ["--import", "tsx", "apps/indexer/src/main.ts", "run"], { cwd: repoRoot, env });
  running.add(child);

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exit = Promise.withResolvers<{ code: number | null; signal: NodeJS.Signals | null }>();
  child.once("exit", (code, signal) => {
    running.delete(child);
    exit.resolve({ code, signal });
  });

  return {
    child,
    exited: exit.promise,
    logs: () =>
      stdout
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    output: () => `${stdout}${stderr}`,
  };
}

/** Safety net for failed tests: never leave an indexer holding the advisory lock. */
export function killAllIndexers(): void {
  for (const child of running) child.kill("SIGKILL");
}

/** Polls until `probe` returns something other than undefined/false; `context` adds diagnostics to the timeout error. */
export async function waitFor<T>(description: string, probe: () => Promise<T | undefined | false>, context?: () => string, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}${context ? `\n${context()}` : ""}`);
    await sleep(10);
  }
}

/** Waits for the process to exit, failing with its output if it outlives `ms`. */
export async function exitWithin(proc: IndexerProcess, ms: number): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const cancel = new AbortController();
  const timeout = sleep(ms, undefined, { signal: cancel.signal }).then(() => {
    throw new Error(`indexer still running after ${ms}ms:\n${proc.output()}`);
  });
  try {
    return await Promise.race([proc.exited, timeout]);
  } finally {
    cancel.abort();
    timeout.catch(() => {});
  }
}
