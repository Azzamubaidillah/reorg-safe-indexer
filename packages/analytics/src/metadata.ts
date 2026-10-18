import { CHAIN_PRESETS, type PriceDirection } from "@rsi/contracts";

export type { PriceDirection };

/** Everything the Parquet files do not carry: decimals are a property of the contract, not of an event. */
export interface TokenMeta {
  symbol: string;
  decimals: number;
}

export interface PoolMeta {
  token0: TokenMeta;
  token1: TokenMeta;
  /** What `poolOhlc` quotes when the caller does not choose: the direction a person reads this pool in. */
  defaultDirection: PriceDirection;
}

export interface AnalyticsMetadata {
  pools: Record<string, PoolMeta>;
}

/**
 * Every preset pool of every chain, keyed by lowercase address. Pool addresses do not collide across chains, so one map
 * serves whichever chain the store was exported from. Override by passing `metadata` to `AnalyticsReader` /
 * `verifyAnalytics` (the CLI reads `--metadata <file.json>`).
 */
export const DEFAULT_METADATA: AnalyticsMetadata = {
  pools: Object.fromEntries(
    Object.values(CHAIN_PRESETS).flatMap((chain) =>
      chain.pools.map((p) => [
        p.address,
        { token0: { symbol: p.token0.symbol, decimals: p.token0.decimals }, token1: { symbol: p.token1.symbol, decimals: p.token1.decimals }, defaultDirection: p.defaultDirection },
      ]),
    ),
  ),
};

export class UnknownPoolError extends Error {
  constructor(readonly pool: string) {
    super(`no decimals metadata for pool ${pool}; pass it via the analytics metadata override`);
    this.name = "UnknownPoolError";
  }
}

/**
 * Multiplier turning the raw ratio `(sqrtPriceX96 / 2^96)^2` (token1 base units per token0 base unit)
 * into whole token1 per whole token0: 10^(decimals0 - decimals1). Computed as a reciprocal of an exact
 * power of ten when negative, because `10 ** -12` is not correctly rounded in every engine.
 */
export function decimalScale(pool: PoolMeta): number {
  const exponent = pool.token0.decimals - pool.token1.decimals;
  return exponent >= 0 ? 10 ** exponent : 1 / 10 ** -exponent;
}

/** The price a swap left the pool at, in `direction`. Doubles: about 15 significant digits, enough for charts, not for accounting. */
export function sqrtPriceToPrice(sqrtPriceX96: bigint, pool: PoolMeta, direction: PriceDirection): number {
  const root = Number(sqrtPriceX96) / 2 ** 96;
  const price = root * root * decimalScale(pool);
  return direction === "token1PerToken0" ? price : 1 / price;
}
