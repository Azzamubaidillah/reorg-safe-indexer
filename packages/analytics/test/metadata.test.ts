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
