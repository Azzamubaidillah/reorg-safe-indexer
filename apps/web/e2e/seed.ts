import { rm } from "node:fs/promises";
import { exportPublished } from "../../../packages/analytics/src/index.ts";
import { createDb, type Database } from "../../../packages/db/src/index.ts";
import { decodeRange } from "../../indexer/src/decode.ts";
import { payloadSha256 } from "../../indexer/src/payload.ts";
import { commitRange, finishRun, startRun } from "../../indexer/src/store.ts";
import { resetDatabase } from "../../indexer/test/support/db.ts";
import { contractsOf } from "../../indexer/test/support/ranges.ts";
import {
  chain,
  CHAIN_ID,
  DATABASE_URL,
  FAILED_FROM,
  FAILED_GATE,
  FAILED_GATE_DETAIL,
  FAILED_JOB_ID,
  FAILED_JOB_REASON,
  FAILED_TO,
  FINALIZED_BLOCK,
  FIRST_BLOCK,
  HALTED_DETECTED_AT,
  HEAD_BLOCK,
  LAST_BLOCK,
  PARQUET_DIR,
  PUBLISHED_RANGES,
  RANGE_COUNT,
  RANGE_SIZE,
  RECONCILIATIONS,
  REORG_CANONICAL,
  REORG_DEPTH,
  REORG_DETECTED_AT,
  REORG_FORK,
  REORG_ORPHANED,
  RPC_CALLS,
  RUN_ID,
} from "./fixture.ts";

const GATES = ["decode_rejects_zero", "counts_consistent", "blocks_linked", "log_positions_unique", "log_block_hash_matches", "value_bounds", "decoded_matches_landing"];
const PUBLISHED_AT = "2026-10-10T13:00:00.000Z";
const CHECKED_AT = "2026-10-10T12:30:00.000Z";

/** `create database` cannot run inside the target database, so connect to the maintenance one. */
async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const name = target.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const { sql } = createDb(admin.toString(), { max: 1 });
  try {
    const [exists] = await sql`select 1 from pg_database where datname = ${name}`;
    if (!exists) await sql.unsafe(`create database "${name.replaceAll('"', '""')}"`);
  } finally {
    await sql.end();
  }
}

async function commitChain(database: Database): Promise<void> {
  await startRun(database, RUN_ID, CHAIN_ID);
  for (let i = 0; i < RANGE_COUNT; i++) {
    const from = FIRST_BLOCK + i * RANGE_SIZE;
    const range = chain.fetched(from, from + RANGE_SIZE - 1);
    await commitRange(database, {
      chainId: CHAIN_ID,
      runId: RUN_ID,
      range,
      decoded: decodeRange(range.logs, contractsOf(chain)),
      payloadSha256: payloadSha256(range),
      rpcCalls: RPC_CALLS,
    });
  }
  await finishRun(database, RUN_ID, { status: "succeeded" });
}

/** Writes the states the indexer's quality, reorg and reconciliation stages would leave behind. */
async function stageOutcomes({ sql }: Database): Promise<void> {
  const publishedTo = FIRST_BLOCK + PUBLISHED_RANGES * RANGE_SIZE - 1;
  await sql`update ops.ranges set status = 'published', published_at = ${PUBLISHED_AT} where chain_id = ${CHAIN_ID} and to_block <= ${publishedTo}`;
  await sql`update ops.ranges set status = 'failed' where chain_id = ${CHAIN_ID} and from_block = ${FAILED_FROM}`;

  // Candidates have not been through the gates yet, so they carry no results.
  for (let from = FIRST_BLOCK; from <= FAILED_FROM; from += RANGE_SIZE) {
    for (const gate of GATES) {
      const failing = from === FAILED_FROM && gate === FAILED_GATE;
      await sql`
        insert into ops.quality_results (chain_id, from_block, gate, passed, rows_checked, rows_failed, detail, checked_at)
        values (${CHAIN_ID}, ${from}, ${gate}, ${!failing}, ${RANGE_SIZE}, ${failing ? 2 : 0}, ${failing ? FAILED_GATE_DETAIL : null}, ${CHECKED_AT})`;
    }
  }
  await sql`
    insert into ops.backfill_jobs (id, chain_id, from_block, to_block, status, failure_reason, attempts, created_at, updated_at)
    values (${FAILED_JOB_ID}, ${CHAIN_ID}, ${FAILED_FROM}, ${FAILED_TO}, 'queued', ${FAILED_JOB_REASON}, 1, ${CHECKED_AT}, ${CHECKED_AT})`;

  await sql`
    insert into ops.reorgs (chain_id, run_id, detected_at, action, ancestor_block, fork_block, depth, rollback_from, finalized_block, orphaned, canonical)
    values
      (${CHAIN_ID}, ${RUN_ID}, ${HALTED_DETECTED_AT}, 'halted', null, ${FIRST_BLOCK}, 1, null, ${FINALIZED_BLOCK}, ${JSON.stringify([{ number: FIRST_BLOCK, hash: chain.header(FIRST_BLOCK).hash }])}::jsonb, ${"[]"}::jsonb),
      (${CHAIN_ID}, ${RUN_ID}, ${REORG_DETECTED_AT}, 'rolled_back', ${REORG_FORK - 1}, ${REORG_FORK}, ${REORG_DEPTH}, ${REORG_FORK}, ${FINALIZED_BLOCK}, ${JSON.stringify(REORG_ORPHANED)}::jsonb, ${JSON.stringify(REORG_CANONICAL)}::jsonb)`;

  const { explained, unexplained } = RECONCILIATIONS;
  // Cast explicitly: postgres.js cannot bind a JS array as a jsonb parameter without it.
  const mismatch = (heights: { number: number; stored: string; observed: string | null }[]) => JSON.stringify(heights);
  await sql`
    insert into ops.reconciliations (chain_id, from_block, to_block, provider, checked_at, status, blocks_checked, hash_mismatches, stored_log_count, observed_log_count, explanation)
    values
      (${CHAIN_ID}, ${FIRST_BLOCK + RANGE_SIZE}, ${FIRST_BLOCK + 2 * RANGE_SIZE - 1}, 'mock-b', '2026-10-10T12:10:00Z', 'match', ${RANGE_SIZE}, ${mismatch([])}::jsonb, 10, 10, null),
      (${CHAIN_ID}, ${FIRST_BLOCK + 2 * RANGE_SIZE}, ${FIRST_BLOCK + 3 * RANGE_SIZE - 1}, 'mock-b', '2026-10-10T12:20:00Z', 'match', ${RANGE_SIZE}, ${mismatch([])}::jsonb, 12, 12, null),
      (${CHAIN_ID}, ${explained.fromBlock}, ${explained.toBlock}, 'mock-b', '2026-10-10T12:30:00Z', 'mismatch', ${RANGE_SIZE}, ${mismatch([{ number: explained.mismatchHeight, stored: chain.header(explained.mismatchHeight).hash, observed: `0x${"cd".repeat(32)}` }])}::jsonb, 9, 9, ${explained.explanation}),
      (${CHAIN_ID}, ${unexplained.fromBlock}, ${unexplained.toBlock}, 'mock-b', '2026-10-10T12:40:00Z', 'mismatch', ${RANGE_SIZE}, ${mismatch([{ number: unexplained.mismatchHeight, stored: chain.header(unexplained.mismatchHeight).hash, observed: unexplained.observed }])}::jsonb, 11, 10, null)`;

  // Equal lag in every sample keeps the percentiles independent of the interpolation method.
  for (let i = 0; i < 10; i++) {
    await sql`
      insert into ops.lag_samples (chain_id, sampled_at, head_block, finalized_block, stored_tip)
      values (${CHAIN_ID}, now() - make_interval(mins => ${i * 3}), ${HEAD_BLOCK}, ${FINALIZED_BLOCK}, ${LAST_BLOCK})`;
  }
}

export async function seed(): Promise<void> {
  await ensureDatabase(DATABASE_URL);
  await resetDatabase(DATABASE_URL);
  const database = createDb(DATABASE_URL, { max: 2 });
  try {
    await commitChain(database);
    await stageOutcomes(database);
    await rm(PARQUET_DIR, { recursive: true, force: true });
    await exportPublished(database, { chainId: CHAIN_ID, dir: PARQUET_DIR });
  } finally {
    await database.sql.end();
  }
}

await seed();
