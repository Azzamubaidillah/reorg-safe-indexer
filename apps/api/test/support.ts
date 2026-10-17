import type { Database } from "@rsi/db";
import { decodeRange } from "../../indexer/src/decode.ts";
import { payloadSha256 } from "../../indexer/src/payload.ts";
import { commitRange } from "../../indexer/src/store.ts";
import type { Hex } from "../../indexer/src/types.ts";
import type { SyntheticChain } from "../../indexer/test/support/synthetic-chain.ts";

export const CHAIN_ID = 1;
export const RUN_ID = "run-1";

/** Distinct from the synthetic default so filters have something to exclude. */
export const TOKENS: Hex[] = ["0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"];
export const POOLS: Hex[] = ["0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640", "0x8ad599c3a0ff1de082011efddc58f1908eb6e6d8"];

export const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

/** Commits [from, to] ranges of `chain` exactly as the pipeline does; ranges are candidates until `setStatus` is called. */
export async function commitSpans(database: Database, chain: SyntheticChain, spans: readonly (readonly [number, number])[], chainId = CHAIN_ID, runId = RUN_ID): Promise<void> {
  for (const [from, to] of spans) {
    const range = chain.fetched(from, to);
    await commitRange(database, {
      chainId,
      runId,
      range,
      decoded: decodeRange(range.logs, { tokens: chain.tokens, pools: chain.pools }),
      payloadSha256: payloadSha256(range),
      rpcCalls: {},
    });
  }
}

export async function setStatus(database: Database, fromBlock: number, status: "candidate" | "published" | "failed", chainId = CHAIN_ID): Promise<void> {
  await database.sql`
    update ops.ranges
    set status = ${status}, published_at = ${status === "published" ? database.sql`now()` : null}
    where chain_id = ${chainId} and from_block = ${fromBlock}`;
}
