import { z } from "zod";

// Wire contract of the read-only API (v1). Query schemas parse and normalise what a client sends
// (strings in, typed values out); response schemas describe what the server returns and are
// what tests and the dashboard parse against. Block numbers fit a JS number; token amounts and
// other uint256/int256 values travel as base-10 strings.

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;

// ---------------------------------------------------------------------------------------------
// Query parameters
// ---------------------------------------------------------------------------------------------

/** Addresses are stored lowercase; accept any casing and normalise. */
const addressParam = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 0x-prefixed 20-byte hex address")
  .transform((s) => s.toLowerCase());

const blockParam = z
  .string()
  .regex(/^\d{1,15}$/, "expected a non-negative integer block number")
  .transform(Number);

const dayParam = z.iso.date();

const boolParam = z.enum(["true", "false"]).transform((v) => v === "true");

const pageParams = {
  limit: z
    .string()
    .regex(/^\d{1,3}$/, `expected an integer between 1 and ${MAX_PAGE_LIMIT}`)
    .transform(Number)
    .pipe(z.number().min(1).max(MAX_PAGE_LIMIT))
    .default(DEFAULT_PAGE_LIMIT),
  cursor: z.string().min(1).max(512).optional(),
};

export const RANGE_STATUSES = ["candidate", "published", "failed"] as const;
export const RangeStatus = z.enum(RANGE_STATUSES);
export type RangeStatus = z.infer<typeof RangeStatus>;

export const BACKFILL_STATUSES = ["queued", "running", "resolved"] as const;
export const BackfillStatus = z.enum(BACKFILL_STATUSES);
export type BackfillStatus = z.infer<typeof BackfillStatus>;

export const RECONCILIATION_STATUSES = ["match", "mismatch"] as const;
export const ReconciliationStatus = z.enum(RECONCILIATION_STATUSES);
export type ReconciliationStatus = z.infer<typeof ReconciliationStatus>;

export const PageQuery = z.strictObject(pageParams);
export type PageQuery = z.infer<typeof PageQuery>;

export const RangesQuery = z.strictObject({ ...pageParams, status: RangeStatus.optional() });
export type RangesQuery = z.infer<typeof RangesQuery>;

export const RangeParams = z.strictObject({ fromBlock: blockParam });
export type RangeParams = z.infer<typeof RangeParams>;

export const BackfillJobsQuery = z.strictObject({ ...pageParams, status: BackfillStatus.optional() });
export type BackfillJobsQuery = z.infer<typeof BackfillJobsQuery>;

export const ReconciliationsQuery = z.strictObject({
  ...pageParams,
  status: ReconciliationStatus.optional(),
  /** `true`: only mismatches without an explanation. `false` is accepted and means no filter. */
  unexplained: boolParam.optional(),
});
export type ReconciliationsQuery = z.infer<typeof ReconciliationsQuery>;

const blockWindow = { fromBlock: blockParam.optional(), toBlock: blockParam.optional() };
const blockWindowOrdered = (q: { fromBlock?: number | undefined; toBlock?: number | undefined }) => q.fromBlock === undefined || q.toBlock === undefined || q.fromBlock <= q.toBlock;
const blockWindowIssue = { message: "fromBlock must not exceed toBlock", path: ["fromBlock"] };

export const TransfersQuery = z.strictObject({
  ...pageParams,
  token: addressParam.optional(),
  /** Matches the sender or the recipient. */
  address: addressParam.optional(),
  ...blockWindow,
}).refine(blockWindowOrdered, blockWindowIssue);
export type TransfersQuery = z.infer<typeof TransfersQuery>;

export const SwapsQuery = z.strictObject({
  ...pageParams,
  pool: addressParam.optional(),
  /** Matches the sender or the recipient. */
  address: addressParam.optional(),
  ...blockWindow,
}).refine(blockWindowOrdered, blockWindowIssue);
export type SwapsQuery = z.infer<typeof SwapsQuery>;

export const OHLC_INTERVALS = ["1h", "1d"] as const;
export const OhlcInterval = z.enum(OHLC_INTERVALS);
export type OhlcInterval = z.infer<typeof OhlcInterval>;

/** Inclusive UTC day bounds, `YYYY-MM-DD`. */
const dayWindow = { from: dayParam.optional(), to: dayParam.optional() };
const dayWindowOrdered = (q: { from?: string | undefined; to?: string | undefined }) => q.from === undefined || q.to === undefined || q.from <= q.to;
const dayWindowIssue = { message: "from must not be after to", path: ["from"] };

export const DailyVolumeQuery = z.strictObject({ token: addressParam, ...dayWindow }).refine(dayWindowOrdered, dayWindowIssue);
export type DailyVolumeQuery = z.infer<typeof DailyVolumeQuery>;

export const PoolOhlcQuery = z
  .strictObject({
    pool: addressParam,
    interval: OhlcInterval.default("1h"),
    ...dayWindow,
  })
  .refine(dayWindowOrdered, dayWindowIssue);
export type PoolOhlcQuery = z.infer<typeof PoolOhlcQuery>;

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export const ApiError = z.object({ error: z.object({ code: z.string(), message: z.string() }) });
export type ApiError = z.infer<typeof ApiError>;

export const Health = z.object({ ok: z.literal(true) });
export type Health = z.infer<typeof Health>;

const isoTimestamp = z.iso.datetime();
const blockNumber = z.number().int().nonnegative();
const decimalString = z.string().regex(/^-?\d+$/);

/** Cursor pagination envelope; `nextCursor` is null on the last page. */
export function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() });
}

export const BlockRef = z.object({ number: blockNumber, hash: z.string() });
export type BlockRef = z.infer<typeof BlockRef>;

export const Reorg = z.object({
  id: z.number().int(),
  detectedAt: isoTimestamp,
  action: z.enum(["rolled_back", "halted"]),
  depth: z.number().int(),
  forkBlock: blockNumber,
  /** null when halted: there was no common ancestor to roll back to. */
  ancestorBlock: blockNumber.nullable(),
  rollbackFrom: blockNumber.nullable(),
  finalizedBlock: blockNumber,
  orphaned: z.array(BlockRef),
  canonical: z.array(BlockRef),
  /** Halted rows only: when the operator acknowledged the halt (`ack-halt`); null while the indexer still refuses to start. Always null when rolled back. */
  acknowledgedAt: isoTimestamp.nullable(),
  /** The operator's reason for judging it safe to continue; set together with `acknowledgedAt`. */
  acknowledgement: z.string().nullable(),
});
export type Reorg = z.infer<typeof Reorg>;
export const ReorgsPage = page(Reorg);
export type ReorgsPage = z.infer<typeof ReorgsPage>;

export const Range = z.object({
  fromBlock: blockNumber,
  toBlock: blockNumber,
  status: RangeStatus,
  blockCount: z.number().int(),
  logCount: z.number().int(),
  transferCount: z.number().int(),
  swapCount: z.number().int(),
  rejectCount: z.number().int(),
  committedAt: isoTimestamp,
  publishedAt: isoTimestamp.nullable(),
});
export type Range = z.infer<typeof Range>;
export const RangesPage = page(Range);
export type RangesPage = z.infer<typeof RangesPage>;

export const BackfillJob = z.object({
  id: z.string(),
  fromBlock: blockNumber,
  toBlock: blockNumber,
  status: BackfillStatus,
  attempts: z.number().int(),
  failureReason: z.string(),
  updatedAt: isoTimestamp,
});
export type BackfillJob = z.infer<typeof BackfillJob>;
export const BackfillJobsPage = page(BackfillJob);
export type BackfillJobsPage = z.infer<typeof BackfillJobsPage>;

export const Reconciliation = z.object({
  id: z.number().int(),
  fromBlock: blockNumber,
  toBlock: blockNumber,
  provider: z.string(),
  checkedAt: isoTimestamp,
  status: ReconciliationStatus,
  blocksChecked: z.number().int(),
  hashMismatches: z.number().int(),
  storedLogCount: z.number().int(),
  observedLogCount: z.number().int(),
  explanation: z.string().nullable(),
});
export type Reconciliation = z.infer<typeof Reconciliation>;
export const ReconciliationsPage = page(Reconciliation);
export type ReconciliationsPage = z.infer<typeof ReconciliationsPage>;

export const QualityGate = z.object({
  gate: z.string(),
  passed: z.boolean(),
  rowsChecked: z.number().int(),
  rowsFailed: z.number().int(),
  detail: z.string().nullable(),
  checkedAt: isoTimestamp,
});
export type QualityGate = z.infer<typeof QualityGate>;

export const RangeDetail = Range.extend({
  gates: z.array(QualityGate),
  backfillJob: BackfillJob.nullable(),
  reconciliations: z.array(Reconciliation),
});
export type RangeDetail = z.infer<typeof RangeDetail>;

const RangeTotals = z.object({ ranges: z.number().int(), blocks: z.number().int(), logs: z.number().int() });

/** Distribution of `head - stored tip` (blocks, clamped at 0) over the last hour's lag samples. */
export const LagStats = z.object({
  samples: z.number().int(),
  p50: z.number(),
  p95: z.number(),
  p99: z.number(),
  max: z.number(),
});
export type LagStats = z.infer<typeof LagStats>;

/**
 * What the indexer's retention has deleted so far, and how long it is configured to keep data (null when this
 * API was not told). A purged range keeps its row in `/v1/ranges`; only its landing logs / decoded rows are gone.
 */
export const Retention = z.object({
  /** Highest block of any range whose landing logs were purged; null while nothing is. Ranges the reconciler has not confirmed stay below it. */
  landingPurgedThroughBlock: blockNumber.nullable(),
  /** Highest block of any range whose decoded rows were purged; null while nothing is (and always null when decoded rows are kept forever). */
  decodedPurgedThroughBlock: blockNumber.nullable(),
  landingRetentionDays: z.number().positive().nullable(),
  /** null: unknown, or decoded rows are kept forever. */
  decodedRetentionDays: z.number().positive().nullable(),
});
export type Retention = z.infer<typeof Retention>;

export const Status = z.object({
  chainId: z.number().int(),
  generatedAt: isoTimestamp,
  /** Newest lag sample; null before the indexer recorded one. */
  head: z.object({ block: blockNumber, sampledAt: isoTimestamp }).nullable(),
  /** Finalized block of the newest lag sample. */
  finalizedBlock: blockNumber.nullable(),
  storedTip: blockNumber.nullable(),
  lastPublishedBlock: blockNumber.nullable(),
  /** head - storedTip, clamped at 0. */
  headLag: z.number().nullable(),
  /** finalizedBlock - lastPublishedBlock, clamped at 0. */
  finalizedLag: z.number().nullable(),
  ranges: z.object({ candidate: RangeTotals, published: RangeTotals, failed: RangeTotals }),
  backfill: z.object({
    open: z.number().int(),
    /** Oldest first, capped at 20. */
    jobs: z.array(BackfillJob),
  }),
  reconciliation: z.object({ match: z.number().int(), mismatch: z.number().int(), unexplained: z.number().int() }),
  /** null when the last hour has no sample with a known stored tip. */
  lag1h: LagStats.nullable(),
  lastRun: z
    .object({
      id: z.string(),
      status: z.enum(["running", "succeeded", "failed"]),
      startedAt: isoTimestamp,
      rpcCalls: z.record(z.string(), z.record(z.string(), z.number())),
    })
    .nullable(),
  lastReorg: Reorg.nullable(),
  retention: Retention,
});
export type Status = z.infer<typeof Status>;

const LogPosition = {
  blockNumber,
  blockHash: z.string(),
  blockTimestamp: isoTimestamp,
  logIndex: z.number().int().nonnegative(),
  txHash: z.string(),
};

export const Transfer = z.object({
  ...LogPosition,
  token: z.string(),
  from: z.string(),
  to: z.string(),
  value: decimalString,
});
export type Transfer = z.infer<typeof Transfer>;
export const TransfersPage = page(Transfer);
export type TransfersPage = z.infer<typeof TransfersPage>;

export const Swap = z.object({
  ...LogPosition,
  pool: z.string(),
  sender: z.string(),
  recipient: z.string(),
  amount0: decimalString,
  amount1: decimalString,
  sqrtPriceX96: decimalString,
  liquidity: decimalString,
  tick: z.number().int(),
});
export type Swap = z.infer<typeof Swap>;
export const SwapsPage = page(Swap);
export type SwapsPage = z.infer<typeof SwapsPage>;

// Analytics (served from Parquet via DuckDB). The row shapes below are what `@rsi/analytics`
// returns and the API forwards unchanged.

export const DailyVolumeRow = z.object({
  /** UTC day, `YYYY-MM-DD`. */
  day: z.iso.date(),
  transfers: z.number().int(),
  /** Sum of transferred token units (base-10 string). */
  volume: decimalString,
  activeAddresses: z.number().int(),
});
export type DailyVolumeRow = z.infer<typeof DailyVolumeRow>;
export const DailyVolume = z.array(DailyVolumeRow);
export type DailyVolume = z.infer<typeof DailyVolume>;

export const PoolOhlcRow = z.object({
  /** Bucket start, UTC. */
  bucket: isoTimestamp,
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  swaps: z.number().int(),
  volumeToken0: decimalString,
  volumeToken1: decimalString,
});
export type PoolOhlcRow = z.infer<typeof PoolOhlcRow>;
export const PoolOhlc = z.array(PoolOhlcRow);
export type PoolOhlc = z.infer<typeof PoolOhlc>;

export const AnalyticsMeta = z.object({
  /** Highest block present in the Parquet export; null before the first export. */
  exportedThroughBlock: blockNumber.nullable(),
  exportedAt: isoTimestamp.nullable(),
  partitions: z.number().int(),
  rowCounts: z.record(z.string(), z.number().int()),
});
export type AnalyticsMeta = z.infer<typeof AnalyticsMeta>;
