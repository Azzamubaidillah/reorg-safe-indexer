import { describe, expect, it } from "vitest";
import { assertDay, dayBounds, isCovered, mergeIntervals } from "../src/layout.ts";

describe("intervals", () => {
  it("merges adjacent and overlapping ranges but not gaps", () => {
    expect(mergeIntervals([[1040, 1059], [1000, 1019], [1020, 1039], [2000, 2010], [2005, 2020]])).toEqual([[1000, 1059], [2000, 2020]]);
  });

  it("covers a range only when one interval contains all of it", () => {
    const merged = mergeIntervals([[1000, 1019], [1040, 1059]]);
    expect(isCovered(merged, 1000, 1019)).toBe(true);
    expect(isCovered(merged, 1020, 1039)).toBe(false);
    expect(isCovered(merged, 1010, 1045)).toBe(false);
  });
});

describe("days", () => {
  it("spans exactly 24 hours in UTC", () => {
    const { start, end } = dayBounds("2024-03-10");
    expect(start.toISOString()).toBe("2024-03-10T00:00:00.000Z");
    expect(end.getTime() - start.getTime()).toBe(86_400_000);
  });

  it("rejects anything that is not a calendar day", () => {
    for (const bad of ["2024-1-1", "2024-13-01", "20240101", "2024-01-01'; drop"]) expect(() => assertDay(bad)).toThrow(RangeError);
  });
});
