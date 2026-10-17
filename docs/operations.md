# Operations

Run the indexer with `node --import tsx apps/indexer/src/main.ts <command>` (or `pnpm indexer <command>`). All settings are environment variables.

## Environment

| Name | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | required | Postgres connection string. |
| `CHAIN_ID` | `1` | Chain being indexed; also scopes every CLI subcommand. |
| `RPC_PROVIDERS` | required | JSON array of `{name, url, maxSpan, rps, batchSize?}`, in preference order. |
| `ERC20_TOKENS` | mainnet USDC when `CHAIN_ID=1` | Comma-separated token addresses (`Transfer` events). |
| `UNISWAP_V3_POOLS` | mainnet USDC/WETH 0.05% when `CHAIN_ID=1` | Comma-separated pool addresses (`Swap` events). |
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
| `LAG_SAMPLE_INTERVAL_MS` | `10000` | Pause between lag samples written to `ops.lag_samples` (kept 14 days, pruned hourly). |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | unset | Both set: alerts are sent to Telegram. Otherwise alerts are only logged (`alert` field, level warn). |
| `ALERT_COOLDOWN_MS` | `1800000` | The same alert is delivered at most once per cooldown. |
| `ALERT_HEAD_LAG_BLOCKS` | `12` | Head lag above this many blocks counts as lagging. |
| `ALERT_HEAD_LAG_MS` | `300000` | Alert once lag has stayed above the limit this long. |

## Commands

| Command | What it does | Exit codes |
|---|---|---|
| `run` | Ingests, and runs the quality, reconcile and lag timers beside the pipeline. SIGINT/SIGTERM stop the timers, wait for running cycles, close the status server and end the run as `failed/interrupted`. | 0 finished or interrupted, 1 error or lock held by another indexer, 2 halted: reorg at or below the finalized block (do not restart blindly) |
| `verify` | Integrity SQL over stored data; prints a JSON report. | 0 ok, 1 problems found |
| `rebuild-verify` | Re-decodes every stored log and compares with the decoded tables; prints JSON. Needs the full `run` environment (contracts come from it). | 0 equal, 1 differs |
| `reconciliations --unexplained` | JSON list of second-source mismatches without an explanation. | 0, 2 on bad usage |
| `explain-reconciliation <id> <text>` | Records why mismatch `<id>` is understood. Only mismatches take an explanation. | 0 ok, 1 unknown id or not a mismatch, 2 bad usage |
| `lag-report [--since <ISO timestamp\|72h>]` | Head and finalized lag percentiles from `ops.lag_samples`; default window `24h`. | 0, 1 on a bad `--since` |

`verify`, `reconciliations`, `explain-reconciliation` and `lag-report` need only `DATABASE_URL` and `CHAIN_ID`.

## Reading the M3 gate inputs

- **Lag:** `lag-report --since 72h`. Read `headLag.p95` (blocks the stored tip trails the head) and `finalizedLag.p95`. `samples` must cover the window; `unknownTip` counts samples taken before anything was stored and is excluded from the percentiles.
- **Ranges by status:** `GET /status`, field `ranges` (`candidate`, `published`, `failed`, each with ranges, blocks and logs), or `select status, count(*) from ops.ranges group by status`. Healthy: every range at or below the finalized block is `published`, nothing is `failed`, and `backfillJobs.open` is 0. Failed ranges come with a queued backfill job and the failing gate in `ops.quality_results`.
- **Unexplained reconciliations:** `reconciliations --unexplained` must print `[]`. `/status` shows the same as `reconciliation.unexplained`. Each mismatch needs an `explain-reconciliation` before the gate can pass.
- **Rebuild:** `rebuild-verify` must exit 0 (`equal: true`). On exit 1 read `tables[].firstDifferences` for the first differing positions.
