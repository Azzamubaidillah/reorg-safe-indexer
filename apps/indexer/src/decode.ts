import { decodeEventLog, parseAbi } from "viem";
import type { DecodedRange, Hex, LogPosition, RawLog, TrackedContracts } from "./types.ts";

const abi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);

// keccak256 of the canonical signatures above.
export const TRANSFER_TOPIC: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const SWAP_TOPIC: Hex = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";

const TRANSFER_TOPIC_COUNT = 3;
const SWAP_TOPIC_COUNT = 3;

function position(log: RawLog): LogPosition {
  return { blockNumber: log.blockNumber, blockHash: log.blockHash, logIndex: log.logIndex, txHash: log.txHash };
}

const lower = (a: string) => a.toLowerCase() as Hex;

/** Tokens decode only as Transfer and pools only as Swap; everything else is kept as a reject, never dropped. */
export function decodeRange(logs: RawLog[], contracts: TrackedContracts): DecodedRange {
  const tokens = new Set(contracts.tokens);
  const pools = new Set(contracts.pools);
  const out: DecodedRange = { transfers: [], swaps: [], rejects: [] };

  for (const log of logs) {
    const reject = (reason: string) => out.rejects.push({ log, reason });
    const topic0 = log.topics[0];
    try {
      if (tokens.has(log.address) && topic0 === TRANSFER_TOPIC) {
        // ERC-721 Transfer shares the topic0 but indexes tokenId (4 topics).
        if (log.topics.length !== TRANSFER_TOPIC_COUNT) {
          reject(`Transfer with ${log.topics.length} topics`);
          continue;
        }
        const { args } = decodeEventLog({ abi, eventName: "Transfer", topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
        out.transfers.push({
          ...position(log),
          token: log.address,
          from: lower(args.from),
          to: lower(args.to),
          value: args.value.toString(),
        });
      } else if (pools.has(log.address) && topic0 === SWAP_TOPIC) {
        if (log.topics.length !== SWAP_TOPIC_COUNT) {
          reject(`Swap with ${log.topics.length} topics`);
          continue;
        }
        const { args } = decodeEventLog({ abi, eventName: "Swap", topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
        out.swaps.push({
          ...position(log),
          pool: log.address,
          sender: lower(args.sender),
          recipient: lower(args.recipient),
          amount0: args.amount0.toString(),
          amount1: args.amount1.toString(),
          sqrtPriceX96: args.sqrtPriceX96.toString(),
          liquidity: args.liquidity.toString(),
          tick: args.tick,
        });
      } else {
        reject(tokens.has(log.address) || pools.has(log.address) ? `unexpected topic0 ${topic0}` : "untracked address");
      }
    } catch (err) {
      reject(`decode failed: ${(err as Error).message.split("\n")[0]}`);
    }
  }
  return out;
}
