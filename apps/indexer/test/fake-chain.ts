import { Provider } from "../src/rpc/provider.ts";

export interface FakeBlock {
  number: number;
  hash: string;
  parentHash: string;
}

export interface FakeLog {
  blockNumber: number;
  blockHash: string;
  logIndex: number;
  removed?: boolean;
}

const hash32 = (tag: string, n: number) => `0x${tag}${n.toString(16).padStart(64 - tag.length, "0")}`;

/** A linked chain of blocks [from, to] with one log per block (two when `logsPerBlock` is 2). */
export function makeChain(from: number, to: number, logsPerBlock = 1): { blocks: FakeBlock[]; logs: FakeLog[] } {
  const blocks: FakeBlock[] = [];
  const logs: FakeLog[] = [];
  for (let n = from; n <= to; n++) {
    blocks.push({ number: n, hash: hash32("b", n), parentHash: hash32("b", n - 1) });
    for (let i = 0; i < logsPerBlock; i++) logs.push({ blockNumber: n, blockHash: hash32("b", n), logIndex: i });
  }
  return { blocks, logs };
}

export interface FakeNode {
  provider: Provider;
  /** Every eth_getLogs span requested, in order. */
  logSpans: { from: number; to: number }[];
  /** HTTP requests carrying eth_getBlockByNumber calls. */
  headerRequests: number;
}

interface FakeNodeOptions {
  blocks: FakeBlock[];
  logs: FakeLog[];
  maxSpan: number;
  batchSize?: number;
  /** eth_getLogs spans wider than this fail with a provider-style "range too large" error. */
  rejectAbove?: number;
  /** Answer eth_getLogs with every log regardless of the requested span (a misbehaving provider). */
  ignoreSpan?: boolean;
}

export function fakeNode(o: FakeNodeOptions): FakeNode {
  const node: FakeNode = { logSpans: [], headerRequests: 0 } as unknown as FakeNode;
  const answer = (call: { id: number; method: string; params: unknown[] }) => {
    if (call.method === "eth_getLogs") {
      const f = call.params[0] as { fromBlock: string; toBlock: string };
      const from = Number(f.fromBlock);
      const to = Number(f.toBlock);
      node.logSpans.push({ from, to });
      if (o.rejectAbove !== undefined && to - from + 1 > o.rejectAbove) {
        return { jsonrpc: "2.0", id: call.id, error: { code: -32005, message: "query exceeds max block range" } };
      }
      const result = o.logs
        .filter((l) => o.ignoreSpan || (l.blockNumber >= from && l.blockNumber <= to))
        .map((l) => ({
          blockNumber: `0x${l.blockNumber.toString(16)}`,
          blockHash: l.blockHash.toUpperCase().replace("0X", "0x"),
          logIndex: `0x${l.logIndex.toString(16)}`,
          transactionHash: `0x${"a".repeat(64)}`,
          transactionIndex: "0x0",
          address: `0x${"AB".repeat(20)}`,
          topics: [`0x${"1".repeat(64)}`],
          data: "0x",
          removed: l.removed ?? false,
        }))
        // Providers do not promise any particular order.
        .reverse();
      return { jsonrpc: "2.0", id: call.id, result };
    }
    const n = Number(call.params[0]);
    const b = o.blocks.find((x) => x.number === n);
    return {
      jsonrpc: "2.0",
      id: call.id,
      result: b ? { number: `0x${b.number.toString(16)}`, hash: b.hash, parentHash: b.parentHash, timestamp: `0x${(1_700_000_000 + b.number).toString(16)}` } : null,
    };
  };

  const fetchFn: typeof fetch = async (_url, init) => {
    const body = JSON.parse(init?.body as string) as { id: number; method: string; params: unknown[] } | { id: number; method: string; params: unknown[] }[];
    const calls = Array.isArray(body) ? body : [body];
    if (calls.some((c) => c.method === "eth_getBlockByNumber")) node.headerRequests++;
    const replies = calls.map(answer);
    return new Response(JSON.stringify(Array.isArray(body) ? replies : replies[0]), { status: 200 });
  };

  node.provider = new Provider(
    { name: "fake", url: "http://fake.invalid", maxSpan: o.maxSpan, rps: 1_000_000, batchSize: o.batchSize ?? 1 },
    fetchFn,
  );
  return node;
}
