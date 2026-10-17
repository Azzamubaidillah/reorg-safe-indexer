import { describe, expect, it } from "vitest";
import { Metrics } from "../src/metrics.ts";
import { RpcError } from "../src/rpc/errors.ts";

/** Value of the series whose line starts with `series` (name plus labels), or undefined when absent. */
function sample(text: string, series: string): number | undefined {
  const line = text.split("\n").find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

describe("Metrics", () => {
  it("exposes positions and derived lags after pipeline events", async () => {
    const m = new Metrics();
    m.onHead(1_000);
    m.onFinalized(940);
    m.onRangeCommitted({ toBlock: 995, logCount: 7 });
    m.onPublished(900);
    const text = await m.render();

    expect(sample(text, "indexer_head_block")).toBe(1_000);
    expect(sample(text, "indexer_finalized_block")).toBe(940);
    expect(sample(text, "indexer_stored_tip_block")).toBe(995);
    expect(sample(text, "indexer_head_lag_blocks")).toBe(5);
    expect(sample(text, "indexer_finalized_lag_blocks")).toBe(40);
    expect(text).toContain("process_cpu_user_seconds_total");
  });

  it("clamps lag at zero when the stored tip passes a stale head", async () => {
    const m = new Metrics();
    m.onRangeCommitted({ toBlock: 1_010, logCount: 0 });
    m.onHead(1_005);
    expect(sample(await m.render(), "indexer_head_lag_blocks")).toBe(0);
  });

  it("reports positions it has not seen as null in the snapshot", () => {
    const m = new Metrics();
    m.onHead(10);
    expect(m.snapshot()).toEqual({ headBlock: 10, finalizedBlock: null, storedTip: null, lastPublishedBlock: null });
  });

  it("counts commits, logs, retries, gate failures, mismatches and reorgs by label", async () => {
    const m = new Metrics();
    m.onRangeCommitted({ toBlock: 99, logCount: 3 });
    m.onRangeCommitted({ toBlock: 199, logCount: 4 });
    m.onRetry(new RpcError("rate_limited", "slow down", "alchemy"));
    m.onRetry(new RpcError("rate_limited", "slow down", "alchemy"));
    m.onRetry(new RpcError("transient", "boom", "infura"));
    m.onGateFailure("row_counts");
    m.onGateFailure("row_counts");
    m.onGateFailure("no_duplicates");
    m.onReconciliation({ mismatches: 0 });
    m.onReconciliation({ mismatches: 2 });
    m.onReorg({ action: "rolled_back", depth: 3, ancestorBlock: 150 });
    m.onReorg({ action: "halted", depth: 70, ancestorBlock: null });
    const text = await m.render();

    expect(sample(text, "indexer_ranges_committed_total")).toBe(2);
    expect(sample(text, "indexer_logs_committed_total")).toBe(7);
    expect(sample(text, 'indexer_rpc_retries_total{provider="alchemy",kind="rate_limited"}')).toBe(2);
    expect(sample(text, 'indexer_rpc_retries_total{provider="infura",kind="transient"}')).toBe(1);
    expect(sample(text, 'indexer_quality_gate_failures_total{gate="row_counts"}')).toBe(2);
    expect(sample(text, 'indexer_quality_gate_failures_total{gate="no_duplicates"}')).toBe(1);
    expect(sample(text, "indexer_reconciliation_mismatches_total")).toBe(2);
    expect(sample(text, 'indexer_reorgs_total{action="rolled_back"}')).toBe(1);
    expect(sample(text, 'indexer_reorgs_total{action="halted"}')).toBe(1);
    // Cumulative buckets: depth 3 falls in le=3 and above, depth 70 only in +Inf.
    expect(sample(text, 'indexer_reorg_depth_bucket{le="2"}')).toBe(0);
    expect(sample(text, 'indexer_reorg_depth_bucket{le="3"}')).toBe(1);
    expect(sample(text, 'indexer_reorg_depth_bucket{le="64"}')).toBe(1);
    expect(sample(text, 'indexer_reorg_depth_bucket{le="+Inf"}')).toBe(2);
    expect(sample(text, "indexer_reorg_depth_count")).toBe(2);
    // A rollback moves the stored tip back to the ancestor; a halt leaves it alone.
    expect(sample(text, "indexer_stored_tip_block")).toBe(150);
  });

  it("feeds rpc call counters from cumulative pool counts as deltas, surviving a pool restart", async () => {
    const m = new Metrics();
    let counts: Record<string, Record<string, number>> = { alchemy: { eth_getLogs: 4, eth_blockNumber: 1 } };
    m.trackRpcCalls(() => counts);

    const series = 'indexer_rpc_calls_total{provider="alchemy",method="eth_getLogs"}';
    expect(sample(await m.render(), series)).toBe(4);
    // Scraping twice without new traffic must not double count.
    expect(sample(await m.render(), series)).toBe(4);
    counts = { alchemy: { eth_getLogs: 10, eth_blockNumber: 1 }, infura: { eth_getLogs: 2 } };
    let text = await m.render();
    expect(sample(text, series)).toBe(10);
    expect(sample(text, 'indexer_rpc_calls_total{provider="alchemy",method="eth_blockNumber"}')).toBe(1);
    expect(sample(text, 'indexer_rpc_calls_total{provider="infura",method="eth_getLogs"}')).toBe(2);

    // New pool (after a run restart in the same process) counts from zero again.
    counts = { alchemy: { eth_getLogs: 3, eth_blockNumber: 1 } };
    expect(sample(await m.render(), series)).toBe(10);
    counts = { alchemy: { eth_getLogs: 5, eth_blockNumber: 1 } };
    text = await m.render();
    expect(sample(text, series)).toBe(12);
  });

  it("measures idle time from the last head poll or commit, starting at construction", () => {
    let now = 1_000_000;
    const m = new Metrics({ now: () => now });
    now += 30_000;
    expect(m.idleMs()).toBe(30_000);
    m.onHead(1);
    now += 10_000;
    expect(m.idleMs()).toBe(10_000);
    m.onRangeCommitted({ toBlock: 1, logCount: 0 });
    now += 5_000;
    expect(m.idleMs()).toBe(5_000);
    // Other events are not liveness evidence.
    m.onFinalized(1);
    m.onPublished(1);
    m.onGateFailure("x");
    expect(m.idleMs()).toBe(5_000);
  });

  it("keeps registries independent between instances", async () => {
    const a = new Metrics();
    const b = new Metrics();
    a.onRangeCommitted({ toBlock: 1, logCount: 1 });
    expect(sample(await b.render(), "indexer_ranges_committed_total")).toBe(0);
  });
});
