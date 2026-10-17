import { describe, expect, it } from "vitest";
import { fetchRange, getLogsSplit, InconsistentRangeError } from "../src/fetcher.ts";
import { RpcError } from "../src/rpc/errors.ts";
import { RpcPool } from "../src/rpc/pool.ts";
import { fakeNode, makeChain } from "./fake-chain.ts";

const filter = (from: number, to: number) => ({ from, to, addresses: [`0x${"ab".repeat(20)}` as const], topic0s: [`0x${"1".repeat(64)}` as const] });

describe("getLogsSplit", () => {
  it("chunks at maxSpan boundaries, including a range that is not a multiple", async () => {
    const { blocks, logs } = makeChain(1000, 1249);
    const node = fakeNode({ blocks, logs, maxSpan: 100 });
    const got = await getLogsSplit(node.provider, filter(1000, 1249));
    expect(node.logSpans).toEqual([
      { from: 1000, to: 1099 },
      { from: 1100, to: 1199 },
      { from: 1200, to: 1249 },
    ]);
    expect(got).toHaveLength(250);
  });

  it("uses a single request when the range is exactly maxSpan wide, and one block is fine", async () => {
    const { blocks, logs } = makeChain(500, 599);
    const node = fakeNode({ blocks, logs, maxSpan: 100 });
    await getLogsSplit(node.provider, filter(500, 599));
    await getLogsSplit(node.provider, filter(599, 599));
    expect(node.logSpans).toEqual([
      { from: 500, to: 599 },
      { from: 599, to: 599 },
    ]);
  });

  it("halves on range_too_large without losing or duplicating logs, and returns them sorted", async () => {
    const { blocks, logs } = makeChain(1, 100, 2);
    const node = fakeNode({ blocks, logs, maxSpan: 100, rejectAbove: 30 });
    const got = await getLogsSplit(node.provider, filter(1, 100));
    expect(got.map((l) => [l.blockNumber, l.logIndex])).toEqual(logs.map((l) => [l.blockNumber, l.logIndex]));
    // 100 -> 50 -> 25: accepted spans are all <= 30 and tile [1, 100] exactly.
    const accepted = node.logSpans.filter((s) => s.to - s.from + 1 <= 30);
    expect(accepted.reduce((n, s) => n + (s.to - s.from + 1), 0)).toBe(100);
  });

  it("normalises hex quantities to numbers and hex strings to lowercase", async () => {
    const { blocks, logs } = makeChain(255, 255);
    const node = fakeNode({ blocks, logs, maxSpan: 100 });
    const [log] = await getLogsSplit(node.provider, filter(255, 255));
    expect(log).toMatchObject({ blockNumber: 255, logIndex: 0, txIndex: 0, address: `0x${"ab".repeat(20)}` });
    expect(log?.blockHash).toBe(log?.blockHash.toLowerCase());
  });

  it("halves down to a single block, then gives up with range_too_large", async () => {
    const { blocks, logs } = makeChain(1, 8);
    const node = fakeNode({ blocks, logs, maxSpan: 100, rejectAbove: 0 });
    await expect(getLogsSplit(node.provider, filter(1, 8))).rejects.toMatchObject({ kind: "range_too_large" });
    const last = node.logSpans.at(-1);
    expect(last?.from).toBe(last?.to);
    expect(await getLogsSplit(node.provider, filter(1, 1)).catch((e) => e)).toBeInstanceOf(RpcError);
  });
});

describe("fetchRange", () => {
  const pool = (node: ReturnType<typeof fakeNode>) => new RpcPool([node.provider], { maxAttempts: 1 });

  it("returns a validated segment and fetches headers in batches of provider.batchSize", async () => {
    const { blocks, logs } = makeChain(100, 124);
    const node = fakeNode({ blocks, logs, maxSpan: 100, batchSize: 10 });
    const range = await fetchRange(pool(node), filter(100, 124));
    expect(range.blocks.map((b) => b.number)).toEqual(Array.from({ length: 25 }, (_, i) => 100 + i));
    expect(range.logs).toHaveLength(25);
    expect(node.headerRequests).toBe(3); // 10 + 10 + 5
  });

  it("rejects a range with a missing header", async () => {
    const { blocks, logs } = makeChain(100, 109);
    const node = fakeNode({ blocks: blocks.filter((b) => b.number !== 105), logs, maxSpan: 100 });
    await expect(fetchRange(pool(node), filter(100, 109))).rejects.toThrow(InconsistentRangeError);
  });

  it("rejects a broken parent-hash link inside the range", async () => {
    const { blocks, logs } = makeChain(100, 109);
    blocks[5] = { ...blocks[5]!, parentHash: `0x${"9".repeat(64)}` };
    const node = fakeNode({ blocks, logs, maxSpan: 100 });
    await expect(fetchRange(pool(node), filter(100, 109))).rejects.toThrow(/parentHash/);
  });

  it("rejects a log whose blockHash differs from the header at its height", async () => {
    const { blocks, logs } = makeChain(100, 109);
    logs[3] = { ...logs[3]!, blockHash: `0x${"7".repeat(64)}` };
    const node = fakeNode({ blocks, logs, maxSpan: 100 });
    await expect(fetchRange(pool(node), filter(100, 109))).rejects.toThrow(/blockHash/);
  });

  it("rejects removed logs", async () => {
    const { blocks, logs } = makeChain(100, 109);
    logs[2] = { ...logs[2]!, removed: true };
    const node = fakeNode({ blocks, logs, maxSpan: 100 });
    await expect(fetchRange(pool(node), filter(100, 109))).rejects.toThrow(/removed/);
  });

  it("rejects a log outside the requested range", async () => {
    const { blocks } = makeChain(100, 110);
    const node = fakeNode({ blocks, logs: makeChain(100, 110).logs, maxSpan: 100, ignoreSpan: true });
    await expect(fetchRange(pool(node), filter(100, 109))).rejects.toThrow(/outside/);
  });
});
