"use client";

import type { Swap, Transfer } from "@rsi/contracts";
import { useQuery } from "@tanstack/react-query";
import { useId, useState, type FormEvent } from "react";
import { formatInt, formatUnits } from "../lib/format.ts";
import { swapsQuery, transfersQuery, type ExplorerParams } from "../lib/queries.ts";
import { POOLS, TOKENS, type TokenInfo } from "../lib/tokens.ts";
import { Hash, QueryBoundary, Section, Table, Td, Th, Time } from "./ui.tsx";

type Kind = "transfers" | "swaps";

const PAGE_SIZES = [10, 25, 50, 100, 200] as const;

interface Filters {
  subject: string;
  address: string;
  fromBlock: string;
  toBlock: string;
  limit: number;
}

const EMPTY_FILTERS: Filters = { subject: "", address: "", fromBlock: "", toBlock: "", limit: 25 };

/** Amount with the token's decimals when known; raw base units otherwise or when the user asks for them. */
function Amount({ raw, token, showRaw }: { raw: string; token: TokenInfo | undefined; showRaw: boolean }) {
  // Amounts reach 78 digits (uint256); break-all keeps one value from stretching the table.
  if (showRaw || !token) return <span className="inline-block min-w-48 max-w-64 font-mono text-xs break-all">{raw}</span>;
  return (
    <span title={`${raw} base units`} className="inline-block min-w-48 max-w-64 break-all">
      {formatUnits(raw, token.decimals)} {token.symbol}
    </span>
  );
}

function TransferRows({ items, showRaw }: { items: Transfer[]; showRaw: boolean }) {
  return (
    <Table caption="Transfers matching the filters">
      <thead>
        <tr>
          <Th numeric>Block</Th>
          <Th>Time</Th>
          <Th numeric>Log</Th>
          <Th>Transaction</Th>
          <Th>Token</Th>
          <Th>From</Th>
          <Th>To</Th>
          <Th numeric>{showRaw ? "Value (raw)" : "Value"}</Th>
        </tr>
      </thead>
      <tbody>
        {items.map((t) => (
          <tr key={`${t.blockHash}:${t.logIndex}`} data-row-id={`${t.blockNumber}:${t.logIndex}`}>
            <Td numeric>{formatInt(t.blockNumber)}</Td>
            <Td>
              <Time value={t.blockTimestamp} />
            </Td>
            <Td numeric>{t.logIndex}</Td>
            <Td>
              <Hash value={t.txHash} />
            </Td>
            <Td>{TOKENS[t.token]?.symbol ?? <Hash value={t.token} />}</Td>
            <Td>
              <Hash value={t.from} />
            </Td>
            <Td>
              <Hash value={t.to} />
            </Td>
            <Td numeric>
              <Amount raw={t.value} token={TOKENS[t.token]} showRaw={showRaw} />
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function SwapRows({ items, showRaw }: { items: Swap[]; showRaw: boolean }) {
  return (
    <Table caption="Swaps matching the filters">
      <thead>
        <tr>
          <Th numeric>Block</Th>
          <Th>Time</Th>
          <Th numeric>Log</Th>
          <Th>Transaction</Th>
          <Th>Pool</Th>
          <Th>Sender</Th>
          <Th>Recipient</Th>
          <Th numeric>{showRaw ? "Amount 0 (raw)" : "Amount 0"}</Th>
          <Th numeric>{showRaw ? "Amount 1 (raw)" : "Amount 1"}</Th>
        </tr>
      </thead>
      <tbody>
        {items.map((s) => {
          const pool = POOLS[s.pool];
          return (
            <tr key={`${s.blockHash}:${s.logIndex}`} data-row-id={`${s.blockNumber}:${s.logIndex}`}>
              <Td numeric>{formatInt(s.blockNumber)}</Td>
              <Td>
                <Time value={s.blockTimestamp} />
              </Td>
              <Td numeric>{s.logIndex}</Td>
              <Td>
                <Hash value={s.txHash} />
              </Td>
              <Td>{pool?.label ?? <Hash value={s.pool} />}</Td>
              <Td>
                <Hash value={s.sender} />
              </Td>
              <Td>
                <Hash value={s.recipient} />
              </Td>
              <Td numeric>
                <Amount raw={s.amount0} token={pool?.token0} showRaw={showRaw} />
              </Td>
              <Td numeric>
                <Amount raw={s.amount1} token={pool?.token1} showRaw={showRaw} />
              </Td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}

interface Applied {
  kind: Kind;
  filters: Filters;
}

function Results({ applied, showRaw }: { applied: Applied; showRaw: boolean }) {
  // Cursors of the pages already visited; the last one is the page on screen. Previous pops, Next pushes.
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const { kind, filters } = applied;
  const base: ExplorerParams = { limit: filters.limit, cursor, address: filters.address.trim(), fromBlock: filters.fromBlock.trim(), toBlock: filters.toBlock.trim() };
  const transfers = useQuery({ ...transfersQuery({ ...base, token: filters.subject.trim() }), enabled: kind === "transfers" });
  const swaps = useQuery({ ...swapsQuery({ ...base, pool: filters.subject.trim() }), enabled: kind === "swaps" });
  const query = kind === "transfers" ? transfers : swaps;
  const next = query.data?.nextCursor ?? null;

  return (
    <>
      <div aria-live="polite" aria-busy={query.isFetching}>
        {kind === "transfers" ? (
          <QueryBoundary query={transfers} what="transfers" isEmpty={(d) => d.items.length === 0} emptyText="No transfers match these filters in published ranges.">
            {(d) => <TransferRows items={d.items} showRaw={showRaw} />}
          </QueryBoundary>
        ) : (
          <QueryBoundary query={swaps} what="swaps" isEmpty={(d) => d.items.length === 0} emptyText="No swaps match these filters in published ranges.">
            {(d) => <SwapRows items={d.items} showRaw={showRaw} />}
          </QueryBoundary>
        )}
      </div>
      <nav aria-label="Pagination" className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={cursors.length <= 1}
          onClick={() => setCursors(cursors.slice(0, -1))}
          className="rounded border border-blue-900 bg-white px-4 py-2 text-sm font-medium text-blue-900 hover:bg-blue-50 disabled:border-slate-400 disabled:text-slate-600"
        >
          Previous
        </button>
        <span className="text-sm text-slate-800">Page {cursors.length}</span>
        <button
          type="button"
          disabled={next === null}
          onClick={() => next && setCursors([...cursors, next])}
          className="rounded border border-blue-900 bg-white px-4 py-2 text-sm font-medium text-blue-900 hover:bg-blue-50 disabled:border-slate-400 disabled:text-slate-600"
        >
          Next
        </button>
      </nav>
    </>
  );
}

const inputClass = "mt-1 block w-full rounded border border-slate-500 bg-white px-2 py-1 text-sm";

export function ExplorerView() {
  const id = useId();
  const [kind, setKind] = useState<Kind>("transfers");
  const [draft, setDraft] = useState<Filters>(EMPTY_FILTERS);
  const [applied, setApplied] = useState<Applied>({ kind: "transfers", filters: EMPTY_FILTERS });
  const [showRaw, setShowRaw] = useState(false);
  // Changing the key remounts Results, which resets its cursor stack whenever filters are re-applied.
  const [generation, setGeneration] = useState(0);

  function submit(event: FormEvent) {
    event.preventDefault();
    setApplied({ kind, filters: draft });
    setGeneration((g) => g + 1);
  }

  const set = (patch: Partial<Filters>) => setDraft({ ...draft, ...patch });
  const subjectLabel = kind === "transfers" ? "Token address" : "Pool address";

  return (
    <>
      <Section title="Filters" id="filters">
        <form onSubmit={submit} className="grid gap-4 rounded border border-slate-300 bg-white p-4 sm:grid-cols-2 lg:grid-cols-3">
          <fieldset className="sm:col-span-2 lg:col-span-3">
            <legend className="text-sm font-medium text-slate-900">Event type</legend>
            <div className="mt-1 flex gap-6">
              {(["transfers", "swaps"] as const).map((k) => (
                <label key={k} className="flex items-center gap-2 text-sm text-slate-900">
                  <input type="radio" name={`${id}-kind`} value={k} checked={kind === k} onChange={() => setKind(k)} />
                  {k === "transfers" ? "ERC-20 transfers" : "Uniswap v3 swaps"}
                </label>
              ))}
            </div>
          </fieldset>
          <div>
            <label htmlFor={`${id}-subject`} className="text-sm font-medium text-slate-900">
              {subjectLabel}
            </label>
            <input id={`${id}-subject`} className={inputClass} value={draft.subject} onChange={(e) => set({ subject: e.target.value })} placeholder="0x… (any)" spellCheck={false} autoComplete="off" />
          </div>
          <div>
            <label htmlFor={`${id}-address`} className="text-sm font-medium text-slate-900">
              Address (sender or recipient)
            </label>
            <input id={`${id}-address`} className={inputClass} value={draft.address} onChange={(e) => set({ address: e.target.value })} placeholder="0x… (any)" spellCheck={false} autoComplete="off" />
          </div>
          <div>
            <label htmlFor={`${id}-limit`} className="text-sm font-medium text-slate-900">
              Rows per page
            </label>
            <select id={`${id}-limit`} className={inputClass} value={draft.limit} onChange={(e) => set({ limit: Number(e.target.value) })}>
              {PAGE_SIZES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-from`} className="text-sm font-medium text-slate-900">
              From block
            </label>
            <input id={`${id}-from`} className={inputClass} inputMode="numeric" value={draft.fromBlock} onChange={(e) => set({ fromBlock: e.target.value })} autoComplete="off" />
          </div>
          <div>
            <label htmlFor={`${id}-to`} className="text-sm font-medium text-slate-900">
              To block
            </label>
            <input id={`${id}-to`} className={inputClass} inputMode="numeric" value={draft.toBlock} onChange={(e) => set({ toBlock: e.target.value })} autoComplete="off" />
          </div>
          <div className="flex items-end gap-4">
            <button type="submit" className="rounded bg-blue-900 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800">
              Apply filters
            </button>
          </div>
        </form>
      </Section>

      <Section title="Results" id="results">
        <label className="mb-3 flex items-center gap-2 text-sm text-slate-900">
          <input type="checkbox" checked={showRaw} onChange={(e) => setShowRaw(e.target.checked)} />
          Show raw amounts (base units)
        </label>
        <Results key={generation} applied={applied} showRaw={showRaw} />
      </Section>
    </>
  );
}
