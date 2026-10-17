import { createHash } from "node:crypto";
import type { Database, Sql } from "@rsi/db";
import { decodeRange } from "./decode.ts";
import { insertChunked } from "./store.ts";
import type { Hex, RawLog, TrackedContracts } from "./types.ts";

type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

export type RebuiltTable = "erc20_transfers" | "uniswap_v3_swaps";

export interface RebuildDifference {
  blockNumber: number;
  logIndex: number;
  /** missing_in_stored: the logs decode to a row the table lacks. extra_in_stored: the table has a row no log decodes to. */
  kind: "missing_in_stored" | "extra_in_stored" | "different";
}

export interface RebuildTableReport {
  table: RebuiltTable;
  storedRows: number;
  rebuiltRows: number;
  /** sha256 over the rows' canonical text, ordered by (block_number, log_index, block_hash). */
  storedSha256: string;
  rebuiltSha256: string;
  equal: boolean;
  /** Up to 5 lowest differing positions; empty when equal. */
  firstDifferences: RebuildDifference[];
}

export interface RebuildReport {
  chainId: number;
  logsScanned: number;
  tables: RebuildTableReport[];
  /** Logs the decoder rejected when rebuilding, against the sum of `ops.ranges.reject_count`. */
  rejects: { rebuilt: number; recorded: number };
  /** Every table equal and the reject counts agree. */
  equal: boolean;
}

export interface RebuildInput {
  chainId: number;
  contracts: TrackedContracts;
  /** Rows per cursor fetch when hashing; default 5000. */
  batchSize?: number;
  /** Blocks of logs decoded per round trip; default 200. */
  blockWindow?: number;
}

const DEFAULT_BATCH_SIZE = 5_000;
const DEFAULT_BLOCK_WINDOW = 200;
const MAX_DIFFERENCES = 5;

const TABLES: Record<RebuiltTable, { stored: string; rebuilt: string; columns: string[] }> = {
  erc20_transfers: {
    stored: "chain.erc20_transfers",
    rebuilt: "rebuilt_transfers",
    columns: ["block_number", "block_hash", "log_index", "tx_hash", "token", "from_address", "to_address", "value"],
  },
  uniswap_v3_swaps: {
    stored: "chain.uniswap_v3_swaps",
    rebuilt: "rebuilt_swaps",
    columns: ["block_number", "block_hash", "log_index", "tx_hash", "pool", "sender", "recipient", "amount0", "amount1", "sqrt_price_x96", "liquidity", "tick"],
  },
};

interface LogRow {
  block_number: string;
  block_hash: string;
  log_index: number;
  tx_hash: string;
  tx_index: number;
  address: string;
  topics: string[];
  data: string;
}

/** Order that makes a table's hash independent of physical layout; block_hash only breaks ties on broken data. */
const ORDER = "order by block_number, log_index, block_hash";

/** Both sides are hashed from the same column list and text encoding, so equal content means equal hash. */
const canonical = (columns: string[]) => `concat_ws('|', ${columns.join(", ")})`;

async function digest(tx: Tx, table: string, columns: string[], chainId: number, batchSize: number): Promise<{ rows: number; sha256: string }> {
  const hash = createHash("sha256");
  let rows = 0;
  const cursor = tx.unsafe<{ row: string }[]>(`select ${canonical(columns)} as row from ${table} where chain_id = $1 ${ORDER}`, [chainId]).cursor(batchSize);
  for await (const batch of cursor) {
    for (const { row } of batch) hash.update(`${row}\n`);
    rows += batch.length;
  }
  return { rows, sha256: hash.digest("hex") };
}

async function firstDifferences(tx: Tx, spec: (typeof TABLES)[RebuiltTable], chainId: number): Promise<RebuildDifference[]> {
  const side = (table: string) => `select block_number, log_index, ${canonical(spec.columns)} as enc from ${table} where chain_id = $1`;
  const rows = await tx.unsafe<{ block_number: string; log_index: number; kind: RebuildDifference["kind"] }[]>(
    `with r as (${side(spec.rebuilt)}), s as (${side(spec.stored)})
     select coalesce(r.block_number, s.block_number) as block_number, coalesce(r.log_index, s.log_index) as log_index,
       case when r.enc is null then 'extra_in_stored' when s.enc is null then 'missing_in_stored' else 'different' end as kind
     from r full join s on r.block_number = s.block_number and r.log_index = s.log_index
     where r.enc is distinct from s.enc
     order by 1, 2
     limit ${MAX_DIFFERENCES}`,
    [chainId],
  );
  return rows.map((r) => ({ blockNumber: Number(r.block_number), logIndex: r.log_index, kind: r.kind }));
}

/**
 * Re-decodes every stored landing log and compares the result with the stored decoded tables, which
 * proves the decoded tables are a pure function of the landing table. The rebuild lives in temporary
 * tables of one transaction (dropped on commit), so production tables are only read, from one
 * snapshot. Memory stays flat: logs are read a window of blocks at a time, hashed rows move through
 * cursors of `batchSize` rows, and the rebuilt rows live in the temp tables, inside Postgres.
 */
export async function verifyRebuild(database: Database, input: RebuildInput): Promise<RebuildReport> {
  const { chainId, contracts } = input;
  const batchSize = input.batchSize ?? DEFAULT_BATCH_SIZE;
  const blockWindow = input.blockWindow ?? DEFAULT_BLOCK_WINDOW;

  // Not READ ONLY: Postgres refuses CREATE TEMP TABLE in a read-only transaction.
  return database.sql.begin("isolation level repeatable read", async (tx) => {
    for (const spec of Object.values(TABLES)) {
      await tx.unsafe(`create temp table ${spec.rebuilt} (like ${spec.stored}) on commit drop`);
    }

    let logsScanned = 0;
    let rebuiltRejects = 0;
    // A cursor cannot be held open while the same connection inserts, so logs are read window by window.
    const [span] = await tx<{ lo: string | null; hi: string | null }[]>`
      select min(block_number) as lo, max(block_number) as hi from chain.logs where chain_id = ${chainId}`;
    for (let lo = Number(span?.lo ?? 0); span?.hi != null && lo <= Number(span.hi); lo += blockWindow) {
      const batch = await tx<LogRow[]>`
        select block_number, block_hash, log_index, tx_hash, tx_index, address, topics, data
        from chain.logs
        where chain_id = ${chainId} and block_number between ${lo} and ${lo + blockWindow - 1}
        order by block_number, log_index, block_hash`;
      const raw = batch.map(
        (l): RawLog => ({
          blockNumber: Number(l.block_number),
          blockHash: l.block_hash as Hex,
          logIndex: l.log_index,
          txHash: l.tx_hash as Hex,
          txIndex: l.tx_index,
          address: l.address as Hex,
          topics: l.topics as Hex[],
          data: l.data as Hex,
        }),
      );
      const decoded = decodeRange(raw, contracts);
      logsScanned += raw.length;
      rebuiltRejects += decoded.rejects.length;

      const transfers = decoded.transfers.map((t) => ({
        chain_id: chainId,
        block_number: t.blockNumber,
        block_hash: t.blockHash,
        log_index: t.logIndex,
        tx_hash: t.txHash,
        token: t.token,
        from_address: t.from,
        to_address: t.to,
        value: t.value,
      }));
      await insertChunked(transfers, 9, (chunk) => tx`insert into ${tx(TABLES.erc20_transfers.rebuilt)} ${tx(chunk)}`);
      const swaps = decoded.swaps.map((s) => ({
        chain_id: chainId,
        block_number: s.blockNumber,
        block_hash: s.blockHash,
        log_index: s.logIndex,
        tx_hash: s.txHash,
        pool: s.pool,
        sender: s.sender,
        recipient: s.recipient,
        amount0: s.amount0,
        amount1: s.amount1,
        sqrt_price_x96: s.sqrtPriceX96,
        liquidity: s.liquidity,
        tick: s.tick,
      }));
      await insertChunked(swaps, 13, (chunk) => tx`insert into ${tx(TABLES.uniswap_v3_swaps.rebuilt)} ${tx(chunk)}`);
    }

    const tables: RebuildTableReport[] = [];
    for (const [table, spec] of Object.entries(TABLES) as [RebuiltTable, (typeof TABLES)[RebuiltTable]][]) {
      const stored = await digest(tx, spec.stored, spec.columns, chainId, batchSize);
      const rebuilt = await digest(tx, spec.rebuilt, spec.columns, chainId, batchSize);
      const equal = stored.sha256 === rebuilt.sha256 && stored.rows === rebuilt.rows;
      tables.push({
        table,
        storedRows: stored.rows,
        rebuiltRows: rebuilt.rows,
        storedSha256: stored.sha256,
        rebuiltSha256: rebuilt.sha256,
        equal,
        firstDifferences: equal ? [] : await firstDifferences(tx, spec, chainId),
      });
    }

    const [recorded] = await tx<{ n: number }[]>`select coalesce(sum(reject_count), 0)::int as n from ops.ranges where chain_id = ${chainId}`;
    const recordedRejects = recorded?.n ?? 0;
    return {
      chainId,
      logsScanned,
      tables,
      rejects: { rebuilt: rebuiltRejects, recorded: recordedRejects },
      equal: tables.every((t) => t.equal) && rebuiltRejects === recordedRejects,
    };
  });
}
