import type { Clock } from "../../src/rpc/limiter.ts";

/** Clock whose sleep advances time instantly and records each requested sleep. */
export class FakeClock implements Clock {
  t = 0;
  readonly sleeps: number[] = [];
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.t += ms;
  }
}
