import { createDb } from "@rsi/db";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { exportPublished } from "./export.ts";
import type { AnalyticsMetadata } from "./metadata.ts";
import { verifyAnalytics } from "./verify.ts";

const USAGE = `usage: cli.ts <export|verify> [--dir <path>] [--chain <id>] [--sample-days <n>] [--metadata <file.json>]
env: DATABASE_URL (required), CHAIN_ID (default 1), ANALYTICS_DIR (default ./analytics-data)`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    dir: { type: "string" },
    chain: { type: "string" },
    "sample-days": { type: "string", default: "5" },
    metadata: { type: "string" },
  },
});

async function main(): Promise<number> {
  const command = positionals[0];
  if (command !== "export" && command !== "verify") {
    console.error(USAGE);
    return 2;
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const chainId = Number(values.chain ?? process.env.CHAIN_ID ?? 1);
  const dir = values.dir ?? process.env.ANALYTICS_DIR ?? "./analytics-data";
  const metadata = values.metadata ? (JSON.parse(await readFile(values.metadata, "utf8")) as AnalyticsMetadata) : undefined;

  const database = createDb(databaseUrl, { max: 1 });
  try {
    if (command === "export") {
      const summary = await exportPublished(database, { chainId, dir });
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
      return 0;
    }
    const report = await verifyAnalytics(database, { chainId, dir, sampleDays: Number(values["sample-days"]), metadata });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.ok ? 0 : 1;
  } finally {
    await database.sql.end({ timeout: 5 });
  }
}

// Exit explicitly: DuckDB's worker threads must not keep the process alive.
main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
