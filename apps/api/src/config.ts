import { z } from "zod";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  CHAIN_ID: z.coerce.number().int().positive().default(1),
  API_PORT: z.coerce.number().int().min(0).max(65535).default(3200),
  /** Loopback by default; put a reverse proxy in front for anything public. */
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_CORS_ORIGIN: z.string().min(1).default("*"),
  ANALYTICS_DIR: z.string().min(1).default("data/analytics"),
  /** Unset: the API never exports; run the export out of band. */
  ANALYTICS_EXPORT_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  /** The indexer's `LANDING_RETENTION_DAYS` / `DECODED_RETENTION_DAYS`, so /v1/status can show them. Unset: reported as unknown (null). */
  LANDING_RETENTION_DAYS: z.coerce.number().positive().optional(),
  DECODED_RETENTION_DAYS: z.coerce.number().positive().optional(),
  LOG_LEVEL: z.string().default("info"),
});

export interface ApiConfig {
  databaseUrl: string;
  chainId: number;
  port: number;
  host: string;
  corsOrigin: string;
  analyticsDir: string;
  analyticsExportIntervalMs: number | undefined;
  landingRetentionDays: number | undefined;
  decodedRetentionDays: number | undefined;
  logLevel: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const e = envSchema.parse(env);
  return {
    databaseUrl: e.DATABASE_URL,
    chainId: e.CHAIN_ID,
    port: e.API_PORT,
    host: e.API_HOST,
    corsOrigin: e.API_CORS_ORIGIN,
    analyticsDir: e.ANALYTICS_DIR,
    analyticsExportIntervalMs: e.ANALYTICS_EXPORT_INTERVAL_MS,
    landingRetentionDays: e.LANDING_RETENTION_DAYS,
    decodedRetentionDays: e.DECODED_RETENTION_DAYS,
    logLevel: e.LOG_LEVEL,
  };
}
