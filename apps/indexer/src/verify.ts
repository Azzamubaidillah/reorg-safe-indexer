import type { Database } from "@rsi/db";

export interface IntegrityProblem {
  check: string;
  count: number;
  sample: unknown[];
}

export interface IntegrityReport {
  ok: boolean;
  chainId: number;
  firstBlock: number | null;
  lastBlock: number | null;
  counts: { ranges: number; blocks: number; logs: number; transfers: number; swaps: number; rejects: number };
  problems: IntegrityProblem[];
}

const SAMPLE_SIZE = 5;

// Each check is a query body selecting the offending rows; $1 is the chain id.
const CHECKS: Record<string, string> = {
  range_gap: `
    select from_block, prev_to_block from (
      select from_block, lag(to_block) over (order by from_block) as prev_to_block from ops.ranges where chain_id = $1
    ) r where from_block > prev_to_block + 1`,
  range_overlap: `
    select from_block, prev_to_block from (
      select from_block, lag(to_block) over (order by from_block) as prev_to_block from ops.ranges where chain_id = $1
    ) r where from_block <= prev_to_block`,
  missing_block: `
    select g.n as block_number
    from (select min(number) lo, max(number) hi from chain.blocks where chain_id = $1) b,
         generate_series(b.lo, b.hi) g(n)
    left join chain.blocks k on k.chain_id = $1 and k.number = g.n
    where k.number is null`,
  broken_parent_link: `
    select b.number as block_number, b.parent_hash, p.hash as stored_parent_hash
    from chain.blocks b join chain.blocks p on p.chain_id = b.chain_id and p.number = b.number - 1
    where b.chain_id = $1 and p.hash <> b.parent_hash`,
  range_block_count: `
    select * from (
      select r.from_block, r.to_block, r.block_count, (
        select count(*) from chain.blocks b where b.chain_id = r.chain_id and b.number between r.from_block and r.to_block
      ) as actual
      from ops.ranges r where r.chain_id = $1
    ) t where block_count <> actual`,
  range_log_count: `
    select * from (
      select r.from_block, r.to_block, r.log_count, (
        select count(*) from chain.logs l where l.chain_id = r.chain_id and l.block_number between r.from_block and r.to_block
      ) as actual
      from ops.ranges r where r.chain_id = $1
    ) t where log_count <> actual`,
  duplicate_log_position: `
    select block_number, log_index, count(*) as copies
    from chain.logs where chain_id = $1 group by block_number, log_index having count(*) > 1`,
  log_block_hash_mismatch: `
    select l.block_number, l.log_index, l.block_hash
    from chain.logs l left join chain.blocks b on b.chain_id = l.chain_id and b.number = l.block_number
    where l.chain_id = $1 and b.hash is distinct from l.block_hash`,
  // Rejects are not stored per row, so the identity is checked against the range row's reject_count.
  range_decode_balance: `
    select * from (
      select r.from_block, r.to_block, r.log_count, r.transfer_count, r.swap_count, r.reject_count,
        (select count(*) from chain.erc20_transfers t where t.chain_id = r.chain_id and t.block_number between r.from_block and r.to_block) as actual_transfers,
        (select count(*) from chain.uniswap_v3_swaps s where s.chain_id = r.chain_id and s.block_number between r.from_block and r.to_block) as actual_swaps
      from ops.ranges r where r.chain_id = $1
    ) t where transfer_count <> actual_transfers or swap_count <> actual_swaps
       or actual_transfers + actual_swaps + reject_count <> log_count`,
  transfer_without_log: `
    select t.block_number, t.log_index from chain.erc20_transfers t
    left join chain.logs l on l.chain_id = t.chain_id and l.block_hash = t.block_hash and l.log_index = t.log_index
    where t.chain_id = $1 and l.log_index is null`,
  swap_without_log: `
    select s.block_number, s.log_index from chain.uniswap_v3_swaps s
    left join chain.logs l on l.chain_id = s.chain_id and l.block_hash = s.block_hash and l.log_index = s.log_index
    where s.chain_id = $1 and l.log_index is null`,
};

export async function verifyIntegrity(database: Database, chainId: number): Promise<IntegrityReport> {
  const { sql } = database;

  const [summary] = await sql<{ ranges: number; rejects: number; first_block: string | null; last_block: string | null }[]>`
    select count(*)::int as ranges, coalesce(sum(reject_count), 0)::int as rejects, min(from_block) as first_block, max(to_block) as last_block
    from ops.ranges where chain_id = ${chainId}`;
  const [totals] = await sql<{ blocks: number; logs: number; transfers: number; swaps: number }[]>`
    select (select count(*) from chain.blocks where chain_id = ${chainId})::int as blocks,
           (select count(*) from chain.logs where chain_id = ${chainId})::int as logs,
           (select count(*) from chain.erc20_transfers where chain_id = ${chainId})::int as transfers,
           (select count(*) from chain.uniswap_v3_swaps where chain_id = ${chainId})::int as swaps`;

  const problems: IntegrityProblem[] = [];
  for (const [check, body] of Object.entries(CHECKS)) {
    const [row] = await sql.unsafe<{ count: number; sample: unknown[] }[]>(
      `with bad as (${body})
       select (select count(*) from bad)::int as count,
              coalesce((select json_agg(s) from (select * from bad limit ${SAMPLE_SIZE}) s), '[]'::json) as sample`,
      [chainId],
    );
    if (row && row.count > 0) problems.push({ check, count: row.count, sample: row.sample });
  }

  return {
    ok: problems.length === 0,
    chainId,
    firstBlock: summary?.first_block == null ? null : Number(summary.first_block),
    lastBlock: summary?.last_block == null ? null : Number(summary.last_block),
    counts: {
      ranges: summary?.ranges ?? 0,
      blocks: totals?.blocks ?? 0,
      logs: totals?.logs ?? 0,
      transfers: totals?.transfers ?? 0,
      swaps: totals?.swaps ?? 0,
      rejects: summary?.rejects ?? 0,
    },
    problems,
  };
}
