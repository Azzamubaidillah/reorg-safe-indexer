import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createDb, type Database } from "@rsi/db";

export const TEST_DATABASE_URL = process.env.DATABASE_URL ?? "postgres://postgres@127.0.0.1:54329/indexer_test";

const dbPackage = fileURLToPath(new URL("../../../../packages/db/", import.meta.url));

interface Migrator {
  migrate(db: Database["db"], config: { migrationsFolder: string }): Promise<void>;
}

// drizzle-orm is a dependency of @rsi/db only; resolve the migrator from there.
async function loadMigrator(): Promise<Migrator> {
  const resolved = createRequire(`${dbPackage}package.json`).resolve("drizzle-orm/postgres-js/migrator");
  return (await import(pathToFileURL(resolved).href)) as Migrator;
}

/** Drop every schema the indexer owns and rebuild it from the committed migrations. */
export async function resetDatabase(url = TEST_DATABASE_URL): Promise<void> {
  const { sql, db } = createDb(url, { max: 1 });
  try {
    await sql`drop schema if exists chain, ops, drizzle cascade`;
    const { migrate } = await loadMigrator();
    await migrate(db, { migrationsFolder: `${dbPackage}migrations` });
  } finally {
    await sql.end();
  }
}

/** Order-independent fingerprint of each table's full contents, to prove a call wrote nothing. */
export async function tableFingerprints(database: Database): Promise<Record<string, string>> {
  const tables = ["chain.blocks", "chain.logs", "chain.erc20_transfers", "chain.uniswap_v3_swaps", "ops.runs", "ops.ranges"];
  const out: Record<string, string> = {};
  for (const table of tables) {
    const [row] = await database.sql<{ digest: string }[]>`
      select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as digest from ${database.sql(table)} t`;
    out[table] = row?.digest ?? "";
  }
  return out;
}
