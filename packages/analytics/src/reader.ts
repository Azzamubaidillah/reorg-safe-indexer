import { DuckDBInstance, type DuckDBValue } from "@duckdb/node-api";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { chunkSumSelect, sumFromChunks } from "./amounts.ts";
import { assertDay, KINDS, MANIFEST_FILE, partitionGlob, readManifest, type Kind, type Manifest } from "./layout.ts";
import { DEFAULT_METADATA, decimalScale, UnknownPoolError, type AnalyticsMetadata, type PriceDirection } from "./metadata.ts";

export interface AnalyticsReaderOptions {
  /** Parquet store written by `exportPublished`. */
  dir: string;
  /** Decimals per pool; defaults to the mainnet constants. */
  metadata?: AnalyticsMetadata;
}

/** `from`/`to` are inclusive UTC days (`YYYY-MM-DD`); omit either for an open end. */
export interface DailyVolumeQuery {
  token: string;
  from?: string;
  to?: string;
}

export interface DailyVolumeRow {
  day: string;
  transfers: number;
  /** Sum of transferred base units (not decimal-adjusted), exact at any size. */
  volume: string;
  /** Distinct addresses that sent or received the token that day. */
  activeAddresses: number;
}

export type OhlcInterval = "1h" | "1d";

export interface PoolOhlcQuery {
  pool: string;
  interval: OhlcInterval;
  from?: string;
  to?: string;
  /** Defaults to the pool's `defaultDirection` (USDC per ETH for the default pool). */
  direction?: PriceDirection;
}

export interface PoolOhlcRow {
  /** Bucket start, UTC ISO-8601. */
  bucket: string;
  open: number;
  high: number;
  low: number;
  close: number;
  swaps: number;
  /** Sum of |amount0| / |amount1| in base units: swap volume counted once, regardless of direction. Exact. */
  volumeToken0: string;
  volumeToken1: string;
}

export interface AnalyticsMeta {
  /** Highest block of any exported range; null before the first export. */
  exportedThroughBlock: number | null;
  exportedAt: string | null;
  /** Number of Parquet files (one per kind and day). */
  partitions: number;
  rowCounts: Record<Kind, number>;
}

const TRUNC_UNIT: Record<OhlcInterval, string> = { "1h": "hour", "1d": "day" };

// day is the hive partition column: filtering on it prunes whole files before they are opened.
const readParquet = "read_parquet(?, hive_partitioning = true, hive_types = {'day': DATE})";

/**
 * Serves aggregates from the Parquet store with an in-process DuckDB. Nothing here touches Postgres: the
 * store is a derived copy, and `meta()` says how far it has been exported.
 *
 * OHLC semantics: each swap contributes the price the pool had *after* it (from `sqrtPriceX96`, so
 * `(sqrtPriceX96 / 2^96)^2` token1 base units per token0 base unit, decimal-adjusted). Open and close are the first
 * and last swap of the bucket by (block, log index); high and low are the extremes. Buckets without swaps are
 * absent, and a bucket's open is not the previous bucket's close.
 */
export class AnalyticsReader {
  private readonly dir: string;
  private readonly metadata: AnalyticsMetadata;
  private instance: Promise<DuckDBInstance> | undefined;
  private cached: { mtimeMs: number; manifest: Manifest | null } | undefined;

  constructor({ dir, metadata = DEFAULT_METADATA }: AnalyticsReaderOptions) {
    this.dir = dir;
    this.metadata = metadata;
  }

  async dailyVolume({ token, from, to }: DailyVolumeQuery): Promise<DailyVolumeRow[]> {
    if (!(await this.hasPartitions("transfers"))) return [];
    const values: DuckDBValue[] = [partitionGlob(this.dir, "transfers"), token.toLowerCase()];
    const days = dayFilter(from, to, values);
    // Two aggregates over the same filtered rows: counts/sums per day, and distinct addresses over from-union-to.
    const rows = await this.query(
      `with t as (select day, from_address, to_address, value_c0, value_c1, value_c2 from ${readParquet} where token = ? ${days}),
            s as (select day, count(*) as transfers, ${chunkSumSelect("value")} from t group by day),
            a as (select day, count(distinct address) as active
                  from (select day, from_address as address from t union all select day, to_address from t) group by day)
       select cast(day as varchar) as day, s.* exclude (day), a.active from s join a using (day) order by s.day`,
      values,
    );
    return rows.map((row) => ({
      day: String(row.day),
      transfers: Number(row.transfers),
      volume: sumFromChunks(row, "value"),
      activeAddresses: Number(row.active),
    }));
  }

  async poolOhlc({ pool, interval, from, to, direction }: PoolOhlcQuery): Promise<PoolOhlcRow[]> {
    const poolKey = pool.toLowerCase();
    const meta = this.metadata.pools[poolKey];
    if (!meta) throw new UnknownPoolError(poolKey);
    if (!(await this.hasPartitions("swaps"))) return [];
    const values: DuckDBValue[] = [decimalScale(meta), partitionGlob(this.dir, "swaps"), poolKey];
    const days = dayFilter(from, to, values);
    const rows = await this.query(
      `select strftime(bucket_start, '%Y-%m-%dT%H:%M:%SZ') as bucket,
              arg_min(price, (block_number, log_index)) as open, max(price) as high, min(price) as low,
              arg_max(price, (block_number, log_index)) as close, count(*) as swaps, ${chunkSumSelect("abs0")}, ${chunkSumSelect("abs1")}
       from (select date_trunc('${TRUNC_UNIT[interval]}', block_time) as bucket_start, block_number, log_index, sqrt_price * sqrt_price * ? as price,
                    abs0_c0, abs0_c1, abs0_c2, abs1_c0, abs1_c1, abs1_c2
             from ${readParquet} where pool = ? ${days})
       group by bucket_start order by bucket_start`,
      values,
    );
    const inverse = (direction ?? meta.defaultDirection) === "token0PerToken1";
    return rows.map((row) => {
      const [open, high, low, close] = [Number(row.open), Number(row.high), Number(row.low), Number(row.close)];
      return {
        bucket: String(row.bucket),
        // Inverting reverses order: the highest inverse price is the lowest direct one.
        ...(inverse ? { open: 1 / open, high: 1 / low, low: 1 / high, close: 1 / close } : { open, high, low, close }),
        swaps: Number(row.swaps),
        volumeToken0: sumFromChunks(row, "abs0"),
        volumeToken1: sumFromChunks(row, "abs1"),
      };
    });
  }

  async meta(): Promise<AnalyticsMeta> {
    const manifest = await this.manifest();
    const rowCounts: Record<Kind, number> = { transfers: 0, swaps: 0 };
    let partitions = 0;
    for (const entry of Object.values(manifest?.days ?? {})) {
      for (const kind of KINDS) {
        if (!entry[kind]) continue;
        partitions += 1;
        rowCounts[kind] += entry[kind].rows;
      }
    }
    return {
      exportedThroughBlock: manifest && manifest.exported.length > 0 ? manifest.exportedThroughBlock : null,
      exportedAt: manifest && manifest.exported.length > 0 ? manifest.exportedAt : null,
      partitions,
      rowCounts,
    };
  }

  async close(): Promise<void> {
    (await this.instance)?.closeSync();
    this.instance = undefined;
  }

  /** The manifest, re-read only when the exporter has replaced it. */
  private async manifest(): Promise<Manifest | null> {
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(join(this.dir, MANIFEST_FILE))).mtimeMs;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (this.cached?.mtimeMs !== mtimeMs) this.cached = { mtimeMs, manifest: await readManifest(this.dir) };
    return this.cached.manifest;
  }

  /** `read_parquet` on a glob that matches nothing is an error, so "nothing exported yet" is answered before asking DuckDB. */
  private async hasPartitions(kind: Kind): Promise<boolean> {
    const manifest = await this.manifest();
    return Object.values(manifest?.days ?? {}).some((entry) => entry[kind] !== undefined);
  }

  private async query(sql: string, values: DuckDBValue[]): Promise<Record<string, unknown>[]> {
    this.instance ??= DuckDBInstance.create(":memory:", { threads: "4" });
    const connection = await (await this.instance).connect();
    try {
      return (await connection.runAndReadAll(sql, values)).getRowObjectsJson();
    } finally {
      connection.closeSync();
    }
  }
}

/** Appends bound `day` bounds; validated first because they decide which files are opened. */
function dayFilter(from: string | undefined, to: string | undefined, values: DuckDBValue[]): string {
  let sql = "";
  if (from !== undefined) {
    assertDay(from);
    values.push(from);
    sql += " and day >= cast(? as date)";
  }
  if (to !== undefined) {
    assertDay(to);
    values.push(to);
    sql += " and day <= cast(? as date)";
  }
  return sql;
}
