export type Hex = `0x${string}`;

/** Header fields the indexer keeps. Hashes are lowercase hex; timestamp is unix seconds. */
export interface BlockHeader {
  number: number;
  hash: Hex;
  parentHash: Hex;
  timestamp: number;
}

/** A log as returned by eth_getLogs, normalised to numbers and lowercase hex. */
export interface RawLog {
  blockNumber: number;
  blockHash: Hex;
  logIndex: number;
  txHash: Hex;
  txIndex: number;
  address: Hex;
  topics: Hex[];
  data: Hex;
}

/** Everything fetched for one inclusive block range, validated as one consistent chain segment. */
export interface FetchedRange {
  from: number;
  to: number;
  /** Exactly to - from + 1 headers, ascending, each linked to the previous by parentHash. */
  blocks: BlockHeader[];
  /** Sorted by (blockNumber, logIndex); every blockHash matches the header at that height. */
  logs: RawLog[];
}

export interface LogPosition {
  blockNumber: number;
  blockHash: Hex;
  logIndex: number;
  txHash: Hex;
}

export interface Erc20Transfer extends LogPosition {
  token: Hex;
  from: Hex;
  to: Hex;
  /** uint256 as a base-10 string. */
  value: string;
}

export interface UniswapV3Swap extends LogPosition {
  pool: Hex;
  sender: Hex;
  recipient: Hex;
  /** int256 / uint160 / uint128 values as base-10 strings. */
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
}

export interface DecodedRange {
  transfers: Erc20Transfer[];
  swaps: UniswapV3Swap[];
  /** Logs that matched the filter but could not be decoded as a tracked event. */
  rejects: { log: RawLog; reason: string }[];
}

export interface TrackedContracts {
  tokens: Hex[];
  pools: Hex[];
}
