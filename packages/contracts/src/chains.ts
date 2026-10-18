// Per-chain defaults: which contracts the indexer tracks when ERC20_TOKENS / UNISWAP_V3_POOLS are not
// set, and the metadata (decimals, token order) that analytics and the dashboard need to present them.
// Addresses are lowercase. Every address here was checked on-chain (decimals(), factory getPool(),
// token0()/token1()/fee()); see docs/base-smoke.md for the Base calls.

export interface TokenPreset {
  address: `0x${string}`;
  symbol: string;
  decimals: number;
}

/**
 * `token1PerToken0`: how many whole token1 one whole token0 costs (what Uniswap's sqrtPriceX96 encodes, decimal-adjusted).
 * `token0PerToken1`: the inverse.
 */
export type PriceDirection = "token1PerToken0" | "token0PerToken1";

export interface PoolPreset {
  address: `0x${string}`;
  label: string;
  token0: TokenPreset;
  token1: TokenPreset;
  /** The direction a person reads this pool in (USDC per ETH for both defaults, whichever token sorts first). */
  defaultDirection: PriceDirection;
}

export interface ChainPreset {
  chainId: number;
  name: string;
  tokens: TokenPreset[];
  pools: PoolPreset[];
}

const MAINNET_USDC: TokenPreset = { address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", symbol: "USDC", decimals: 6 };
const MAINNET_WETH: TokenPreset = { address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", symbol: "WETH", decimals: 18 };
const BASE_USDC: TokenPreset = { address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", symbol: "USDC", decimals: 6 };
const BASE_WETH: TokenPreset = { address: "0x4200000000000000000000000000000000000006", symbol: "WETH", decimals: 18 };

export const CHAIN_PRESETS: Record<number, ChainPreset> = {
  1: {
    chainId: 1,
    name: "Ethereum",
    tokens: [MAINNET_USDC],
    // Uniswap v3 USDC/WETH 0.05%: USDC sorts first, so token0 = USDC and the readable price is token0 per token1.
    pools: [{ address: "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", label: "USDC/WETH 0.05%", token0: MAINNET_USDC, token1: MAINNET_WETH, defaultDirection: "token0PerToken1" }],
  },
  8453: {
    chainId: 8453,
    name: "Base",
    tokens: [BASE_USDC],
    // Uniswap v3 WETH/USDC 0.05%: on Base WETH (0x4200…) sorts first, so token0 = WETH and USDC per ETH is token1 per token0.
    pools: [{ address: "0xd0b53d9277642d899df5c87a3966a349a798f224", label: "WETH/USDC 0.05%", token0: BASE_WETH, token1: BASE_USDC, defaultDirection: "token1PerToken0" }],
  },
};
