import { DuckDBInstance } from "@duckdb/node-api";
import { describe, expect, it } from "vitest";
import { chunkSelect, chunkSumSelect, sumFromChunks } from "../src/amounts.ts";

describe("amount chunks", () => {
  it("split and recombine uint256 and int256 extremes exactly", async () => {
    const values = ["0", "1", "-1", (2n ** 256n - 1n).toString(), (-(2n ** 255n)).toString(), "99999999999999999999999999", "100000000000000000000000000"];
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    try {
      await connection.run("create table t (v varchar)");
      await connection.run(`insert into t values ${values.map((v) => `('${v}')`).join(", ")}`);
      const rows = (await connection.runAndReadAll(`select v, ${chunkSumSelect("a")} from (select v, ${chunkSelect("v", "a")} from t) group by v`)).getRowObjectsJson();
      expect(rows).toHaveLength(values.length);
      for (const row of rows) expect(sumFromChunks(row, "a")).toBe(String(row.v).replace("-", ""));
      // Summing across rows stays exact past 2^256, where no fixed-width SQL type can hold the total.
      const [total] = (await connection.runAndReadAll(`select ${chunkSumSelect("a")} from (select ${chunkSelect("v", "a")} from t)`)).getRowObjectsJson();
      expect(sumFromChunks(total ?? {}, "a")).toBe(values.reduce((sum, v) => sum + BigInt(v.replace("-", "")), 0n).toString());
    } finally {
      connection.closeSync();
      instance.closeSync();
    }
  });
});
