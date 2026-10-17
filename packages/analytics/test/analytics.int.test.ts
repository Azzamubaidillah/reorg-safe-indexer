import { DuckDBInstance } from "@duckdb/node-api";
import type { Database } from "@rsi/db";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnalyticsReader, exportPublished, verifyAnalytics } from "../src/index.ts";
import { partitionPath, readManifest, sha256File, writeManifest } from "../src/layout.ts";
import { CHAIN_ID, freshDatabase, insertBlocks, insertRange, insertSwaps, insertTransfers, OTHER_TOKEN, POOL, Q96, seedRanges, TOKEN, UINT256_MAX, type RangeSpec } from "./support/seed.ts";

// Day 2024-01-01 = blocks 1000-1047, day 2024-01-02 = 1048-1095 (30-minute blocks). The middle range straddles midnight.
const R1: RangeSpec = [1000, 1019, "published"];
const R2: RangeSpec = [1020, 1039, "published"];
const R3: RangeSpec = [1040, 1059, "published"];
const DAY1 = "2024-01-01";
const DAY2 = "2024-01-02";

let database: Database;
let dir: string;
const readers: AnalyticsReader[] = [];

function reader(): AnalyticsReader {
  const r = new AnalyticsReader({ dir });
  readers.push(r);
  return r;
}

beforeEach(async () => {
  database = await freshDatabase();
  dir = await mkdtemp(join(tmpdir(), "analytics-test-"));
});

afterEach(async () => {
  await Promise.all(readers.splice(0).map((r) => r.close()));
  await database.sql.end();
  await rm(dir, { recursive: true, force: true });
});

/** Runs SQL against the Parquet files directly, bypassing the reader, to see exactly what was stored. */
async function duck(sql: string): Promise<Record<string, unknown>[]> {
  const instance = await DuckDBInstance.create(":memory:");
  const connection = await instance.connect();
  try {
    return (await connection.runAndReadAll(sql)).getRowObjectsJson();
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

/** What retention leaves behind for the range starting at `from`: no decoded rows, both flags set. */
async function purgeDecoded(from: number, to: number): Promise<void> {
  await database.sql`delete from chain.erc20_transfers where block_number between ${from} and ${to}`;
  await database.sql`delete from chain.uniswap_v3_swaps where block_number between ${from} and ${to}`;
  await database.sql`update ops.ranges set landing_purged_at = now(), decoded_purged_at = now() where from_block = ${from}`;
}

/** Content hash of every file under the store (manifest included), keyed by relative path: byte-identical means equal maps. */
async function storeHashes(): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) hashes[join(entry.parentPath, entry.name).slice(dir.length)] = await sha256File(join(entry.parentPath, entry.name));
  }
  return hashes;
}

const sumOf = async (query: string): Promise<bigint> => BigInt(String((await database.sql.unsafe<{ v: string }[]>(query))[0]?.v));

describe("exportPublished", () => {
  it("exports published ranges only: candidate and failed ranges never reach Parquet", async () => {
    await seedRanges(database.sql, [R1, [1020, 1039, "candidate"], [1040, 1059, "failed"]]);
    const summary = await exportPublished(database, { chainId: CHAIN_ID, dir });

    expect(summary.newRanges).toBe(1);
    expect(summary.exportedThroughBlock).toBe(1039 - 20);
    const [expected] = await database.sql<{ t: string; s: string }[]>`
      select (select count(*) from chain.erc20_transfers where block_number <= 1019)::text t, (select count(*) from chain.uniswap_v3_swaps where block_number <= 1019)::text s`;
    expect(summary.rowCounts).toEqual({ transfers: Number(expected?.t), swaps: Number(expected?.s) });
    // The chain tables hold far more than was exported, so this cannot pass by exporting everything.
    const [all] = await database.sql<{ n: string }[]>`select count(*)::text n from chain.erc20_transfers`;
    expect(Number(all?.n)).toBeGreaterThan(summary.rowCounts.transfers);
    const [{ max }] = (await duck(`select max(block_number)::varchar as max from read_parquet('${dir}/transfers/day=*/data.parquet')`)) as [{ max: string }];
    expect(Number(max)).toBeLessThanOrEqual(1019);
  });

  it("is idempotent: a second run writes nothing, and a rebuilt day is byte-identical", async () => {
    await seedRanges(database.sql, [R1, R2, R3]);
    const first = await exportPublished(database, { chainId: CHAIN_ID, dir });
    expect(first.partitions.length).toBeGreaterThan(0);
    const manifestBefore = await readFile(join(dir, "_manifest.json"), "utf8");
    const mtimeBefore = (await stat(partitionPath(dir, "transfers", DAY1))).mtimeMs;

    const second = await exportPublished(database, { chainId: CHAIN_ID, dir });
    expect(second.newRanges).toBe(0);
    expect(second.partitions).toEqual([]);
    expect(second.rowCounts).toEqual(first.rowCounts);
    expect(await readFile(join(dir, "_manifest.json"), "utf8")).toBe(manifestBefore);
    expect((await stat(partitionPath(dir, "transfers", DAY1))).mtimeMs).toBe(mtimeBefore);

    // Losing the manifest forces every day to be rebuilt from Postgres: the bytes must come out the same and nothing be replaced.
    const hashes = Object.fromEntries(await Promise.all(["transfers", "swaps"].flatMap((k) => [DAY1, DAY2].map(async (d) => [`${k}/${d}`, await sha256File(partitionPath(dir, k as "transfers" | "swaps", d))] as const))));
    await rm(join(dir, "_manifest.json"));
    const rebuilt = await exportPublished(database, { chainId: CHAIN_ID, dir });
    expect(rebuilt.partitions.length).toBe(first.partitions.length);
    expect(rebuilt.partitions.every((p) => !p.changed)).toBe(true);
    for (const [name, hash] of Object.entries(hashes)) {
      const [kind, day] = name.split("/") as ["transfers" | "swaps", string];
      expect(await sha256File(partitionPath(dir, kind, day))).toBe(hash);
    }
  });

  it("extends the right day partition when a range is published later", async () => {
    await seedRanges(database.sql, [R1, [1020, 1039, "candidate"], [1040, 1059, "candidate"]]);
    await exportPublished(database, { chainId: CHAIN_ID, dir });
    const day2Before = await readManifest(dir).then((m) => m?.days[DAY2]);
    const day1Hash = await sha256File(partitionPath(dir, "transfers", DAY1));
    expect(day2Before).toBeUndefined();

    // R3 straddles midnight (1040-1047 are day 1, 1048-1059 day 2); publishing it must touch both days and nothing else.
    await database.sql`update ops.ranges set status = 'published', published_at = now() where from_block = 1040`;
    const summary = await exportPublished(database, { chainId: CHAIN_ID, dir });
    expect(summary.newRanges).toBe(1);
    expect([...new Set(summary.partitions.map((p) => p.day))]).toEqual([DAY1, DAY2]);
    expect(await sha256File(partitionPath(dir, "transfers", DAY1))).not.toBe(day1Hash);

    const expected = await database.sql<{ n: string }[]>`
      select count(*)::text n from chain.erc20_transfers t join chain.blocks b on b.hash = t.block_hash
      where (t.block_number between 1000 and 1019 or t.block_number between 1040 and 1059) and b.timestamp < '2024-01-02T00:00:00Z'`;
    const [stored] = await duck(`select count(*)::varchar n from read_parquet('${partitionPath(dir, "transfers", DAY1)}')`);
    expect(stored?.n).toBe(expected[0]?.n);

    // Publishing the gap range later (1020-1039, out of order) is picked up too.
    await database.sql`update ops.ranges set status = 'published', published_at = now() where from_block = 1020`;
    const gap = await exportPublished(database, { chainId: CHAIN_ID, dir });
    expect(gap.newRanges).toBe(1);
    expect((await readManifest(dir))?.exported).toEqual([[1000, 1059]]);
    expect((await verifyAnalytics(database, { chainId: CHAIN_ID, dir, sampleDays: 2 })).ok).toBe(true);
  });

  it("keeps uint256 max, negative amounts and negative ticks lossless", async () => {
    await seedRanges(database.sql, [R1, R2, R3]);
    await exportPublished(database, { chainId: CHAIN_ID, dir });

    const max = await duck(`select value, value_c0::varchar c0, value_c1::varchar c1, value_c2::varchar c2 from read_parquet('${dir}/transfers/day=*/data.parquet') where value = '${UINT256_MAX}' limit 1`);
    expect(max).toHaveLength(1);
    const row = max[0] as Record<string, string>;
    expect(BigInt(row.c2!) * 10n ** 52n + BigInt(row.c1!) * 10n ** 26n + BigInt(row.c0!)).toBe(UINT256_MAX);

    const swaps = await duck(`select amount0, amount1, tick, abs0_c0::varchar a0 from read_parquet('${dir}/swaps/day=*/data.parquet') where amount0 like '-%' and tick < 0 limit 1`);
    expect(swaps).toHaveLength(1);
    const swap = swaps[0] as { amount0: string; tick: number; a0: string };
    expect(BigInt(swap.amount0)).toBeLessThan(0n);
    expect(swap.tick).toBeLessThan(0);
    expect(BigInt(swap.a0)).toBe(-BigInt(swap.amount0));

    // Every stored amount equals Postgres' text exactly, not just the extremes.
    const [diff] = await database.sql<{ n: string }[]>`select count(*)::text n from chain.uniswap_v3_swaps where amount0 < 0`;
    const [stored] = await duck(`select count(*)::varchar n from read_parquet('${dir}/swaps/day=*/data.parquet') where amount0 like '-%'`);
    expect(stored?.n).toBe(diff?.n);
  });

  it("serves daily volume equal to the same aggregate computed in Postgres", async () => {
    await seedRanges(database.sql, [R1, R2, R3]);
    await exportPublished(database, { chainId: CHAIN_ID, dir });
    const rows = await reader().dailyVolume({ token: TOKEN });
    expect(rows.map((r) => r.day)).toEqual([DAY1, DAY2]);

    for (const row of rows) {
      const [pg] = await database.sql<{ n: string; v: string; a: string }[]>`
        with t as (
          select x.* from chain.erc20_transfers x join chain.blocks b on b.hash = x.block_hash
          where x.token = ${TOKEN} and (b.timestamp at time zone 'UTC')::date = ${row.day}::date)
        select (select count(*) from t)::text n, (select sum(value) from t)::text v,
               (select count(*) from (select from_address from t union select to_address from t) u)::text a`;
      expect(row).toEqual({ day: row.day, transfers: Number(pg?.n), volume: pg?.v, activeAddresses: Number(pg?.a) });
    }
    // The sum includes uint256 max values, so it has more than 78 digits: only exact chunk arithmetic gets this right.
    expect(BigInt(rows[0]?.volume ?? 0)).toBeGreaterThan(UINT256_MAX);
    expect(await reader().dailyVolume({ token: TOKEN, from: DAY2, to: DAY2 })).toEqual([rows[1]]);
    expect(await reader().dailyVolume({ token: OTHER_TOKEN, from: "2030-01-01" })).toEqual([]);
  });

  it("reports meta from the manifest", async () => {
    expect(await reader().meta()).toEqual({ exportedThroughBlock: null, exportedAt: null, partitions: 0, rowCounts: { transfers: 0, swaps: 0 } });
    expect(await reader().dailyVolume({ token: TOKEN })).toEqual([]);
    await seedRanges(database.sql, [R1, R2]);
    const summary = await exportPublished(database, { chainId: CHAIN_ID, dir });
    const meta = await reader().meta();
    expect(meta.exportedThroughBlock).toBe(1039);
    expect(meta.partitions).toBe(summary.partitions.length);
    expect(meta.rowCounts).toEqual(summary.rowCounts);
  });
});

describe("poolOhlc", () => {
  // Pool is USDC (6 decimals) / WETH (18). sqrtPriceX96 = s * 2^96 means raw token1/token0 = s^2, so
  // whole WETH per USDC = s^2 * 10^(6-18) and USDC per WETH = 10^12 / s^2.
  //   s = 20000 -> s^2 = 4e8   -> 2500 USDC/ETH     s = 10000 -> 1e8 -> 10000 USDC/ETH
  //   s = 40000 -> s^2 = 1.6e9 -> 625 USDC/ETH      s = 25000 -> 6.25e8 -> 1600 USDC/ETH
  const swap = (blockNumber: number, logIndex: number, s: bigint, amount0: bigint, amount1: bigint) => ({
    blockNumber, logIndex, pool: POOL, sender: "0x01", recipient: "0x02", amount0, amount1, sqrtPriceX96: s * Q96, liquidity: 1n, tick: -1,
  });

  beforeEach(async () => {
    await database.sql`insert into ops.runs (id, chain_id, status) values ('seed-run', ${CHAIN_ID}, 'succeeded')`;
    await insertBlocks(database.sql, 1000, 1059);
    // Blocks 1000-1001 are hour 00:00, 1002-1003 hour 01:00, 1004 hour 02:00. The two blocks of an hour share a bucket.
    await insertSwaps(database.sql, [
      swap(1000, 5, 20_000n, 100n, -50n),
      swap(1001, 1, 10_000n, -30n, 7n),
      swap(1001, 2, 40_000n, 5n, -1n),
      swap(1002, 0, 25_000n, -10n, 2n),
      swap(1004, 0, 20_000n, 1n, -1n),
    ]);
    await insertRange(database.sql, R1);
    await exportPublished(database, { chainId: CHAIN_ID, dir });
  });

  it("builds hourly candles in USDC per ETH from sqrtPriceX96, with exact absolute volumes", async () => {
    const rows = await reader().poolOhlc({ pool: POOL, interval: "1h" });
    expect(rows.map((r) => r.bucket)).toEqual(["2024-01-01T00:00:00Z", "2024-01-01T01:00:00Z", "2024-01-01T02:00:00Z"]);
    const [h0] = rows;
    // Swaps of hour 0 by (block, logIndex): 2500, 10000, 625 -> open 2500, high 10000, low 625, close 625.
    expect(h0?.open).toBeCloseTo(2500, 8);
    expect(h0?.high).toBeCloseTo(10_000, 8);
    expect(h0?.low).toBeCloseTo(625, 8);
    expect(h0?.close).toBeCloseTo(625, 8);
    expect(h0).toMatchObject({ swaps: 3, volumeToken0: "135", volumeToken1: "58" });
    expect(rows[1]).toMatchObject({ swaps: 1, volumeToken0: "10", volumeToken1: "2" });
    expect(rows[1]?.open).toBeCloseTo(1600, 8);
  });

  it("can quote token1 per token0, and rolls up to days", async () => {
    const [day] = await reader().poolOhlc({ pool: POOL, interval: "1d", direction: "token1PerToken0" });
    // 1/2500 etc: the high of the inverse is the low of the direct price and vice versa.
    expect(day?.open).toBeCloseTo(1 / 2500, 12);
    expect(day?.high).toBeCloseTo(1 / 625, 12);
    expect(day?.low).toBeCloseTo(1 / 10_000, 12);
    expect(day?.close).toBeCloseTo(1 / 2500, 12);
    expect(day).toMatchObject({ bucket: "2024-01-01T00:00:00Z", swaps: 5, volumeToken0: "146", volumeToken1: "61" });
  });

  it("refuses a pool it has no decimals for", async () => {
    await expect(reader().poolOhlc({ pool: OTHER_TOKEN, interval: "1h" })).rejects.toThrow(/no decimals metadata/);
  });
});

describe("exportPublished and decoded purges", () => {
  // Blocks 1100-1119 are on a third UTC day (1096-1143), after the days the other ranges touch.
  const LATER: RangeSpec = [1100, 1119, "published"];

  it("refuses to rewrite a purged day when the manifest is gone, naming the day and leaving every file untouched", async () => {
    await seedRanges(database.sql, [R1, R2, R3]);
    await exportPublished(database, { chainId: CHAIN_ID, dir });
    await purgeDecoded(R1[0], R1[1]);
    await rm(join(dir, "_manifest.json"));
    const before = await storeHashes();

    await expect(exportPublished(database, { chainId: CHAIN_ID, dir })).rejects.toThrow(/refusing to export: day\(s\) 2024-01-01/);

    expect(await storeHashes()).toEqual(before);
    expect(await readManifest(dir)).toBeNull();
    expect((await readdir(dir)).filter((name) => name.startsWith(".duckdb-"))).toEqual([]);
  });

  it("refuses a pending range that lands in a purged day, and writes nothing, not even the other pending days", async () => {
    await seedRanges(database.sql, [R1, R2]);
    await exportPublished(database, { chainId: CHAIN_ID, dir });
    await purgeDecoded(R1[0], R1[1]);
    // R3 reaches into day 1 (blocks 1040-1047); LATER is a clean third day.
    await seedRanges(database.sql, [R3, LATER]);
    const before = await storeHashes();

    await expect(exportPublished(database, { chainId: CHAIN_ID, dir })).rejects.toThrow(/day\(s\) 2024-01-01 contain ranges/);

    expect(await storeHashes()).toEqual(before);
    expect((await readManifest(dir))?.exported).toEqual([[1000, 1039]]);
  });

  it("still exports later days incrementally while earlier days are purged and already in the manifest", async () => {
    await seedRanges(database.sql, [R1, R2, R3]);
    await exportPublished(database, { chainId: CHAIN_ID, dir });
    await purgeDecoded(R1[0], R1[1]);
    await purgeDecoded(R2[0], R2[1]);
    await purgeDecoded(R3[0], R3[1]);
    const before = await storeHashes();
    await seedRanges(database.sql, [LATER]);

    const summary = await exportPublished(database, { chainId: CHAIN_ID, dir });

    expect(summary.newRanges).toBe(1);
    expect(summary.partitions.map((p) => [p.kind, p.day])).toEqual([["transfers", "2024-01-03"], ["swaps", "2024-01-03"]]);
    expect((await readManifest(dir))?.exported).toEqual([[1000, 1059], [1100, 1119]]);
    // The purged days' files are exactly as before; the only changes are the new day and the manifest.
    const after = await storeHashes();
    for (const [path, hash] of Object.entries(before)) {
      if (!path.endsWith("_manifest.json")) expect(after[path], path).toBe(hash);
    }
    expect(Object.keys(after).filter((path) => !(path in before) && !path.includes("2024-01-03"))).toEqual([]);
    const report = await verifyAnalytics(database, { chainId: CHAIN_ID, dir, sampleDays: 5 });
    expect(report).toMatchObject({ ok: true, purgedDays: [DAY1, DAY2], sampledDays: ["2024-01-03"] });
  });
});

describe("verifyAnalytics", () => {
  const verify = () => verifyAnalytics(database, { chainId: CHAIN_ID, dir, sampleDays: 5 });
  const failed = (report: Awaited<ReturnType<typeof verify>>) => report.checks.filter((c) => !c.passed).map((c) => c.name);

  it("passes on a faithful export, checking aggregates, files and a rebuild", async () => {
    await seedRanges(database.sql, [R1, R2, R3]);
    await exportPublished(database, { chainId: CHAIN_ID, dir });
    const report = await verify();
    expect(failed(report)).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual(["manifest", "coverage", "files", "row-counts", `aggregates:${DAY1}`, `aggregates:${DAY2}`, "rebuild"]);
  });

  describe("after retention purged decoded rows", () => {
    it("compares only the days still fully in Postgres and reports the purged day", async () => {
      await seedRanges(database.sql, [R1, R2, R3]);
      await exportPublished(database, { chainId: CHAIN_ID, dir });
      await purgeDecoded(R1[0], R1[1]);

      const report = await verify();

      expect(failed(report)).toEqual([]);
      expect(report).toMatchObject({ ok: true, purgedDays: [DAY1], sampledDays: [DAY2] });
      expect(report.checks.map((c) => c.name)).toEqual(["manifest", "coverage", "files", "row-counts", `aggregates:${DAY2}`, "rebuild"]);
      expect(report.checks.find((c) => c.name === "rebuild")?.detail).toContain("1 purged days skipped");
    });

    it("does not compare the rows still left in a purged day, but still catches a bad day that is fully retained", async () => {
      await seedRanges(database.sql, [R1, R2, R3]);
      await exportPublished(database, { chainId: CHAIN_ID, dir });
      await purgeDecoded(R1[0], R1[1]);
      // R2's rows belong to the purged day: whatever they hold, Parquet is the only complete copy of that day.
      await database.sql`update chain.erc20_transfers set value = value + 1 where block_number between ${R2[0]} and ${R2[1]}`;
      expect((await verify()).ok).toBe(true);

      // Block 1050 is in the other day, which Postgres still holds whole.
      await database.sql`delete from chain.erc20_transfers where block_number = 1050`;
      const report = await verify();
      expect(report.ok).toBe(false);
      expect(failed(report)).toEqual(expect.arrayContaining(["row-counts", `aggregates:${DAY2}`, "rebuild"]));
    });

    it("skips everything Postgres-based once every day is purged, leaving the file checks", async () => {
      await seedRanges(database.sql, [R1, R2, R3]);
      await exportPublished(database, { chainId: CHAIN_ID, dir });
      for (const [from, to] of [R1, R2, R3]) await purgeDecoded(from, to);

      const report = await verify();

      expect(report).toMatchObject({ ok: true, purgedDays: [DAY1, DAY2], sampledDays: [] });
      expect(report.checks.map((c) => c.name)).toEqual(["manifest", "coverage", "files", "row-counts", "rebuild"]);
    });
  });

  it("passes on an empty store with nothing published, fails when something is published but not exported", async () => {
    expect((await verify()).ok).toBe(true);
    await seedRanges(database.sql, [R1]);
    expect(failed(await verify())).toEqual(["manifest"]);
    await exportPublished(database, { chainId: CHAIN_ID, dir });
    await database.sql`update ops.ranges set status = 'published' where false`;
    await seedRanges(database.sql, [R2]);
    expect(failed(await verify())).toContain("coverage");
  });

  /** Rewrites a day's transfers with one chunk changed, leaving a perfectly valid Parquet file with the wrong numbers. */
  async function tamper(day: string): Promise<string> {
    const path = partitionPath(dir, "transfers", day);
    const original = `${path}.orig`;
    await copyFile(path, original);
    await duck(`copy (select * replace (value_c0 + 1 as value_c0) from read_parquet('${original}')) to '${path}' (format parquet, compression zstd)`);
    await rm(original);
    return path;
  }

  it("detects a tampered Parquet file by hash, rebuild and row-level aggregates", async () => {
    await seedRanges(database.sql, [R1, R2, R3]);
    await exportPublished(database, { chainId: CHAIN_ID, dir });
    await tamper(DAY1);
    const report = await verify();
    expect(report.ok).toBe(false);
    expect(failed(report)).toEqual(expect.arrayContaining(["files", "rebuild"]));
    expect(failed(report)).toContain(`aggregates:${DAY1}`);
    expect(failed(report)).not.toContain(`aggregates:${DAY2}`);
  });

  it("still catches wrong numbers when the manifest was updated to match the tampered bytes", async () => {
    await seedRanges(database.sql, [R1, R2, R3]);
    await exportPublished(database, { chainId: CHAIN_ID, dir });
    const path = await tamper(DAY1);
    const manifest = await readManifest(dir);
    if (!manifest?.days[DAY1]?.transfers) throw new Error("fixture has no transfers on day 1");
    manifest.days[DAY1].transfers.sha256 = await sha256File(path);
    await writeManifest(dir, manifest);
    const report = await verify();
    expect(failed(report)).not.toContain("files");
    expect(failed(report)).toEqual(expect.arrayContaining([`aggregates:${DAY1}`, "rebuild"]));
  });

  it("reports a corrupt file as a failed check instead of throwing", async () => {
    await seedRanges(database.sql, [R1, R2, R3]);
    await exportPublished(database, { chainId: CHAIN_ID, dir });
    await writeFile(partitionPath(dir, "transfers", DAY2), "not parquet");
    const report = await verify();
    expect(failed(report)).toEqual(expect.arrayContaining(["files", `aggregates:${DAY2}`]));
  });

  it("detects a missing and a stray partition", async () => {
    await seedRanges(database.sql, [R1, R2, R3]);
    await exportPublished(database, { chainId: CHAIN_ID, dir });
    await rm(partitionPath(dir, "swaps", DAY2));
    await mkdir(join(dir, "swaps", "day=2023-12-31"));
    await copyFile(partitionPath(dir, "swaps", DAY1), partitionPath(dir, "swaps", "2023-12-31"));
    const report = await verify();
    const detail = report.checks.find((c) => c.name === "files")?.detail;
    expect(detail).toContain(`swaps/${DAY2} missing`);
    expect(detail).toContain("swaps/day=2023-12-31 is not in the manifest");
  });
});
