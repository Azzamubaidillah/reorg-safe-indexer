import { describe, expect, it } from "vitest";
import { SWAP_TOPIC, TRANSFER_TOPIC } from "../src/decode.ts";
import { EtherscanSource } from "../src/etherscan.ts";
import type { Hex } from "../src/types.ts";
import fixture from "./fixtures/etherscan.json" with { type: "json" };

const KEY = "TESTKEY0000000000000000000000000000";
const USDC: Hex = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const POOL: Hex = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
const contracts = { tokens: [USDC], pools: [POOL] };

interface WireLog {
  blockNumber: string;
  blockHash: string;
  logIndex: string;
  transactionHash: string;
}

/** A fake Etherscan answering from `route`, recording every request URL. */
function fakeFetch(route: (params: URLSearchParams) => unknown) {
  const seen: URLSearchParams[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const params = new URL(String(input)).searchParams;
    seen.push(params);
    return Response.json(route(params));
  }) as typeof fetch;
  return { fetchFn, seen };
}

const source = (fetchFn: typeof fetch) => new EtherscanSource({ apiKey: KEY, chainId: 1, rps: 1_000 }, fetchFn);
const identity = (w: WireLog) => ({ blockNumber: Number(w.blockNumber), blockHash: w.blockHash.toLowerCase(), logIndex: Number(w.logIndex), txHash: w.transactionHash.toLowerCase() });

describe("EtherscanSource on recorded responses", () => {
  it("observes a block: header hash plus the transfer and swap logs, one getLogs per contract", async () => {
    const block = fixture.transfersBlock;
    const swapsInBlock = (fixture.swaps.result as WireLog[]).filter((l) => Number(l.blockNumber) === block);
    const { fetchFn, seen } = fakeFetch((p) => {
      if (p.get("module") === "proxy") return fixture.header;
      if (p.get("address") === USDC) return fixture.transfers;
      return swapsInBlock.length ? { ...fixture.swaps, result: swapsInBlock } : fixture.empty;
    });
    const es = source(fetchFn);
    const observed = await es.observe(contracts, block, block);

    expect(observed.lastBlockHash).toBe(fixture.header.result.hash.toLowerCase());
    expect(observed.logs).toEqual([...(fixture.transfers.result as WireLog[]), ...swapsInBlock].map(identity));
    expect(observed.logs.length).toBe(29 + swapsInBlock.length);
    expect(es.calls).toEqual({ "proxy.eth_getBlockByNumber": 1, "logs.getLogs": 2 });
    const logCalls = seen.filter((p) => p.get("module") === "logs");
    expect(logCalls.map((p) => [p.get("address"), p.get("topic0")])).toEqual([
      [USDC, TRANSFER_TOPIC],
      [POOL, SWAP_TOPIC],
    ]);
    expect(seen.every((p) => p.get("chainid") === "1" && p.get("apikey") === KEY)).toBe(true);
    expect(logCalls.every((p) => p.get("fromBlock") === String(block) && p.get("toBlock") === String(block) && p.get("page") === "1" && p.get("offset") === "1000")).toBe(true);
  });

  it("treats 'No records found' as an empty result, not an error", async () => {
    const { fetchFn } = fakeFetch((p) => (p.get("module") === "proxy" ? fixture.header : fixture.empty));
    const observed = await source(fetchFn).observe(contracts, fixture.transfersBlock, fixture.transfersBlock);
    expect(observed.logs).toEqual([]);
  });

  it("reads Etherscan's '0x' for a zero log index as 0", async () => {
    const [first] = fixture.transfers.result as WireLog[];
    const { fetchFn } = fakeFetch((p) => {
      if (p.get("module") === "proxy") return fixture.header;
      if (p.get("address") === USDC) return { ...fixture.transfers, result: [{ ...first, logIndex: "0x" }] };
      return fixture.empty;
    });
    const observed = await source(fetchFn).observe(contracts, fixture.transfersBlock, fixture.transfersBlock);
    expect(observed.logs).toEqual([{ ...identity(first!), logIndex: 0 }]);
  });
});

describe("EtherscanSource paging", () => {
  const [row] = fixture.transfers.result as WireLog[];
  const page = (n: number) => ({ status: "1", message: "OK", result: Array.from({ length: n }, (_, i) => ({ ...row, logIndex: `0x${i.toString(16)}` })) });

  it("follows full pages of 1,000 until a short one", async () => {
    const { fetchFn, seen } = fakeFetch((p) => {
      if (p.get("module") === "proxy") return fixture.header;
      if (p.get("address") !== USDC) return fixture.empty;
      return p.get("page") === "1" ? page(1_000) : page(3);
    });
    const observed = await source(fetchFn).observe(contracts, fixture.transfersBlock, fixture.transfersBlock);
    expect(observed.logs.length).toBe(1_003);
    expect(seen.filter((p) => p.get("address") === USDC).map((p) => p.get("page"))).toEqual(["1", "2"]);
  });

  it("refuses a range with more logs than Etherscan pages through (10 x 1,000) instead of returning a truncated set", async () => {
    const { fetchFn } = fakeFetch((p) => (p.get("module") === "proxy" ? fixture.header : page(1_000)));
    await expect(source(fetchFn).observe(contracts, fixture.transfersBlock, fixture.transfersBlock)).rejects.toThrow(/more than 10000 logs/);
  });
});

describe("EtherscanSource errors", () => {
  const cases: [string, (p: URLSearchParams) => unknown, RegExp][] = [
    ["rate limit on getLogs", (p) => (p.get("module") === "proxy" ? fixture.header : fixture.rateLimited), /rate limit reached/],
    ["invalid key on getLogs", (p) => (p.get("module") === "proxy" ? fixture.header : fixture.invalidKey), /Invalid API Key/],
    ["rate limit on the header", () => fixture.rateLimited, /eth_getBlockByNumber: NOTOK: Max calls per sec/],
    ["unknown block", () => ({ jsonrpc: "2.0", id: 1, result: null }), /has no block/],
    ["header for another height", () => ({ ...fixture.header, result: { ...fixture.header.result, number: "0x1" } }), /answered block 1 for/],
  ];

  it.each(cases)("%s throws, and the message never carries the API key", async (_name, route, message) => {
    const { fetchFn } = fakeFetch(route);
    const failure = await source(fetchFn)
      .observe(contracts, fixture.transfersBlock, fixture.transfersBlock)
      .then(() => undefined, (err: Error) => err);
    expect(failure?.message).toMatch(message);
    expect(failure?.message).not.toContain(KEY);
  });

  it("throws on a non-2xx HTTP status", async () => {
    const fetchFn = (async () => new Response("bad gateway", { status: 502 })) as typeof fetch;
    await expect(source(fetchFn).observe(contracts, 1, 1)).rejects.toThrow(/HTTP 502/);
  });
});
