import { SyntheticChain, TEST_POOL, TEST_TOKEN } from "../../indexer/test/support/synthetic-chain.ts";

// The dashboard E2E world. Seeded by seed.ts, asserted by the specs; both derive everything from this file so the
// expected values cannot drift from what was written.

export const CHAIN_ID = 1;
export const RUN_ID = "e2e-run";
export const RANGE_SIZE = 20;
/** Chosen so the published blocks span two UTC hours (block 1367 is the first at or after 17:00 UTC), giving the OHLC chart two buckets. */
export const FIRST_BLOCK = 1300;
/** 12 ranges of 20 blocks: 1300..1539. */
export const RANGE_COUNT = 12;
export const LAST_BLOCK = FIRST_BLOCK + RANGE_SIZE * RANGE_COUNT - 1;

/** Ranges that are published: the first 8 (1300..1459). */
export const PUBLISHED_RANGES = 8;
export const PUBLISHED_TO = FIRST_BLOCK + RANGE_SIZE * PUBLISHED_RANGES - 1;
/** The 9th range fails a gate and is unpublished with a queued backfill job. */
export const FAILED_FROM = PUBLISHED_TO + 1;
export const FAILED_TO = FAILED_FROM + RANGE_SIZE - 1;
export const FAILED_GATE = "counts_consistent";
export const FAILED_GATE_DETAIL = "transfer_count=2";
export const FAILED_JOB_ID = `${CHAIN_ID}:${FAILED_FROM}-${FAILED_TO}`;
export const FAILED_JOB_REASON = "gate counts_consistent failed: transfer_count=2";

export const HEAD_BLOCK = LAST_BLOCK + 6;
export const FINALIZED_BLOCK = PUBLISHED_TO + 40;

export const chain = new SyntheticChain();
export { TEST_POOL, TEST_TOKEN };

/** The staged reorg: stored blocks REORG_FORK..REORG_FORK+2 were replaced by a competing fork. */
export const REORG_FORK = FIRST_BLOCK + 150;
export const REORG_DEPTH = 3;
export const REORG_DETECTED_AT = "2026-10-10T12:00:00.000Z";
const fork = chain.fork(REORG_FORK, "e2e-fork");
const heights = Array.from({ length: REORG_DEPTH }, (_, i) => REORG_FORK + i);
export const REORG_ORPHANED = heights.map((number) => ({ number, hash: chain.header(number).hash }));
export const REORG_CANONICAL = heights.map((number) => ({ number, hash: fork.header(number).hash }));
/** Two halts: #1 still blocks the indexer's restart, #2 was acknowledged by the operator; #3 is the rollback above. */
export const UNACKED_HALT_DETECTED_AT = "2026-09-20T08:30:00.000Z";
export const HALTED_DETECTED_AT = "2026-10-01T08:30:00.000Z";
export const HALT_ACKNOWLEDGED_AT = "2026-10-01T09:15:00.000Z";
export const HALT_ACKNOWLEDGEMENT = "Provider rolled back inside finality; two other providers agree with the stored chain.";

export const RECONCILIATIONS = {
  matchCount: 2,
  explained: { fromBlock: FIRST_BLOCK, toBlock: FIRST_BLOCK + RANGE_SIZE - 1, mismatchHeight: FIRST_BLOCK + 10, explanation: "Provider B served a stale uncle block; re-read after the provider resynced." },
  unexplained: { fromBlock: FIRST_BLOCK + 6 * RANGE_SIZE, toBlock: FIRST_BLOCK + 7 * RANGE_SIZE - 1, mismatchHeight: FIRST_BLOCK + 6 * RANGE_SIZE + 7, observed: `0x${"ab".repeat(32)}` },
};

export const RPC_CALLS = { "mock-a": { eth_getLogs: 12, eth_getBlockByNumber: 240 }, "mock-b": { eth_getLogs: 3 } };

/** What the published ranges contain; explorer and analytics are fail-closed to exactly this. */
export const publishedTotals = chain.totals(FIRST_BLOCK, PUBLISHED_TO);
export const allTotals = chain.totals(FIRST_BLOCK, LAST_BLOCK);

export const API_PORT = 3291;
export const WEB_PORT = 3191;
export const API_URL = `http://127.0.0.1:${API_PORT}`;
export const WEB_URL = `http://127.0.0.1:${WEB_PORT}`;
export const DATABASE_URL = process.env.E2E_DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/indexer_test_m4_web";
export const PARQUET_DIR = new URL("./.state/parquet", import.meta.url).pathname;
