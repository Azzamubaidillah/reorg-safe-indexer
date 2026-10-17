// Display metadata for the contracts the indexer tracks by default (see MAINNET_DEFAULTS in apps/indexer/src/config.ts).
// Unknown addresses fall back to raw base units: guessing decimals would silently misstate amounts.
export interface TokenInfo {
  symbol: string;
  decimals: number;
}

export interface PoolInfo {
  label: string;
  token0: TokenInfo;
  token1: TokenInfo;
}

export const USDC: TokenInfo = { symbol: "USDC", decimals: 6 };
export const WETH: TokenInfo = { symbol: "WETH", decimals: 18 };

export const TOKENS: Record<string, TokenInfo> = {
  "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": USDC,
};

export const POOLS: Record<string, PoolInfo> = {
  "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640": { label: "USDC/WETH 0.05%", token0: USDC, token1: WETH },
};

export const DEFAULT_TOKEN = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const DEFAULT_POOL = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
