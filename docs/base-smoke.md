# Base smoke run (chain 8453)

A local, short run on Base mainnet, to show the indexer runs on a second chain by configuration only. It is a smoke test, not a gate: Base is not deployed. Run on 2026-10-18 against keyless public endpoints.

## Contracts (checked on-chain)

| Contract | Address | Check |
|---|---|---|
| USDC | `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913` | `decimals()` = 6 |
| WETH | `0x4200000000000000000000000000000000000006` | `decimals()` = 18 |
| Uniswap v3 WETH/USDC 0.05% | `0xd0b53d9277642d899df5c87a3966a349a798f224` | factory `0x33128a8f…6fdfd` `getPool(WETH, USDC, 500)` returns it; `token0()` = WETH, `token1()` = USDC, `fee()` = 500 |

WETH sorts before USDC on Base, the reverse of mainnet, so the readable price (USDC per ETH) is `token1PerToken0` here and `token0PerToken1` on mainnet. The chain presets (`packages/contracts/src/chains.ts`) carry that per pool; `packages/analytics/test/metadata.test.ts` checks the Base direction against a hand-computed `sqrtPriceX96`.

## Endpoints (probed with a few requests each)

| Endpoint | `eth_getLogs` for these two contracts | Notes |
|---|---|---|
| `mainnet.base.org` | refused from this host during the run (`request limit reached`, HTTP 429) | `eth_blockNumber` still answered; Base documents a 2,000-block span limit |
| `base-rpc.publicnode.com` | 100 blocks fine; 1,000 blocks: `query exceeds max results 20000, retry with the range …` | no history beyond roughly 8,000 to 10,000 blocks without a token |
| `base.drpc.org` | 100 blocks fine; 1,000 blocks: `ranges over 10000 blocks are not supported on free plan` | |
| `base-mainnet.public.blastapi.io` | 10-block limit | used as the reconcile source |
| `base.meowrpc.com` | `The method eth_getLogs is not supported.` | |

publicnode's "max results" message was not recognised as a span error before this run (it would have been retried as transient instead of split). It is now classified `range_too_large`; the real body is a fixture in `apps/indexer/test/rpc/fixtures/real-errors.json`.

## Run

Configuration: `CHAIN_ID=8453` (contracts from the preset), `RPC_PROVIDERS` = publicnode (`maxSpan` 100) then drpc, `RECONCILE_PROVIDER` = blastapi, `RANGE_SIZE=100`.

1. Backfill: `START_BLOCK` = finalized − 3,000 = 52,752,815, `END_BLOCK` = 52,755,814. 30 ranges in 383 s (about 7.8 blocks/s), exit 0. Calls: 30 `eth_getLogs`, 3,001 `eth_getBlockByNumber`, all served by publicnode.
2. Follow the head for 6 minutes without `END_BLOCK`, then SIGTERM: 81 more commits covering 988 blocks in 335 s while catching up with the head (the run started that far behind), exit 0, run row `failed/interrupted`.

| Result | Value |
|---|---|
| Blocks stored | 3,988 (52,752,815 … 52,756,802), every parent link intact |
| Published ranges (finalized, all 7 gates passed) | 33: 3,300 blocks, 196,017 logs, 195,313 transfers, 704 swaps, 0 rejects |
| Candidate ranges (above finalized) | 78: 688 blocks |
| Quality gate failures | 0 |
| Second-source reconciliation (blastapi) | 33 match, 0 mismatch; 3 cycles where blastapi could not answer were retried later, as designed |
| `verify` | ok, 0 problems (3,988 blocks, 233,944 logs) |
| `rebuild-verify` | equal |
| `reconciliations --unexplained` | `[]` |
| Reorgs | none in the window |

## What Base changes

- **Finality window.** `latest − finalized` was 490 to 617 blocks over 72 samples (16 to 21 minutes at 2 s blocks); `finalized` advances in steps of about 200 blocks. The reorg window is about 50 times L1's in blocks, so the ancestor search and the candidate backlog are larger, but the logic is the same.
- **Volume.** About 59 matching logs per block and 72 KB of storage per block (the four `chain` tables, indexes included). At 43,200 blocks a day that is about 3.1 GB a day before retention, against about 0.6 GB on L1. This is why Base is not deployed on the shared host.
- **Endpoints.** Keyless Base endpoints cap results rather than blocks, so the span-splitting path matters more than on L1.

Head lag during this run is not a steady-state number: both runs started behind the head and were catching up for the whole window.
