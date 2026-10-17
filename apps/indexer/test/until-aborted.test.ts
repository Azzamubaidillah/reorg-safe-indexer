import { getEventListeners } from "node:events";
import { setImmediate as nextTurn } from "node:timers/promises";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { untilAborted } from "../src/pipeline.ts";

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

async function collected(ref: WeakRef<object>): Promise<boolean> {
  for (let i = 0; i < 10 && ref.deref() !== undefined; i++) {
    await nextTurn();
    gc();
  }
  return ref.deref() === undefined;
}

describe("untilAborted", () => {
  it("returns the value and leaves no abort listener behind", async () => {
    const controller = new AbortController();
    for (let i = 0; i < 100; i++) expect(await untilAborted(Promise.resolve(i), controller.signal)).toBe(i);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("does not keep settled values reachable through a long-lived signal", async () => {
    // Regression: racing each await against one shared pending promise retained every fetched
    // range (~9 MB per 100-block range), so long runs died with a heap OOM.
    const controller = new AbortController();
    // The payload lives only in this helper's frame, so after it returns the only possible path to
    // it is through promise reactions hanging off the signal.
    const awaitPayload = async () => {
      const payload = { logs: new Array(10_000).fill("0x") };
      await untilAborted(Promise.resolve(payload), controller.signal);
      return new WeakRef(payload);
    };
    expect(await collected(await awaitPayload())).toBe(true);
  });

  it("resolves 'aborted' when the signal fires first, and immediately if already aborted", async () => {
    const controller = new AbortController();
    const pending = untilAborted(Promise.withResolvers<never>().promise, controller.signal);
    controller.abort();
    expect(await pending).toBe("aborted");
    expect(await untilAborted(Promise.resolve(1), controller.signal)).toBe("aborted");
  });
});
