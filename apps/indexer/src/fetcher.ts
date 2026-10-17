import { setTimeout as sleep } from "node:timers/promises";
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

/**
 * The provider's answer does not form one consistent chain segment (logs from one fork, headers
 * from another, a lagging node). Expected at the head during a reorg; see fetchRangeRetrying.
 */
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

const blockCalls = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => ({ method: "eth_getBlockByNumber", params: [quantity(from + i), false] }));

const toHeader = (b: WireBlock): BlockHeader => ({ number: Number(b.number), hash: hex(b.hash), parentHash: hex(b.parentHash), timestamp: Number(b.timestamp) });

async function getHeaders(provider: Provider, from: number, to: number): Promise<BlockHeader[]> {
  const wire = await provider.batch<WireBlock | null>(blockCalls(from, to));
  return wire.map((b, i) => {
    if (!b) throw new InconsistentRangeError(`provider has no block ${from + i}`);
    return toHeader(b);
  });
}

/** Headers for [from, to] as the provider sees them now; a height it does not have (above its head) is undefined. */
export async function fetchCanonicalHeaders(pool: RpcPool, from: number, to: number): Promise<(BlockHeader | undefined)[]> {
  const wire = await pool.run((p) => p.batch<WireBlock | null>(blockCalls(from, to)));
  return wire.map((b) => (b ? toHeader(b) : undefined));
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

export interface RetryPolicy {
  /** Retries after the first attempt. */
  retries: number;
  /** Delay before retry number `attempt` (1-based). */
  backoffMs(attempt: number): number;
  signal?: AbortSignal;
  onRetry?(err: InconsistentRangeError, attempt: number): void;
}

/**
 * fetchRange, re-fetching an inconsistent answer a bounded number of times. Near the head a range
 * can straddle a reorg or hit a node that lags its peers; both settle within a few seconds.
 */
export async function fetchRangeRetrying(pool: RpcPool, req: LogFilter, policy: RetryPolicy): Promise<FetchedRange> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetchRange(pool, req);
    } catch (err) {
      if (!(err instanceof InconsistentRangeError) || attempt > policy.retries) throw err;
      policy.onRetry?.(err, attempt);
      await sleep(policy.backoffMs(attempt), undefined, { signal: policy.signal });
    }
  }
}

export async function latestBlockNumber(pool: RpcPool): Promise<number> {
  return Number(await pool.run((p) => p.request<string>("eth_blockNumber", [])));
}

export async function finalizedBlockNumber(pool: RpcPool): Promise<number> {
  const block = await pool.run((p) => p.request<WireBlock | null>("eth_getBlockByNumber", ["finalized", false]));
  if (!block) throw new Error("provider returned no finalized block");
  return Number(block.number);
}
