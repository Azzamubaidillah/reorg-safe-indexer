import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { TEST_DATABASE_URL } from "../../support/db.ts";
import type { IndexerProcess } from "../../support/indexer-process.ts";
import { ANVIL_CHAIN_ID, type Fixtures } from "./anvil.ts";

const repoRoot = fileURLToPath(new URL("../../../../../", import.meta.url));

export interface AnvilIndexerOptions {
  rpcUrl: string;
  fixtures: Fixtures;
  rangeSize: number;
}

export const HEAD_POLL_INTERVAL_MS = 50;
export const FINALIZED_POLL_INTERVAL_MS = 200;

const running = new Set<ChildProcess>();

/**
 * Follow-the-head indexer against anvil: no END_BLOCK, short polls so a test never waits on the
 * production 4s/60s intervals. Spawned as `node --import tsx` so kills hit the indexer itself.
 */
export function spawnAnvilIndexer(o: AnvilIndexerOptions): IndexerProcess {
  // An END_BLOCK in the developer's shell would turn this into a bounded run.
  const { END_BLOCK: _ignored, ...inherited } = process.env;
  const env = {
    ...inherited,
    DATABASE_URL: TEST_DATABASE_URL,
    CHAIN_ID: String(ANVIL_CHAIN_ID),
    RPC_PROVIDERS: JSON.stringify([{ name: "anvil", url: o.rpcUrl, maxSpan: 1000, rps: 1000, batchSize: 50 }]),
    ERC20_TOKENS: o.fixtures.token,
    UNISWAP_V3_POOLS: o.fixtures.pool,
    START_BLOCK: String(o.fixtures.startBlock),
    RANGE_SIZE: String(o.rangeSize),
    FETCH_CONCURRENCY: "2",
    HEAD_POLL_INTERVAL_MS: String(HEAD_POLL_INTERVAL_MS),
    POLL_INTERVAL_MS: String(FINALIZED_POLL_INTERVAL_MS),
    LOG_LEVEL: "info",
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
    stdout: () => stdout,
  };
}

export function killAnvilIndexers(): void {
  for (const child of running) child.kill("SIGKILL");
}
