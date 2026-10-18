import { CHAIN_PRESETS, type TokenPreset } from "@rsi/contracts";

// Display metadata comes from the same chain presets the indexer uses for its default contracts.
// Unknown addresses fall back to raw base units: guessing decimals would silently misstate amounts.
export type TokenInfo = Pick<TokenPreset, "symbol" | "decimals">;

export interface PoolInfo {
  label: string;
  token0: TokenInfo;
  token1: TokenInfo;
}

const presets = Object.values(CHAIN_PRESETS);

/** Every preset token and pool across chains, keyed by lowercase address; addresses do not collide across chains. */
export const TOKENS: Record<string, TokenInfo> = Object.fromEntries(presets.flatMap((c) => c.tokens.map((t) => [t.address, t])));
export const POOLS: Record<string, PoolInfo> = Object.fromEntries(presets.flatMap((c) => c.pools.map((p) => [p.address, p])));
