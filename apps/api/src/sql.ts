import type { Sql } from "@rsi/db";

/**
 * Drizzle configures the shared postgres-js client to return timestamps as session-zone text, so
 * the API formats them itself: ISO-8601 UTC with milliseconds, regardless of the server timezone.
 * Alias the result differently from the column when the query also orders by that column.
 */
export const iso = (sql: Sql, column: string) => sql`to_char(${sql(column)} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
