# Decisions

Architecture decision records, in the order the system was built. Each entry gives the context, what I decided and what that costs. "Evidence" points at code or tests in this repository. 

Index: [001 chain](#adr-001-ethereum-l1-not-an-l2) · [002 build vs buy](#adr-002-write-the-indexer-instead-of-using-ponder-or-the-graph) · [003 language](#adr-003-typescript-everywhere) · [004 storage](#adr-004-postgres-as-the-source-of-truth-two-schemas) · [005 commit unit](#adr-005-one-transaction-per-block-range-the-range-row-is-the-checkpoint) · [006 finality](#adr-006-the-finalized-tag-defines-the-reorg-window) · [007 reorg signal](#adr-007-parent-hash-continuity-is-the-reorg-signal) · [008 rollback](#adr-008-roll-back-whole-ranges) · [009 halt](#adr-009-halt-on-a-fork-at-or-below-the-finalized-block) · [010 landing table](#adr-010-keep-raw-logs-in-a-landing-table-decode-into-separate-tables) · [011 publish](#adr-011-fail-closed-publish-after-seven-sql-gates) · [012 backfill ids](#adr-012-deterministic-backfill-job-ids) · [013 reconciliation](#adr-013-second-source-reconciliation) · [014 rebuild](#adr-014-rebuild-verification) · [015 Parquet](#adr-015-parquet-and-duckdb-for-scan-heavy-aggregates-with-deterministic-output) · [016 API](#adr-016-read-only-api-with-fail-closed-queries-and-keyset-pagination) · [017 RPC pool](#adr-017-classify-rpc-errors-and-let-the-pool-decide) · [018 lock](#adr-018-one-indexer-per-chain-via-an-advisory-lock) · [019 observability](#adr-019-operational-state-lives-in-postgres-alerts-are-log-only-until-configured) · [020 retention](#adr-020-retention-by-reacquirability) · [021 tests](#adr-021-test-the-failure-paths-with-a-mock-rpc-and-a-real-node) · [022 abort handling](#adr-022-per-call-abort-promises) · [023 sticky halt](#adr-023-a-halt-is-sticky-until-acknowledged)

## ADR-001: Ethereum L1, not an L2

**Context.** The project exists to demonstrate reorg-safe ingestion. A reorg-safe indexer that has never seen a reorg proves little.

**Decision.** Index Ethereum mainnet (`CHAIN_ID=1`, the default). Base had a single L2 reorg ever, so an L2 would leave the reorg path almost entirely untested against reality. L1 produces real, shallow reorgs.

**Consequences.** Block time is 12 s and finality takes two epochs (about 12.8 min), which keeps the reorg window small enough to test and large enough to matter. L1 `eth_getLogs` is heavier than on most L2s (about 83 logs per block for the two contracts, [M1 gate](m1-gate.md)). The live evidence is one depth-1 reorg at block 26,212,486, rolled back and later confirmed against two independent providers. One observed reorg is an anecdote; the Anvil suite (ADR-021) is what exercises depths 1 to above the window.

## ADR-002: Write the indexer instead of using Ponder or The Graph

**Context.** [Ponder](https://ponder.sh) and The Graph both handle reorgs, checkpoints and an API. For a product, buying is the right answer.

**Decision.** Build the ingestion, reorg, quality and publish layers myself, because they are the skill being shown, and treat Ponder as the baseline to compare against.

**Consequences.** More code to own: roughly 5,600 lines of TypeScript in the indexer, API and packages (tests and dashboard not counted). No plugin ecosystem, no multi-contract generator, one instance. In exchange every failure path is explicit and each has a test ([failure-modes.md](failure-modes.md)). What this does not claim: that it is better than Ponder. It is narrower and slower to extend.

## ADR-003: TypeScript everywhere

**Context.** The system has an ingestion service, an HTTP API and a dashboard. Money-like values (uint256 token amounts) cross all of them.

**Decision.** TypeScript on Node 22 for all of it, in a pnpm workspace. `packages/contracts` holds Zod schemas that the API validates against and the dashboard imports, so the wire format has one definition. `viem` decodes events, Drizzle owns the schema and migrations, Fastify serves the API, Next.js the UI. The images run the sources with `tsx`; there is no separate build step for the indexer or API.

**Consequences.** One language and one set of types end to end; amounts are base-10 strings in JSON and NUMERIC(78,0) in Postgres so no uint256 is ever a JavaScript number. The cost is runtime TypeScript execution through `tsx` and a single-threaded runtime, which is fine at about 1,100 logs/s but is a ceiling. The heap leak found in M1 (ADR-022) is the kind of problem a managed-memory runtime does not remove.

## ADR-004: Postgres as the source of truth, two schemas

**Context.** Reorg handling needs deletes and inserts that either all happen or none do, and resume needs a durable checkpoint.

**Decision.** Postgres 17. Schema `chain` holds indexed data (`blocks`, landing `logs`, `erc20_transfers`, `uniswap_v3_swaps`); schema `ops` holds evidence about how it got there (`runs`, `ranges`, `reorgs`, `quality_results`, `backfill_jobs`, `reconciliations`, `lag_samples`). Hashes and addresses are lowercase `0x` hex text; amounts are `NUMERIC(78,0)`, which holds uint256 and int256. Constraints carry invariants where cheap: status and action checks, a shape check on `ops.reorgs` that makes `rolled_back` rows carry an ancestor and `halted` rows carry none ([schema.ts](../packages/db/src/schema.ts)).

**Consequences.** Everything is one transaction boundary. Storage is large, about 86 KB per block live, because decoded rows duplicate raw logs (ADR-010); retention bounds it (ADR-020). Primary keys are `(chain_id, block_hash, log_index)` for logs, so a reorged block's rows cannot collide with the canonical ones.

## ADR-005: One transaction per block range; the range row is the checkpoint

**Context.** A crash mid-batch must leave neither partial data nor a gap.

**Decision.** The unit of commit is a range of `RANGE_SIZE` blocks (default 100). `commitRange` writes headers, landing logs, decoded rows and the `ops.ranges` row in one transaction ([store.ts](../apps/indexer/src/store.ts)). Resume is `max(to_block) + 1` over `ops.ranges`; there is no separate checkpoint to disagree with the data. Ranges are fetched up to `FETCH_CONCURRENCY` ahead but committed strictly in order, so committed ranges always form a contiguous prefix. Each range stores `payload_sha256`, a hash of the canonicalised headers and logs; re-committing an identical range is a no-op and a different payload for the same start block is an error.

**Consequences.** After `kill -9`, at most the in-flight ranges are lost and refetched (the M1 gate killed at 60 of 500 ranges and resumed with 0 gaps and 0 duplicates). Throughput is bounded by in-order commits. The payload hash catches a provider that returns different data for a range already committed. Evidence: [crash-resume.int.test.ts](../apps/indexer/test/crash-resume.int.test.ts), [store.int.test.ts](../apps/indexer/test/store.int.test.ts) (atomicity, idempotent recommit, payload mismatch).

## ADR-006: The `finalized` tag defines the reorg window

**Context.** "N confirmations" is a guess that is wrong at some depth. Post-merge Ethereum has a protocol-level finality notion.

**Decision.** Follow `latest` for ingestion, and read the provider's `finalized` block tag (refreshed every `POLL_INTERVAL_MS`, default 60 s, since it moves once per epoch). Blocks above `finalized` may reorg and are stored as `candidate`; blocks at or below it must not. The window is whatever the protocol says it is. The pipeline never lets `finalized` go backwards even if providers disagree ([pipeline.ts](../apps/indexer/src/pipeline.ts)). Reorg detection reads a fresh `finalized` at detection time, not the value from the last poll (test: "judges the fork against finality as of detection").

**Consequences.** No magic confirmation count to tune. Dependence on providers implementing the `finalized` tag. A provider that lags on `finalized` makes the window look wider than it is, which is the safe direction.

## ADR-007: Parent-hash continuity is the reorg signal

**Context.** Polling `eth_getLogs` does not say that a log you already stored was removed, and block numbers alone cannot show a fork.

**Decision.** Every range is stored with headers. A new range is accepted only if its first header's `parent_hash` equals the stored hash of the block below ([store.ts](../apps/indexer/src/store.ts) `ContinuityError`). Inside one fetch, headers and logs must come from the same provider and be consistent: headers contiguous and linked, every log's `blockHash` equal to the header at its height, no `removed` logs ([fetcher.ts](../apps/indexer/src/fetcher.ts)). An inconsistent answer is retried a bounded number of times (8) with backoff, because near the head it usually means a lagging node or a fork settling. A continuity break starts the resolver, which walks down from the stored tip in batches of 32 comparing stored and canonical hashes to find the common ancestor.

**Consequences.** Detection happens on the next range commit, not instantly, and needs one header per block (about 1 `eth_getBlockByNumber` per block, which dominates the RPC budget; see [costs-and-load.md](costs-and-load.md)). The resolver has a `no_fork` outcome: if the stored tip is still canonical, the fetched range came from a node on another view, and the indexer refetches instead of deleting anything. After 8 consecutive spurious breaks it fails.

## ADR-008: Roll back whole ranges

**Context.** After finding the common ancestor, one could delete exactly the orphaned blocks, or whole ranges.

**Decision.** Delete every range that reaches past the ancestor, including its still-canonical blocks below the ancestor, and restart ingest at the first deleted block ([store.ts](../apps/indexer/src/store.ts) `rollbackTo`). The deletes and the `ops.reorgs` audit row (orphaned and canonical block lists, depth, finalized block) are one transaction.

**Consequences.** A range is always either fully present with its checkpoint row or absent, so `ops.ranges` stays a truthful ledger and gate counts per range stay exact. The price is a few extra blocks refetched per reorg (at most `RANGE_SIZE - 1`). Test: "drops whole ranges past the ancestor, including their still-canonical blocks, and nothing else" and "is atomic: a failed audit insert undoes the deletes" ([store.int.test.ts](../apps/indexer/test/store.int.test.ts)); replay equals fresh ingest ([reorg.int.test.ts](../apps/indexer/test/reorg.int.test.ts)).

## ADR-009: Halt on a fork at or below the finalized block

**Context.** Finalized blocks reverting means either a provider is wrong or the chain failed in a way no indexer should guess about.

**Decision.** The ancestor search never looks below `max(finalized, lowest stored block)`. If no common ancestor exists at or above that floor, the indexer writes a `halted` row to `ops.reorgs`, deletes nothing, throws `ReorgBelowFinalizedError`, and exits with code 2. A halt alert is sent before the process ends. The halt then stays in force until a human acknowledges it (ADR-023); [operations.md](operations.md), [runbook.md](runbook.md).

**Consequences.** Availability is deliberately sacrificed for correctness; data stays exactly as it was for inspection. A faulty provider that reports a bogus fork would stop the indexer, which is annoying but recoverable and visible. Tests: Anvil `halts with exit code 2 on a depth-N reorg` at the window size and window + 10 ([reorg.anvil.test.ts](../apps/indexer/test/anvil/reorg.anvil.test.ts)); "fork below finalized" cases in [reorg.int.test.ts](../apps/indexer/test/reorg.int.test.ts).

## ADR-010: Keep raw logs in a landing table; decode into separate tables

**Context.** Decoders get fixed and extended. Without the raw logs, a decoder bug means going back to the network.

**Decision.** `chain.logs` stores every fetched log as returned. `erc20_transfers` and `uniswap_v3_swaps` are derived. Logs that match the filter but do not decode are never dropped: they are counted in `ops.ranges.reject_count`, so `transfers + swaps + rejects = logs` is an invariant a gate can check ([decode.ts](../apps/indexer/src/decode.ts); an ERC-721 `Transfer` shares topic0 with ERC-20 and is rejected by topic count).

**Consequences.** Decoded tables are a pure function of the landing table, which makes ADR-014 possible and makes retention classes (ADR-020) meaningful. The cost is the 99% of storage that `logs` and `erc20_transfers` take together (M1 gate: 2,878 MB and 1,967 MB of 4.9 GB).

## ADR-011: Fail-closed publish after seven SQL gates

**Context.** "It ran without errors" is not evidence the data is right. Readers should only see data that was checked.

**Decision.** Ranges start as `candidate`. The quality cycle (default every 60 s) takes each candidate whose `to_block` is at or below the finalized block and runs seven gates, each a SQL query bounded by the range so cost does not grow with history ([quality.ts](../apps/indexer/src/quality.ts)): `decode_rejects_zero`, `counts_consistent`, `blocks_linked`, `log_positions_unique`, `log_block_hash_matches`, `value_bounds`, `decoded_matches_landing`. All pass: the range becomes `published` and results, status and job resolution are written in one transaction. Any fails: the range becomes `failed` and one backfill job is queued. Failed ranges are not re-gated; only a backfill can change them. The API and the Parquet export read published ranges only.

**Consequences.** A bug that corrupts data makes data disappear from readers rather than appear wrong, and the dashboard shows which gate failed. A noisy gate (for example one rejected log) hides a whole range of 100 blocks until someone looks. The gates catch structural damage and internal inconsistency, not a provider that consistently returns wrong logs; that is what ADR-013 is for. Tests: table-driven corruptions that must each fail the intended gate, plus "publishes a range ending exactly at the finalized block and not one ending a block above it" ([quality.int.test.ts](../apps/indexer/test/quality.int.test.ts)).

## ADR-012: Deterministic backfill job ids

**Context.** A failing range is re-checked and re-failed; retries and crashes must not multiply work or lose it.

**Decision.** A job's id is `<chain>:<from>-<to>`, and `(chain_id, from_block, to_block)` is also unique. Failing again updates the existing job (status back to `queued`, new reason) instead of inserting. Backfill re-fetches the range, then swaps old rows for new in one transaction, but only if the new first header links to the stored block below and the new last header is the parent of the stored block above; otherwise the job is re-queued with the reason and nothing changes. Jobs are worked oldest-touched first, at most `QUALITY_MAX_BACKFILLS` (2) per cycle, so a stuck job cannot starve others. A job left `running` by a crashed process is re-queued at the next cycle.

**Consequences.** Any number of repeats converge on one job per range; the crash case needs no cleanup procedure. A range whose re-fetch keeps failing stays queued forever and needs a human ([runbook.md](runbook.md), stuck backfill). Tests: "keeps one job and one result row per gate", "refuses a re-fetch whose first header does not extend the stored block below", "picks up a job left running by a crashed process" ([quality.int.test.ts](../apps/indexer/test/quality.int.test.ts)).

## ADR-013: Second-source reconciliation

**Context.** Everything so far trusts the provider that served the data. A provider that silently omits logs would pass every internal gate.

**Decision.** An optional reconciler (`RECONCILE_PROVIDER`, name must differ from every ingest provider) re-reads finalized, non-failed ranges from a different provider: the last block's header and `eth_getLogs` for the range. It compares log identity (block number, block hash, log index, tx hash) and block hashes, and writes one `ops.reconciliations` row per range with status `match` or `mismatch`. A second source that has not reached the range, or fails, writes no row and is retried; it is not recorded as a mismatch. Mismatches need a human `explain-reconciliation` text before the M3 gate can pass ([reconcile.ts](../apps/indexer/src/reconcile.ts)).

**Consequences.** Costs about one header call and one `eth_getLogs` per range on the second provider, a small fraction of ingest cost. It checks hashes at heights where logs exist plus the last block, not every block's hash (blocks with no tracked logs are not compared). Two providers agreeing is stronger evidence than one, but they could share an upstream node. Tests: [reconcile.int.test.ts](../apps/indexer/test/reconcile.int.test.ts) (missing log, wrong block hash, competing fork, not-yet-synced second source).

## ADR-014: Rebuild verification

**Context.** Decoded tables should be reproducible from the landing table, otherwise they have drifted somewhere.

**Decision.** `rebuild-verify` re-decodes every stored log into temporary tables inside one read snapshot and compares ordered content hashes with the stored decoded tables, reporting the first differing positions ([rebuild.ts](../apps/indexer/src/rebuild.ts)). It writes nothing to production tables, and its memory use is flat because rows stay in Postgres.

**Consequences.** A decoder change, a manual edit or a bug is caught as a difference with a position. It reads the whole landing table, so it is an on-demand check, not a cycle. Tests: tampered value, deleted row, extra row, changed landing log, reject count disagreement ([rebuild.int.test.ts](../apps/indexer/test/rebuild.int.test.ts)).

## ADR-015: Parquet and DuckDB for scan-heavy aggregates, with deterministic output

**Context.** Daily volume and OHLC are scans over millions of rows. Postgres can do it, but a columnar copy answers faster and keeps heavy scans away from the transactional store.

**Decision.** Export published ranges only to day-partitioned Parquet files (`transfers/day=YYYY-MM-DD/data.parquet`, same for swaps) with a manifest recording each file's row count and SHA-256 and which block intervals are included. A day is never patched: it is rewritten whole from Postgres in a repeatable-read snapshot and replaced atomically. Rows are ordered (`order by 1, 2`) so the same rows always produce the same bytes. uint256 and int256 amounts are split into chunks so DuckDB aggregates stay exact ([export.ts](../packages/analytics/src/export.ts), [amounts.test.ts](../packages/analytics/test/amounts.test.ts)). `verifyAnalytics` checks manifest and coverage, file hashes, row counts, sampled-day aggregates against SQL on the chain tables, and a full re-export into a scratch directory that must reproduce every partition's hash.

**Consequences.** Parquet is derived and disposable. If it is lost or suspect, it is rebuilt from Postgres, and byte determinism is how I know the rebuild is the same data. The cost is a second system to run and a freshness lag (the export runs on an interval, `ANALYTICS_EXPORT_INTERVAL_MS`). Verify should run while the indexer is idle or newly published ranges show up as an export gap, not corruption.

## ADR-016: Read-only API with fail-closed queries and keyset pagination

**Context.** The API is the public surface. It must never show candidate or failed data and must stay fast as tables grow.

**Decision.** The Fastify API has only `GET`, `HEAD` and `OPTIONS` routes. Event queries (`/v1/transfers`, `/v1/swaps`) show a row only if its block is inside a `published` range, with two guards: an uncorrelated upper bound at the highest published block (an index condition) and a per-row probe for the containing range. Pagination is keyset on `(block_number desc, log_index desc)`; the cursor is that pair, base64url-encoded and re-validated on decode so a forged cursor is a 400 and never SQL input ([events.ts](../apps/api/src/events.ts), [http.ts](../apps/api/src/http.ts)). Inputs are validated with the shared Zod schemas before any I/O. Defaults: loopback bind, `API_CORS_ORIGIN=*` since nothing carries credentials. Errors use one envelope and do not leak internals.

**Consequences.** Offset pagination would go slow and shift under a moving tip; keyset stays constant-cost and is stable while new ranges publish mid-walk (tested). The API does not authenticate. The query user needs only `SELECT`; the repository does not create or enforce a database role, so using a read-only role for the API's `DATABASE_URL` is a deployment step ([runbook.md](runbook.md)). Tests: [api.int.test.ts](../apps/api/test/api.int.test.ts) ("hides rows of a range the moment it leaves published", "is stable while newer ranges are committed and published mid-walk").

## ADR-017: Classify RPC errors and let the pool decide

**Context.** Public RPCs fail in provider-specific ways: span limits, 429s, pruned history, timeouts.

**Decision.** Each failure is classified from HTTP status and message into `range_too_large`, `rate_limited`, `unsupported` or `transient` ([errors.ts](../apps/indexer/src/rpc/errors.ts); the message patterns come from real provider answers kept in a fixture). `range_too_large` is not retried by the pool; `eth_getLogs` halves the span and retries on the same provider, down to one block. `rate_limited` cools that provider down (honouring `Retry-After`) and moves on. `unsupported` skips the provider for the rest of that operation. `transient` backs off exponentially, capped at 30 s, rotating providers; the pool gives up after 8 attempts. Per-provider `maxSpan`, `rps` and `batchSize` are configuration, not discovered.

**Consequences.** Rate limits cost time, not correctness. Classification by regex on messages is fragile by nature: a new provider message may be classed `transient` and just retried until the attempt limit. Tests: [pool.test.ts](../apps/indexer/test/rpc/pool.test.ts), [errors.test.ts](../apps/indexer/test/rpc/errors.test.ts), [fetcher.test.ts](../apps/indexer/test/fetcher.test.ts).

## ADR-018: One indexer per chain via an advisory lock

**Context.** Two writers on one chain would race on checkpoints and rollbacks.

**Decision.** `run` takes `pg_try_advisory_lock(namespace, chainId)` on a dedicated connection. A second process exits with code 1. Postgres releases the lock if the process dies, so a stale lock cannot survive a crash, and on start the new process marks leftover `running` runs `failed/abandoned` ([main.ts](../apps/indexer/src/main.ts)).

**Consequences.** Exactly one writer, no lease management. No standby: failover is a restart. Test: "refuses a second concurrent run, leaves the first untouched, and stops the first cleanly on SIGTERM" ([crash-resume.int.test.ts](../apps/indexer/test/crash-resume.int.test.ts)).

## ADR-019: Operational state lives in Postgres; alerts are log-only until configured

**Context.** I wanted lag percentiles, evidence and status without running a metrics stack.

**Decision.** The indexer samples head, finalized and stored tip into `ops.lag_samples` (default every 10 s, pruned after 14 days) and `lag-report` computes percentiles from it. A small server exposes Prometheus `/metrics`, `/healthz` (503 when no head poll or commit for `HEALTH_STALE_AFTER_MS`) and `/status`. The API's `/v1/status` is derived from the database alone, so the dashboard works even if the indexer is down. Alerts (halt, gate failure, reconciliation mismatch, run crash, head lag, background task failure) go to Telegram when both variables are set and are otherwise logged with an `alert` field. Alerts are de-duplicated per key within `ALERT_COOLDOWN_MS` and a Telegram failure never takes the indexer down ([alerts.ts](../apps/indexer/src/alerts.ts)).

**Consequences.** Percentiles are exact for the window and cost one small table. Without Telegram configured, nobody is paged; that is a deployment choice stated plainly in the runbook.

## ADR-020: Retention by reacquirability

**Context.** Storage grew by about 86 KB per block live (about 700 MiB a day) and is dominated by data that is either refetchable or derivable.

**Decision.** Classify data by how it can be recovered, and let that decide what may be deleted ([retention.ts](../apps/indexer/src/retention.ts)):

| Class | Tables | Recoverable from | Policy |
|---|---|---|---|
| Landing logs | `chain.logs` | Refetch from providers by block range | Purged per range after `LANDING_RETENTION_DAYS` (default 7) |
| Decoded rows | `erc20_transfers`, `uniswap_v3_swaps` | Rebuilt from landing logs while they exist, refetched afterwards | Purged per range after `DECODED_RETENTION_DAYS` (unset: kept forever) |
| Irreplaceable | `chain.blocks`, all `ops.*` tables | Nothing: headers anchor continuity and the ops tables are the evidence trail | Never deleted |

A timer walks ranges oldest first, one transaction per range, and records the step on the range row (`landing_purged_at`, `decoded_purged_at`, migration `0003_ops_range_retention`). Counts stay, so a purged range still describes itself. A check constraint says a purge needs a published range and that decoded is never purged before landing.

Blockers, checked in SQL and again under the range's row lock inside the purge transaction (so a backfill racing the cycle wins):

- **Landing purge:** the range is `published`; its last block is older than the limit; and, once the reconciler has written any row for the chain, the range has a `match` reconciliation row. A mismatch or a missing row keeps the logs, because they are the evidence.
- **Decoded purge:** landing is already purged; the range is older than the decoded limit; the Parquet manifest (`ANALYTICS_MANIFEST_PATH`) lists the range as exported; and no unexported range exists earlier in the same UTC day. The exporter rewrites a whole day from Postgres, so purging part of a day that still has an unexported range could make the next rewrite lose rows. The process refuses to start with `DECODED_RETENTION_DAYS` set and no manifest path.

Consumers were changed to match: `verify` skips only the parts that were purged, `rebuild-verify` covers ranges whose logs are present and reports `skippedRanges`, the reconciler skips landing-purged ranges instead of recording a false mismatch, and `analytics verify` compares Postgres with Parquet only for days fully retained in Postgres and lists the rest as `purgedDays`. The exporter throws before writing anything if an export would rewrite a day that contains a decoded-purged range.

**Consequences.** Steady-state size is bounded (see [costs-and-load.md](costs-and-load.md#storage)). The real cost: after a decoded purge the Parquet store is the only copy of those days, and `/v1/transfers` and `/v1/swaps` return nothing for them (use the analytics endpoints). It must be backed up and never deleted. `rebuild-verify` and the `decoded_matches_landing` gate cannot cover purged windows. Deleted rows free space inside the tables, they do not shrink the files. Tests: [retention.int.test.ts](../apps/indexer/test/retention.int.test.ts) (reconciliation blockers, range-lock re-check, UTC-day barrier, dry run equals the cycle, consumers of purged ranges), [m3-e2e.int.test.ts](../apps/indexer/test/m3-e2e.int.test.ts) (timer purges, `verify` and `rebuild-verify` stay green), [analytics.int.test.ts](../packages/analytics/test/analytics.int.test.ts) (exporter refusal, `analytics verify` after purges).

## ADR-021: Test the failure paths with a mock RPC and a real node

**Context.** A reorg handler that only passes tests written against its own assumptions proves little.

**Decision.** Two reorg suites. Thirteen replay cases against a mock RPC with a synthetic chain whose forks are scripted (depths 1, 3, 12, ancestor exactly at finalized, fork while the indexer was down, fork and fork back, forks while ranges are in flight, forks below finalized). Seven cases against a real Anvil node using `anvil_reorg`, including halt below finalized and two successive reorgs. Both run 10 times as independent CI jobs and all 10 must pass, since "usually green" is not a property of a reorg handler. The dashboard E2E gets the same 10-run treatment. Integration tests run real Postgres, not mocks of it.

**Consequences.** CI is slow and heavy compared with the amount of code. A flake in these suites is treated as a bug in the indexer or the test, not noise. Tests use no public network.

## ADR-022: Per-call abort promises

**Context.** The M1 gate run died from out-of-memory after about 230 ranges. Every `await` in the pipeline raced one long-lived, never-settling abort promise. Each `Promise.race` adds a reaction to that promise that keeps the settled value, an entire fetched range, reachable forever: about 9 MB per range.

**Decision.** `untilAborted` creates a fresh abort promise per call and removes its listener when the awaited promise settles ([pipeline.ts](../apps/indexer/src/pipeline.ts)). A GC-based regression test checks that settled values are not kept reachable through a long-lived signal ([until-aborted.test.ts](../apps/indexer/test/until-aborted.test.ts)).

**Consequences.** Memory is flat over a long run. The lesson I took from it: the fault was invisible to every functional test, and only a run longer than a minute found it, which is why the gate is a real 50,000-block run and not a unit suite.

## ADR-023: A halt is sticky until acknowledged

**Context.** Exit code 2 was meant to tell the supervisor not to restart blindly. Docker's `restart: on-failure` cannot exclude one exit code, so in the Docker deployment a halt became a restart loop, each restart querying the provider and halting again.

**Decision.** The halt is recorded in the database and enforced there. On startup, right after taking the chain lock and before any RPC call, `run` looks for a `halted` row in `ops.reorgs` without `acknowledged_at`. If one exists it logs fatal (`halted: unacknowledged reorg #<id>`), sends a `halt-unacknowledged` alert, records a failed run with that reason, and exits 2. `ack-halt <reorgId> <text>` sets `acknowledged_at` and the text, which must not be empty and which only unacknowledged `halted` rows accept. A check constraint ties acknowledgement to halted rows with non-empty text. Migration `0004_ops_reorg_ack` marks halts that existed before it as acknowledged (`predates sticky halts`) so the upgrade cannot block a running indexer. If the provider still serves the fork after acknowledgement, the run halts again as a new row and blocks again.

**Consequences.** A restart loop costs one database round trip per attempt and calls no provider. Resuming needs a person to look and write down what they found, which also leaves that text in the audit table. The cost is that a halt cannot clear itself, even when it was a transient provider fault; that is intended. Tests: [reorg.int.test.ts](../apps/indexer/test/reorg.int.test.ts), describe "a halt stays in force until it is acknowledged" ("makes a restart exit 2 without a single RPC call, recording one failed run and alerting", "lets the run proceed after ack-halt and halts again, as a new unacknowledged row, when the fork is still there", "resumes ingesting after the acknowledgement once the provider serves the stored chain again", "ack-halt refuses bad usage, unknown ids and halts that are already acknowledged").
