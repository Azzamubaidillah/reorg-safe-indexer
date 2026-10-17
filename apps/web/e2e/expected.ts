import { chain, FIRST_BLOCK, PUBLISHED_TO } from "./fixture.ts";

// What the API must return for the seeded published ranges, computed straight from the synthetic chain.
export const transfers = chain.decoded(FIRST_BLOCK, PUBLISHED_TO).transfers;
export const swaps = chain.decoded(FIRST_BLOCK, PUBLISHED_TO).swaps;

/** Row id the explorer renders for a log. */
export const rowId = (e: { blockNumber: number; logIndex: number }) => `${e.blockNumber}:${e.logIndex}`;

/** Independent of the app's formatter on purpose: plain BigInt division. */
export function units(raw: string, decimals: number): string {
  const v = BigInt(raw);
  const scale = 10n ** BigInt(decimals);
  const whole = (v / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (v % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export const timestampOf = (blockNumber: number) => chain.header(blockNumber).timestamp;
