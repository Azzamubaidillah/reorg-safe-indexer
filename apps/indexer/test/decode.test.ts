import { describe, expect, it } from "vitest";
import { decodeRange, SWAP_TOPIC, TRANSFER_TOPIC } from "../src/decode.ts";
import type { Hex, RawLog } from "../src/types.ts";
import swapFixture from "./fixtures/uniswap-v3-swap.json" with { type: "json" };
import negativeTickFixture from "./fixtures/uniswap-v3-swap-negative-tick.json" with { type: "json" };
import transferFixture from "./fixtures/usdc-transfer.json" with { type: "json" };

// Logs recorded once from mainnet via eth_getLogs (raw JSON-RPC shape).
interface WireLog {
  blockNumber: string;
  blockHash: string;
  logIndex: string;
  transactionHash: string;
  transactionIndex: string;
  address: string;
  topics: string[];
  data: string;
}

const toRaw = (w: WireLog): RawLog => ({
  blockNumber: Number(w.blockNumber),
  blockHash: w.blockHash as Hex,
  logIndex: Number(w.logIndex),
  txHash: w.transactionHash as Hex,
  txIndex: Number(w.transactionIndex),
  address: w.address as Hex,
  topics: w.topics as Hex[],
  data: w.data as Hex,
});

const word = (data: string, i: number) => data.slice(2 + 64 * i, 2 + 64 * (i + 1));
const int256 = (w: string) => BigInt.asIntN(256, BigInt(`0x${w}`)).toString();
const uint = (w: string) => BigInt(`0x${w}`).toString();
const topicAddress = (t: string) => `0x${t.slice(26)}`;

const transferLog = toRaw(transferFixture);
const swapLog = toRaw(swapFixture);
const negativeTickLog = toRaw(negativeTickFixture);
const contracts = { tokens: [transferLog.address], pools: [swapLog.address, negativeTickLog.address] };

describe("decodeRange", () => {
  it("decodes a real USDC Transfer", () => {
    const { transfers, swaps, rejects } = decodeRange([transferLog], contracts);
    expect(swaps).toEqual([]);
    expect(rejects).toEqual([]);
    expect(transfers).toEqual([
      {
        blockNumber: transferLog.blockNumber,
        blockHash: transferLog.blockHash,
        logIndex: transferLog.logIndex,
        txHash: transferLog.txHash,
        token: transferLog.address,
        from: topicAddress(transferLog.topics[1]!),
        to: topicAddress(transferLog.topics[2]!),
        value: uint(word(transferLog.data, 0)),
      },
    ]);
  });

  it.each([
    ["USDC/WETH pool", swapLog],
    ["pool with negative tick", negativeTickLog],
  ])("decodes a real Swap: %s", (_name, log) => {
    const { swaps, transfers, rejects } = decodeRange([log], contracts);
    expect(transfers).toEqual([]);
    expect(rejects).toEqual([]);
    expect(swaps).toEqual([
      {
        blockNumber: log.blockNumber,
        blockHash: log.blockHash,
        logIndex: log.logIndex,
        txHash: log.txHash,
        pool: log.address,
        sender: topicAddress(log.topics[1]!),
        recipient: topicAddress(log.topics[2]!),
        amount0: int256(word(log.data, 0)),
        amount1: int256(word(log.data, 1)),
        sqrtPriceX96: uint(word(log.data, 2)),
        liquidity: uint(word(log.data, 3)),
        tick: Number(BigInt.asIntN(24, BigInt(`0x${word(log.data, 4)}`))),
      },
    ]);
  });

  it("covers negative amounts and a negative tick in the fixtures", () => {
    expect(BigInt(`0x${word(swapFixture.data, 0)}`) >= 2n ** 255n).toBe(true);
    expect(decodeRange([negativeTickLog], contracts).swaps[0]!.tick).toBeLessThan(0);
    expect(decodeRange([swapLog], contracts).swaps[0]!.amount0.startsWith("-")).toBe(true);
  });

  it("rejects a token Transfer with the wrong topic count (ERC-721 style)", () => {
    const nft: RawLog = { ...transferLog, topics: [...transferLog.topics, `0x${"0".repeat(63)}1` as Hex], data: "0x" };
    const out = decodeRange([nft], contracts);
    expect(out.transfers).toEqual([]);
    expect(out.rejects).toHaveLength(1);
    expect(out.rejects[0]!.log).toBe(nft);
  });

  it("rejects truncated data, wrong topic0 for the contract kind, and untracked addresses", () => {
    const truncated: RawLog = { ...swapLog, data: `0x${word(swapLog.data, 0)}` };
    const swapTopicOnToken: RawLog = { ...transferLog, topics: [SWAP_TOPIC, transferLog.topics[1]!, transferLog.topics[2]!] };
    const transferTopicOnPool: RawLog = { ...swapLog, topics: [TRANSFER_TOPIC, swapLog.topics[1]!, swapLog.topics[2]!] };
    const stranger: RawLog = { ...transferLog, address: `0x${"12".repeat(20)}` };
    const out = decodeRange([truncated, swapTopicOnToken, transferTopicOnPool, stranger], contracts);
    expect(out.transfers).toEqual([]);
    expect(out.swaps).toEqual([]);
    expect(out.rejects).toHaveLength(4);
  });

  it("keeps every input log accounted for", () => {
    const logs = [transferLog, swapLog, { ...transferLog, topics: [TRANSFER_TOPIC] }];
    const out = decodeRange(logs, contracts);
    expect(out.transfers.length + out.swaps.length + out.rejects.length).toBe(logs.length);
  });
});
