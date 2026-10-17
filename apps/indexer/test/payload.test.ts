import { describe, expect, it } from "vitest";
import { payloadSha256 } from "../src/payload.ts";
import type { FetchedRange, RawLog } from "../src/types.ts";

const h = (c: string) => `0x${c.repeat(64)}` as const;

function range(): FetchedRange {
  const log = (blockNumber: number, logIndex: number): RawLog => ({
    blockNumber,
    blockHash: h(String(blockNumber)),
    logIndex,
    txHash: h("a"),
    txIndex: 0,
    address: `0x${"ab".repeat(20)}`,
    topics: [h("1"), h("2")],
    data: "0x00",
  });
  return {
    from: 1,
    to: 3,
    blocks: [1, 2, 3].map((n) => ({ number: n, hash: h(String(n)), parentHash: h(String(n - 1)), timestamp: 1000 + n })),
    logs: [log(1, 0), log(1, 1), log(2, 0), log(3, 5)],
  };
}

describe("payloadSha256", () => {
  it("is a lowercase hex sha256 independent of input order", () => {
    const r = range();
    const shuffled: FetchedRange = { ...r, blocks: [r.blocks[2]!, r.blocks[0]!, r.blocks[1]!], logs: [r.logs[3]!, r.logs[1]!, r.logs[0]!, r.logs[2]!] };
    expect(payloadSha256(r)).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadSha256(shuffled)).toBe(payloadSha256(r));
  });

  it.each([
    ["header timestamp", (r: FetchedRange) => void (r.blocks[1]!.timestamp += 1)],
    ["header parentHash", (r: FetchedRange) => void (r.blocks[1]!.parentHash = h("f"))],
    ["log data", (r: FetchedRange) => void (r.logs[2]!.data = "0x01")],
    ["log topic", (r: FetchedRange) => void (r.logs[0]!.topics[1] = h("3"))],
    ["log txIndex", (r: FetchedRange) => void (r.logs[3]!.txIndex = 1)],
    ["a dropped log", (r: FetchedRange) => void r.logs.pop()],
  ])("changes when %s changes", (_name, mutate) => {
    const changed = range();
    mutate(changed);
    expect(payloadSha256(changed)).not.toBe(payloadSha256(range()));
  });

  it("does not let adjacent fields blur together", () => {
    const a = range();
    const b = range();
    a.logs[0]!.topics = [h("1"), h("2")];
    b.logs[0]!.topics = [h("1")];
    b.logs[0]!.data = `0x${"2".repeat(64)}00`;
    expect(payloadSha256(a)).not.toBe(payloadSha256(b));
  });
});
