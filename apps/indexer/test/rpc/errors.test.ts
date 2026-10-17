import { describe, expect, it } from "vitest";
import { classifyRpcFailure, parseRetryAfter } from "../../src/rpc/errors.ts";
import fixture from "./fixtures/real-errors.json" with { type: "json" };

describe("classifyRpcFailure", () => {
  it.each(fixture.cases)("real $provider message -> $kind", ({ status, message, kind }) => {
    expect(classifyRpcFailure(status, message)).toBe(kind);
  });

  it("429 is rate_limited whatever the body says", () => {
    expect(classifyRpcFailure(429, "")).toBe("rate_limited");
    expect(classifyRpcFailure(429, "HTTP 429: Too Many Requests")).toBe("rate_limited");
  });

  it("401/403 are unsupported (fail over, do not retry)", () => {
    expect(classifyRpcFailure(401, "HTTP 401: unauthorized")).toBe("unsupported");
    expect(classifyRpcFailure(403, "HTTP 403: forbidden")).toBe("unsupported");
  });

  it("5xx and gateway noise are transient", () => {
    for (const status of [500, 502, 503, 504]) expect(classifyRpcFailure(status, `HTTP ${status}: oops`)).toBe("transient");
  });

  it("generic -32000 messages never become range_too_large", () => {
    for (const message of [
      "execution reverted",
      "execution reverted: ERC20: transfer amount exceeds balance",
      "header not found",
      "nonce too low",
      "insufficient funds for gas * price + value",
      "internal error",
      "request timed out",
    ]) {
      expect(["transient", "unsupported"]).toContain(classifyRpcFailure(undefined, message));
    }
  });

  it("pruned / disabled-method messages are unsupported", () => {
    expect(classifyRpcFailure(undefined, "missing trie node abc (path )")).toBe("unsupported");
    expect(classifyRpcFailure(undefined, "the method eth_getLogs does not exist/is not available")).toBe("unsupported");
  });
});

describe("parseRetryAfter", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");

  it("parses delta-seconds", () => {
    expect(parseRetryAfter("2", now)).toBe(2000);
    expect(parseRetryAfter("0.5", now)).toBe(500);
  });

  it("parses an HTTP-date relative to now", () => {
    expect(parseRetryAfter("Sat, 17 Oct 2026 12:00:07 GMT", now)).toBe(7000);
  });

  it("clamps past dates and negative values to 0", () => {
    expect(parseRetryAfter("Sat, 17 Oct 2026 11:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("-5", now)).toBe(0);
  });

  it("returns undefined for missing or garbage headers", () => {
    expect(parseRetryAfter(null, now)).toBeUndefined();
    expect(parseRetryAfter("", now)).toBeUndefined();
    expect(parseRetryAfter("soon", now)).toBeUndefined();
  });
});
