import { z } from "zod";

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

/** Contracts indexed on Ethereum mainnet unless overridden: USDC and the Uniswap v3 USDC/WETH 0.05% pool. */
const MAINNET_DEFAULTS = {
  ERC20_TOKENS: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  UNISWAP_V3_POOLS: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640",
};

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  CHAIN_ID: z.coerce.number().int().positive().default(1),
  RPC_PROVIDERS: z
    .string()
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "RPC_PROVIDERS must be JSON" });
        return z.NEVER;
      }
    })
    .pipe(z.array(providerSchema).min(1)),
  ERC20_TOKENS: addressList.optional(),
  UNISWAP_V3_POOLS: addressList.optional(),
  START_BLOCK: z.coerce.number().int().nonnegative(),
  /** Stop after this block (inclusive). Unset: keep following the finalized head. */
  END_BLOCK: z.coerce.number().int().nonnegative().optional(),
  RANGE_SIZE: z.coerce.number().int().positive().default(100),
  FETCH_CONCURRENCY: z.coerce.number().int().positive().default(4),
  /** `finalized` advances once per epoch (~6.4 min on L1); polling faster only burns RPC quota. */
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  LOG_LEVEL: z.string().default("info"),
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
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const e = envSchema.parse(env);
  const defaults = e.CHAIN_ID === 1 ? MAINNET_DEFAULTS : undefined;
  const tokens = e.ERC20_TOKENS ?? (defaults ? addressList.parse(defaults.ERC20_TOKENS) : []);
  const pools = e.UNISWAP_V3_POOLS ?? (defaults ? addressList.parse(defaults.UNISWAP_V3_POOLS) : []);
  if (tokens.length + pools.length === 0) throw new Error("no contracts configured (ERC20_TOKENS / UNISWAP_V3_POOLS)");
  if (e.END_BLOCK !== undefined && e.END_BLOCK < e.START_BLOCK) throw new Error("END_BLOCK is before START_BLOCK");
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
    logLevel: e.LOG_LEVEL,
  };
}
