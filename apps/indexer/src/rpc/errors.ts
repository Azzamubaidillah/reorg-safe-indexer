/**
 * How the caller should react to a failed JSON-RPC call:
 * - range_too_large: split the eth_getLogs block range and retry on the same provider
 * - rate_limited:    back off this provider (honouring Retry-After) and try another
 * - unsupported:     this provider refuses the request (pruned history, plan limit,
 *                    method disabled); fail over without splitting
 * - transient:       5xx, timeout, network error, malformed response; retry with backoff
 */
export type RpcErrorKind = "range_too_large" | "rate_limited" | "unsupported" | "transient";

export class RpcError extends Error {
  constructor(
    readonly kind: RpcErrorKind,
    message: string,
    readonly provider: string,
    readonly retryAfterMs?: number,
  ) {
    super(`[${provider}] ${kind}: ${message}`);
    this.name = "RpcError";
  }
}

// Messages observed from real providers (see apps/indexer/test/rpc/fixtures/real-errors.json).
const RANGE_PATTERNS = [
  /block range/i,
  /ranges? over \d+ blocks/i,
  /range is too (large|wide)/i,
  /limited to [\d\s-]+ blocks?/i,
  /more than \d+ results/i,
  /log response size exceeded/i,
  /response size (exceeded|too large|should not)/i,
  /too many (logs|results)/i,
  /exceed(s|ed)? (the )?max(imum)? (block )?(range|span)/i,
];
const RATE_PATTERNS = [/rate.?limit/i, /too many requests/i, /exceeded .*capacity/i, /compute units? per second/i, /throughput/i];
const UNSUPPORTED_PATTERNS = [
  /method .*(not (found|supported|available)|does not exist)/i,
  /not supported/i,
  /pruned/i,
  /missing trie node/i,
  /historical state|history (is )?not available|archive/i,
  /upgrade your plan|not available on (the )?free/i,
];

/** Classify an HTTP status and/or JSON-RPC error message into an {@link RpcErrorKind}. */
export function classifyRpcFailure(status: number | undefined, message: string): RpcErrorKind {
  if (RANGE_PATTERNS.some((p) => p.test(message))) return "range_too_large";
  if (status === 429 || RATE_PATTERNS.some((p) => p.test(message))) return "rate_limited";
  if (UNSUPPORTED_PATTERNS.some((p) => p.test(message))) return "unsupported";
  if (status === 401 || status === 403) return "unsupported";
  return "transient";
}

export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}
