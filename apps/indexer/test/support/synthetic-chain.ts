import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, toHex } from "viem";
import type { BlockHeader, DecodedRange, Erc20Transfer, FetchedRange, Hex, RawLog, UniswapV3Swap } from "../../src/types.ts";

export const TEST_TOKEN: Hex = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
export const TEST_POOL: Hex = "0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640";
/** Emits Transfer-shaped logs the indexer must never see: the eth_getLogs address filter has to exclude it. */
const DECOY_TOKEN: Hex = "0xdac17f958d2ee523a2206206994597c13d831ec7";

const events = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);

export type SyntheticEntry =
  | { log: RawLog; transfer: Erc20Transfer; swap?: undefined }
  | { log: RawLog; swap: UniswapV3Swap; transfer?: undefined };

export interface Totals {
  blocks: number;
  logs: number;
  transfers: number;
  swaps: number;
}

export interface SyntheticChainOptions {
  /** Different seeds yield disjoint chains: use one to build a competing fork. */
  seed?: string;
  tokens?: Hex[];
  pools?: Hex[];
}

interface ForkPoint {
  parent: SyntheticChain;
  /** First height that differs from `parent`; lower heights are the parent's, hash for hash. */
  height: number;
}

const UINT256_MAX = 2n ** 256n - 1n;

/**
 * A deterministic fake chain. Block n's hash is a function of (seed, n) and its
 * parentHash is the hash of n-1, so any sub-range is internally consistent and
 * ranges stitch together. Log counts vary per block (every 7th block has none),
 * ids are non-contiguous because decoy logs from an untracked address take
 * positions, and amounts span the full uint256 / int256 range of magnitudes
 * including negative swap amounts and ticks.
 */
export class SyntheticChain {
  readonly tokens: Hex[];
  readonly pools: Hex[];
  private readonly seed: string;
  private readonly forkPoint: ForkPoint | undefined;
  private readonly blockCache = new Map<number, { header: BlockHeader; entries: SyntheticEntry[]; decoys: RawLog[] }>();

  constructor(options: SyntheticChainOptions = {}, forkPoint?: ForkPoint) {
    this.seed = options.seed ?? "main";
    this.tokens = options.tokens ?? [TEST_TOKEN];
    this.pools = options.pools ?? [TEST_POOL];
    this.forkPoint = forkPoint;
  }

  /**
   * A competing chain sharing every block below `height` with this one and diverging from `height` up:
   * new hashes, new logs, and block `height` points at this chain's block `height - 1`.
   */
  fork(height: number, seed: string): SyntheticChain {
    return new SyntheticChain({ seed, tokens: this.tokens, pools: this.pools }, { parent: this, height });
  }

  header(n: number): BlockHeader {
    return this.block(n).header;
  }

  /** Logs eth_getLogs would return for the tracked contracts only, ascending by logIndex. */
  entries(n: number): SyntheticEntry[] {
    return this.block(n).entries;
  }

  /** Every log in the block including decoys, ascending by logIndex. */
  allLogs(n: number): RawLog[] {
    const b = this.block(n);
    return [...b.entries.map((e) => e.log), ...b.decoys].sort((a, c) => a.logIndex - c.logIndex);
  }

  fetched(from: number, to: number): FetchedRange {
    const blocks: BlockHeader[] = [];
    const logs: RawLog[] = [];
    for (let n = from; n <= to; n++) {
      blocks.push(this.header(n));
      logs.push(...this.entries(n).map((e) => e.log));
    }
    return { from, to, blocks, logs };
  }

  decoded(from: number, to: number): DecodedRange {
    const transfers: Erc20Transfer[] = [];
    const swaps: UniswapV3Swap[] = [];
    for (let n = from; n <= to; n++) {
      for (const e of this.entries(n)) {
        if (e.transfer) transfers.push(e.transfer);
        else swaps.push(e.swap);
      }
    }
    return { transfers, swaps, rejects: [] };
  }

  totals(from: number, to: number): Totals {
    const d = this.decoded(from, to);
    return { blocks: to - from + 1, logs: d.transfers.length + d.swaps.length, transfers: d.transfers.length, swaps: d.swaps.length };
  }

  private word(n: number, label: string): bigint {
    return BigInt(keccak256(toHex(`${this.seed}:${n}:${label}`)));
  }

  private address(n: number, label: string): Hex {
    return `0x${keccak256(toHex(`${this.seed}:${n}:${label}`)).slice(26)}`;
  }

  private block(n: number): { header: BlockHeader; entries: SyntheticEntry[]; decoys: RawLog[] } {
    if (this.forkPoint && n < this.forkPoint.height) return this.forkPoint.parent.block(n);
    let b = this.blockCache.get(n);
    if (!b) {
      b = this.build(n);
      this.blockCache.set(n, b);
    }
    return b;
  }

  private build(n: number) {
    const hashOf = (height: number): Hex =>
      this.forkPoint && height < this.forkPoint.height ? this.forkPoint.parent.header(height).hash : keccak256(toHex(`${this.seed}:block:${height}`));
    const blockHash = hashOf(n);
    const header: BlockHeader = {
      number: n,
      hash: blockHash,
      parentHash: hashOf(n - 1),
      timestamp: 1_600_000_000 + 12 * n,
    };
    const entries: SyntheticEntry[] = [];
    const decoys: RawLog[] = [];
    const count = n % 7 === 0 ? 0 : 1 + Number(this.word(n, "count") % 6n);
    // Untracked logs before ours push tracked logIndexes away from 0.
    let logIndex = n % 4;
    for (let i = 0; i < count; i++) {
      const label = (k: string) => `${k}:${i}`;
      const txIndex = Number(this.word(n, label("tx")) % 5n);
      const base = { blockNumber: n, blockHash, txIndex, txHash: keccak256(toHex(`${this.seed}:${n}:tx:${txIndex}`)) };
      const pickSwap = this.tokens.length === 0 || (this.pools.length > 0 && this.word(n, label("kind")) % 3n === 0n);
      if (i === 2) {
        decoys.push({ ...base, logIndex: logIndex++, address: DECOY_TOKEN, ...this.transferPayload(n, label("decoy")).raw });
      }
      const logIndexHere = logIndex++;
      if (pickSwap) entries.push(this.swapEntry(n, i, { ...base, logIndex: logIndexHere }));
      else entries.push(this.transferEntry(n, i, { ...base, logIndex: logIndexHere }));
    }
    return { header, entries, decoys };
  }

  private transferPayload(n: number, label: string) {
    const from = this.address(n, `${label}:from`);
    const to = this.address(n, `${label}:to`);
    const magnitude = this.word(n, `${label}:mag`);
    // One in sixteen carries the uint256 maximum to exercise NUMERIC(78,0).
    const value = magnitude % 16n === 0n ? UINT256_MAX : this.word(n, `${label}:value`) % 10n ** (6n + (magnitude % 72n));
    const topics = (encodeEventTopics({ abi: events, eventName: "Transfer", args: { from, to } }) as Hex[]).map((t) => t.toLowerCase() as Hex);
    const data = encodeAbiParameters([{ type: "uint256" }], [value]).toLowerCase() as Hex;
    return { from, to, value, raw: { topics, data } };
  }

  private transferEntry(n: number, i: number, position: Pick<RawLog, "blockNumber" | "blockHash" | "logIndex" | "txHash" | "txIndex">): SyntheticEntry {
    const token = this.tokens[Number(this.word(n, `token:${i}`) % BigInt(this.tokens.length))] as Hex;
    const p = this.transferPayload(n, `transfer:${i}`);
    const log: RawLog = { ...position, address: token, ...p.raw };
    const transfer: Erc20Transfer = {
      blockNumber: position.blockNumber,
      blockHash: position.blockHash,
      logIndex: position.logIndex,
      txHash: position.txHash,
      token,
      from: p.from,
      to: p.to,
      value: p.value.toString(),
    };
    return { log, transfer };
  }

  private swapEntry(n: number, i: number, position: Pick<RawLog, "blockNumber" | "blockHash" | "logIndex" | "txHash" | "txIndex">): SyntheticEntry {
    const label = `swap:${i}`;
    const pool = this.pools[Number(this.word(n, `pool:${i}`) % BigInt(this.pools.length))] as Hex;
    const sender = this.address(n, `${label}:sender`);
    const recipient = this.address(n, `${label}:recipient`);
    const sign = this.word(n, `${label}:sign`) % 2n === 0n ? 1n : -1n;
    // Real swaps move the two tokens in opposite directions.
    const amount0 = sign * (this.word(n, `${label}:a0`) % 10n ** (6n + (this.word(n, `${label}:m0`) % 40n)));
    const amount1 = -sign * (this.word(n, `${label}:a1`) % 10n ** (6n + (this.word(n, `${label}:m1`) % 40n)));
    const sqrtPriceX96 = this.word(n, `${label}:sqrt`) % 2n ** 160n;
    const liquidity = this.word(n, `${label}:liq`) % 2n ** 128n;
    const tick = Number(this.word(n, `${label}:tick`) % 1_774_545n) - 887_272;
    const topics = (encodeEventTopics({ abi: events, eventName: "Swap", args: { sender, recipient } }) as Hex[]).map((t) => t.toLowerCase() as Hex);
    const data = encodeAbiParameters(
      [{ type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }],
      [amount0, amount1, sqrtPriceX96, liquidity, tick],
    ).toLowerCase() as Hex;
    const log: RawLog = { ...position, address: pool, topics, data };
    const swap: UniswapV3Swap = {
      blockNumber: position.blockNumber,
      blockHash: position.blockHash,
      logIndex: position.logIndex,
      txHash: position.txHash,
      pool,
      sender,
      recipient,
      amount0: amount0.toString(),
      amount1: amount1.toString(),
      sqrtPriceX96: sqrtPriceX96.toString(),
      liquidity: liquidity.toString(),
      tick,
    };
    return { log, swap };
  }
}
