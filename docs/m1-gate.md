# M1 gate run

Date: 2026-10-17 (all times UTC). Chain: Ethereum mainnet (CHAIN_ID=1). Gate DB: `postgres://postgres@127.0.0.1:54329/indexer` (data left in place).
Raw logs, SQL and outputs: `/tmp/rsi-gate/` (`run1.log`, `run2.log`, `run3.log`, `proof.sql`, `proof.out`, `verify.out`, `spot.mjs`, `spot.out`, `sizes.out`).

## Result

| Gate criterion | Result |
|---|---|
| 1. Backfill 50,000 finalized mainnet blocks (USDC `Transfer` + Uniswap v3 USDC/WETH 0.05% `Swap`) | PASS |
| 2. `kill -9` mid-batch, resume, 0 gaps, 0 duplicates (SQL) | PASS |
| 3. Projected Alchemy free-tier CU/day < 50% of quota | PASS (21.6% ideal, 24.5% with measured retry overhead) |
| 4. CI green | checked separately (not assessed here) |

One unplanned restart occurred: run 2 died from a Node.js heap out-of-memory abort (exit 134) after 230 ranges. See "Restarts and causes". It did not corrupt data; run 3 resumed and finished. The OOM is an open defect in the indexer (see below), not fixed by this gate run.

## Block range and configuration

- Finalized head read from `https://rpc.mevblocker.io` at 09:34:56: block 26,211,339 (`0x18ff40b`).
- `END_BLOCK` = 26,211,339 − 100 = **26,211,239**; `START_BLOCK` = END − 49,999 = **26,161,240**. 50,000 blocks, 500 ranges of 100.
- Contracts (config defaults for CHAIN_ID=1): USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` (`Transfer`), Uniswap v3 USDC/WETH 0.05% pool `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640` (`Swap`).
- Providers (in preference order; the pool uses the first one not cooling down):

```json
[{"name":"mevblocker","url":"https://rpc.mevblocker.io","maxSpan":100,"rps":15,"batchSize":20},
 {"name":"blastapi","url":"https://eth-mainnet.public.blastapi.io","maxSpan":10,"rps":15,"batchSize":20},
 {"name":"drpc","url":"https://eth.drpc.org","maxSpan":100,"rps":2,"batchSize":3}]
```

- Other env: `RANGE_SIZE=100 FETCH_CONCURRENCY=4 LOG_LEVEL=info`, `POLL_INTERVAL_MS` default (60,000).

## Commands

```sh
export DATABASE_URL=postgres://postgres@127.0.0.1:54329/indexer
pnpm db:migrate
# run N (N=1 killed, 2 and 3 restarts); stdout to /tmp/rsi-gate/runN.log
node --import tsx apps/indexer/src/main.ts run
kill -9 <pid of that node process>          # run 1, 09:41:57
node --import tsx apps/indexer/src/main.ts verify
```

Runs 2 and 3 were started by `/tmp/rsi-gate/loop.sh`, which restarts the indexer after any non-zero exit.

## Kill and resume

Run 1 (`e5da1e94-…`) started 09:35:04, was killed with `kill -9` on the node process (pid 50397) at 09:41:57. The last commit before the kill was logged at 09:41:52, five seconds earlier, with the next ranges being fetched.

State right after the kill (before any restart):

```
 ranges |   min    |   max    | blocks |  logs
     60 | 26161240 | 26167239 |   6000 | 437373          -- ops.ranges: 60 of 500 ranges (12%)

 id e5da1e94-…  status=running  first_block=26161240  last_block=26167239  failure_reason=NULL  finished_at=NULL
 chain.blocks count = 6000
```

"Mid-batch" evidence: `rpc_calls` stored at the last commit for run 1 shows 64 `eth_getLogs` for 60 committed ranges, so 4 further ranges (`FETCH_CONCURRENCY=4`) had fetches in flight when the process was killed. Those never committed.

`verify` on the partial data (exit 0):

```json
{"ok":true,"chainId":1,"firstBlock":26161240,"lastBlock":26167239,
 "counts":{"ranges":60,"blocks":6000,"logs":437373,"transfers":433584,"swaps":3789,"rejects":0},
 "problems":[]}
```

Resume: run 2 started 09:42:07 and logged `marked stale runs as abandoned {"abandoned":1}`. The first range it committed started at block 26,167,240 (`ops.runs.first_block` of run 2), i.e. immediately after the last committed range of run 1.

## Timings and throughput

| Run | Start | End | Duration | Ranges | Blocks | Logs | Blocks/s | Logs/s | Outcome |
|---|---|---|---|---|---|---|---|---|---|
| 1 `e5da1e94` | 09:35:04 | 09:41:57 | 413 s | 60 | 6,000 | 437,373 | 14.5 | 1,059 | killed (-9), row left `running`, later marked `failed/abandoned` |
| 2 `08704e16` | 09:42:07 | 10:10:42 | 1,721 s | 230 | 23,000 | 1,919,260 | 13.4 | 1,115 | OOM abort (exit 134), marked `failed/abandoned` by run 3 |
| 3 `ceff8e13` | 10:10:48 | 10:36:08 | 1,521 s | 210 | 21,000 | 1,798,489 | 13.8 | 1,183 | `succeeded` |
| Total | 09:35:04 | 10:36:09 | 61 min wall; 3,654 s running | 500 | 50,000 | 4,155,122 | 13.7 | 1,137 | |

(Run 2's end time is when the process aborted; its `finished_at` in the DB is the time run 3 abandoned it, 10:10:48.) Totals: 4,110,661 transfers, 44,461 swaps, 0 rejects, 4,155,122 logs (about 83 logs per block).

Retries and rate limits (warn-level `rpc retry` lines):

| Run | mevblocker | blastapi | drpc |
|---|---|---|---|
| 1 | 0 | 0 | 0 |
| 2 | 5 transient (`network: The operation was aborted due to timeout`, 30 s request timeout) | 0 | 0 |
| 3 | 7 transient (same timeout) | 1 `rate_limited` (HTTP-level message "exceeded its compute units per second capacity") | 0 |

No other provider errors. Each timeout made the pool retry the range on the next provider (blastapi, span 10), which served a few ranges: 5 in run 2 and 6 in run 3. mevblocker served the other ~489 ranges. drpc was never called. Zero `InconsistentRangeError`s and zero exhausted retries occurred.

`ops.runs.rpc_calls` (cumulative counts as of each run's last commit; for the two failed runs this excludes calls issued after their last commit):

| Run | mevblocker getLogs | mevblocker getBlockByNumber | blastapi getLogs | blastapi getBlockByNumber | drpc |
|---|---|---|---|---|---|
| 1 (killed) | 64 | 6,041 | 0 | 0 | 0 |
| 2 (OOM) | 304 | 22,901 | 50 | 500 | 0 |
| 3 (final log line: 20,782 headers) | 324 | 20,781 | 64 | 620 | 0 |
| Sum | 692 | 49,723 | 114 | 1,120 | 0 |

Sum over all providers: 806 `eth_getLogs`, 50,843 `eth_getBlockByNumber` (this includes the `finalized` polls and calls in flight at the commit snapshots).

## Gate proof (SQL, independent of `verify.ts`)

Script: `/tmp/rsi-gate/proof.sql`, output `/tmp/rsi-gate/proof.out`. START = 26161240, END = 26211239. Column names: `chain.blocks(number, hash, parent_hash)`, `chain.logs(block_number, block_hash, log_index, …)` with primary key `(chain_id, block_hash, log_index)`, `ops.ranges(from_block, to_block, block_count, log_count, …)`.

**1. Every height START..END exactly once in `chain.blocks`**

```sql
select count(*) n, count(distinct number) distinct_heights, min(number) min_h, max(number) max_h from chain.blocks where chain_id=1;
select count(*) missing from generate_series(26161240,26211239) g(h)
  where not exists (select 1 from chain.blocks b where b.chain_id=1 and b.number=g.h);
select (select count(*) from chain.blocks where chain_id=1 and (number<26161240 or number>26211239)) outside,
       (select count(*) from (select number from chain.blocks where chain_id=1 group by 1 having count(*)>1) d) dup_heights;
```
```
   n   | distinct_heights |  min_h   |  max_h
 50000 |            50000 | 26161240 | 26211239
 missing = 0
 outside = 0 | dup_heights = 0
```

**2. Ranges contiguous, non-overlapping, covering START..END exactly**

```sql
select count(*) n, min(from_block) first_from, max(to_block) last_to, sum(to_block-from_block+1) covered, sum(block_count) sum_block_count,
  count(*) filter (where from_block <> coalesce(prev_to+1, from_block)) gaps_or_overlaps
from (select *, lag(to_block) over (order by from_block) prev_to from ops.ranges where chain_id=1) r;
select (select count(*) from ops.ranges a join ops.ranges b on a.chain_id=b.chain_id and a.from_block<b.from_block and b.from_block<=a.to_block) overlap_pairs,
  (select count(*) from ops.ranges where block_count<>to_block-from_block+1) bad_count,
  (select count(*) from ops.ranges r where (select count(*) from chain.blocks b where b.chain_id=r.chain_id and b.number between r.from_block and r.to_block)<>r.block_count) rows_mismatch;
```
```
  n  | first_from | last_to  | covered | sum_block_count | gaps_or_overlaps
 500 |   26161240 | 26211239 |   50000 |           50000 |                0
 overlap_pairs = 0 | bad_count = 0 | rows_mismatch = 0
```

**3. Each block's `parent_hash` equals the previous block's `hash`**

```sql
select count(*) broken_links from (select number, parent_hash, lag(hash) over (order by number) prev_hash, lag(number) over (order by number) prev_n
  from chain.blocks where chain_id=1) t where prev_hash is distinct from parent_hash and prev_n is not null;
select count(*) consecutive_pairs_checked from (select number, lag(number) over (order by number) prev_n from chain.blocks where chain_id=1) t where prev_n = number-1;
```
```
 broken_links = 0
 consecutive_pairs_checked = 49999
```

**4. No duplicate log keys**

```sql
select count(*) logs, count(distinct (chain_id, block_number, log_index)) distinct_num_idx, count(distinct (chain_id, block_hash, log_index)) distinct_hash_idx from chain.logs;
select count(*) dup_groups from (select 1 from chain.logs group by chain_id, block_number, log_index having count(*)>1) d;
select count(*) logs_without_block from chain.logs l where not exists (select 1 from chain.blocks b where b.chain_id=l.chain_id and b.number=l.block_number and b.hash=l.block_hash);
```
```
  logs   | distinct_num_idx | distinct_hash_idx
 4155122 |          4155122 |           4155122
 dup_groups = 0 | logs_without_block = 0
```

**5. transfers + swaps + rejects = logs**

```sql
select (select count(*) from chain.erc20_transfers) transfers, (select count(*) from chain.uniswap_v3_swaps) swaps, (select sum(reject_count) from ops.ranges) rejects,
  (select count(*) from chain.logs) logs,
  (select count(*) from chain.erc20_transfers)+(select count(*) from chain.uniswap_v3_swaps)+(select sum(reject_count) from ops.ranges) = (select count(*) from chain.logs) as equal;
```
```
 transfers | swaps | rejects |  logs   | equal
   4110661 | 44461 |       0 | 4155122 | t
```
`ops.ranges` sums agree: `log_count` 4,155,122, `transfer_count` 4,110,661, `swap_count` 44,461.

**6. `ops.runs` shows the killed run as failed/abandoned**

```sql
select id, status, failure_reason, first_block, last_block, started_at, finished_at from ops.runs order by started_at;
```
```
 id            | status    | failure_reason | first_block | last_block | started_at          | finished_at
 e5da1e94-…    | failed    | abandoned      |    26161240 |   26167239 | 09:35:04.816527+00  | 09:42:07.509398+00   <- kill -9
 08704e16-…    | failed    | abandoned      |    26167240 |   26190239 | 09:42:07.511749+00  | 10:10:48.246538+00   <- OOM abort
 ceff8e13-…    | succeeded |                |    26190240 |   26211239 | 10:10:48.262185+00  | 10:36:08.797119+00
```
Run-to-range attribution (`ops.ranges` by `run_id`): 60 + 230 + 210 = 500 ranges; no range belongs to two runs.

**`verify` on the final data** (`node --import tsx apps/indexer/src/main.ts verify`, exit 0):

```json
{
  "ok": true,
  "chainId": 1,
  "firstBlock": 26161240,
  "lastBlock": 26211239,
  "counts": {"ranges": 500, "blocks": 50000, "logs": 4155122, "transfers": 4110661, "swaps": 44461, "rejects": 0},
  "problems": []
}
```

## Independent completeness spot-check

Ten pseudo-random 10-block windows inside the range (LCG seed 123456789, script `/tmp/rsi-gate/spot.mjs`). Each window was fetched with one `eth_getLogs` (same two addresses, topic0 `Transfer` or `Swap`) from **blastapi** (`https://eth-mainnet.public.blastapi.io`), a different provider from mevblocker, which served ~489 of 500 ranges. The set of `(blockHash, logIndex)` was compared with `chain.logs` for the same blocks.

| Window | Provider logs | DB logs | In provider, not in DB | In DB, not in provider |
|---|---|---|---|---|
| 26171952–26171961 | 731 | 731 | 0 | 0 |
| 26205022–26205031 | 1,162 | 1,162 | 0 | 0 |
| 26187451–26187460 | 562 | 562 | 0 | 0 |
| 26178414–26178423 | 796 | 796 | 0 | 0 |
| 26188481–26188490 | 1,241 | 1,241 | 0 | 0 |
| 26179871–26179880 | 1,347 | 1,347 | 0 | 0 |
| 26175681–26175690 | 991 | 991 | 0 | 0 |
| 26187977–26187986 | 705 | 705 | 0 | 0 |
| 26180984–26180993 | 631 | 631 | 0 | 0 |
| 26167654–26167663 | 518 | 518 | 0 | 0 |
| **Total** | **8,684** | **8,684** | **0** | **0** |

Mismatches: 0. Caveat: 10 windows of 10 blocks is 100 blocks (0.2% of the range) so this is a sample, not a full audit.

## Budget: Alchemy free tier

Sources: <https://www.alchemy.com/docs/reference/compute-unit-costs>, <https://www.alchemy.com/docs/reference/pricing-plans>. Values used (read 2026-10-17): free tier 30M CU/month and 300 CU/s; `eth_getLogs` 60 CU (mainnet, 10-block span limit), `eth_getBlockByNumber` 20 CU, `eth_blockNumber` 10 CU. The indexer uses `eth_getBlockByNumber` (including for the `finalized` poll), not `eth_blockNumber`.

Calls per 100-block range, from the code and the counters above:
- Headers: 100 `eth_getBlockByNumber` (measured 50,843 over 50,000 blocks = 1.017 per block; the excess is finalized polls, retries and in-flight work lost to the kill/OOM).
- Logs: 1 `eth_getLogs` at maxSpan 100 (mevblocker, measured 692 calls for about 489 ranges plus lost in-flight work and retries). On Alchemy the span is 10, so 10 `eth_getLogs` per 100 blocks.
- Finalized poll: 1 `eth_getBlockByNumber("finalized")` per 60 s = 1,440 per day.

| Item | Calls | CU |
|---|---|---|
| Per 100 blocks, ideal (100 headers + 10 getLogs) | 110 | 2,000 + 600 = **2,600** |
| Steady tail, per day: 7,200 blocks, headers | 7,200 × 20 | 144,000 |
| Steady tail, per day: getLogs, 720 (maxSpan 10) | 720 × 60 | 43,200 |
| Steady tail, per day: finalized polls | 1,440 × 20 | 28,800 |
| **Steady tail, per day, ideal** | | **216,000 CU/day = 6.48M/month = 21.6% of 30M** |
| Steady tail with measured overhead (headers ×1.017, getLogs ×1.61 = 806 measured / 500 ranges) | | 146,448 + 69,552 + 28,800 = 244,800 CU/day = 7.34M/month = **24.5%** |
| 50k backfill, ideal (500 × 2,600 + 3 polls) | | 1,300,000 CU (4.3% of one month) |
| 50k backfill, measured header calls (50,843 × 20) + 5,000 getLogs × 60 | | 1,316,860 CU (4.4%) |
| 50k backfill, measured header calls + getLogs ×1.61 (8,050 × 60) | | 1,499,860 CU (5.0%) |

Gate threshold: 50% of 30M/month = 15M CU/month = 500,000 CU/day. Projected 216,000–244,800 CU/day is 43–49% of that threshold, i.e. 21.6–24.5% of the monthly quota. Throughput check: Alchemy's 300 CU/s allows a 100-block range (2,600 CU) every 8.7 s, about 11.5 blocks/s, so the 50k backfill alone on that limit would take about 72 minutes. The steady tail needs about 2.5 CU/s. Caveats: the projection is by arithmetic from per-call costs in the docs, not measured against Alchemy; the getLogs response-size limits on Alchemy (not tested) are not modelled.

## Storage

After the full backfill (`pg_database_size('indexer')` = 5,130,835,635 bytes, 4,893 MB):

| Table | Total | Heap | Indexes |
|---|---|---|---|
| chain.logs | 2,878 MB | 2,188 MB | 690 MB |
| chain.erc20_transfers | 1,967 MB | 1,285 MB | 682 MB |
| chain.uniswap_v3_swaps | 23 MB | 16 MB | 7,008 kB |
| chain.blocks | 17 MB | 9,328 kB | 7,592 kB |
| ops.ranges | 168 kB | 104 kB | 32 kB |
| ops.runs | 32 kB | 8 kB | 16 kB |

About 102 KB per block; `chain.logs` and `chain.erc20_transfers` are 99% of the size (the decoded rows duplicate the raw logs).

## Restarts and causes

| # | Run | Cause | Evidence |
|---|---|---|---|
| 1 | 1 → 2 | Deliberate `kill -9` at 60/500 ranges (6,000 blocks, 12%), 09:41:57 | "Kill and resume" section above |
| 2 | 2 → 3 | **Unplanned:** `FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory`, process abort exit 134 at 10:10:42, after 230 ranges and 1,715 s. GC trace shows about 2.0 GB heap in use | `run2.log` lines 239–246 |

Not a fail-closed exit: no `InconsistentRangeError`, no exhausted retries, no `run failed` log line. Because the process aborted, the run row was left `running` and run 3 marked it `failed/abandoned`.

Memory growth is about 9 MB per committed range (about 2 GB in 230 ranges at about 8,300 logs per range), so a run longer than about 250 ranges will hit the default heap limit. Run 3 committed 210 ranges and finished before reaching it. [INFERENCE, not tested]: the likely cause is in `apps/indexer/src/pipeline.ts`: each `Promise.race([inflight.shift()!, aborted.promise])` attaches a reaction to the long-lived `aborted.promise` that is never released, so every fetched range (logs, decoded rows) stays reachable for the process lifetime. No source change was made, because the gate was not blocked: resume worked as designed. A real follow-up is needed before the indexer is run unattended on the finalized tail.

## Code changes

None. The gate was run against `main` as committed.

## Addendum (2026-10-17, after the gate)

The heap leak above is fixed in commit `09f5d43`. The inferred cause was correct: every `await` in the run loop raced one shared, never-settling abort promise, and each `Promise.race` left a reaction on it that kept the settled value (a whole fetched range) reachable. `untilAborted` in `apps/indexer/src/pipeline.ts` now creates the abort promise per call and removes its listener when the awaited promise settles. `apps/indexer/test/until-aborted.test.ts` forces garbage collection and asserts that a settled value is collectable; the same check fails on the old pattern. The gate results above were produced before the fix and are unchanged by it.
