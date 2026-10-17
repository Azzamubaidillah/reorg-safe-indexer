import { describe, expect, it } from "vitest";
import { parseSince } from "../src/cli.ts";

const NOW = Date.parse("2026-10-17T12:00:00Z");

describe("parseSince", () => {
  it.each([
    ["90s", "2026-10-17T11:58:30.000Z"],
    ["30m", "2026-10-17T11:30:00.000Z"],
    ["72h", "2026-10-14T12:00:00.000Z"],
    ["2d", "2026-10-15T12:00:00.000Z"],
  ])("reads duration %s relative to now", (text, expected) => {
    expect(parseSince(text, NOW).toISOString()).toBe(expected);
  });

  it("reads an ISO timestamp as is", () => {
    expect(parseSince("2026-10-01T00:00:00Z", NOW).toISOString()).toBe("2026-10-01T00:00:00.000Z");
  });

  it.each(["", "72", "h", "-5h", "yesterday"])("rejects %j", (text) => {
    expect(() => parseSince(text, NOW)).toThrow(/--since/);
  });
});
