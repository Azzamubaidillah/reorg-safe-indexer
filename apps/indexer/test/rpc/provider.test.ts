import { describe, expect, it } from "vitest";
import { RpcError } from "../../src/rpc/errors.ts";
import { Provider } from "../../src/rpc/provider.ts";
import { FakeClock } from "./support.ts";

interface Sent {
  id: number;
  method: string;
  params: unknown[];
}

type Handler = (sent: Sent[], raw: unknown) => Response | Promise<Response>;

function json(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function makeProvider(handler: Handler, batchSize = 3) {
  const requests: Sent[][] = [];
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const raw = JSON.parse(String(init?.body));
    const sent: Sent[] = Array.isArray(raw) ? raw : [raw];
    requests.push(sent);
    return handler(sent, raw);
  }) as typeof fetch;
  const provider = new Provider({ name: "p", url: "http://x", maxSpan: 100, rps: 1000, batchSize }, fetchFn, new FakeClock());
  return { provider, requests };
}

async function rejection(p: Promise<unknown>): Promise<RpcError> {
  try {
    await p;
  } catch (e) {
    return e as RpcError;
  }
  throw new Error("expected rejection");
}

const echo: Handler = (sent) => json(sent.map((s) => ({ jsonrpc: "2.0", id: s.id, result: s.params[0] })));

describe("Provider", () => {
  it("splits a batch into batchSize chunks and keeps call order", async () => {
    const { provider, requests } = makeProvider(echo, 3);
    const calls = Array.from({ length: 7 }, (_, i) => ({ method: "m", params: [i] }));
    expect(await provider.batch(calls)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(requests.map((r) => r.length)).toEqual([3, 3, 1]);
    const ids = requests.flat().map((r) => r.id);
    expect(new Set(ids).size).toBe(7);
  });

  it("maps results by id when the server answers out of order", async () => {
    const { provider } = makeProvider((sent) => json(sent.map((s) => ({ jsonrpc: "2.0", id: s.id, result: s.params[0] })).reverse()));
    expect(await provider.batch([0, 1, 2].map((i) => ({ method: "m", params: [i] })))).toEqual([0, 1, 2]);
  });

  it("sends a lone call as a plain object and a single-element chunk likewise", async () => {
    const { provider } = makeProvider((sent) => json({ jsonrpc: "2.0", id: sent[0]!.id, result: "ok" }));
    expect(await provider.request("m", [])).toBe("ok");
  });

  it("throws the classified kind for a batch item error", async () => {
    const { provider } = makeProvider((sent) =>
      json(
        sent.map((s, i) =>
          i === 1
            ? { jsonrpc: "2.0", id: s.id, error: { code: -32005, message: "query returned more than 10000 results" } }
            : { jsonrpc: "2.0", id: s.id, result: 1 },
        ),
      ),
    );
    const err = await rejection(provider.batch([1, 2, 3].map(() => ({ method: "eth_getLogs", params: [] }))));
    expect(err).toBeInstanceOf(RpcError);
    expect(err.kind).toBe("range_too_large");
  });

  it("classifies a whole-batch JSON-RPC error object (not an array) instead of calling it a missing id", async () => {
    const { provider } = makeProvider(() => json({ jsonrpc: "2.0", id: null, error: { code: -32005, message: "query returned more than 10000 results" } }));
    const err = await rejection(provider.batch([1, 2].map(() => ({ method: "eth_getLogs", params: [] }))));
    expect(err.kind).toBe("range_too_large");
  });

  it("HTTP 429 with Retry-After -> rate_limited with retryAfterMs", async () => {
    const { provider } = makeProvider(() => new Response("slow down", { status: 429, headers: { "retry-after": "3" } }));
    const err = await rejection(provider.request("m", []));
    expect(err).toBeInstanceOf(RpcError);
    expect(err.kind).toBe("rate_limited");
    expect(err.retryAfterMs).toBe(3000);
  });

  it("HTTP 400 with a range error body -> range_too_large", async () => {
    const { provider } = makeProvider(() =>
      json({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "up to a 10 block range" } }, { status: 400 }),
    );
    const err = await rejection(provider.request("m", []));
    expect(err.kind).toBe("range_too_large");
  });

  it("non-JSON body -> transient (even with HTTP 200)", async () => {
    const { provider } = makeProvider(() => new Response("<html>bad gateway</html>", { status: 200 }));
    const err = await rejection(provider.request("m", []));
    expect(err.kind).toBe("transient");
  });

  it("HTTP 502 -> transient", async () => {
    const { provider } = makeProvider(() => new Response("bad gateway", { status: 502 }));
    expect((await rejection(provider.request("m", []))).kind).toBe("transient");
  });

  it("network failure -> transient", async () => {
    const { provider } = makeProvider(() => {
      throw new TypeError("fetch failed");
    });
    const err = await rejection(provider.request("m", []));
    expect(err).toBeInstanceOf(RpcError);
    expect(err.kind).toBe("transient");
  });

  it("a response missing an id is transient", async () => {
    const { provider } = makeProvider((sent) => json(sent.slice(1).map((s) => ({ jsonrpc: "2.0", id: s.id, result: 1 }))));
    const err = await rejection(provider.batch([1, 2].map(() => ({ method: "m", params: [] }))));
    expect(err.kind).toBe("transient");
  });

  it("counts each call inside a batch once, per method", async () => {
    const { provider } = makeProvider(echo, 2);
    await provider.batch([
      { method: "a", params: [1] },
      { method: "b", params: [1] },
      { method: "a", params: [1] },
    ]);
    await provider.request("a", [1]);
    expect(provider.calls).toEqual({ a: 3, b: 1 });
  });
});
