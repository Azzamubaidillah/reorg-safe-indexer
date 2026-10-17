import type { Sql } from "@rsi/db";
import type { Kind } from "./layout.ts";

/** The transaction handle `sql.begin` passes to its callback (not assignable to `Sql`). */
export type Tx = Parameters<Parameters<Sql["begin"]>[1]>[0];

/** The slice of the chain one day partition is built from. */
export interface DayWindow {
  /** Block span of the day among exported ranges: lets Postgres seek instead of scanning every published row. */
  minBlock: number;
  maxBlock: number;
  /** Half-open UTC bounds `[start, end)`. Bound as ISO text: postgres.js cannot serialise a Date in a raw parameterised query. */
  start: Date;
  end: Date;
}

const TABLES: Record<Kind, string> = { transfers: "erc20_transfers", swaps: "uniswap_v3_swaps" };

/**
 * The single definition of "a row that belongs in the analytics store": decoded rows inside a `published`
 * range (fail-closed, exactly like the API), joined to their block for the timestamp, restricted to one UTC
 * day. The export and the verifier both embed this fragment so they cannot drift apart. Aliases: `t` row,
 * `b` block, `r` range. Ranges never overlap, so the join cannot duplicate rows.
 */
export function publishedInDay(sql: Tx, chainId: number, kind: Kind, window: DayWindow) {
  return sql`
    from ops.ranges r
    join chain.${sql(TABLES[kind])} t on t.chain_id = r.chain_id and t.block_number between r.from_block and r.to_block
    join chain.blocks b on b.chain_id = t.chain_id and b.hash = t.block_hash
    where r.chain_id = ${chainId} and r.status = 'published'
      and r.to_block >= ${window.minBlock} and r.from_block <= ${window.maxBlock}
      and b.timestamp >= ${window.start.toISOString()}::timestamptz and b.timestamp < ${window.end.toISOString()}::timestamptz`;
}

/**
 * Number of decoded rows of `kind` in published ranges, over all time. Independent of day windows and manifests.
 * Rows inside `excluded` (inclusive block intervals) are left out: the spans of days whose rows were purged.
 */
export async function countPublished(sql: Tx, chainId: number, kind: Kind, excluded: readonly (readonly [number, number])[] = []): Promise<number> {
  const [row] = await sql<{ n: string }[]>`
    select count(*)::text as n
    from ops.ranges r
    join chain.${sql(TABLES[kind])} t on t.chain_id = r.chain_id and t.block_number between r.from_block and r.to_block
    where r.chain_id = ${chainId} and r.status = 'published'
      and not exists (
        select 1 from unnest(${sql.array(excluded.map(([from]) => from))}::bigint[], ${sql.array(excluded.map(([, to]) => to))}::bigint[]) as x(lo, hi)
        where t.block_number between x.lo and x.hi)`;
  return Number(row?.n ?? 0);
}
