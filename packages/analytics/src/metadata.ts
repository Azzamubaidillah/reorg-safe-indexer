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

/**
 * `token1PerToken0`: how many whole token1 one whole token0 costs (what Uniswap's sqrtPriceX96 encodes, decimal-adjusted).
 * `token0PerToken1`: the inverse, e.g. USDC per ETH for the USDC/WETH pool.
 */
export type PriceDirection = "token1PerToken0" | "token0PerToken1";

export interface AnalyticsMetadata {
  pools: Record<string, PoolMeta>;
}

const USDC: TokenMeta = { symbol: "USDC", decimals: 6 };
const WETH: TokenMeta = { symbol: "WETH", decimals: 18 };

/**
 * Ethereum mainnet defaults, matching the indexer's default contracts. Keys are lowercase addresses.
 * Override by passing `metadata` to `AnalyticsReader` / `verifyAnalytics` (the CLI reads `--metadata <file.json>`).
 */
export const DEFAULT_METADATA: AnalyticsMetadata = {
  pools: {
    // Uniswap v3 USDC/WETH 0.05%: token0 = USDC, token1 = WETH, so the readable price is USDC per ETH.
    "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640": { token0: USDC, token1: WETH, defaultDirection: "token0PerToken1" },
  },
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
