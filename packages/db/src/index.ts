import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.ts";

export * from "./schema.ts";
export { schema };

export type Sql = postgres.Sql;
export type Db = PostgresJsDatabase<typeof schema>;

export interface Database {
  sql: Sql;
  db: Db;
}

export function createDb(url: string, options: { max?: number } = {}): Database {
  const sql = postgres(url, { max: options.max ?? 4, onnotice: () => {} });
  const db = drizzle(sql, { schema });
  return { sql, db };
}
