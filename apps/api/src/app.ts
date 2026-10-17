import cors from "@fastify/cors";
import { UnknownPoolError } from "@rsi/analytics";
import type { Database } from "@rsi/db";
import {
  AnalyticsMeta,
  BackfillJobsQuery,
  DailyVolumeQuery,
  PageQuery,
  PoolOhlcQuery,
  RangeParams,
  RangesQuery,
  ReconciliationsQuery,
  SwapsQuery,
  TransfersQuery,
  type ApiError,
  type DailyVolumeRow,
  type PoolOhlcRow,
} from "@rsi/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { listSwaps, listTransfers } from "./events.ts";
import { HttpError, parseInput } from "./http.ts";
import { getRangeDetail, listBackfillJobs, listRanges, listReconciliations, listReorgs } from "./ops.ts";
import { buildStatus } from "./status.ts";

/** What the API needs from `@rsi/analytics`' AnalyticsReader; a structural type so tests can fake it. */
export interface AnalyticsSource {
  dailyVolume(query: { token: string; from?: string; to?: string }): Promise<DailyVolumeRow[]>;
  poolOhlc(query: { pool: string; interval: "1h" | "1d"; from?: string; to?: string }): Promise<PoolOhlcRow[]>;
  meta(): Promise<AnalyticsMeta>;
}

export interface AppInput {
  database: Database;
  analytics: AnalyticsSource;
  chainId: number;
  /** Value of Access-Control-Allow-Origin; the API is read-only and carries no credentials. */
  corsOrigin?: string;
  /** Pino-compatible logger options for Fastify; off by default so tests stay quiet. */
  logger?: boolean | { level: string };
  now?: () => number;
}

const errorBody = (code: string, message: string): ApiError => ({ error: { code, message } });

export async function buildApp(input: AppInput): Promise<FastifyInstance> {
  const { database, analytics, chainId } = input;
  const now = input.now ?? Date.now;
  const app = Fastify({ logger: input.logger ?? false });
  await app.register(cors, { origin: input.corsOrigin ?? "*", methods: ["GET", "HEAD", "OPTIONS"] });

  app.setNotFoundHandler((_req, reply) => reply.code(404).send(errorBody("not_found", "no such endpoint")));
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send(errorBody(err.code, err.message));
    if (err instanceof UnknownPoolError) return reply.code(404).send(errorBody("unknown_pool", `pool ${err.pool} is not configured for analytics`));
    if (err instanceof ZodError) return reply.code(400).send(errorBody("bad_request", err.message));
    req.log.error({ err }, "request failed");
    return reply.code(500).send(errorBody("internal_error", "internal error"));
  });

  app.get("/healthz", async (_req, reply) => {
    try {
      await database.sql`select 1`;
    } catch (err) {
      app.log.error({ err }, "healthz: database unreachable");
      return reply.code(503).send(errorBody("unavailable", "database unreachable"));
    }
    return { ok: true };
  });

  app.get("/v1/status", async () => buildStatus(database, chainId, now()));

  app.get("/v1/reorgs", async (req) => listReorgs(database, chainId, parseInput(PageQuery, req.query)));

  app.get("/v1/ranges", async (req) => listRanges(database, chainId, parseInput(RangesQuery, req.query)));

  app.get("/v1/ranges/:fromBlock", async (req) => {
    const { fromBlock } = parseInput(RangeParams, req.params);
    const detail = await getRangeDetail(database, chainId, fromBlock);
    if (!detail) throw new HttpError(404, "not_found", `no range starts at block ${fromBlock}`);
    return detail;
  });

  app.get("/v1/backfill-jobs", async (req) => listBackfillJobs(database, chainId, parseInput(BackfillJobsQuery, req.query)));

  app.get("/v1/reconciliations", async (req) => listReconciliations(database, chainId, parseInput(ReconciliationsQuery, req.query)));

  app.get("/v1/transfers", async (req) => listTransfers(database, chainId, parseInput(TransfersQuery, req.query)));

  app.get("/v1/swaps", async (req) => listSwaps(database, chainId, parseInput(SwapsQuery, req.query)));

  app.get("/v1/analytics/daily-volume", async (req) => analytics.dailyVolume(parseInput(DailyVolumeQuery, req.query)));

  app.get("/v1/analytics/pool-ohlc", async (req) => analytics.poolOhlc(parseInput(PoolOhlcQuery, req.query)));

  app.get("/v1/analytics/meta", async () => analytics.meta());

  return app;
}
