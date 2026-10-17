import { and, eq, sql } from "drizzle-orm";
import { blocks, erc20Transfers, logs, ranges, runs, uniswapV3Swaps, type Database } from "@rsi/db";
import type { DecodedRange, FetchedRange } from "./types.ts";

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

async function insertChunked<T extends object>(rows: T[], columns: number, insert: (chunk: T[]) => Promise<unknown>): Promise<void> {
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
