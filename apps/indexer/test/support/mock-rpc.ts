import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import type { Hex } from "../../src/types.ts";
import type { SyntheticChain } from "./synthetic-chain.ts";

export interface MockRpcOptions {
  chain: SyntheticChain;
  /** Initial `latest` block; blocks above it do not exist. Also the initial `finalized` unless that is given. */
  head: number;
  finalized?: number;
  /** Largest eth_getLogs span (inclusive block count) served before answering with a range error. */
  maxSpan: number;
  chainId?: number;
  /** Delay applied to every HTTP request, batches included. */
  latencyMs?: number;
}

/** Logs served from `chain` for heights >= `fromHeight` while `times` more eth_getLogs calls reach that far. */
export interface StaleLogs {
  chain: SyntheticChain;
  fromHeight: number;
  times: number;
}

export interface RpcCall {
  method: string;
  params: unknown[];
}

export interface MockRpc {
  url: string;
  /** Replace the canonical chain (a reorg when it diverges from the previous one). Takes effect on the next request. */
  setChain(chain: SyntheticChain): void;
  setHead(latest: number): void;
  setFinalized(finalized: number): void;
  /** Make headers and logs disagree: headers follow the current chain, logs come from a lagging node. */
  serveStaleLogs(stale: StaleLogs): void;
  /** Runs synchronously before each JSON-RPC call is answered, so a test can change the chain mid-fetch. */
  beforeCall(hook: ((call: RpcCall) => void) | undefined): void;
  /** JSON-RPC calls answered so far, by method. */
  calls: Record<string, number>;
  close(): Promise<void>;
}

interface JsonRpcRequest {
  id?: number | string | null;
  method: string;
  params?: unknown[];
}

interface GetLogsFilter {
  fromBlock: string;
  toBlock: string;
  address?: string | string[];
  topics?: (string | string[] | null)[];
}

class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export async function startMockRpc(options: MockRpcOptions): Promise<MockRpc> {
  const { maxSpan, chainId = 1, latencyMs = 0 } = options;
  let { chain, head } = options;
  let finalized = options.finalized ?? head;
  let stale: StaleLogs | undefined;
  let hook: ((call: RpcCall) => void) | undefined;
  const calls: Record<string, number> = {};

  const resolveBlock = (tag: string): number => {
    if (tag === "latest") return head;
    if (tag === "finalized" || tag === "safe") return finalized;
    if (!/^0x[0-9a-f]+$/.test(tag)) throw new RpcFailure(-32602, `invalid block tag ${tag}`);
    return Number.parseInt(tag, 16);
  };

  const toHexNumber = (n: number): Hex => `0x${n.toString(16)}`;

  const handle = (method: string, params: unknown[]): unknown => {
    calls[method] = (calls[method] ?? 0) + 1;
    hook?.({ method, params });
    switch (method) {
      case "eth_chainId":
        return toHexNumber(chainId);
      case "eth_blockNumber":
        return toHexNumber(head);
      case "eth_getBlockByNumber": {
        const n = resolveBlock(params[0] as string);
        if (n > head) return null;
        const h = chain.header(n);
        return {
          number: toHexNumber(h.number),
          hash: h.hash,
          parentHash: h.parentHash,
          timestamp: toHexNumber(h.timestamp),
          transactions: [],
        };
      }
      case "eth_getLogs": {
        const f = params[0] as GetLogsFilter;
        const from = resolveBlock(f.fromBlock);
        const to = Math.min(resolveBlock(f.toBlock), head);
        if (to - from + 1 > maxSpan) {
          throw new RpcFailure(-32602, `block range too large: at most ${maxSpan} blocks per request`);
        }
        const addresses = f.address === undefined ? undefined : [f.address].flat().map((a) => a.toLowerCase());
        const topic0 = f.topics?.[0];
        const topic0s = topic0 == null ? undefined : [topic0].flat().map((t) => t.toLowerCase());
        const out: unknown[] = [];
        const lagging = stale && stale.times > 0 && to >= stale.fromHeight ? stale : undefined;
        if (lagging) lagging.times--;
        for (let n = from; n <= to; n++) {
          const source = lagging && n >= lagging.fromHeight ? lagging.chain : chain;
          for (const log of source.allLogs(n)) {
            if (addresses && !addresses.includes(log.address)) continue;
            if (topic0s && !topic0s.includes(log.topics[0] as string)) continue;
            out.push({
              address: log.address,
              topics: log.topics,
              data: log.data,
              blockNumber: toHexNumber(log.blockNumber),
              blockHash: log.blockHash,
              transactionHash: log.txHash,
              transactionIndex: toHexNumber(log.txIndex),
              logIndex: toHexNumber(log.logIndex),
              removed: false,
            });
          }
        }
        return out;
      }
      default:
        throw new RpcFailure(-32601, `method not found: ${method}`);
    }
  };

  const respond = (req: JsonRpcRequest) => {
    const id = req.id ?? null;
    try {
      return { jsonrpc: "2.0", id, result: handle(req.method, req.params ?? []) };
    } catch (err) {
      if (!(err instanceof RpcFailure)) throw err;
      return { jsonrpc: "2.0", id, error: { code: err.code, message: err.message } };
    }
  };

  const server: Server = createServer(async (req, res) => {
    try {
      const body = JSON.parse(await readBody(req)) as JsonRpcRequest | JsonRpcRequest[];
      if (latencyMs > 0) await sleep(latencyMs);
      const payload = Array.isArray(body) ? body.map(respond) : respond(body);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(payload));
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });

  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;

  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    setChain: (c) => (chain = c),
    setHead: (n) => (head = n),
    setFinalized: (n) => (finalized = n),
    serveStaleLogs: (s) => (stale = { ...s }),
    beforeCall: (h) => (hook = h),
    calls,
    async close() {
      const closed = Promise.withResolvers<void>();
      server.close((err) => (err ? closed.reject(err) : closed.resolve()));
      // Clients keep connections alive; without this close() waits for them.
      server.closeAllConnections();
      await closed.promise;
    },
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}
