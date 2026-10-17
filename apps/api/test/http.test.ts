import { describe, expect, it } from "vitest";
import { z } from "zod";
import { decodeCursor, encodeCursor, HttpError, paginate, parseInput } from "../src/http.ts";

const shape = z.strictObject({ b: z.number().int().nonnegative(), l: z.number().int().nonnegative() });

describe("cursors", () => {
  it("round-trips a sort key and is URL-safe", () => {
    const cursor = encodeCursor({ b: 21_000_000, l: 417 });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(shape, cursor)).toEqual({ b: 21_000_000, l: 417 });
    expect(decodeCursor(shape, undefined)).toBeUndefined();
  });

  it("turns anything that is not a valid key for the endpoint into a 400", () => {
    const forged = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
    for (const bad of ["", "%%%", "e30", forged({ b: 1 }), forged({ b: 1, l: 2, x: 3 }), forged({ b: "1", l: 2 }), forged({ b: 1.5, l: 2 }), forged(null), forged("str")]) {
      expect(() => decodeCursor(shape, bad), bad).toThrow(HttpError);
    }
    try {
      decodeCursor(shape, "%%%");
    } catch (err) {
      expect(err).toMatchObject({ status: 400, code: "invalid_cursor" });
    }
  });
});

describe("paginate", () => {
  const cursorOf = (n: number) => `after-${n}`;

  it("returns a cursor from the last returned row, not from the probe row", () => {
    expect(paginate([5, 4, 3], 2, cursorOf)).toEqual({ items: [5, 4], nextCursor: "after-4" });
  });

  it("returns no cursor when the page is the last one, including an exactly full page", () => {
    expect(paginate([5, 4], 2, cursorOf)).toEqual({ items: [5, 4], nextCursor: null });
    expect(paginate([], 2, cursorOf)).toEqual({ items: [], nextCursor: null });
  });
});

describe("parseInput", () => {
  it("reports every offending field in one 400", () => {
    const schema = z.strictObject({ a: z.string().regex(/^\d+$/, "digits only"), b: z.string().min(2) });
    try {
      parseInput(schema, { a: "x", b: "y" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect(err).toMatchObject({ status: 400, code: "bad_request" });
      expect((err as HttpError).message).toContain("a: digits only");
      expect((err as HttpError).message).toContain("b:");
    }
  });
});
