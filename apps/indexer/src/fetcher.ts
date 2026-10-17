import { RpcError } from "./rpc/errors.ts";
import type { RpcPool } from "./rpc/pool.ts";
import type { Provider } from "./rpc/provider.ts";
import type { BlockHeader, FetchedRange, Hex, RawLog } from "./types.ts";

export interface LogFilter {
  from: number;
  to: number;
  addresses: Hex[];
  topic0s: Hex[];
}

/** The provider's answer does not form one consistent chain segment. Not retried: the data itself is suspect. */
export class InconsistentRangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InconsistentRangeError";
  }
}

interface WireLog {
  blockNumber: string;
  blockHash: string;
  logIndex: string;
  transactionHash: string;
  transactionIndex: string;
  address: string;
  topics: string[];
  data: string;
  removed?: boolean;
}

interface WireBlock {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
}

const hex = (value: string) => value.toLowerCase() as Hex;
const quantity = (n: number) => `0x${n.toString(16)}`;

function toRawLog(w: WireLog): RawLog {
  if (w.removed === true) throw new InconsistentRangeError(`provider returned a removed log at block ${Number(w.blockNumber)}`);
  return {
    blockNumber: Number(w.blockNumber),
    blockHash: hex(w.blockHash),
    logIndex: Number(w.logIndex),
    txHash: hex(w.transactionHash),
    txIndex: Number(w.transactionIndex),
    address: hex(w.address),
    topics: w.topics.map(hex),
    data: hex(w.data),
  };
}

async function getLogsSpan(provider: Provider, f: LogFilter): Promise<RawLog[]> {
  try {
    const wire = await provider.request<WireLog[]>("eth_getLogs", [
      { fromBlock: quantity(f.from), toBlock: quantity(f.to), address: f.addresses, topics: [f.topic0s] },
    ]);
    return wire.map(toRawLog);
  } catch (err) {
    if (!(err instanceof RpcError) || err.kind !== "range_too_large" || f.from === f.to) throw err;
    const mid = f.from + Math.floor((f.to - f.from) / 2);
    const left = await getLogsSpan(provider, { ...f, to: mid });
    const right = await getLogsSpan(provider, { ...f, from: mid + 1 });
    return [...left, ...right];
  }
}

/** eth_getLogs over [from, to] in chunks of provider.maxSpan, halving a chunk the provider rejects as too large. */
export async function getLogsSplit(provider: Provider, f: LogFilter): Promise<RawLog[]> {
  const logs: RawLog[] = [];
  for (let from = f.from; from <= f.to; from += provider.maxSpan) {
    logs.push(...(await getLogsSpan(provider, { ...f, from, to: Math.min(f.to, from + provider.maxSpan - 1) })));
  }
  return logs.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
}

async function getHeaders(provider: Provider, from: number, to: number): Promise<BlockHeader[]> {
  const calls = [];
  for (let n = from; n <= to; n++) calls.push({ method: "eth_getBlockByNumber", params: [quantity(n), false] });
  const wire = await provider.batch<WireBlock | null>(calls);
  return wire.map((b, i) => {
    if (!b) throw new InconsistentRangeError(`provider has no block ${from + i}`);
    return { number: Number(b.number), hash: hex(b.hash), parentHash: hex(b.parentHash), timestamp: Number(b.timestamp) };
  });
}

function validate(f: LogFilter, blocks: BlockHeader[], logs: RawLog[]): void {
  blocks.forEach((b, i) => {
    if (b.number !== f.from + i) throw new InconsistentRangeError(`expected block ${f.from + i}, got ${b.number}`);
    const prev = blocks[i - 1];
    if (prev && b.parentHash !== prev.hash) throw new InconsistentRangeError(`block ${b.number} parentHash does not match block ${prev.number}`);
  });
  for (const log of logs) {
    const header = blocks[log.blockNumber - f.from];
    if (!header) throw new InconsistentRangeError(`log at block ${log.blockNumber} is outside [${f.from}, ${f.to}]`);
    if (log.blockHash !== header.hash) {
      throw new InconsistentRangeError(`log ${log.blockNumber}:${log.logIndex} blockHash ${log.blockHash} != header ${header.hash}`);
    }
  }
}

/** Logs and headers for one range, all from the same provider so they describe the same chain view. */
export async function fetchRange(pool: RpcPool, req: LogFilter): Promise<FetchedRange> {
  const { blocks, logs } = await pool.run(async (provider) => {
    const [logs, blocks] = await Promise.all([getLogsSplit(provider, req), getHeaders(provider, req.from, req.to)]);
    return { logs, blocks };
  });
  validate(req, blocks, logs);
  return { from: req.from, to: req.to, blocks, logs };
}

export async function finalizedBlockNumber(pool: RpcPool): Promise<number> {
  const block = await pool.run((p) => p.request<WireBlock | null>("eth_getBlockByNumber", ["finalized", false]));
  if (!block) throw new Error("provider returned no finalized block");
  return Number(block.number);
}
