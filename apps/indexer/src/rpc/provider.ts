import type { ProviderConfig } from "../config.ts";
import { classifyRpcFailure, parseRetryAfter, RpcError } from "./errors.ts";
import { realClock, TokenBucket, type Clock } from "./limiter.ts";

export interface RpcCall {
  method: string;
  params: unknown[];
}

interface JsonRpcResponse {
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * One JSON-RPC endpoint: rate-limited, batched when the provider allows it,
 * and counted per method (the counts drive the free-tier budget check).
 */
export class Provider {
  readonly name: string;
  readonly maxSpan: number;
  readonly batchSize: number;
  /** JSON-RPC calls sent, by method. Each call inside a batch counts once. */
  readonly calls: Record<string, number> = {};
  private readonly url: string;
  private readonly bucket: TokenBucket;
  private nextId = 1;

  constructor(
    config: ProviderConfig,
    private readonly fetchFn: typeof fetch = fetch,
    clock: Clock = realClock,
  ) {
    this.name = config.name;
    this.url = config.url;
    this.maxSpan = config.maxSpan;
    this.batchSize = config.batchSize;
    this.bucket = new TokenBucket(config.rps, Math.max(config.rps, config.batchSize), clock);
  }

  async request<T>(method: string, params: unknown[]): Promise<T> {
    const [result] = await this.batch<T>([{ method, params }]);
    return result as T;
  }

  /** Send calls in chunks of `batchSize`; results keep the order of `calls`. */
  async batch<T>(calls: RpcCall[]): Promise<T[]> {
    const results: T[] = [];
    for (let i = 0; i < calls.length; i += this.batchSize) {
      results.push(...(await this.send<T>(calls.slice(i, i + this.batchSize))));
    }
    return results;
  }

  private async send<T>(calls: RpcCall[]): Promise<T[]> {
    await this.bucket.take(calls.length);
    const firstId = this.nextId;
    this.nextId += calls.length;
    const payload = calls.map((c, i) => ({ jsonrpc: "2.0", id: firstId + i, method: c.method, params: c.params }));
    for (const c of calls) this.calls[c.method] = (this.calls[c.method] ?? 0) + 1;

    let response: Response;
    try {
      response = await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(calls.length === 1 ? payload[0] : payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new RpcError("transient", `network: ${(err as Error).message}`, this.name);
    }

    const text = await response.text();
    let body: JsonRpcResponse | JsonRpcResponse[] | undefined;
    try {
      body = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
    } catch {
      body = undefined;
    }

    if (!response.ok || body === undefined) {
      const message = errorMessage(body) ?? `HTTP ${response.status}: ${text.slice(0, 200)}`;
      const kind = classifyRpcFailure(response.status, message);
      throw new RpcError(kind, message, this.name, parseRetryAfter(response.headers.get("retry-after")));
    }

    // Some gateways answer a whole batch with one bare error object.
    if (!Array.isArray(body) && body.error) {
      const message = body.error.message ?? `code ${body.error.code}`;
      throw new RpcError(classifyRpcFailure(undefined, message), message, this.name);
    }
    const items = Array.isArray(body) ? body : [body];
    const byId = new Map(items.map((item) => [item.id, item]));
    return payload.map((p) => {
      const item = calls.length === 1 && items.length === 1 ? items[0] : byId.get(p.id);
      if (!item) throw new RpcError("transient", `missing response for id ${p.id}`, this.name);
      if (item.error) {
        const message = item.error.message ?? `code ${item.error.code}`;
        throw new RpcError(classifyRpcFailure(undefined, message), message, this.name);
      }
      if (!("result" in item)) throw new RpcError("transient", "response has neither result nor error", this.name);
      return item.result as T;
    });
  }
}

function errorMessage(body: JsonRpcResponse | JsonRpcResponse[] | undefined): string | undefined {
  const first = Array.isArray(body) ? body.find((b) => b.error) : body;
  return first?.error?.message;
}
