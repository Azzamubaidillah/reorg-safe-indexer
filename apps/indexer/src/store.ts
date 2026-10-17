import { and, asc, between, eq, gt, gte, isNull, sql } from "drizzle-orm";
import { blocks, erc20Transfers, logs, ranges, reorgs, runs, uniswapV3Swaps, type Database } from "@rsi/db";
import type { BlockRef, DecodedRange, FetchedRange, Hex } from "./types.ts";

export class ContinuityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContinuityError";
  }
}

export class PayloadMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayloadMismatchError";
  }
}

export interface CommitInput {
  chainId: number;
  runId: string;
  range: FetchedRange;
  decoded: DecodedRange;
  payloadSha256: string;
  /** Cumulative per-provider, per-method call counts of the run so far. */
  rpcCalls: Record<string, Record<string, number>>;
}

// Postgres allows 65,535 bind parameters per statement.
const MAX_BIND_PARAMS = 60_000;

export async function insertChunked<T extends object>(rows: T[], columns: number, insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
  const size = Math.floor(MAX_BIND_PARAMS / columns);
  for (let i = 0; i < rows.length; i += size) await insert(rows.slice(i, i + size));
}

/** Next block to fetch: one past the last committed range, or startBlock on an empty chain. */
export async function resumePoint(database: Database, chainId: number, startBlock: number): Promise<number> {
  const [row] = await database.db
    .select({ first: sql<number | null>`min(${ranges.fromBlock})`, last: sql<number | null>`max(${ranges.toBlock})` })
    .from(ranges)
    .where(eq(ranges.chainId, chainId));
  if (row?.first == null || row.last == null) return startBlock;
  if (Number(row.first) !== startBlock) {
    throw new Error(`committed ranges begin at block ${row.first} but START_BLOCK is ${startBlock}`);
  }
  return Number(row.last) + 1;
}

export type DbTransaction = Parameters<Parameters<Database["db"]["transaction"]>[0]>[0];

/** Inserts a range's headers, landing logs and decoded rows; the caller owns the transaction and the ops.ranges row. */
export async function insertRangeRows(tx: DbTransaction, chainId: number, range: FetchedRange, decoded: DecodedRange): Promise<void> {
  await insertChunked(range.blocks, 4, (chunk) =>
    tx
      .insert(blocks)
      .values(chunk.map((b) => ({ chainId, number: b.number, hash: b.hash, parentHash: b.parentHash, timestamp: new Date(b.timestamp * 1000) })))
      .onConflictDoNothing(),
  );
  await insertChunked(range.logs, 9, (chunk) => tx.insert(logs).values(chunk.map((l) => ({ chainId, ...l }))).onConflictDoNothing());
  await insertChunked(decoded.transfers, 9, (chunk) =>
    tx
      .insert(erc20Transfers)
      .values(
        chunk.map((t) => ({
          chainId,
          blockNumber: t.blockNumber,
          blockHash: t.blockHash,
          logIndex: t.logIndex,
          txHash: t.txHash,
          token: t.token,
          fromAddress: t.from,
          toAddress: t.to,
          value: t.value,
        })),
      )
      .onConflictDoNothing(),
  );
  await insertChunked(decoded.swaps, 13, (chunk) => tx.insert(uniswapV3Swaps).values(chunk.map((s) => ({ chainId, ...s }))).onConflictDoNothing());
}

/** Writes one range (data, range row, run progress) atomically; a crash leaves either all of it or none. */
export async function commitRange(database: Database, input: CommitInput): Promise<"committed" | "already_committed"> {
  const { chainId, runId, range, decoded, payloadSha256 } = input;
  const first = range.blocks[0];
  if (!first) throw new Error("cannot commit an empty range");

  return database.db.transaction(async (tx) => {
    const [existing] = await tx
      .select({ payloadSha256: ranges.payloadSha256 })
      .from(ranges)
      .where(and(eq(ranges.chainId, chainId), eq(ranges.fromBlock, range.from)));
    if (existing) {
      if (existing.payloadSha256 === payloadSha256) return "already_committed";
      throw new PayloadMismatchError(`range starting at ${range.from} is committed with a different payload`);
    }

    const [prev] = await tx
      .select({ hash: blocks.hash })
      .from(blocks)
      .where(and(eq(blocks.chainId, chainId), eq(blocks.number, range.from - 1)));
    if (prev && prev.hash !== first.parentHash) {
      throw new ContinuityError(`block ${range.from} parentHash ${first.parentHash} does not extend stored block ${prev.hash}`);
    }

    await insertRangeRows(tx, chainId, range, decoded);

    await tx.insert(ranges).values({
      chainId,
      fromBlock: range.from,
      toBlock: range.to,
      blockCount: range.blocks.length,
      logCount: range.logs.length,
      transferCount: decoded.transfers.length,
      swapCount: decoded.swaps.length,
      rejectCount: decoded.rejects.length,
      payloadSha256,
      runId,
    });
    await tx
      .update(runs)
      .set({
        firstBlock: sql`coalesce(${runs.firstBlock}, ${range.from})`,
        lastBlock: range.to,
        rpcCalls: input.rpcCalls,
      })
      .where(eq(runs.id, runId));
    return "committed";
  });
}

export interface ReorgRecord {
  chainId: number;
  runId: string;
  /** Last known finalized block when the reorg was detected. */
  finalizedBlock: number;
  forkBlock: number;
  depth: number;
  orphaned: BlockRef[];
  canonical: BlockRef[];
}

export interface RollbackInput extends ReorgRecord {
  /** Highest block both the stored and the canonical chain agree on. */
  ancestorBlock: number;
}

/** Lowest and highest stored block height; undefined when nothing is stored. */
export async function storedBounds(database: Database, chainId: number): Promise<{ first: number; tip: number } | undefined> {
  const [row] = await database.db
    .select({ first: sql<string | null>`min(${blocks.number})`, tip: sql<string | null>`max(${blocks.number})` })
    .from(blocks)
    .where(eq(blocks.chainId, chainId));
  return row?.first == null || row.tip == null ? undefined : { first: Number(row.first), tip: Number(row.tip) };
}

/** Stored blocks in [from, to], ascending. */
export async function storedBlocks(database: Database, chainId: number, from: number, to: number): Promise<BlockRef[]> {
  const rows = await database.db
    .select({ number: blocks.number, hash: blocks.hash })
    .from(blocks)
    .where(and(eq(blocks.chainId, chainId), between(blocks.number, from, to)))
    .orderBy(asc(blocks.number));
  return rows.map((r) => ({ number: r.number, hash: r.hash as Hex }));
}

/**
 * Drops everything above `ancestorBlock` and records why, in one transaction. Ranges are the unit
 * of re-ingest, so every range reaching past the ancestor goes whole, including its still-canonical
 * blocks below the ancestor; returns the first deleted height, where ingest restarts.
 */
export async function rollbackTo(database: Database, input: RollbackInput): Promise<{ rollbackFrom: number }> {
  const { chainId, runId, ancestorBlock } = input;
  return database.db.transaction(async (tx) => {
    const dropped = await tx
      .delete(ranges)
      .where(and(eq(ranges.chainId, chainId), gt(ranges.toBlock, ancestorBlock)))
      .returning({ fromBlock: ranges.fromBlock });
    if (dropped.length === 0) throw new Error(`no committed range extends past ancestor ${ancestorBlock}`);
    const rollbackFrom = Math.min(...dropped.map((r) => r.fromBlock));

    await tx.delete(erc20Transfers).where(and(eq(erc20Transfers.chainId, chainId), gte(erc20Transfers.blockNumber, rollbackFrom)));
    await tx.delete(uniswapV3Swaps).where(and(eq(uniswapV3Swaps.chainId, chainId), gte(uniswapV3Swaps.blockNumber, rollbackFrom)));
    await tx.delete(logs).where(and(eq(logs.chainId, chainId), gte(logs.blockNumber, rollbackFrom)));
    await tx.delete(blocks).where(and(eq(blocks.chainId, chainId), gte(blocks.number, rollbackFrom)));

    await tx.insert(reorgs).values({ ...input, action: "rolled_back", ancestorBlock, rollbackFrom });
    await tx.update(runs).set({ lastBlock: rollbackFrom - 1 }).where(eq(runs.id, runId));
    return { rollbackFrom };
  });
}

/** Audit row for a reorg the indexer refuses to repair; deletes nothing. */
export async function recordHalt(database: Database, input: ReorgRecord): Promise<void> {
  await database.db.insert(reorgs).values({ ...input, action: "halted", ancestorBlock: null, rollbackFrom: null });
}

export interface UnacknowledgedHalt {
  id: number;
  forkBlock: number;
  finalizedBlock: number;
  detectedAt: Date;
}

/**
 * The oldest halt of the chain that nobody has acknowledged. A restart (Docker's `on-failure` cannot exclude exit
 * code 2) would otherwise re-detect the same fork against the same provider and halt again, so `run` refuses to
 * start while this exists.
 */
export async function unacknowledgedHalt(database: Database, chainId: number): Promise<UnacknowledgedHalt | undefined> {
  const [row] = await database.db
    .select({ id: reorgs.id, forkBlock: reorgs.forkBlock, finalizedBlock: reorgs.finalizedBlock, detectedAt: reorgs.detectedAt })
    .from(reorgs)
    .where(and(eq(reorgs.chainId, chainId), eq(reorgs.action, "halted"), isNull(reorgs.acknowledgedAt)))
    .orderBy(asc(reorgs.id))
    .limit(1);
  return row;
}

/** Records that the operator looked at a halt and judged it safe to continue; `text` says why. Throws when there is nothing to acknowledge. */
export async function acknowledgeHalt(database: Database, chainId: number, id: number, text: string): Promise<void> {
  const note = text.trim();
  if (note === "") throw new Error("acknowledgement must not be empty");
  const updated = await database.db
    .update(reorgs)
    .set({ acknowledgedAt: sql`now()`, acknowledgement: note })
    .where(and(eq(reorgs.id, id), eq(reorgs.chainId, chainId), eq(reorgs.action, "halted"), isNull(reorgs.acknowledgedAt)))
    .returning({ id: reorgs.id });
  if (updated.length > 0) return;

  const [row] = await database.db
    .select({ action: reorgs.action, acknowledgedAt: reorgs.acknowledgedAt })
    .from(reorgs)
    .where(and(eq(reorgs.id, id), eq(reorgs.chainId, chainId)));
  if (!row) throw new Error(`no reorg ${id} on chain ${chainId}`);
  throw new Error(row.action === "halted" ? `halt ${id} is already acknowledged` : `reorg ${id} was ${row.action}, only halts need an acknowledgement`);
}

export async function startRun(database: Database, runId: string, chainId: number): Promise<void> {
  await database.db.insert(runs).values({ id: runId, chainId, status: "running" });
}

export async function finishRun(
  database: Database,
  runId: string,
  outcome: { status: "succeeded" } | { status: "failed"; reason: string },
): Promise<void> {
  await database.db
    .update(runs)
    .set({ status: outcome.status, failureReason: outcome.status === "failed" ? outcome.reason : null, finishedAt: sql`now()` })
    .where(eq(runs.id, runId));
}

/** Callers hold the chain lock, so any run still `running` belongs to a dead process. */
export async function abandonStaleRuns(database: Database, chainId: number): Promise<number> {
  const rows = await database.db
    .update(runs)
    .set({ status: "failed", failureReason: "abandoned", finishedAt: sql`now()` })
    .where(and(eq(runs.chainId, chainId), eq(runs.status, "running")))
    .returning({ id: runs.id });
  return rows.length;
}
