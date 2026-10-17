import { setTimeout as sleep } from "node:timers/promises";

/**
 * Runs `task` now and then every `intervalMs` after the previous run finished, so runs never
 * overlap. A failing run is passed to `onError` (awaited) and retried on the next tick. Resolves
 * once the signal has aborted and the run in progress (if any) has finished.
 */
export async function runEvery(intervalMs: number, signal: AbortSignal, task: () => Promise<void>, onError: (err: unknown) => void | Promise<void>): Promise<void> {
  while (!signal.aborted) {
    try {
      await task();
    } catch (err) {
      await onError(err);
    }
    await sleep(intervalMs, undefined, { signal }).catch(() => {});
  }
}
