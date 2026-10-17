import type { Database } from "@rsi/db";
import type { Logger } from "pino";
import { fetchCanonicalHeaders } from "./fetcher.ts";
import type { RpcPool } from "./rpc/pool.ts";
import { recordHalt, rollbackTo, storedBlocks, storedBounds, type ReorgRecord } from "./store.ts";
import type { BlockRef } from "./types.ts";

/** What a detected reorg looked like; `ancestorBlock` is null when nothing could be rolled back. */
export interface ReorgDetails {
  depth: number;
  forkBlock: number;
  ancestorBlock: number | null;
  finalizedBlock: number;
}

/** The chains diverge at or below the finalized block, which must never happen: stop instead of guessing. */
export class ReorgBelowFinalizedError extends Error {
  constructor(
    message: string,
    readonly details: ReorgDetails,
  ) {
    super(`reorg below finalized: ${message}`);
    this.name = "ReorgBelowFinalizedError";
  }
}

export interface AncestorSearchInput {
  /** Highest stored block. */
  tip: number;
  /** Lowest height worth checking; a fork reaching below it is not repairable. */
  floor: number;
  /** Heights compared per round trip. */
  batchSize: number;
  /** Stored blocks in [from, to], ascending and contiguous. */
  stored(from: number, to: number): Promise<BlockRef[]>;
  /** Canonical blocks for [from, to], index-aligned; undefined where the provider has no block. */
  canonical(from: number, to: number): Promise<(BlockRef | undefined)[]>;
}

export interface AncestorSearch {
  /** Highest height at or above `floor` whose stored hash is canonical; undefined when there is none. */
  ancestor: number | undefined;
  /** Stored blocks above the ancestor (every inspected block when there is none), ascending. */
  orphaned: BlockRef[];
  /** Canonical blocks at the orphaned heights; heights the provider has no block for are absent. */
  canonical: BlockRef[];
}

/** Walks down from the stored tip, `batchSize` heights per request, to the first height both chains agree on. */
export async function findCommonAncestor(input: AncestorSearchInput): Promise<AncestorSearch> {
  const orphaned: BlockRef[] = [];
  const canonical: BlockRef[] = [];
  const finish = (ancestor: number | undefined): AncestorSearch => ({ ancestor, orphaned: orphaned.reverse(), canonical: canonical.reverse() });

  for (let hi = input.tip; hi >= input.floor; ) {
    const lo = Math.max(input.floor, hi - input.batchSize + 1);
    const [stored, canon] = await Promise.all([input.stored(lo, hi), input.canonical(lo, hi)]);
    if (stored.length !== hi - lo + 1) throw new Error(`stored blocks [${lo}, ${hi}] are not contiguous`);
    for (let n = hi; n >= lo; n--) {
      const mine = stored[n - lo]!;
      const theirs = canon[n - lo];
      if (theirs?.hash === mine.hash) return finish(n);
      orphaned.push(mine);
      if (theirs) canonical.push(theirs);
    }
    hi = lo - 1;
  }
  return finish(undefined);
}

export type ReorgOutcome = { kind: "rolled_back"; nextBlock: number; details: ReorgDetails } | { kind: "no_fork" };

export interface ReorgContext {
  database: Database;
  pool: RpcPool;
  log: Logger;
  runId: string;
  chainId: number;
  finalized: number;
  batchSize?: number;
}

const ANCESTOR_BATCH_SIZE = 32;

/**
 * Called when a fetched range does not extend the stored tip. Finds where stored and canonical
 * chains diverge; rolls the stored chain back to that point, or throws ReorgBelowFinalizedError
 * after recording the refusal. `no_fork` means the tip is still canonical: the fetched range came
 * from a node on another view, so nothing is stored differently and the caller just fetches again.
 */
export async function resolveReorg(ctx: ReorgContext): Promise<ReorgOutcome> {
  const { database, pool, log, runId, chainId, finalized } = ctx;
  const bounds = await storedBounds(database, chainId);
  if (!bounds) throw new Error("continuity break with no stored blocks");

  // Never look below the finalized block, and never below what is stored. A tip under `finalized`
  // (still backfilling) is compared on its own: if it is canonical there is no fork to repair.
  const floor = Math.min(bounds.tip, Math.max(finalized, bounds.first));
  const search = await findCommonAncestor({
    tip: bounds.tip,
    floor,
    batchSize: ctx.batchSize ?? ANCESTOR_BATCH_SIZE,
    stored: (from, to) => storedBlocks(database, chainId, from, to),
    canonical: async (from, to) => (await fetchCanonicalHeaders(pool, from, to)).map((h) => h && { number: h.number, hash: h.hash }),
  });

  if (search.ancestor === bounds.tip) return { kind: "no_fork" };

  const record: ReorgRecord = {
    chainId,
    runId,
    finalizedBlock: finalized,
    forkBlock: search.ancestor === undefined ? floor : search.ancestor + 1,
    depth: search.orphaned.length,
    orphaned: search.orphaned,
    canonical: search.canonical,
  };

  if (search.ancestor === undefined) {
    await recordHalt(database, record);
    log.fatal({ action: "halted", depth: record.depth, forkBlock: record.forkBlock, ancestorBlock: null, rollbackFrom: null }, "reorg");
    throw new ReorgBelowFinalizedError(`stored blocks ${floor}..${bounds.tip} differ from the canonical chain, finalized block is ${finalized}`, {
      depth: record.depth,
      forkBlock: record.forkBlock,
      ancestorBlock: null,
      finalizedBlock: finalized,
    });
  }

  const { rollbackFrom } = await rollbackTo(database, { ...record, ancestorBlock: search.ancestor });
  log.warn({ action: "rolled_back", depth: record.depth, forkBlock: record.forkBlock, ancestorBlock: search.ancestor, rollbackFrom }, "reorg");
  return {
    kind: "rolled_back",
    nextBlock: rollbackFrom,
    details: { depth: record.depth, forkBlock: record.forkBlock, ancestorBlock: search.ancestor, finalizedBlock: finalized },
  };
}
