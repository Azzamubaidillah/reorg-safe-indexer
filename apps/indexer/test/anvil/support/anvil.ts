import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { encodeFunctionData, parseAbi } from "viem";
import type { BlockHeader, Hex, RawLog } from "../../../src/types.ts";
import { swapEmitterBytecode, transferEmitterBytecode } from "./bytecode.generated.ts";

/*
 * Anvil 1.8.5 semantics this suite relies on, each checked against a real node (hence the odd-looking choices below):
 *
 * - Chain id is 31337 (0x7a69) unless --chain-id says otherwise.
 * - Tags: with `--slots-in-an-epoch N`, `safe` = max(0, latest - N) and `finalized` = max(0, latest - 2N), recomputed
 *   from `latest` on every call (default N = 32). So the reorg window (finalized, latest] is exactly 2N blocks wide.
 *   anvil_reorg never moves them: a reorg deeper than that is accepted by anvil (depth 9 with finalized = 22 at
 *   latest = 30 succeeded and finalized stayed 22), which is how the "reorg below finalized" case is produced.
 * - Automine is asynchronous: txs sent back to back land in whatever blocks the miner task happens to cut (seen: 3 txs
 *   in one block). With `--no-mining`, `eth_sendTransaction` only queues and `evm_mine` cuts exactly one block holding
 *   everything queued, so the block each event lands in is deterministic.
 * - anvil_reorg(depth, [[tx, offset], ...]) takes positional params. It drops the last `depth` blocks and mines `depth`
 *   new ones on top of height head - depth, so the head height is unchanged (a reorg is therefore invisible to height
 *   polling until another block is mined). `tx` is an unsigned request from an unlocked dev account (or raw bytes) and
 *   `offset` is the 0-based index among the replacement blocks, so it must be < depth. Dropped txs are not re-queued
 *   (receipt is null afterwards, nothing pending). Every replacement block gets a new hash, even with no txs: the
 *   empty reorg of depth 3 at head 30 changed hashes 28..30 while 20..27 stayed. depth > head is rejected with
 *   "Reorg depth must not exceed current chain height".
 * - Blocks mined within the same wall-clock second share a timestamp; the hash still differs when contents differ.
 */

export const ANVIL_CHAIN_ID = 31337;

const STARTUP_TIMEOUT_MS = 15_000;
const RPC_TIMEOUT_MS = 10_000;

export interface TxRequest {
  from: Hex;
  to?: Hex;
  data: Hex;
}

/** A tx for `anvil_reorg`: it lands in the `offset`-th replacement block. */
export interface Replacement {
  offset: number;
  tx: TxRequest;
}

interface WireBlock {
  number: string;
  hash: string;
  parentHash: string;
  timestamp: string;
  transactions: string[];
}

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

const emitterAbi = parseAbi([
  "function emitTransfer(address from, address to, uint256 value)",
  "function emitSwap(address sender, address recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);

export interface SwapArgs {
  sender: Hex;
  recipient: Hex;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
}

const running = new Set<ChildProcess>();
process.on("exit", () => {
  for (const child of running) child.kill("SIGKILL");
});

async function freePort(): Promise<number> {
  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
  if (typeof address !== "object" || address === null) throw new Error("could not allocate a port");
  return address.port;
}

const toHeader = (b: WireBlock): BlockHeader => ({
  number: Number(b.number),
  hash: b.hash.toLowerCase() as Hex,
  parentHash: b.parentHash.toLowerCase() as Hex,
  timestamp: Number(b.timestamp),
});
const quantity = (n: number) => `0x${n.toString(16)}`;

export class AnvilNode {
  private nextId = 1;
  private constructor(
    readonly url: string,
    private readonly child: ChildProcess,
    private readonly output: () => string,
    /** First dev account, unlocked on the node. */
    readonly account: Hex,
  ) {}

  /** Starts a fresh `--no-mining` node on a free port; `slotsInAnEpoch` sets the finalized window to twice that many blocks. */
  static async start(options: { slotsInAnEpoch: number }): Promise<AnvilNode> {
    for (let attempt = 1; ; attempt++) {
      const port = await freePort();
      const args = ["--port", String(port), "--host", "127.0.0.1", "--silent", "--no-mining", "--chain-id", String(ANVIL_CHAIN_ID), "--slots-in-an-epoch", String(options.slotsInAnEpoch)];
      const child = spawn("anvil", args, { stdio: ["ignore", "pipe", "pipe"] });
      running.add(child);
      let out = "";
      child.stdout.on("data", (c: Buffer) => (out += c.toString()));
      child.stderr.on("data", (c: Buffer) => (out += c.toString()));
      const exited = Promise.withResolvers<{ failure: string }>();
      child.once("error", (err) => exited.resolve({ failure: `spawn failed: ${err.message}` }));
      child.once("exit", (code) => {
        running.delete(child);
        exited.resolve({ failure: `anvil exited with code ${code}` });
      });

      const url = `http://127.0.0.1:${port}`;
      const result = await Promise.race([AnvilNode.probe(url), exited.promise]);
      if ("account" in result) return new AnvilNode(url, child, () => out, result.account);
      child.kill("SIGKILL");
      if (attempt >= 3) throw new Error(`anvil did not start on port ${port}: ${result.failure}\n${out}`);
    }
  }

  /** Resolves with the first dev account once the node answers, or with a failure on timeout. */
  private static async probe(url: string): Promise<{ account: Hex } | { failure: string }> {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_accounts", params: [] }),
          signal: AbortSignal.timeout(1000),
        });
        const body = (await res.json()) as { result?: Hex[] };
        const account = body.result?.[0];
        if (account) return { account: account.toLowerCase() as Hex };
      } catch {
        // not listening yet
      }
      await sleep(50);
    }
    return { failure: `no answer within ${STARTUP_TIMEOUT_MS}ms` };
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const exited = Promise.withResolvers<void>();
    this.child.once("exit", () => exited.resolve());
    this.child.kill("SIGKILL");
    await exited.promise;
  }

  async rpc<T>(method: string, ...params: unknown[]): Promise<T> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    const body = (await res.json()) as { result?: T; error?: unknown };
    if (body.error) throw new Error(`anvil ${method} failed: ${JSON.stringify(body.error)}\n${this.output()}`);
    return body.result as T;
  }

  /** Header at a height or tag (`latest`, `safe`, `finalized`). */
  async header(at: number | "latest" | "safe" | "finalized"): Promise<BlockHeader> {
    const block = await this.rpc<WireBlock | null>("eth_getBlockByNumber", typeof at === "number" ? quantity(at) : at, false);
    if (!block) throw new Error(`anvil has no block ${at}`);
    return toHeader(block);
  }

  async headers(from: number, to: number): Promise<BlockHeader[]> {
    const out: BlockHeader[] = [];
    for (let n = from; n <= to; n++) out.push(await this.header(n));
    return out;
  }

  /** Cuts one block containing exactly `txs` (possibly none) and returns its header. */
  async mineBlock(txs: TxRequest[] = []): Promise<BlockHeader> {
    for (const tx of txs) await this.rpc("eth_sendTransaction", tx);
    await this.rpc("evm_mine");
    const latest = await this.rpc<WireBlock>("eth_getBlockByNumber", "latest", false);
    if (latest.transactions.length !== txs.length) {
      throw new Error(`block ${Number(latest.number)} holds ${latest.transactions.length} txs, expected ${txs.length}`);
    }
    return toHeader(latest);
  }

  /** Deploys creation bytecode in its own block. */
  async deploy(bytecode: Hex): Promise<{ address: Hex; block: number }> {
    const hash = await this.rpc<Hex>("eth_sendTransaction", { from: this.account, data: bytecode });
    await this.rpc("evm_mine");
    const receipt = await this.rpc<{ contractAddress: Hex; blockNumber: string; status: string } | null>("eth_getTransactionReceipt", hash);
    if (!receipt || receipt.status !== "0x1") throw new Error(`deployment ${hash} failed: ${JSON.stringify(receipt)}`);
    return { address: receipt.contractAddress.toLowerCase() as Hex, block: Number(receipt.blockNumber) };
  }

  /** anvil_reorg: drop the last `depth` blocks, mine `depth` replacements, put `replacements` into them. Head height is unchanged. */
  async reorg(depth: number, replacements: Replacement[] = []): Promise<void> {
    await this.rpc("anvil_reorg", depth, replacements.map((r) => [r.tx, r.offset]));
  }

  /** Logs of `addresses` carrying a `topic0s` signature, normalised like the indexer's `RawLog`, sorted by position. */
  async logs(from: number, to: number, addresses: Hex[], topic0s: Hex[]): Promise<RawLog[]> {
    const wire = await this.rpc<WireLog[]>("eth_getLogs", { fromBlock: quantity(from), toBlock: quantity(to), address: addresses, topics: [topic0s] });
    return wire
      .map((w) => ({
        blockNumber: Number(w.blockNumber),
        blockHash: w.blockHash.toLowerCase() as Hex,
        logIndex: Number(w.logIndex),
        txHash: w.transactionHash.toLowerCase() as Hex,
        txIndex: Number(w.transactionIndex),
        address: w.address.toLowerCase() as Hex,
        topics: w.topics.map((t) => t.toLowerCase() as Hex),
        data: w.data.toLowerCase() as Hex,
      }))
      .sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  }
}

/** The two deployed fixture contracts and builders for the txs that make them emit events. */
export interface Fixtures {
  token: Hex;
  pool: Hex;
  /** Height of the first block the indexer needs (the token deployment). */
  startBlock: number;
  transfer(from: Hex, to: Hex, value: bigint): TxRequest;
  swap(args: SwapArgs): TxRequest;
}

/** Deploys the token emitter then the pool emitter, each in its own block. */
export async function deployFixtures(node: AnvilNode): Promise<Fixtures> {
  const token = await node.deploy(transferEmitterBytecode);
  const pool = await node.deploy(swapEmitterBytecode);
  return {
    token: token.address,
    pool: pool.address,
    startBlock: token.block,
    transfer: (from, to, value) => ({
      from: node.account,
      to: token.address,
      data: encodeFunctionData({ abi: emitterAbi, functionName: "emitTransfer", args: [from, to, value] }),
    }),
    swap: (a) => ({
      from: node.account,
      to: pool.address,
      data: encodeFunctionData({ abi: emitterAbi, functionName: "emitSwap", args: [a.sender, a.recipient, a.amount0, a.amount1, a.sqrtPriceX96, a.liquidity, a.tick] }),
    }),
  };
}
