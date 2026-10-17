import { describe, expect, it } from "vitest";
import { RpcError, type RpcErrorKind } from "../../src/rpc/errors.ts";
import type { Provider } from "../../src/rpc/provider.ts";
import { RpcPool } from "../../src/rpc/pool.ts";
import { FakeClock } from "./support.ts";

const fake = (name: string) => ({ name, calls: {} }) as unknown as Provider;
const fail = (kind: RpcErrorKind, provider: string, retryAfterMs?: number) => new RpcError(kind, "boom", provider, retryAfterMs);

describe("RpcPool", () => {
  it("rate_limited on A moves to B; A is not reused before its Retry-After elapses", async () => {
    const clock = new FakeClock();
    const [a, b] = [fake("A"), fake("B")];
    const pool = new RpcPool([a, b], { clock });
    const used: string[] = [];
    const run = (limitFirst: boolean) =>
      pool.run(async (p) => {
        used.push(p.name);
        if (limitFirst && p.name === "A") throw fail("rate_limited", "A", 5000);
        return p.name;
      });

    expect(await run(true)).toBe("B");
    expect(used).toEqual(["A", "B"]);

    clock.t = 4999;
    expect(await run(false)).toBe("B");
    clock.t = 5000;
    expect(await run(false)).toBe("A");
    expect(clock.sleeps).toEqual([]);
  });

  it("waits for the soonest provider when all are cooling down", async () => {
    const clock = new FakeClock();
    const pool = new RpcPool([fake("A"), fake("B")], { clock });
    let n = 0;
    const result = await pool.run(async (p) => {
      if (n++ < 2) throw fail("rate_limited", p.name, n === 1 ? 4000 : 9000);
      return p.name;
    });
    expect(result).toBe("A");
    expect(clock.sleeps).toEqual([4000]);
  });

  it("unsupported on A fails over to B and A is not retried in the same run", async () => {
    const used: string[] = [];
    const pool = new RpcPool([fake("A"), fake("B")], { clock: new FakeClock() });
    await expect(
      pool.run(async (p) => {
        used.push(p.name);
        if (p.name === "A") throw fail("unsupported", "A");
        if (used.length < 4) throw fail("transient", "B");
        return "ok";
      }),
    ).resolves.toBe("ok");
    expect(used).toEqual(["A", "B", "B", "B"]);
  });

  it("range_too_large propagates immediately without retry or failover", async () => {
    const used: string[] = [];
    const pool = new RpcPool([fake("A"), fake("B")], { clock: new FakeClock() });
    const err = await pool
      .run(async (p) => {
        used.push(p.name);
        throw fail("range_too_large", p.name);
      })
      .catch((e) => e);
    expect(err.kind).toBe("range_too_large");
    expect(used).toEqual(["A"]);
  });

  it("throws when every provider is unsupported", async () => {
    const used: string[] = [];
    const pool = new RpcPool([fake("A"), fake("B")], { clock: new FakeClock() });
    const err = await pool
      .run(async (p) => {
        used.push(p.name);
        throw fail("unsupported", p.name);
      })
      .catch((e) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect(err.provider).toBe("B");
    expect(used).toEqual(["A", "B"]);
  });

  it("throws the last RpcError once maxAttempts is exhausted, backing off exponentially", async () => {
    const clock = new FakeClock();
    const pool = new RpcPool([fake("A")], { clock, maxAttempts: 4, baseBackoffMs: 100 });
    let n = 0;
    const err = await pool
      .run(async () => {
        throw fail("transient", "A", undefined);
      })
      .catch((e) => {
        n++;
        return e;
      });
    expect(n).toBe(1);
    expect(err.kind).toBe("transient");
    // attempts 2..4 each wait out the cooldown set by the previous failure
    expect(clock.sleeps).toEqual([100, 200, 400]);
  });

  it("calls op exactly maxAttempts times before giving up", async () => {
    let calls = 0;
    const pool = new RpcPool([fake("A"), fake("B")], { clock: new FakeClock(), maxAttempts: 5 });
    await pool
      .run(async (p) => {
        calls++;
        throw fail("transient", p.name);
      })
      .catch(() => undefined);
    expect(calls).toBe(5);
  });

  it("propagates non-RpcError unchanged and without retry", async () => {
    const boom = new TypeError("bug");
    let calls = 0;
    const pool = new RpcPool([fake("A"), fake("B")], { clock: new FakeClock() });
    const err = await pool
      .run(async () => {
        calls++;
        throw boom;
      })
      .catch((e) => e);
    expect(err).toBe(boom);
    expect(calls).toBe(1);
  });

  it("callCounts reports per-provider copies", () => {
    const a = fake("A");
    a.calls.eth_getLogs = 2;
    const counts = new RpcPool([a]).callCounts();
    expect(counts).toEqual({ A: { eth_getLogs: 2 } });
    counts.A!.eth_getLogs = 99;
    expect(a.calls.eth_getLogs).toBe(2);
  });
});
