import { SWAP_TOPIC, TRANSFER_TOPIC } from "./decode.ts";
import type { LogIdentity, ObservedRange, SecondSource } from "./reconcile.ts";
import { realClock, TokenBucket, type Clock } from "./rpc/limiter.ts";
import type { Hex, TrackedContracts } from "./types.ts";

const DEFAULT_BASE_URL = "https://api.etherscan.io/v2/api";
// Etherscan returns at most 1,000 logs per page and refuses page × offset above 10,000.
const PAGE_SIZE = 1_000;
const MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 30_000;

export interface EtherscanConfig {
  apiKey: string;
  chainId: number;
  /** Calls per second; the free plan allows 3. */
  rps: number;
  baseUrl?: string;
}

/** Etherscan's API wraps everything in `{status, message, result}`; the proxy module answers in JSON-RPC shape instead. */
interface Envelope {
  status?: string;
  message?: string;
  result?: unknown;
}

interface WireLog {
  blockNumber: string;
  blockHash: string;
  logIndex: string;
  transactionHash: string;
}

interface WireHeader {
  number: string;
  hash: string;
}

/** Etherscan writes a zero quantity as "0x", which `Number("0x")` would read as NaN. */
function quantity(hex: string): number {
  return hex === "0x" ? 0 : Number(hex);
}

/**
 * Etherscan's API v2 as an independent second source for reconciliation: logs from its own index
 * (`module=logs`) and block hashes through its node proxy. Error texts never include the request URL,
 * which carries the API key.
 */
export class EtherscanSource implements SecondSource {
  readonly name = "etherscan";
  readonly calls: Record<string, number> = {};
  private readonly bucket: TokenBucket;
  private readonly baseUrl: string;

  constructor(
    private readonly config: EtherscanConfig,
    private readonly fetchFn: typeof fetch = fetch,
    clock: Clock = realClock,
  ) {
    this.bucket = new TokenBucket(config.rps, 1, clock);
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
  }

  async observe(contracts: TrackedContracts, from: number, to: number): Promise<ObservedRange> {
    const lastBlockHash = await this.blockHash(to);
    const pairs: [Hex, Hex][] = [...contracts.tokens.map((t): [Hex, Hex] => [t, TRANSFER_TOPIC]), ...contracts.pools.map((p): [Hex, Hex] => [p, SWAP_TOPIC])];
    const logs: LogIdentity[] = [];
    for (const [address, topic0] of pairs) logs.push(...(await this.logs(address, topic0, from, to)));
    return { logs, lastBlockHash };
  }

  private async call(params: Record<string, string>): Promise<Envelope> {
    await this.bucket.take();
    const method = `${params.module}.${params.action}`;
    this.calls[method] = (this.calls[method] ?? 0) + 1;
    const url = new URL(this.baseUrl);
    for (const [key, value] of Object.entries({ chainid: String(this.config.chainId), ...params, apikey: this.config.apiKey })) {
      url.searchParams.set(key, value);
    }
    const response = await this.fetchFn(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`etherscan ${method}: HTTP ${response.status}`);
    return (await response.json()) as Envelope;
  }

  private async logs(address: Hex, topic0: Hex, from: number, to: number): Promise<LogIdentity[]> {
    const found: LogIdentity[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const body = await this.call({
        module: "logs",
        action: "getLogs",
        fromBlock: String(from),
        toBlock: String(to),
        address,
        topic0,
        page: String(page),
        offset: String(PAGE_SIZE),
      });
      // An empty answer is status "0" too; only this message distinguishes it from an error.
      if (body.status === "0" && body.message === "No records found") return found;
      if (body.status !== "1" || !Array.isArray(body.result)) throw new Error(`etherscan getLogs: ${body.message}: ${String(body.result)}`);
      for (const w of body.result as WireLog[]) {
        found.push({
          blockNumber: quantity(w.blockNumber),
          blockHash: w.blockHash.toLowerCase() as Hex,
          logIndex: quantity(w.logIndex),
          txHash: w.transactionHash.toLowerCase() as Hex,
        });
      }
      if (body.result.length < PAGE_SIZE) return found;
    }
    throw new Error(`etherscan getLogs ${address} ${from}-${to}: more than ${PAGE_SIZE * MAX_PAGES} logs, beyond what Etherscan pages through`);
  }

  private async blockHash(number: number): Promise<string> {
    const body = await this.call({ module: "proxy", action: "eth_getBlockByNumber", tag: `0x${number.toString(16)}`, boolean: "false" });
    const header = body.result as WireHeader | null | string | undefined;
    // Rate limits and key errors come back as a string result in the explorer envelope, not as JSON-RPC errors.
    if (typeof header === "string") throw new Error(`etherscan eth_getBlockByNumber: ${body.message ?? "error"}: ${header}`);
    if (!header) throw new Error(`etherscan has no block ${number}`);
    if (quantity(header.number) !== number) throw new Error(`etherscan answered block ${quantity(header.number)} for ${number}`);
    return header.hash.toLowerCase();
  }
}
