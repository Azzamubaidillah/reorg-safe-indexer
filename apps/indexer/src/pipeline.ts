import { setTimeout as sleep } from "node:timers/promises";
import type { Database } from "@rsi/db";
import type { Logger } from "pino";
import { decodeRange, SWAP_TOPIC, TRANSFER_TOPIC } from "./decode.ts";
import { fetchRange, finalizedBlockNumber } from "./fetcher.ts";
import { payloadSha256 } from "./payload.ts";
import type { RpcPool } from "./rpc/pool.ts";
import { commitRange } from "./store.ts";
import type { DecodedRange, FetchedRange } from "./types.ts";

export interface PipelineOptions {
  database: Database;
  pool: RpcPool;
  log: Logger;
  signal: AbortSignal;
  runId: string;
  chainId: number;
  tokens: `0x${string}`[];
  pools: `0x${string}`[];
  /** First block not yet committed. */
  nextBlock: number;
  /** Stop after committing this block; undefined follows the finalized head forever. */
  endBlock: number | undefined;
  rangeSize: number;
  fetchConcurrency: number;
  pollIntervalMs: number;
}

interface Prepared {
  range: FetchedRange;
  decoded: DecodedRange;
  hash: string;
}

/**
 * Fetches up to `fetchConcurrency` ranges ahead but commits them strictly in order, so the
 * committed ranges are always a contiguous prefix. Returns when endBlock is committed or the
 * signal aborts (after any in-flight commit finishes).
 */
export async function runPipeline(o: PipelineOptions): Promise<void> {
  const aborted = Promise.withResolvers<"aborted">();
  o.signal.addEventListener("abort", () => aborted.resolve("aborted"), { once: true });
  if (o.signal.aborted) return;

  const addresses = [...o.tokens, ...o.pools];
  const topic0s = [TRANSFER_TOPIC, SWAP_TOPIC];
  let next = o.nextBlock;

  const prepare = async (from: number, to: number): Promise<Prepared> => {
    const range = await fetchRange(o.pool, { from, to, addresses, topic0s });
    return { range, decoded: decodeRange(range.logs, { tokens: o.tokens, pools: o.pools }), hash: payloadSha256(range) };
  };

  while (!o.signal.aborted) {
    const finalized = await Promise.race([finalizedBlockNumber(o.pool), aborted.promise]);
    if (finalized === "aborted") return;
    const target = Math.min(finalized, o.endBlock ?? finalized);
    if (next > target) {
      if (o.endBlock !== undefined && next > o.endBlock) return;
      await sleep(o.pollIntervalMs, undefined, { signal: o.signal }).catch(() => {});
      continue;
    }

    const inflight: Promise<Prepared>[] = [];
    let cursor = next;
    while (cursor <= target || inflight.length > 0) {
      while (inflight.length < o.fetchConcurrency && cursor <= target) {
        const task = prepare(cursor, Math.min(cursor + o.rangeSize - 1, target));
        task.catch(() => {}); // a failure is reported when this task reaches the head of the queue
        inflight.push(task);
        cursor += o.rangeSize;
      }
      const head = await Promise.race([inflight.shift()!, aborted.promise]);
      if (head === "aborted") return;

      const result = await commitRange(o.database, {
        chainId: o.chainId,
        runId: o.runId,
        range: head.range,
        decoded: head.decoded,
        payloadSha256: head.hash,
        rpcCalls: o.pool.callCounts(),
      });
      next = head.range.to + 1;
      o.log.info(
        { from: head.range.from, to: head.range.to, logs: head.range.logs.length, transfers: head.decoded.transfers.length, swaps: head.decoded.swaps.length, rejects: head.decoded.rejects.length, result },
        "range committed",
      );
      if (o.signal.aborted) return;
    }
  }
}
