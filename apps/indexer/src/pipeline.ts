import { setTimeout as sleep } from "node:timers/promises";
import type { Database } from "@rsi/db";
import type { Logger } from "pino";
import { decodeRange, SWAP_TOPIC, TRANSFER_TOPIC } from "./decode.ts";
import { fetchRangeRetrying, finalizedBlockNumber, latestBlockNumber } from "./fetcher.ts";
import { payloadSha256 } from "./payload.ts";
import { resolveReorg } from "./reorg.ts";
import type { RpcPool } from "./rpc/pool.ts";
import { commitRange, ContinuityError } from "./store.ts";
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
  /** Stop after committing this block; undefined follows the head forever. */
  endBlock: number | undefined;
  rangeSize: number;
  fetchConcurrency: number;
  /** How often the finalized block number is refreshed. */
  pollIntervalMs: number;
  /** How often an idle indexer asks for a new head. */
  headPollIntervalMs: number;
}

interface Prepared {
  range: FetchedRange;
  decoded: DecodedRange;
  hash: string;
}

// Inconsistent answers and spurious continuity breaks settle within seconds; beyond that something is wrong.
const MAX_RETRIES = 8;
const backoffMs = (attempt: number) => Math.min(4_000, 250 * 2 ** (attempt - 1));

/**
 * Follows `latest` (capped at endBlock): fetches up to `fetchConcurrency` ranges ahead but commits
 * them strictly in order, so the committed ranges are always a contiguous prefix. A range that does
 * not extend the stored tip is the reorg signal: the stored chain is rolled back to the common
 * ancestor and ingest restarts from there (or throws ReorgBelowFinalizedError). Returns when
 * endBlock is committed or the signal aborts (after any in-flight commit finishes).
 */
export async function runPipeline(o: PipelineOptions): Promise<void> {
  const aborted = Promise.withResolvers<"aborted">();
  o.signal.addEventListener("abort", () => aborted.resolve("aborted"), { once: true });
  if (o.signal.aborted) return;

  const addresses = [...o.tokens, ...o.pools];
  const topic0s = [TRANSFER_TOPIC, SWAP_TOPIC];
  let next = o.nextBlock;
  let finalized = 0;
  let finalizedAt = -Infinity;
  // Consecutive continuity breaks that turned out not to be forks.
  let spurious = 0;
  const refreshFinalized = async () => {
    // Providers can lag each other; finality never goes backwards.
    finalized = Math.max(finalized, await finalizedBlockNumber(o.pool));
    finalizedAt = performance.now();
  };

  while (!o.signal.aborted) {
    const latest = await Promise.race([latestBlockNumber(o.pool), aborted.promise]);
    if (latest === "aborted") return;
    if (performance.now() - finalizedAt >= o.pollIntervalMs && (await Promise.race([refreshFinalized(), aborted.promise])) === "aborted") return;

    const target = Math.min(latest, o.endBlock ?? latest);
    if (next > target) {
      if (o.endBlock !== undefined && next > o.endBlock) return;
      await sleep(o.headPollIntervalMs, undefined, { signal: o.signal }).catch(() => {});
      continue;
    }

    // Cancels fetches (their retry sleeps) still queued when this pass ends early on a reorg.
    const pass = new AbortController();
    const passSignal = AbortSignal.any([o.signal, pass.signal]);
    const prepare = async (from: number, to: number): Promise<Prepared> => {
      const range = await fetchRangeRetrying(o.pool, { from, to, addresses, topic0s }, {
        retries: MAX_RETRIES,
        backoffMs,
        signal: passSignal,
        onRetry: (err, attempt) => o.log.warn({ from, to, attempt, err: err.message }, "inconsistent range, refetching"),
      });
      return { range, decoded: decodeRange(range.logs, { tokens: o.tokens, pools: o.pools }), hash: payloadSha256(range) };
    };

    try {
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

        try {
          const result = await commitRange(o.database, {
            chainId: o.chainId,
            runId: o.runId,
            range: head.range,
            decoded: head.decoded,
            payloadSha256: head.hash,
            rpcCalls: o.pool.callCounts(),
          });
          next = head.range.to + 1;
          spurious = 0;
          o.log.info(
            { from: head.range.from, to: head.range.to, logs: head.range.logs.length, transfers: head.decoded.transfers.length, swaps: head.decoded.swaps.length, rejects: head.decoded.rejects.length, result },
            "range committed",
          );
        } catch (err) {
          if (!(err instanceof ContinuityError)) throw err;
          // Ranges still in flight were fetched against the chain that just lost; drop them.
          // The periodic value can be minutes old; a fork is judged against finality as of now.
          await refreshFinalized();
          const outcome = await resolveReorg({ database: o.database, pool: o.pool, log: o.log, runId: o.runId, chainId: o.chainId, finalized });
          if (outcome.kind === "rolled_back") {
            next = outcome.nextBlock;
            spurious = 0;
          } else if (++spurious > MAX_RETRIES) {
            throw err;
          } else {
            o.log.warn({ attempt: spurious, err: err.message }, "continuity break but stored tip is canonical, refetching");
            await sleep(backoffMs(spurious), undefined, { signal: o.signal }).catch(() => {});
          }
          break;
        }
        if (o.signal.aborted) return;
      }
    } finally {
      pass.abort();
    }
  }
}
