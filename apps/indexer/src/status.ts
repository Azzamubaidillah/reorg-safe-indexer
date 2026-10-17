import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database } from "@rsi/db";
import { lagReport, type LagStats } from "./lag.ts";
import type { Metrics } from "./metrics.ts";

export interface StatusServerInput {
  chainId: number;
  port: number;
  /** Bind address; loopback by default because /status exposes internals. */
  host?: string;
  /** /healthz fails when no head poll or range commit happened for this long. */
  staleAfterMs?: number;
}

export interface StatusServer {
  /** The bound port (differs from the requested one when that was 0). */
  port: number;
  close(): Promise<void>;
}

export interface RangeStatusCounts {
  ranges: number;
  blocks: number;
  logs: number;
}

export interface StatusReport {
  chainId: number;
  generatedAt: string;
  head: number | null;
  finalized: number | null;
  storedTip: number | null;
  lastPublishedBlock: number | null;
  /** head - stored tip, clamped at 0; null while either is unknown. */
  headLag: number | null;
  /** finalized - last published range end, clamped at 0; null while either is unknown. */
  finalizedLag: number | null;
  ranges: Record<"candidate" | "published" | "failed", RangeStatusCounts>;
  backfillJobs: {
    open: number;
    /** Oldest first, capped at 20. */
    jobs: { id: string; fromBlock: number; toBlock: number; status: string; attempts: number; failureReason: string }[];
  };
  recentReorgs: {
    id: number;
    detectedAt: string;
    action: string;
    forkBlock: number;
    ancestorBlock: number | null;
    depth: number;
    finalizedBlock: number;
  }[];
  reconciliation: { match: number; mismatch: number; unexplained: number };
  lagLastHour: { samples: number; headLagP95: number | null; finalizedLagP95: number | null; headLag: LagStats; finalizedLag: LagStats };
}

export interface HealthReport {
  ok: boolean;
  idleMs: number;
  staleAfterMs: number;
  reason?: string;
}

const DEFAULT_STALE_AFTER_MS = 60_000;
const OPEN_JOB_LIMIT = 20;
const HOUR_MS = 3600 * 1000;

const lagToNumber = (head: number | null, base: number | null): number | null => (head !== null && base !== null ? Math.max(0, head - base) : null);

export async function buildStatus(database: Database, metrics: Metrics, chainId: number): Promise<StatusReport> {
  const { sql } = database;
  const now = metrics.now();
  const [positions, rangeRows, jobRows, reorgRows, reconRows, lag] = await Promise.all([
    sql<{ stored_tip: number | null; published_to: number | null }[]>`
      select
        (select max(number) from chain.blocks where chain_id = ${chainId})::float8 as stored_tip,
        (select max(to_block) from ops.ranges where chain_id = ${chainId} and status = 'published')::float8 as published_to`,
    sql<{ status: keyof StatusReport["ranges"]; ranges: number; blocks: number; logs: number }[]>`
      select status, count(*)::int as ranges, sum(block_count)::float8 as blocks, sum(log_count)::float8 as logs
      from ops.ranges where chain_id = ${chainId} group by status`,
    sql<{ id: string; from_block: number; to_block: number; status: string; attempts: number; failure_reason: string; total: number }[]>`
      select id, from_block::float8, to_block::float8, status, attempts, failure_reason, (count(*) over ())::int as total
      from ops.backfill_jobs where chain_id = ${chainId} and status <> 'resolved'
      order by created_at, id limit ${OPEN_JOB_LIMIT}`,
    sql<{ id: number; detected_at: string; action: string; fork_block: number; ancestor_block: number | null; depth: number; finalized_block: number }[]>`
      select id::float8, to_char(detected_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as detected_at, action, fork_block::float8, ancestor_block::float8, depth, finalized_block::float8
      from ops.reorgs where chain_id = ${chainId} order by detected_at desc, id desc limit 5`,
    sql<{ match: number; mismatch: number; unexplained: number }[]>`
      select
        (count(*) filter (where status = 'match'))::int as match,
        (count(*) filter (where status = 'mismatch'))::int as mismatch,
        (count(*) filter (where status = 'mismatch' and (explanation is null or explanation = '')))::int as unexplained
      from ops.reconciliations where chain_id = ${chainId}`,
    lagReport(database, { chainId, since: new Date(now - HOUR_MS) }),
  ]);

  const { headBlock, finalizedBlock } = metrics.snapshot();
  const storedTip = positions[0]?.stored_tip ?? null;
  const lastPublishedBlock = positions[0]?.published_to ?? null;
  const ranges: StatusReport["ranges"] = {
    candidate: { ranges: 0, blocks: 0, logs: 0 },
    published: { ranges: 0, blocks: 0, logs: 0 },
    failed: { ranges: 0, blocks: 0, logs: 0 },
  };
  for (const r of rangeRows) ranges[r.status] = { ranges: r.ranges, blocks: r.blocks, logs: r.logs };

  return {
    chainId,
    generatedAt: new Date(now).toISOString(),
    head: headBlock,
    finalized: finalizedBlock,
    storedTip,
    lastPublishedBlock,
    headLag: lagToNumber(headBlock, storedTip),
    finalizedLag: lagToNumber(finalizedBlock, lastPublishedBlock),
    ranges,
    backfillJobs: {
      open: jobRows[0]?.total ?? 0,
      jobs: jobRows.map((j) => ({
        id: j.id,
        fromBlock: j.from_block,
        toBlock: j.to_block,
        status: j.status,
        attempts: j.attempts,
        failureReason: j.failure_reason,
      })),
    },
    recentReorgs: reorgRows.map((r) => ({
      id: r.id,
      detectedAt: r.detected_at,
      action: r.action,
      forkBlock: r.fork_block,
      ancestorBlock: r.ancestor_block,
      depth: r.depth,
      finalizedBlock: r.finalized_block,
    })),
    reconciliation: reconRows[0] ?? { match: 0, mismatch: 0, unexplained: 0 },
    lagLastHour: { samples: lag.samples, headLagP95: lag.headLag.p95, finalizedLagP95: lag.finalizedLag.p95, headLag: lag.headLag, finalizedLag: lag.finalizedLag },
  };
}

export function healthReport(metrics: Metrics, staleAfterMs: number): HealthReport {
  const idleMs = metrics.idleMs();
  if (idleMs <= staleAfterMs) return { ok: true, idleMs, staleAfterMs };
  return {
    ok: false,
    idleMs,
    staleAfterMs,
    reason: `no head poll or range commit for ${Math.round(idleMs / 1000)}s (limit ${Math.round(staleAfterMs / 1000)}s)`,
  };
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  res.end(body);
}

const sendJson = (res: ServerResponse, status: number, body: unknown) => send(res, status, "application/json", JSON.stringify(body));

/** Read-only HTTP endpoints: /metrics (Prometheus), /healthz (liveness of ingest), /status (JSON). */
export async function startStatusServer(database: Database, metrics: Metrics, input: StatusServerInput): Promise<StatusServer> {
  const staleAfterMs = input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  const server: Server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method !== "GET") return sendJson(res, 405, { error: "method not allowed" });
        const path = new URL(req.url ?? "/", "http://localhost").pathname;
        if (path === "/metrics") return send(res, 200, metrics.registry.contentType, await metrics.render());
        if (path === "/healthz") {
          const health = healthReport(metrics, staleAfterMs);
          return sendJson(res, health.ok ? 200 : 503, health);
        }
        if (path === "/status") return sendJson(res, 200, await buildStatus(database, metrics, input.chainId));
        return sendJson(res, 404, { error: "not found" });
      } catch (err) {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    })();
  });

  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(input.port, input.host ?? "127.0.0.1", () => listening.resolve());
  await listening.promise;
  server.removeListener("error", listening.reject);

  return {
    port: (server.address() as AddressInfo).port,
    async close() {
      const closed = Promise.withResolvers<void>();
      server.close((err) => (err ? closed.reject(err) : closed.resolve()));
      server.closeAllConnections();
      await closed.promise;
    },
  };
}
