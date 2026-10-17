import { setImmediate as nextTurn } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { runEvery } from "../src/ticker.ts";

describe("runEvery", () => {
  it("never overlaps runs, keeps going after a failure, and reports it", async () => {
    const stop = new AbortController();
    const errors: unknown[] = [];
    let active = 0;
    let maxActive = 0;
    let runs = 0;
    const loop = runEvery(
      1,
      stop.signal,
      async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await nextTurn();
        active--;
        if (++runs === 2) throw new Error("boom");
        if (runs === 5) stop.abort();
      },
      (err) => void errors.push(err),
    );
    await loop;
    expect(runs).toBe(5);
    expect(maxActive).toBe(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("boom");
  });

  it("resolves only after the run in progress finished when aborted mid-run", async () => {
    const stop = new AbortController();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let finished = false;
    const loop = runEvery(
      60_000,
      stop.signal,
      async () => {
        started.resolve();
        await release.promise;
        finished = true;
      },
      () => {},
    );
    await started.promise;
    stop.abort();
    const settled = Promise.race([loop.then(() => "done"), nextTurn().then(() => "pending")]);
    expect(await settled).toBe("pending");
    release.resolve();
    await loop;
    expect(finished).toBe(true);
  });

  it("does not start a run when already aborted", async () => {
    let ran = false;
    await runEvery(1, AbortSignal.abort(), async () => void (ran = true), () => {});
    expect(ran).toBe(false);
  });
});
