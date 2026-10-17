import { describe, expect, it } from "vitest";
import { TokenBucket } from "../../src/rpc/limiter.ts";
import { FakeClock } from "./support.ts";

describe("TokenBucket", () => {
  it("serves a full burst without waiting", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(10, 5, clock);
    await Promise.all(Array.from({ length: 5 }, () => bucket.take()));
    expect(clock.sleeps).toEqual([]);
  });

  it("sustains the configured rate after the burst", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(10, 5, clock);
    await Promise.all(Array.from({ length: 25 }, () => bucket.take()));
    // 5 free, 20 more at 10/s = 2 s
    expect(clock.t).toBeGreaterThanOrEqual(2000);
    expect(clock.t).toBeLessThanOrEqual(2000 + 20); // ceil rounding only
  });

  it("refills while idle but never beyond burst", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(10, 5, clock);
    await bucket.take(5);
    clock.t += 60_000;
    await bucket.take(5);
    expect(clock.sleeps).toEqual([]);
    await bucket.take(1);
    expect(clock.sleeps.length).toBeGreaterThan(0);
  });

  it("serves waiters in call order: a big take is not starved by later small ones", async () => {
    const clock = new FakeClock();
    const bucket = new TokenBucket(10, 5, clock);
    await bucket.take(5);
    const order: string[] = [];
    const big = bucket.take(5).then(() => order.push("big"));
    const smalls = [1, 2, 3].map((i) => bucket.take(1).then(() => order.push(`small${i}`)));
    await Promise.all([big, ...smalls]);
    expect(order).toEqual(["big", "small1", "small2", "small3"]);
  });

  it("rejects take(n) with n > burst instead of waiting forever", () => {
    const bucket = new TokenBucket(10, 5, new FakeClock());
    expect(() => bucket.take(6)).toThrow(/cannot take 6/);
  });

  it("rejects non-positive rate or burst", () => {
    expect(() => new TokenBucket(0, 1)).toThrow();
    expect(() => new TokenBucket(1, 0)).toThrow();
  });
});
