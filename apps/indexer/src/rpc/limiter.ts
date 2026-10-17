import { setTimeout as sleep } from "node:timers/promises";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => sleep(ms),
};

/**
 * Token bucket: `rate` tokens per second, holding at most `burst`. `take(n)`
 * resolves once n tokens are available. Waiters are served in call order, so a
 * large batch cannot be starved by single calls.
 */
export class TokenBucket {
  private tokens: number;
  private updatedAt: number;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly rate: number,
    private readonly burst: number,
    private readonly clock: Clock = realClock,
  ) {
    if (rate <= 0 || burst <= 0) throw new Error("rate and burst must be positive");
    this.tokens = burst;
    this.updatedAt = clock.now();
  }

  take(n = 1): Promise<void> {
    if (n > this.burst) throw new Error(`cannot take ${n} tokens from a bucket of ${this.burst}`);
    const turn = this.queue.then(() => this.acquire(n));
    this.queue = turn;
    return turn;
  }

  private async acquire(n: number): Promise<void> {
    for (;;) {
      const now = this.clock.now();
      this.tokens = Math.min(this.burst, this.tokens + ((now - this.updatedAt) / 1000) * this.rate);
      this.updatedAt = now;
      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      await this.clock.sleep(Math.ceil(((n - this.tokens) / this.rate) * 1000));
    }
  }
}
