import { setTimeout as sleep } from "node:timers/promises";
import { AnalyticsReader, exportPublished } from "@rsi/analytics";
import { createDb } from "@rsi/db";
import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";

const config = loadConfig();
const database = createDb(config.databaseUrl);
const analytics = new AnalyticsReader({ dir: config.analyticsDir });
const app = await buildApp({
  database,
  analytics,
  chainId: config.chainId,
  corsOrigin: config.corsOrigin,
  logger: { level: config.logLevel },
  retentionDays: { landing: config.landingRetentionDays, decoded: config.decodedRetentionDays },
});

const shutdown = new AbortController();

// A sequential loop is single-flight by construction: the next export starts only after the
// previous one finished and the interval elapsed, so slow exports never overlap.
async function exportLoop(intervalMs: number): Promise<void> {
  while (!shutdown.signal.aborted) {
    try {
      const summary = await exportPublished(database, { chainId: config.chainId, dir: config.analyticsDir });
      app.log.info({ summary }, "analytics export finished");
    } catch (err) {
      app.log.error({ err }, "analytics export failed");
    }
    try {
      await sleep(intervalMs, undefined, { signal: shutdown.signal });
    } catch {
      return; // aborted by shutdown
    }
  }
}

const exporting = config.analyticsExportIntervalMs ? exportLoop(config.analyticsExportIntervalMs) : Promise.resolve();

async function stop(): Promise<void> {
  shutdown.abort();
  await exporting;
  await app.close();
  await analytics.close();
  await database.sql.end({ timeout: 5 });
  process.exit(0);
}
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

await app.listen({ port: config.port, host: config.host });
