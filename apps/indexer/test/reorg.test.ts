import { describe, expect, it } from "vitest";
import { findCommonAncestor } from "../src/reorg.ts";
import type { BlockRef } from "../src/types.ts";

const hash = (tag: string, n: number): BlockRef["hash"] => `0x${tag}${n.toString(16).padStart(64 - tag.length, "0")}`;
const ref = (tag: string, n: number): BlockRef => ({ number: n, hash: hash(tag, n) });

/**
 * Stored chain: "old" for [first, tip]. Canonical chain: "old" below `forkAt`, "new" from `forkAt` to `canonicalTip`.
 * Counts the round trips so batching can be asserted.
 */
function scenario(o: { first: number; tip: number; forkAt: number; canonicalTip?: number; floor: number; batchSize: number }) {
  const canonicalTip = o.canonicalTip ?? o.tip;
  const requests: [number, number][] = [];
  const search = findCommonAncestor({
    tip: o.tip,
    floor: o.floor,
    batchSize: o.batchSize,
    stored: async (from, to) => {
      requests.push([from, to]);
      return Array.from({ length: to - from + 1 }, (_, i) => ref("a", from + i)).filter((b) => b.number >= o.first);
    },
    canonical: async (from, to) =>
      Array.from({ length: to - from + 1 }, (_, i): BlockRef | undefined => {
        const n = from + i;
        if (n > canonicalTip) return undefined;
        return n < o.forkAt ? ref("a", n) : ref("b", n);
      }),
  });
  return { search, requests };
}

describe("findCommonAncestor", () => {
  it("finds the block right below the fork and reports exactly the orphaned blocks", async () => {
    const { search } = scenario({ first: 100, tip: 130, forkAt: 128, floor: 100, batchSize: 8 });
    expect(await search).toEqual({
      ancestor: 127,
      orphaned: [ref("a", 128), ref("a", 129), ref("a", 130)],
      canonical: [ref("b", 128), ref("b", 129), ref("b", 130)],
    });
  });

  it("reports the tip itself as the ancestor when nothing diverges", async () => {
    const { search } = scenario({ first: 100, tip: 130, forkAt: 500, floor: 100, batchSize: 8 });
    expect(await search).toEqual({ ancestor: 130, orphaned: [], canonical: [] });
  });

  it("accepts an ancestor sitting exactly on the floor (fork right above the finalized block)", async () => {
    const { search } = scenario({ first: 100, tip: 150, forkAt: 121, floor: 120, batchSize: 8 });
    const result = await search;
    expect(result.ancestor).toBe(120);
    expect(result.orphaned.map((b) => b.number)).toEqual(Array.from({ length: 30 }, (_, i) => 121 + i));
  });

  it("finds no ancestor when the fork reaches the floor, listing every inspected block", async () => {
    const { search } = scenario({ first: 100, tip: 150, forkAt: 120, floor: 120, batchSize: 8 });
    const result = await search;
    expect(result.ancestor).toBeUndefined();
    expect(result.orphaned.map((b) => b.number)).toEqual(Array.from({ length: 31 }, (_, i) => 120 + i));
    expect(result.canonical).toHaveLength(31);
  });

  it("does not look below the floor even though older blocks are stored", async () => {
    const { search, requests } = scenario({ first: 100, tip: 150, forkAt: 100, floor: 140, batchSize: 8 });
    expect((await search).ancestor).toBeUndefined();
    expect(Math.min(...requests.map(([from]) => from))).toBe(140);
  });

  it("walks in batches and stops at the batch containing the ancestor", async () => {
    const { search, requests } = scenario({ first: 0, tip: 99, forkAt: 88, floor: 0, batchSize: 5 });
    expect((await search).ancestor).toBe(87);
    // 99..95, 94..90, 89..85: the ancestor is in the third batch, so a fourth is never requested.
    expect(requests).toEqual([
      [95, 99],
      [90, 94],
      [85, 89],
    ]);
  });

  it("treats heights the provider does not have as orphaned, with no canonical counterpart", async () => {
    // The canonical chain is shorter than what we stored: 128..130 vanished, 126 and 127 differ.
    const { search } = scenario({ first: 100, tip: 130, forkAt: 126, canonicalTip: 127, floor: 100, batchSize: 4 });
    expect(await search).toEqual({
      ancestor: 125,
      orphaned: [ref("a", 126), ref("a", 127), ref("a", 128), ref("a", 129), ref("a", 130)],
      canonical: [ref("b", 126), ref("b", 127)],
    });
  });

  it("fails loudly if storage has a hole in the window", async () => {
    await expect(scenario({ first: 125, tip: 130, forkAt: 120, floor: 120, batchSize: 16 }).search).rejects.toThrow(/not contiguous/);
  });
});
