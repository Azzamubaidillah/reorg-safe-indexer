# Costs and load

What the system costs to run in RPC calls, storage and latency, with the source of every number. Everything here was measured on 2026-10-17 unless marked otherwise. Items marked `TODO(gate)` belong to the 72 h live gate window (running until 2026-10-20 10:59 UTC) and are not known yet.

Sources:

- M1 gate run: [m1-gate.md](m1-gate.md) (50,000 finalized blocks, keyless public RPCs, three process runs).
- Live run: the deployed indexer following the mainnet head.
- Latency: deployed-host measurements of the dashboard endpoints; the repeatable local version is `apps/api/test/latency-bench.ts`.
- Arithmetic is mine and shown, so it can be checked.

## Ingestion throughput (M1 gate)

| Run | Duration | Blocks | Logs | Blocks/s | Logs/s | Outcome |
|---|---|---|---|---|---|---|
| 1 | 413 s | 6,000 | 437,373 | 14.5 | 1,059 | killed with `kill -9` (deliberate) |
| 2 | 1,721 s | 23,000 | 1,919,260 | 13.4 | 1,115 | heap out-of-memory abort (leak, since fixed) |
| 3 | 1,521 s | 21,000 | 1,798,489 | 13.8 | 1,183 | succeeded |
| Total | 3,654 s running time | 50,000 | 4,155,122 | 13.7 | 1,137 | |

Configuration: `RANGE_SIZE=100`, `FETCH_CONCURRENCY=4`, three keyless public providers in preference order. A mainnet block arrives every 12 s (0.083 blocks/s), so the 13.7 blocks/s backfill rate is about 164 times faster than the chain produces blocks. Keeping up with the head is not the constraint on these endpoints; their request budgets and timeouts are.

The workload is about 83 logs per block (4,155,122 logs over 50,000 blocks): 4,110,661 USDC transfers and 44,461 pool swaps.

Provider behaviour in those runs: one provider served about 489 of 500 ranges; 12 timeouts (30 s request timeout) and 1 rate-limit response were retried on the next provider with no data effect; the third provider was never called. Zero inconsistent-range retries. Full table in [m1-gate.md](m1-gate.md#timings-and-throughput).

## RPC budget

Calls per 100-block range: 100 `eth_getBlockByNumber` (one header per block, needed for parent-hash continuity) plus `ceil(100 / maxSpan)` `eth_getLogs`. A second-source reconciler adds one header call and the log calls for the same range, on the second provider. Plus one `finalized` poll every `POLL_INTERVAL_MS` (default 60 s, 1,440 a day).

Measured on the keyless providers, over 50,000 blocks: 806 `eth_getLogs` and 50,843 `eth_getBlockByNumber` calls (1.017 header calls per block; the excess is finalized polls, retries and in-flight work lost to the kill and the abort).

Alchemy-equivalent budget, computed from Alchemy's published compute-unit prices as read on 2026-10-17 (free tier 30M CU per month and 300 CU per second; `eth_getBlockByNumber` 20 CU; `eth_getLogs` 60 CU with a 10-block span on mainnet). This is a calculation from measured call counts, not a measurement on that service:

| Item | Calls | CU |
|---|---|---|
| Per 100 blocks, ideal (100 headers + 10 `eth_getLogs`) | 110 | 2,600 |
| Finalized tail per day, ideal: 7,200 blocks of headers | 7,200 x 20 | 144,000 |
| Finalized tail per day, ideal: 720 `eth_getLogs` | 720 x 60 | 43,200 |
| Finalized tail per day, ideal: finalized polls | 1,440 x 20 | 28,800 |
| **Finalized tail per day, ideal** | | **216,000 CU = 6.48M per month = 21.6% of the free tier** |
| Finalized tail per day with measured overhead (headers x 1.017, `eth_getLogs` x 1.61) | | 244,800 CU = 7.34M per month = **24.5%** |
| 50,000-block backfill, ideal | 500 x 2,600 + 3 polls | 1,300,000 CU (4.3% of one month) |
| 50,000-block backfill with measured header calls and `eth_getLogs` x 1.61 | | 1,499,860 CU (5.0%) |

The M1 gate threshold was under 50% of the monthly quota; the projection is 21.6% to 24.5%. Throughput on that tier is bounded by 300 CU/s: a 100-block range costs 2,600 CU, so one range every 8.7 s, about 11.5 blocks/s, still far above the chain's 0.083 blocks/s.

Reconciliation cost: one header call and one `eth_getLogs` per range at a second-source span of 100 (the test "costs one header plus one getLogs per range" asserts this in `apps/indexer/test/reconcile.int.test.ts`). At the default `RECONCILE_LIMIT=5` per `RECONCILE_INTERVAL_MS=300000`, that is at most 5 ranges every 5 minutes, 1,440 ranges a day, against about 72 ranges produced a day (7,200 blocks / 100). It is therefore not rate-limited by the default settings.

Public-RPC cost in money is zero; the cost is reliability (timeouts, rate limits) and the absence of any service level.

### Live run

TODO(gate): measured RPC calls per day by provider and method over the 72 h window, from `ops.runs.rpc_calls` and `indexer_rpc_calls_total`, set against the computed 216,000 to 244,800 CU per day.

## Storage

M1 gate after the 50,000-block backfill (`pg_database_size` = 5,130,835,635 bytes):

| Table | Total | Heap | Indexes |
|---|---|---|---|
| `chain.logs` | 2,878 MB | 2,188 MB | 690 MB |
| `chain.erc20_transfers` | 1,967 MB | 1,285 MB | 682 MB |
| `chain.uniswap_v3_swaps` | 23 MB | 16 MB | 7 MB |
| `chain.blocks` | 17 MB | 9 MB | 8 MB |
| `ops.*` | under 1 MB | | |

That is about 102 KB per block (5,130,835,635 / 50,000), 99% of it in the landing logs and the decoded transfers, which duplicate each other by design ([decisions.md](decisions.md#adr-010-keep-raw-logs-in-a-landing-table-decode-into-separate-tables)). The live indexer measures about 86 KB per block. I have not broken down the difference between the two figures, so I use both as a range.

Projection at 7,200 blocks per day with **no retention** (decimal units, rounded):

| Per-block size | Per day | Per 30 days | Per year |
|---|---|---|---|
| 86 KB (live) | 0.62 GB | 18.6 GB | 226 GB |
| 102 KB (M1 backfill) | 0.73 GB | 22.0 GB | 268 GB |

### With retention

Retention ([decisions.md](decisions.md#adr-020-retention-by-reacquirability), [runbook.md](runbook.md#retention)) deletes landing logs after `LANDING_RETENTION_DAYS` and decoded rows after `DECODED_RETENTION_DAYS`; blocks and `ops.*` stay. The live deployment uses 7 and 14 days. The steady state below is computed, not yet observed over a full window, and uses the M1 gate per-table sizes (indexes included) as the basis, as worked out in [operations.md](operations.md#sizing):

| Table group | Per block | Per day (7,200 blocks) | Kept for | Steady state |
|---|---|---|---|---|
| `chain.logs` | 58.9 KiB | 414 MiB | 7 days | 2.8 GiB |
| `chain.erc20_transfers` + `chain.uniswap_v3_swaps` | 40.8 KiB | 287 MiB | 14 days | 3.9 GiB |
| `chain.blocks` | 0.35 KiB | 2.5 MiB | forever | grows 2.5 MiB/day (0.9 GiB/year) |
| Total | | 703 MiB/day without retention | | **6.8 GiB**, then about 2.5 MiB/day, plus the small `ops.*` rows (not measured) |

Two bases, because the figures disagree (above):

- **M1 gate basis (102 KB per block):** 6.8 GiB, as in the table.
- **Live basis (86 KB per block):** the same table scaled by 86/102, about 5.7 GiB (6.1 GB). This assumes the live rows have the same logs-to-decoded split as the backfill, which I have not checked.

Add roughly one retention interval of data (about 29 MiB per hour at the M1 basis) because purges run hourly, and the Parquet store, which is outside Postgres and whose size I have not measured. Deleted rows are reused inside the tables but do not shrink the files, so the size settles at the peak of the retained window. With retention off the first table applies unchanged. After decoded rows are purged the Parquet store is the only copy of those days, so it counts as data to keep and back up, not as a cache.

The 72 h gate window is too short to show the 7 and 14 day steady state, so the retained-window size stays a computation until the deployment has run for 14 days.

## API latency

Per-endpoint p95 at the deployed host, in milliseconds:

| Endpoint | p95 (ms) |
|---|---|
| `/v1/status` | 20 |
| `/v1/reorgs` | 12 |
| `/v1/ranges` | 16 |
| `/v1/transfers` | 23 |
| `/v1/transfers` filtered by address | 76 |
| `/v1/swaps` | 19 |
| `/v1/analytics/daily-volume` | 96 |
| `/v1/analytics/pool-ohlc` | 32 |
| `/v1/analytics/meta` | 12 |

Every endpoint is at or below 96 ms. The two slowest are the address-filtered transfer query and daily volume, which scans Parquet through DuckDB; I have not profiled either further. Event queries stay flat as history grows because they use keyset pagination and range-bounded probes ([decisions.md](decisions.md#adr-016-read-only-api-with-fail-closed-queries-and-keyset-pagination)). The gates are bounded by range for the same reason ([quality.ts](../apps/indexer/src/quality.ts)).

These are per-request latency percentiles for dashboard use. They are not a concurrent-load test and say nothing about how the API behaves under many simultaneous clients.

## Lag and quality over the live gate window

Measured by `lag-report --since 72h` and the SQL in [runbook.md](runbook.md#reading-the-gates). The window runs until 2026-10-20 10:59 UTC; these values are not available yet.

| Measure | Value |
|---|---|
| Samples in window (one per 10 s by default) | TODO(gate) |
| Head lag p50 / p95 / max (blocks) | TODO(gate) |
| Finalized lag p95 / max (blocks) | TODO(gate) |
| Ranges published / candidate / failed at window end | TODO(gate) |
| Quality gate failures during the window | TODO(gate) |
| Reconciled ranges, mismatches, unexplained mismatches | TODO(gate) |
| Reorgs observed in the window (rolled back / halted) | TODO(gate) |
| Process restarts and their causes | TODO(gate) |

Already known from the live run before the window ends: the first mainnet reorg was at block 26,212,486, depth 1 with common ancestor 26,212,485, detected 2 h 49 min into the live run and rolled back. After finality the stored hash for that height equals the canonical hash from two independent providers, and the orphaned hash is absent.
