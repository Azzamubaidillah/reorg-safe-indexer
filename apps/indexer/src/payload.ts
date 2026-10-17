import { createHash } from "node:crypto";
import type { FetchedRange } from "./types.ts";

/**
 * Hash of the range as fetched. Fixed field order and sorted rows make it independent of
 * provider ordering, so re-fetching the same range from any provider yields the same hash.
 */
export function payloadSha256(range: FetchedRange): string {
  const blocks = [...range.blocks]
    .sort((a, b) => a.number - b.number)
    .map((b) => [b.number, b.hash, b.parentHash, b.timestamp]);
  const logs = [...range.logs]
    .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex)
    .map((l) => [l.blockNumber, l.blockHash, l.logIndex, l.txHash, l.txIndex, l.address, l.topics, l.data]);
  return createHash("sha256").update(JSON.stringify({ from: range.from, to: range.to, blocks, logs })).digest("hex");
}
