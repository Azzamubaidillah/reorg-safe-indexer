import { CHAIN_PRESETS } from "@rsi/contracts";
import { z } from "zod";
import type { RetentionPolicy } from "./retention.ts";

const address = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/)
  .transform((s) => s.toLowerCase() as `0x${string}`);

const addressList = z
  .string()
  .transform((s) => s.split(",").map((x) => x.trim()).filter(Boolean))
  .pipe(z.array(address));

export const providerSchema = z.object({
  name: z.string().min(1),
  url: z.url(),
  /** Largest eth_getLogs block span this provider accepts. */
  maxSpan: z.number().int().positive(),
  /** Sustained requests per second; each call inside a batch counts as one. */
  rps: z.number().positive(),
  /** Calls per JSON-RPC batch; 1 disables batching. */
  batchSize: z.number().int().positive().default(1),
});
export type ProviderConfig = z.infer<typeof providerSchema>;

const jsonOf = (name: string) =>
  z.string().transform((s, ctx) => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      ctx.addIssue({ code: "custom", message: `${name} must be JSON` });
      return z.NEVER;
    }
  });

const DAY_MS = 86_400_000;

const retentionEnv = z.object({
  /** Days `chain.logs` of a published range stay after its last block. */
  LANDING_RETENTION_DAYS: z.coerce.number().positive().default(7),
  /** Days decoded rows stay; unset keeps them forever. Needs ANALYTICS_MANIFEST_PATH. */
  DECODED_RETENTION_DAYS: z.coerce.number().positive().optional(),
  /** `_manifest.json` of the Parquet store, proof that decoded rows were exported before they are deleted. */
  ANALYTICS_MANIFEST_PATH: z.string().min(1).optional(),
  RETENTION_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  RETENTION_MAX_RANGES: z.coerce.number().int().positive().default(500),
});

const envSchema = retentionEnv.extend({
  DATABASE_URL: z.string().min(1),
  CHAIN_ID: z.coerce.number().int().positive().default(1),
  RPC_PROVIDERS: jsonOf("RPC_PROVIDERS").pipe(z.array(providerSchema).min(1)),
  ERC20_TOKENS: addressList.optional(),
  UNISWAP_V3_POOLS: addressList.optional(),
  START_BLOCK: z.coerce.number().int().nonnegative(),
  /** Stop after this block (inclusive), or at the head if that is lower. Unset: keep following the head. */
  END_BLOCK: z.coerce.number().int().nonnegative().optional(),
  RANGE_SIZE: z.coerce.number().int().positive().default(100),
  FETCH_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /** `finalized` advances once per epoch (~6.4 min on L1); polling faster only burns RPC quota. */
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  /** `latest` moves every ~12 s on L1; this is how often an idle indexer asks for a new head. */
  HEAD_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(4_000),
  LOG_LEVEL: z.string().default("info"),
  QUALITY_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  QUALITY_MAX_BACKFILLS: z.coerce.number().int().positive().default(2),
  /** Same shape as one RPC_PROVIDERS entry. Unset: reconciliation is off. */
  RECONCILE_PROVIDER: jsonOf("RECONCILE_PROVIDER").pipe(providerSchema).optional(),
  RECONCILE_LIMIT: z.coerce.number().int().positive().default(5),
  RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(300_000),
  /** Etherscan API key for the spot-check sampler. Unset or blank: no Etherscan checks. */
  ETHERSCAN_API_KEY: z
    .string()
    .trim()
    .transform((s) => s || undefined)
    .optional(),
  /** Random finalized ranges checked per cycle. The free plan allows 100k calls/day; a range costs one call per contract plus one header. */
  ETHERSCAN_SAMPLE_SIZE: z.coerce.number().int().positive().default(20),
  ETHERSCAN_INTERVAL_MS: z.coerce.number().int().positive().default(3_600_000),
  ETHERSCAN_RPS: z.coerce.number().positive().max(5).default(2),
  /** 0 or unset: no status server. */
  METRICS_PORT: z.coerce.number().int().min(0).max(65_535).optional(),
  METRICS_HOST: z.string().min(1).default("127.0.0.1"),
  HEALTH_STALE_AFTER_MS: z.coerce.number().int().positive().default(60_000),
  LAG_SAMPLE_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
});

export interface Config {
  databaseUrl: string;
  chainId: number;
  providers: ProviderConfig[];
  tokens: `0x${string}`[];
  pools: `0x${string}`[];
  startBlock: number;
  endBlock: number | undefined;
  rangeSize: number;
  fetchConcurrency: number;
  pollIntervalMs: number;
  headPollIntervalMs: number;
  logLevel: string;
  qualityIntervalMs: number;
  qualityMaxBackfills: number;
  /** Second source for reconciliation; undefined disables it. */
  reconcileProvider: ProviderConfig | undefined;
  reconcileLimit: number;
  reconcileIntervalMs: number;
  /** Etherscan spot checks; undefined when ETHERSCAN_API_KEY is unset. */
  etherscan: { apiKey: string; sampleSize: number; intervalMs: number; rps: number } | undefined;
  /** Port of the /metrics, /healthz and /status server; undefined disables it. */
  metricsPort: number | undefined;
  metricsHost: string;
  healthStaleAfterMs: number;
  lagSampleIntervalMs: number;
  retention: RetentionPolicy;
  retentionIntervalMs: number;
}

export type RetentionConfig = Pick<Config, "retention" | "retentionIntervalMs">;

function retentionConfig(e: z.infer<typeof retentionEnv>): RetentionConfig {
  // Without a manifest the purge could never prove an export, so decoded rows would silently stay forever.
  if (e.DECODED_RETENTION_DAYS !== undefined && e.ANALYTICS_MANIFEST_PATH === undefined) {
    throw new Error("DECODED_RETENTION_DAYS needs ANALYTICS_MANIFEST_PATH: decoded rows are only deleted once the Parquet export is proven");
  }
  return {
    retention: {
      landingRetentionMs: e.LANDING_RETENTION_DAYS * DAY_MS,
      decodedRetentionMs: e.DECODED_RETENTION_DAYS === undefined ? undefined : e.DECODED_RETENTION_DAYS * DAY_MS,
      analyticsManifestPath: e.ANALYTICS_MANIFEST_PATH,
      maxRanges: e.RETENTION_MAX_RANGES,
    },
    retentionIntervalMs: e.RETENTION_INTERVAL_MS,
  };
}

/** The retention settings alone, for commands that need no RPC providers. */
export const loadRetentionConfig = (env: NodeJS.ProcessEnv = process.env): RetentionConfig => retentionConfig(retentionEnv.parse(env));

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = envSchema.parse(env);
  // Defaults come from the chain preset; an explicit list always wins, and a chain without a preset needs one.
  const preset = CHAIN_PRESETS[e.CHAIN_ID];
  const tokens = e.ERC20_TOKENS ?? preset?.tokens.map((t) => t.address) ?? [];
  const pools = e.UNISWAP_V3_POOLS ?? preset?.pools.map((p) => p.address) ?? [];
  if (tokens.length + pools.length === 0) throw new Error("no contracts configured (ERC20_TOKENS / UNISWAP_V3_POOLS)");
  if (e.END_BLOCK !== undefined && e.END_BLOCK < e.START_BLOCK) throw new Error("END_BLOCK is before START_BLOCK");
  // The reconciliation rows are keyed by provider name; a name shared with an ingest provider would make "second source" meaningless.
  if (e.RECONCILE_PROVIDER && e.RPC_PROVIDERS.some((p) => p.name === e.RECONCILE_PROVIDER?.name)) {
    throw new Error(`RECONCILE_PROVIDER name "${e.RECONCILE_PROVIDER.name}" must differ from every RPC_PROVIDERS name`);
  }
  return {
    databaseUrl: e.DATABASE_URL,
    chainId: e.CHAIN_ID,
    providers: e.RPC_PROVIDERS,
    tokens,
    pools,
    startBlock: e.START_BLOCK,
    endBlock: e.END_BLOCK,
    rangeSize: e.RANGE_SIZE,
    fetchConcurrency: e.FETCH_CONCURRENCY,
    pollIntervalMs: e.POLL_INTERVAL_MS,
    headPollIntervalMs: e.HEAD_POLL_INTERVAL_MS,
    logLevel: e.LOG_LEVEL,
    qualityIntervalMs: e.QUALITY_INTERVAL_MS,
    qualityMaxBackfills: e.QUALITY_MAX_BACKFILLS,
    reconcileProvider: e.RECONCILE_PROVIDER,
    reconcileLimit: e.RECONCILE_LIMIT,
    reconcileIntervalMs: e.RECONCILE_INTERVAL_MS,
    etherscan: e.ETHERSCAN_API_KEY
      ? { apiKey: e.ETHERSCAN_API_KEY, sampleSize: e.ETHERSCAN_SAMPLE_SIZE, intervalMs: e.ETHERSCAN_INTERVAL_MS, rps: e.ETHERSCAN_RPS }
      : undefined,
    metricsPort: e.METRICS_PORT || undefined,
    metricsHost: e.METRICS_HOST,
    healthStaleAfterMs: e.HEALTH_STALE_AFTER_MS,
    lagSampleIntervalMs: e.LAG_SAMPLE_INTERVAL_MS,
    ...retentionConfig(e),
  };
}
