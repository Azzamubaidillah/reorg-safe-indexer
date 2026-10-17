import { and, asc, between, eq, isNull, lte, ne, notExists, or, sql } from "drizzle-orm";
import { logs, ranges, reconciliations, type Database, type ReconciliationMismatch } from "@rsi/db";
import { SWAP_TOPIC, TRANSFER_TOPIC } from "./decode.ts";
import { getLogsSplit } from "./fetcher.ts";
import type { Provider } from "./rpc/provider.ts";
import { storedBlocks } from "./store.ts";
import type { TrackedContracts } from "./types.ts";

/** What identifies a log across sources: where it sits and which transaction emitted it. */
export interface LogIdentity {
  blockNumber: number;
  blockHash: string;
  logIndex: number;
  txHash: string;
}

export interface RangeComparison {
  status: "match" | "mismatch";
  /** Distinct heights compared: every height with a log on either side, plus the last block. */
  blocksChecked: number;
  hashMismatches: ReconciliationMismatch[];
  storedLogCount: number;
  observedLogCount: number;
  /** Logs present on one side only (by full identity), summed over both sides. Not persisted; explains a mismatch whose counts agree. */
  logDifferences: number;
}

export interface RangeSides {
  from: number;
  to: number;
  stored: {
    logs: LogIdentity[];
    /** Stored block hash by height, for every block of the range. */
    blockHashes: ReadonlyMap<number, string>;
  };
  observed: {
    logs: LogIdentity[];
    /** Second source's hash for the range's last block (the only header it is asked for). */
    lastBlockHash: string;
  };
}

const identityKey = (l: LogIdentity) => `${l.blockNumber}:${l.blockHash}:${l.logIndex}:${l.txHash}`;

/**
 * Stored vs second-source view of one range. A height's observed hash comes from the hash on its
 * logs (the last block: from its header), so a height where only one side has logs, or where the
 * logs carry a different block hash, is a hash mismatch. Heights with no logs on either side are
 * not compared: no source says anything about them except the last block's header.
 */
export function compareRange({ to, stored, observed }: RangeSides): RangeComparison {
  const observedHash = new Map<number, string>();
  for (const l of observed.logs) if (!observedHash.has(l.blockNumber)) observedHash.set(l.blockNumber, l.blockHash);
  observedHash.set(to, observed.lastBlockHash);

  const heights = new Set([to, ...stored.logs.map((l) => l.blockNumber), ...observed.logs.map((l) => l.blockNumber)]);
  const hashMismatches: ReconciliationMismatch[] = [];
  for (const number of [...heights].sort((a, b) => a - b)) {
    // "" = no stored block at a height the second source has logs for: never equal to a real hash.
    const storedHash = stored.blockHashes.get(number) ?? "";
    const observedAt = observedHash.get(number) ?? null;
    if (storedHash !== observedAt) hashMismatches.push({ number, stored: storedHash, observed: observedAt });
  }

  const storedKeys = new Set(stored.logs.map(identityKey));
  const observedKeys = new Set(observed.logs.map(identityKey));
  let logDifferences = 0;
  for (const k of storedKeys) if (!observedKeys.has(k)) logDifferences++;
  for (const k of observedKeys) if (!storedKeys.has(k)) logDifferences++;

  const matches =
    hashMismatches.length === 0 && logDifferences === 0 && stored.logs.length === observed.logs.length;
  return {
    status: matches ? "match" : "mismatch",
    blocksChecked: heights.size,
    hashMismatches,
    storedLogCount: stored.logs.length,
    observedLogCount: observed.logs.length,
    logDifferences,
  };
}

export interface ReconcileInput {
  chainId: number;
  finalizedBlock: number;
  /** Most ranges examined in one call. */
  limit: number;
  contracts: TrackedContracts;
}

export interface ReconcileFailure {
  fromBlock: number;
  toBlock: number;
  message: string;
}

export interface ReconcileSummary {
  rangesChecked: number;
  matches: number;
  /** `ops.reconciliations.id` of every mismatch recorded by this call. */
  mismatchIds: number[];
  /** Ranges the second source could not answer for; no row was written, so the next call retries them. */
  providerErrors: number;
  failures: ReconcileFailure[];
  /** JSON-RPC calls this call sent to the second source, by method. */
  rpcCalls: Record<string, number>;
}

interface WireHeader {
  number: string;
  hash: string;
}

const quantity = (n: number) => `0x${n.toString(16)}`;

interface Observed {
  logs: LogIdentity[];
  lastBlockHash: string;
}

/** Header first: a second source that has not reached the range yet is an error, not a pile of mismatches. */
async function observeRange(provider: Provider, contracts: TrackedContracts, from: number, to: number): Promise<Observed> {
  const header = await provider.request<WireHeader | null>("eth_getBlockByNumber", [quantity(to), false]);
  if (!header) throw new Error(`${provider.name} has no block ${to}`);
  if (Number(header.number) !== to) throw new Error(`${provider.name} answered block ${Number(header.number)} for ${to}`);
  const found = await getLogsSplit(provider, {
    from,
    to,
    addresses: [...contracts.tokens, ...contracts.pools],
    topic0s: [TRANSFER_TOPIC, SWAP_TOPIC],
  });
  return { logs: found, lastBlockHash: header.hash.toLowerCase() };
}

/**
 * Re-reads the oldest finalized ranges not yet checked against `provider` and records one
 * `ops.reconciliations` row each. A provider failure writes nothing, so the range comes up again
 * on the next call; database errors propagate.
 */
export async function reconcileRanges(database: Database, provider: Provider, input: ReconcileInput): Promise<ReconcileSummary> {
  const { chainId, finalizedBlock, limit, contracts } = input;
  const due = await database.db
    .select({ fromBlock: ranges.fromBlock, toBlock: ranges.toBlock })
    .from(ranges)
    .where(
      and(
        eq(ranges.chainId, chainId),
        lte(ranges.toBlock, finalizedBlock),
        ne(ranges.status, "failed"),
        notExists(
          database.db
            .select({ one: sql`1` })
            .from(reconciliations)
            .where(
              and(
                eq(reconciliations.chainId, ranges.chainId),
                eq(reconciliations.fromBlock, ranges.fromBlock),
                eq(reconciliations.toBlock, ranges.toBlock),
                eq(reconciliations.provider, provider.name),
              ),
            ),
        ),
      ),
    )
    .orderBy(asc(ranges.fromBlock))
    .limit(limit);

  const callsBefore = { ...provider.calls };
  const summary: ReconcileSummary = { rangesChecked: 0, matches: 0, mismatchIds: [], providerErrors: 0, failures: [], rpcCalls: {} };

  for (const { fromBlock, toBlock } of due) {
    let observed: Observed;
    try {
      observed = await observeRange(provider, contracts, fromBlock, toBlock);
    } catch (err) {
      summary.providerErrors++;
      summary.failures.push({ fromBlock, toBlock, message: err instanceof Error ? err.message : String(err) });
      continue;
    }

    const storedLogs = await database.db
      .select({ blockNumber: logs.blockNumber, blockHash: logs.blockHash, logIndex: logs.logIndex, txHash: logs.txHash })
      .from(logs)
      .where(and(eq(logs.chainId, chainId), between(logs.blockNumber, fromBlock, toBlock)));
    const blockHashes = new Map((await storedBlocks(database, chainId, fromBlock, toBlock)).map((b) => [b.number, b.hash]));

    const result = compareRange({
      from: fromBlock,
      to: toBlock,
      stored: { logs: storedLogs, blockHashes },
      observed,
    });
    const [row] = await database.db
      .insert(reconciliations)
      .values({
        chainId,
        fromBlock,
        toBlock,
        provider: provider.name,
        status: result.status,
        blocksChecked: result.blocksChecked,
        hashMismatches: result.hashMismatches,
        storedLogCount: result.storedLogCount,
        observedLogCount: result.observedLogCount,
      })
      .returning({ id: reconciliations.id });
    if (!row) throw new Error(`reconciliation insert for ${fromBlock}-${toBlock} returned no row`);

    summary.rangesChecked++;
    if (result.status === "match") summary.matches++;
    else summary.mismatchIds.push(row.id);
  }

  for (const [method, count] of Object.entries(provider.calls)) {
    const used = count - (callsBefore[method] ?? 0);
    if (used > 0) summary.rpcCalls[method] = used;
  }
  return summary;
}

/** Records why a mismatch is understood; only mismatches need one, and the text must say something. */
export async function explainReconciliation(database: Database, id: number, explanation: string): Promise<void> {
  const text = explanation.trim();
  if (text === "") throw new Error("explanation must not be empty");
  const updated = await database.db
    .update(reconciliations)
    .set({ explanation: text })
    .where(and(eq(reconciliations.id, id), eq(reconciliations.status, "mismatch")))
    .returning({ id: reconciliations.id });
  if (updated.length > 0) return;

  const [row] = await database.db.select({ status: reconciliations.status }).from(reconciliations).where(eq(reconciliations.id, id));
  throw new Error(row ? `reconciliation ${id} is a ${row.status}, only mismatches take an explanation` : `no reconciliation with id ${id}`);
}

/** Mismatches nobody has explained yet, oldest first: the rows that keep the M3 gate closed. */
export async function unexplainedMismatches(database: Database, chainId: number): Promise<(typeof reconciliations.$inferSelect)[]> {
  return database.db
    .select()
    .from(reconciliations)
    .where(and(eq(reconciliations.chainId, chainId), eq(reconciliations.status, "mismatch"), or(isNull(reconciliations.explanation), eq(reconciliations.explanation, ""))))
    .orderBy(asc(reconciliations.id));
}
