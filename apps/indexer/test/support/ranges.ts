import type { Database } from "@rsi/db";
import { decodeRange } from "../../src/decode.ts";
import { payloadSha256 } from "../../src/payload.ts";
import { commitRange } from "../../src/store.ts";
import type { TrackedContracts } from "../../src/types.ts";
import type { SyntheticChain } from "./synthetic-chain.ts";

export const CHAIN_ID = 1;
export const RUN_ID = "run-1";
/** Three adjacent 20-block ranges. */
export const RANGES = [
  [1000, 1019],
  [1020, 1039],
  [1040, 1059],
] as const;

export const contractsOf = (chain: SyntheticChain): TrackedContracts => ({ tokens: chain.tokens, pools: chain.pools });

/** Commits `ranges` of `chain` exactly as the pipeline would: fetched logs decoded with decodeRange. */
export async function commitRanges(database: Database, chain: SyntheticChain, ranges: readonly (readonly [number, number])[] = RANGES): Promise<void> {
  for (const [from, to] of ranges) {
    const range = chain.fetched(from, to);
    await commitRange(database, {
      chainId: CHAIN_ID,
      runId: RUN_ID,
      range,
      decoded: decodeRange(range.logs, contractsOf(chain)),
      payloadSha256: payloadSha256(range),
      rpcCalls: {},
    });
  }
}
