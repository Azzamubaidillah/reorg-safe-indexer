import { createDb, type Database } from "@rsi/db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { verifyRebuild, type RebuildReport } from "../src/rebuild.ts";
import { startRun } from "../src/store.ts";
import { resetDatabase, tableFingerprints, TEST_DATABASE_URL } from "./support/db.ts";
import { CHAIN_ID, commitRanges, contractsOf, RUN_ID } from "./support/ranges.ts";
import { SyntheticChain } from "./support/synthetic-chain.ts";

const chain = new SyntheticChain();
const totals = chain.totals(1000, 1059);
let database: Database;

const rebuild = (extra: { batchSize?: number; blockWindow?: number } = {}): Promise<RebuildReport> =>
  verifyRebuild(database, { chainId: CHAIN_ID, contracts: contractsOf(chain), ...extra });

const table = (report: RebuildReport, name: "erc20_transfers" | "uniswap_v3_swaps") => report.tables.find((t) => t.table === name)!;

interface Pos {
  block_number: string;
  block_hash: string;
  log_index: number;
}

const decodedRows = (name: "erc20_transfers" | "uniswap_v3_swaps", limit: number) =>
  database.sql<Pos[]>`select block_number, block_hash, log_index from ${database.sql(`chain.${name}`)} order by block_number, log_index limit ${limit}`;

beforeEach(async () => {
  await resetDatabase();
  database = createDb(TEST_DATABASE_URL, { max: 2 });
  await startRun(database, RUN_ID, CHAIN_ID);
  await commitRanges(database, chain);
});

afterEach(async () => {
  await database.sql.end();
});

describe("verifyRebuild", () => {
  it("finds the decoded tables equal to a rebuild from the landing logs, without writing anything", async () => {
    const before = await tableFingerprints(database);
    const report = await rebuild();

    expect(report.equal).toBe(true);
    expect(report.logsScanned).toBe(totals.logs);
    expect(report.rejects).toEqual({ rebuilt: 0, recorded: 0 });
    expect(table(report, "erc20_transfers")).toMatchObject({ storedRows: totals.transfers, rebuiltRows: totals.transfers, equal: true, firstDifferences: [] });
    expect(table(report, "uniswap_v3_swaps")).toMatchObject({ storedRows: totals.swaps, rebuiltRows: totals.swaps, equal: true, firstDifferences: [] });
    for (const t of report.tables) {
      expect(t.storedSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(t.storedSha256).toBe(t.rebuiltSha256);
    }
    expect(table(report, "erc20_transfers").storedSha256).not.toBe(table(report, "uniswap_v3_swaps").storedSha256);
    expect(await tableFingerprints(database)).toEqual(before);
    const leaked = await database.sql`select 1 from pg_class where relname in ('rebuilt_transfers', 'rebuilt_swaps')`;
    expect(leaked).toHaveLength(0);
  });

  it("gives the same answer however the work is batched", async () => {
    const whole = await rebuild();
    // Windows and cursor fetches that split ranges, blocks and tables at arbitrary points.
    expect(await rebuild({ batchSize: 7, blockWindow: 3 })).toEqual(whole);
    expect(await rebuild({ batchSize: 1, blockWindow: 1_000 })).toEqual(whole);
  });

  it("reports a tampered decoded value at its position", async () => {
    const [t] = await decodedRows("erc20_transfers", 1);
    await database.sql`update chain.erc20_transfers set value = value + 1 where block_hash = ${t!.block_hash} and log_index = ${t!.log_index}`;

    const report = await rebuild();

    expect(report.equal).toBe(false);
    const transfers = table(report, "erc20_transfers");
    expect(transfers.equal).toBe(false);
    expect(transfers.storedSha256).not.toBe(transfers.rebuiltSha256);
    expect(transfers.storedRows).toBe(transfers.rebuiltRows);
    expect(transfers.firstDifferences).toEqual([{ blockNumber: Number(t!.block_number), logIndex: t!.log_index, kind: "different" }]);
    expect(table(report, "uniswap_v3_swaps").equal).toBe(true);
  });

  it("reports a deleted decoded row as missing from the stored table", async () => {
    const [s] = await decodedRows("uniswap_v3_swaps", 1);
    await database.sql`delete from chain.uniswap_v3_swaps where block_hash = ${s!.block_hash} and log_index = ${s!.log_index}`;

    const report = await rebuild();

    const swaps = table(report, "uniswap_v3_swaps");
    expect(report.equal).toBe(false);
    expect(swaps).toMatchObject({ equal: false, storedRows: totals.swaps - 1, rebuiltRows: totals.swaps });
    expect(swaps.firstDifferences).toEqual([{ blockNumber: Number(s!.block_number), logIndex: s!.log_index, kind: "missing_in_stored" }]);
    expect(table(report, "erc20_transfers").equal).toBe(true);
  });

  it("reports a stored row that no log decodes to as extra", async () => {
    await database.sql`
      insert into chain.erc20_transfers
      select chain_id, block_number, block_hash, 999, tx_hash, token, from_address, to_address, value
      from chain.erc20_transfers order by block_number, log_index limit 1`;

    const report = await rebuild();

    const transfers = table(report, "erc20_transfers");
    expect(transfers.storedRows).toBe(totals.transfers + 1);
    expect(transfers.firstDifferences).toHaveLength(1);
    expect(transfers.firstDifferences[0]).toMatchObject({ logIndex: 999, kind: "extra_in_stored" });
  });

  it("catches decoded rows that no longer follow from a changed landing log", async () => {
    // The decoded table is untouched; its source moved. Only a rebuild can see this.
    const [t] = await decodedRows("erc20_transfers", 1);
    await database.sql`
      update chain.logs set data = '0x' || lpad('7', 64, '0') where block_hash = ${t!.block_hash} and log_index = ${t!.log_index}`;

    const report = await rebuild();

    expect(table(report, "erc20_transfers").firstDifferences).toEqual([
      { blockNumber: Number(t!.block_number), logIndex: t!.log_index, kind: "different" },
    ]);
  });

  it("lists at most five differing positions, lowest first", async () => {
    const victims = await decodedRows("erc20_transfers", 7);
    expect(victims).toHaveLength(7);
    for (const v of victims) {
      await database.sql`delete from chain.erc20_transfers where block_hash = ${v.block_hash} and log_index = ${v.log_index}`;
    }

    const transfers = table(await rebuild(), "erc20_transfers");

    expect(transfers.storedRows).toBe(totals.transfers - 7);
    expect(transfers.firstDifferences).toEqual(
      victims.slice(0, 5).map((v) => ({ blockNumber: Number(v.block_number), logIndex: v.log_index, kind: "missing_in_stored" })),
    );
  });

  it("flags a reject count that disagrees with what the rebuild rejects", async () => {
    await database.sql`update ops.ranges set reject_count = 2 where from_block = 1000`;

    const report = await rebuild();

    expect(report.tables.every((t) => t.equal)).toBe(true);
    expect(report.rejects).toEqual({ rebuilt: 0, recorded: 2 });
    expect(report.equal).toBe(false);
  });

  it("ignores other chains' rows", async () => {
    await database.sql`
      insert into chain.erc20_transfers
      select 2, block_number, block_hash, log_index, tx_hash, token, from_address, to_address, value + 1 from chain.erc20_transfers`;

    expect((await rebuild()).equal).toBe(true);
  });
});
