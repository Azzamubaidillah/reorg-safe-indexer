# Operations

Run the indexer with `node --import tsx apps/indexer/src/main.ts <command>` (or `pnpm indexer <command>`). All settings are environment variables.

## Environment

| Name | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | Postgres connection string. |
| `CHAIN_ID` | `1` | Chain being indexed; also scopes every CLI subcommand. |
| `RPC_PROVIDERS` | required | JSON array of `{name, url, maxSpan, rps, batchSize?}`, in preference order. |
| `ERC20_TOKENS` | the chain preset's USDC (chains 1 and 8453) | Comma-separated token addresses (`Transfer` events). Set it to replace the preset's tokens. |
| `UNISWAP_V3_POOLS` | the chain preset's USDC/WETH 0.05% pool (chains 1 and 8453) | Comma-separated pool addresses (`Swap` events). Set it to replace the preset's pools. A chain without a preset needs at least one of the two lists. |
| `START_BLOCK` | required | First block on an empty database; later runs resume from the stored tip. |
| `END_BLOCK` | unset | Stop after this block; unset follows the head. |
| `RANGE_SIZE` | `100` | Blocks per committed range. |
| `FETCH_CONCURRENCY` | `4` | Ranges fetched ahead of the commit. |
| `POLL_INTERVAL_MS` | `60000` | How often the finalized block is refreshed. |
| `HEAD_POLL_INTERVAL_MS` | `4000` | How often an idle indexer asks for a new head. |
| `LOG_LEVEL` | `info` | pino level. |
| `QUALITY_INTERVAL_MS` | `60000` | Pause between quality cycles (gate checks, publishing, backfills). |
| `QUALITY_MAX_BACKFILLS` | `2` | Backfill jobs worked off per quality cycle. |
| `RECONCILE_PROVIDER` | unset (off) | JSON for the second source, same shape as one `RPC_PROVIDERS` entry. Its `name` must differ from every `RPC_PROVIDERS` name. |
| `RECONCILE_LIMIT` | `5` | Finalized ranges checked per reconcile cycle. |
| `RECONCILE_INTERVAL_MS` | `300000` | Pause between reconcile cycles. |
| `METRICS_PORT` | unset / `0` (off) | Port of the `/metrics`, `/healthz`, `/status` server. |
| `METRICS_HOST` | `127.0.0.1` | Bind address of that server; `/status` exposes internals, so keep it on loopback or behind a proxy. |
| `HEALTH_STALE_AFTER_MS` | `60000` | `/healthz` returns 503 when there was no head poll or commit for this long. |
| `LANDING_RETENTION_DAYS` | `7` | Days the raw `chain.logs` rows of a published range are kept, counted from the range's last block (see [Retention](#retention)). |
| `DECODED_RETENTION_DAYS` | unset (keep forever) | Days decoded rows (`chain.erc20_transfers`, `chain.uniswap_v3_swaps`) are kept. Needs `ANALYTICS_MANIFEST_PATH`; the process refuses to start without it. |
| `ANALYTICS_MANIFEST_PATH` | unset | Path of `_manifest.json` in the Parquet store (`<ANALYTICS_DIR>/_manifest.json`). Decoded rows are only deleted for blocks it lists as exported. |
| `RETENTION_INTERVAL_MS` | `3600000` | Pause between retention cycles. |
| `RETENTION_MAX_RANGES` | `500` | Purge steps (a range's landing purge or decoded purge) per cycle. |
| `LAG_SAMPLE_INTERVAL_MS` | `10000` | Pause between lag samples written to `ops.lag_samples` (kept 14 days, pruned hourly). |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | unset | Both set: alerts are sent to Telegram. Otherwise alerts are only logged (`alert` field, level warn). |
| `ALERT_COOLDOWN_MS` | `1800000` | The same alert is delivered at most once per cooldown. |
| `ALERT_HEAD_LAG_BLOCKS` | `12` | Head lag above this many blocks counts as lagging. |
| `ALERT_HEAD_LAG_MS` | `300000` | Alert once lag has stayed above the limit this long. |

## Commands

| Command | What it does | Exit codes |
|---|---|---|
| `run` | Ingests, and runs the quality, reconcile, retention and lag timers beside the pipeline. SIGINT/SIGTERM stop the timers, wait for running cycles, close the status server and end the run as `failed/interrupted`. | 0 finished or interrupted, 1 error or lock held by another indexer, 2 halted: reorg at or below the finalized block, or a start refused because such a halt is still unacknowledged (see [Halts](#halts)) |
| `verify` | Integrity SQL over stored data; prints a JSON report. | 0 ok, 1 problems found |
| `rebuild-verify` | Re-decodes every stored log and compares with the decoded tables; prints JSON. Ranges whose landing logs were purged are left out of both sides and counted in `skippedRanges`. Needs the full `run` environment (contracts come from it). | 0 equal, 1 differs |
| `retention --dry-run` | Prints as JSON the ranges a retention cycle would purge now (`landing`, `decoded`) and `manifestProblem` (why decoded rows cannot be purged although configured); writes nothing. Without `--dry-run` it only prints usage: purging is done by the `run` timer. | 0, 2 on bad usage |
| `reconciliations --unexplained` | JSON list of second-source mismatches without an explanation. | 0, 2 on bad usage |
| `ack-halt <reorgId> <text>` | Acknowledges the halt `ops.reorgs.id = <reorgId>`, so `run` may start again. Only `halted` rows that are not acknowledged yet take it, and the text (why continuing is safe) must not be empty. | 0 ok, 1 unknown id, not a halt, or already acknowledged, 2 bad usage |
| `explain-reconciliation <id> <text>` | Records why mismatch `<id>` is understood. Only mismatches take an explanation. | 0 ok, 1 unknown id or not a mismatch, 2 bad usage |
| `lag-report [--since <ISO timestamp\|72h>]` | Head and finalized lag percentiles from `ops.lag_samples`; default window `24h`. | 0, 1 on a bad `--since` |

`verify`, `reconciliations`, `ack-halt`, `explain-reconciliation` and `lag-report` need only `DATABASE_URL` and `CHAIN_ID`; `retention` adds the retention variables above.

## Halts

A reorg at or below the finalized block should never happen, so the indexer stops instead of guessing: it records a `halted` row in `ops.reorgs` (nothing is deleted), alerts, and exits with code 2. Docker's `on-failure` policy cannot exclude exit code 2, so the halt is sticky: on startup, right after taking the chain lock and before any RPC call, `run` looks for a `halted` row without `acknowledged_at`. If there is one it logs fatal (`halted: unacknowledged reorg #<id>`), sends the `halt-unacknowledged` alert, records a failed run with that reason, and exits 2 again. A restart loop therefore costs one database round trip per attempt, not a fresh detection against the provider.

To resume: find out why the chains diverged (compare the stored hashes in `GET /v1/reorgs`, the Reorgs page, or `ops.reorgs.orphaned`/`canonical` with two other providers), fix the cause (provider, finality assumption, or the stored data), then run `ack-halt <reorgId> "<why it is safe to continue>"`. The next start proceeds normally. If the provider still serves a fork below the finalized block the run halts again as a new row, which blocks in turn. `GET /v1/reorgs`, the Reorgs page and `lastReorg` in `/v1/status` show `acknowledgedAt` and `acknowledgement` for halted rows.

Halts recorded before migration `0004_ops_reorg_ack` are marked acknowledged by the migration (`predates sticky halts`), so upgrading never blocks a running indexer.

## Reading the M3 gate inputs

- **Lag:** `lag-report --since 72h`. Read `headLag.p95` (blocks the stored tip trails the head) and `finalizedLag.p95`. `samples` must cover the window; `unknownTip` counts samples taken before anything was stored and is excluded from the percentiles.
- **Ranges by status:** `GET /status`, field `ranges` (`candidate`, `published`, `failed`, each with ranges, blocks and logs), or `select status, count(*) from ops.ranges group by status`. Healthy: every range at or below the finalized block is `published`, nothing is `failed`, and `backfillJobs.open` is 0. Failed ranges come with a queued backfill job and the failing gate in `ops.quality_results`.
- **Unexplained reconciliations:** `reconciliations --unexplained` must print `[]`. `/status` shows the same as `reconciliation.unexplained`. Each mismatch needs an `explain-reconciliation` before the gate can pass.
- **Rebuild:** `rebuild-verify` must exit 0 (`equal: true`). On exit 1 read `tables[].firstDifferences` for the first differing positions.

## Retention

Without it the database grows by about 700 MB per day (see [Sizing](#sizing)). Data is kept according to whether it can be obtained again:

| Class | Tables | Policy |
|---|---|---|
| Refetchable landing data | `chain.logs` | Deleted per range after `LANDING_RETENTION_DAYS`. |
| Rebuildable decoded data | `chain.erc20_transfers`, `chain.uniswap_v3_swaps` | Pure function of the landing logs while those exist, refetchable once they are gone. Deleted per range after `DECODED_RETENTION_DAYS`, only once the Parquet export has them. Kept forever when that variable is unset. |
| Irreplaceable | `chain.blocks` (about 0.35 KB per block) and every `ops.*` table | Never deleted: the block chain, range counts, gate results, reorg and reconciliation evidence stay complete. |

A cycle (every `RETENTION_INTERVAL_MS`, single-flight, failures alerted like the other timers) walks the ranges oldest first, at most `RETENTION_MAX_RANGES` purge steps, one transaction per range. The range row records the step in `ops.ranges.landing_purged_at` / `decoded_purged_at`; counts stay, so `GET /v1/ranges` keeps describing the range.

**Landing purge** needs all of: the range is `published`; its last block is older than `LANDING_RETENTION_DAYS`; and, once the reconciler has written any row for the chain, the range has a `match` reconciliation row (only a mismatch, or no row, keeps the logs: they are the evidence). Status is re-read under the range's lock inside the transaction, so a backfill racing the cycle wins.

**Decoded purge** needs all of: landing already purged; last block older than `DECODED_RETENTION_DAYS`; `ANALYTICS_MANIFEST_PATH` set and its `exported` intervals covering the range; and the range ending before the UTC day of the lowest range the manifest does not cover. The exporter rewrites a whole day from Postgres, so a day with an unexported range must keep its rows until that range is exported. A missing or foreign manifest is logged as a warning (`decoded rows not purged`) and shown by `retention --dry-run` as `manifestProblem`; nothing is deleted then.

Once decoded rows are purged the Parquet files are the only copy of those days: back the store up. The exporter protects them: an export that would write a day containing a decoded-purged range (for example after the manifest was deleted, or a late range published into a purged day) throws `refusing to export: day(s) ... contain ranges whose decoded rows were purged` before writing anything, so the manifest and every file stay as they were. Restore the manifest and files of those days from the backup, then export again. `verify` on the analytics CLI is not affected: its scratch rebuild is only compared on days still fully in Postgres.

What stays correct on purged ranges:

- **Quality gates** only gate candidates, so purged (published) ranges are never re-gated or backfilled; new ranges still link to the old blocks.
- **`verify`** skips the log counts of landing-purged ranges and the decoded counts of decoded-purged ones, and the "decoded row has no log" checks for landing-purged ranges. Block, link and range checks are unchanged. `purged` in the report counts the ranges.
- **`rebuild-verify`** only covers ranges whose landing logs are present (`skippedRanges` says how many were left out).
- **Reconciler** skips landing-purged ranges.
- **`GET /v1/status`** has `retention`: `landingPurgedThroughBlock` and `decodedPurgedThroughBlock` (highest block of any purged range, null while none) and `landingRetentionDays` / `decodedRetentionDays`. The API only knows the days if it is given the same `LANDING_RETENTION_DAYS` / `DECODED_RETENTION_DAYS`; otherwise they are null.
- **Event endpoints** (`/v1/transfers`, `/v1/swaps`) answer from the decoded tables, so a decoded-purged range returns no rows; use `/v1/analytics/*` for those days.
- **Analytics verify** (`packages/analytics` CLI `verify`) compares Postgres with Parquet only for days fully retained in Postgres, skips the rebuild check for the others and lists them as `purgedDays`; the file checks still cover every day.

Deleted rows free space inside the tables for new rows (autovacuum), they do not shrink the files, so the size settles at the peak of the retained window plus one cycle.

### Sizing

Measured in `docs/m1-gate.md` (Storage): 50,000 blocks, `chain.logs` 2,878 MiB, `chain.erc20_transfers` 1,967 MiB, `chain.uniswap_v3_swaps` 23 MiB, `chain.blocks` 17 MiB, i.e. 58.9, 40.3, 0.47 and 0.35 KiB per block. At 7,200 blocks per day: logs 414 MiB/day, decoded 287 MiB/day, blocks 2.5 MiB/day, 703 MiB/day in total.

| Setting | Steady state (indexes included) | Still grows by |
|---|---|---|
| Retention off | none | 703 MiB/day |
| Defaults (7 days landing, decoded kept) | 7 d of logs, 2.8 GiB | decoded + blocks, 289 MiB/day (41%) |
| `DECODED_RETENTION_DAYS=14` | 2.8 GiB logs + 14 d of decoded 3.9 GiB = 6.8 GiB | blocks only, 2.5 MiB/day (0.9 GiB per year), plus the small `ops.*` rows (not measured) |

Add roughly one retention interval of data (29 MiB per hour) and the Parquet store, which lives outside Postgres.
