import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from "prom-client";
import type { RpcError } from "./rpc/errors.ts";

export interface MetricsOptions {
  /** Epoch-milliseconds clock; injectable so staleness can be tested without sleeping. */
  now?: () => number;
}

/** Latest positions the indexer has reported; null until the first event. */
export interface MetricsSnapshot {
  headBlock: number | null;
  finalizedBlock: number | null;
  storedTip: number | null;
  lastPublishedBlock: number | null;
}

export interface RangeCommittedEvent {
  toBlock: number;
  logCount: number;
}

export interface ReorgEvent {
  action: "rolled_back" | "halted";
  depth: number;
  /** Stored tip after a rollback; null when nothing was rolled back. */
  ancestorBlock: number | null;
}

type RpcCallCounts = Record<string, Record<string, number>>;

/**
 * One Prometheus registry per indexer process. Methods are named after the pipeline event that
 * calls them; lag gauges are derived from the positions the events report, so callers never
 * compute lag themselves.
 */
export class Metrics {
  readonly registry = new Registry();
  readonly now: () => number;

  private readonly head: Gauge;
  private readonly finalized: Gauge;
  private readonly storedTip: Gauge;
  private readonly headLag: Gauge;
  private readonly finalizedLag: Gauge;
  private readonly reorgs: Counter<"action">;
  private readonly reorgDepth: Histogram;
  private readonly rangesCommitted: Counter;
  private readonly logsCommitted: Counter;
  private readonly gateFailures: Counter<"gate">;
  private readonly reconciliationMismatches: Counter;
  private readonly rpcCalls: Counter<"provider" | "method">;
  private readonly rpcRetries: Counter<"provider" | "kind">;

  private position: MetricsSnapshot = { headBlock: null, finalizedBlock: null, storedTip: null, lastPublishedBlock: null };
  private lastHeadPollAt: number;
  private lastCommitAt: number;
  private rpcSource: (() => RpcCallCounts) | undefined;
  // Last cumulative value read per `provider\0method`, so each scrape adds only the delta.
  private readonly rpcSeen = new Map<string, number>();

  constructor(options: MetricsOptions = {}) {
    this.now = options.now ?? Date.now;
    // Starting counts as activity: a fresh process gets one staleness window before /healthz can fail.
    this.lastHeadPollAt = this.now();
    this.lastCommitAt = this.lastHeadPollAt;

    const registers = [this.registry];
    collectDefaultMetrics({ register: this.registry });
    this.head = new Gauge({ name: "indexer_head_block", help: "Latest block number reported by the provider", registers });
    this.finalized = new Gauge({ name: "indexer_finalized_block", help: "Finalized block number reported by the provider", registers });
    this.storedTip = new Gauge({ name: "indexer_stored_tip_block", help: "Highest block stored in chain.blocks", registers });
    this.headLag = new Gauge({ name: "indexer_head_lag_blocks", help: "Head block minus stored tip", registers });
    this.finalizedLag = new Gauge({ name: "indexer_finalized_lag_blocks", help: "Finalized block minus last published range end", registers });
    this.reorgs = new Counter({ name: "indexer_reorgs_total", help: "Reorgs detected", labelNames: ["action"], registers });
    this.reorgDepth = new Histogram({
      name: "indexer_reorg_depth",
      help: "Heights inspected per detected reorg",
      buckets: [1, 2, 3, 4, 6, 8, 12, 16, 32, 64],
      registers,
    });
    this.rangesCommitted = new Counter({ name: "indexer_ranges_committed_total", help: "Block ranges committed", registers });
    this.logsCommitted = new Counter({ name: "indexer_logs_committed_total", help: "Logs committed", registers });
    this.gateFailures = new Counter({
      name: "indexer_quality_gate_failures_total",
      help: "Data-quality gate failures",
      labelNames: ["gate"],
      registers,
    });
    this.reconciliationMismatches = new Counter({
      name: "indexer_reconciliation_mismatches_total",
      help: "Second-source reconciliation mismatches",
      registers,
    });
    this.rpcCalls = new Counter({
      name: "indexer_rpc_calls_total",
      help: "JSON-RPC calls",
      labelNames: ["provider", "method"],
      registers,
    });
    this.rpcRetries = new Counter({
      name: "indexer_rpc_retries_total",
      help: "RPC pool retries",
      labelNames: ["provider", "kind"],
      registers,
    });
  }

  /** A new `latest` block number was read from a provider. */
  onHead(headBlock: number): void {
    this.position.headBlock = headBlock;
    this.lastHeadPollAt = this.now();
    this.head.set(headBlock);
    this.updateHeadLag();
  }

  onFinalized(finalizedBlock: number): void {
    this.position.finalizedBlock = finalizedBlock;
    this.finalized.set(finalizedBlock);
    this.updateFinalizedLag();
  }

  onRangeCommitted(event: RangeCommittedEvent): void {
    this.lastCommitAt = this.now();
    this.rangesCommitted.inc();
    this.logsCommitted.inc(event.logCount);
    this.setStoredTip(event.toBlock);
  }

  /** Seeds the stored tip at startup, before any range commits (resume point - 1). */
  onStoredTip(storedTip: number): void {
    this.setStoredTip(storedTip);
  }

  onReorg(event: ReorgEvent): void {
    this.reorgs.inc({ action: event.action });
    this.reorgDepth.observe(event.depth);
    if (event.action === "rolled_back" && event.ancestorBlock !== null) this.setStoredTip(event.ancestorBlock);
  }

  /** Highest `to_block` among published ranges, after a quality cycle. */
  onPublished(lastPublishedBlock: number): void {
    this.position.lastPublishedBlock = lastPublishedBlock;
    this.updateFinalizedLag();
  }

  onRetry(error: RpcError): void {
    this.rpcRetries.inc({ provider: error.provider, kind: error.kind });
  }

  onGateFailure(gate: string): void {
    this.gateFailures.inc({ gate });
  }

  onReconciliation(result: { mismatches: number }): void {
    if (result.mismatches > 0) this.reconciliationMismatches.inc(result.mismatches);
  }

  /** Feed `indexer_rpc_calls_total` from the pool's cumulative counts; read at every scrape. */
  trackRpcCalls(source: () => RpcCallCounts): void {
    this.rpcSource = source;
  }

  snapshot(): MetricsSnapshot {
    return { ...this.position };
  }

  /** Milliseconds since the last head poll or range commit (or process start). */
  idleMs(): number {
    return this.now() - Math.max(this.lastHeadPollAt, this.lastCommitAt);
  }

  /** Prometheus text exposition. */
  async render(): Promise<string> {
    this.syncRpcCalls();
    return this.registry.metrics();
  }

  private syncRpcCalls(): void {
    if (!this.rpcSource) return;
    for (const [provider, methods] of Object.entries(this.rpcSource())) {
      for (const [method, total] of Object.entries(methods)) {
        const key = `${provider}\0${method}`;
        const delta = total - (this.rpcSeen.get(key) ?? 0);
        this.rpcSeen.set(key, total);
        // A new pool restarts its counts from zero; a negative delta is a reset, not negative traffic.
        if (delta > 0) this.rpcCalls.inc({ provider, method }, delta);
      }
    }
  }

  private setStoredTip(storedTip: number): void {
    this.position.storedTip = storedTip;
    this.storedTip.set(storedTip);
    this.updateHeadLag();
  }

  // Lags are clamped at zero: the stored tip can briefly pass a provider's stale head.
  private updateHeadLag(): void {
    const { headBlock, storedTip } = this.position;
    if (headBlock !== null && storedTip !== null) this.headLag.set(Math.max(0, headBlock - storedTip));
  }

  private updateFinalizedLag(): void {
    const { finalizedBlock, lastPublishedBlock } = this.position;
    if (finalizedBlock !== null && lastPublishedBlock !== null) this.finalizedLag.set(Math.max(0, finalizedBlock - lastPublishedBlock));
  }
}
