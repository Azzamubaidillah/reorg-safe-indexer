import { describe, expect, it } from "vitest";
import { DEFAULT_METADATA, sqrtPriceToPrice } from "../src/metadata.ts";

const pool = DEFAULT_METADATA.pools["0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640"]!;
const Q96 = 2n ** 96n;

describe("sqrtPriceToPrice", () => {
  // sqrtPriceX96 = 20000 * 2^96 => raw token1/token0 = 4e8; USDC (6) / WETH (18) => 4e8 * 1e-12 = 4e-4 WETH per USDC = 2500 USDC per WETH.
  it("converts a hand-computed price in both directions", () => {
    expect(sqrtPriceToPrice(20_000n * Q96, pool, "token1PerToken0")).toBeCloseTo(4e-4, 15);
    expect(sqrtPriceToPrice(20_000n * Q96, pool, "token0PerToken1")).toBeCloseTo(2500, 9);
  });

  it("is the identity ratio at 2^96 for equal decimals", () => {
    const even = { ...pool, token1: pool.token0 };
    expect(sqrtPriceToPrice(Q96, even, "token1PerToken0")).toBe(1);
    expect(sqrtPriceToPrice(2n * Q96, even, "token1PerToken0")).toBe(4);
  });

  it("defaults the USDC/WETH pool to USDC per ETH", () => {
    expect(pool.defaultDirection).toBe("token0PerToken1");
  });
});

describe("Base WETH/USDC metadata (WETH sorts first on Base)", () => {
  const base = DEFAULT_METADATA.pools["0xd0b53d9277642d899df5c87a3966a349a798f224"]!;

  // 2500 USDC per WETH with token0 = WETH (18) and token1 = USDC (6): raw token1/token0 = 2500e6 / 1e18 = 2.5e-9,
  // sqrt = 5e-5 = 1/20000, so sqrtPriceX96 = 2^96 / 20000. The mainnet pool has the opposite token order.
  it("reads USDC per ETH by default, which on Base is token1 per token0", () => {
    expect(base.token0).toEqual({ symbol: "WETH", decimals: 18 });
    expect(base.token1).toEqual({ symbol: "USDC", decimals: 6 });
    expect(sqrtPriceToPrice(Q96 / 20_000n, base, base.defaultDirection)).toBeCloseTo(2500, 6);
  });
});
