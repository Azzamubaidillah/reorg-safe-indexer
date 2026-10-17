import { RpcError } from "./errors.ts";
import { realClock, type Clock } from "./limiter.ts";
import type { Provider } from "./provider.ts";

export interface PoolOptions {
  /** Total attempts across all providers before giving up. */
  maxAttempts?: number;
  /** First backoff after a transient failure; doubles per attempt, capped at 30 s. */
  baseBackoffMs?: number;
  clock?: Clock;
  onRetry?: (error: RpcError, attempt: number) => void;
}

const MAX_BACKOFF_MS = 30_000;

/**
 * Runs an operation against an ordered list of providers.
 * - range_too_large is not handled here: it propagates so the caller can split.
 * - rate_limited cools the provider down (Retry-After or backoff) and moves on.
 * - unsupported fails over to the next provider without splitting; the provider is
 *   skipped for the rest of this operation.
 * - transient errors back off and retry, rotating providers.
 */
export class RpcPool {
  private readonly coolUntil = new Map<string, number>();
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly clock: Clock;
  private readonly onRetry: PoolOptions["onRetry"];

  constructor(
    readonly providers: Provider[],
    options: PoolOptions = {},
  ) {
    if (providers.length === 0) throw new Error("RpcPool needs at least one provider");
    this.maxAttempts = options.maxAttempts ?? 8;
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.clock = options.clock ?? realClock;
    this.onRetry = options.onRetry;
  }

  async run<T>(op: (provider: Provider) => Promise<T>): Promise<T> {
    const refused = new Set<string>();
    let lastError: RpcError | undefined;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const usable = this.providers.filter((p) => !refused.has(p.name));
      if (usable.length === 0) break;
      const provider = await this.pick(usable);
      try {
        return await op(provider);
      } catch (err) {
        if (!(err instanceof RpcError) || err.kind === "range_too_large") throw err;
        lastError = err;
        this.onRetry?.(err, attempt);
        const backoff = Math.min(MAX_BACKOFF_MS, this.baseBackoffMs * 2 ** (attempt - 1));
        if (err.kind === "unsupported") refused.add(provider.name);
        else this.coolUntil.set(provider.name, this.clock.now() + (err.retryAfterMs ?? backoff));
      }
    }
    throw lastError ?? new Error("every provider refused the request");
  }

  /** Prefer the first provider that is not cooling down; otherwise wait for the soonest one. */
  private async pick(usable: Provider[]): Promise<Provider> {
    const now = this.clock.now();
    const ready = usable.find((p) => (this.coolUntil.get(p.name) ?? 0) <= now);
    if (ready) return ready;
    const soonest = usable.reduce((a, b) => ((this.coolUntil.get(a.name) ?? 0) <= (this.coolUntil.get(b.name) ?? 0) ? a : b));
    await this.clock.sleep((this.coolUntil.get(soonest.name) ?? now) - now);
    return soonest;
  }

  /** Calls per provider per method, for the run record. */
  callCounts(): Record<string, Record<string, number>> {
    return Object.fromEntries(this.providers.map((p) => [p.name, { ...p.calls }]));
  }
}
