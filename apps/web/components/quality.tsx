"use client";

import { RANGE_STATUSES, type Range, type RangeDetail, type RangeStatus } from "@rsi/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Fragment, useId, useState } from "react";
import { formatInt } from "../lib/format.ts";
import { rangeDetailQuery, rangesQuery } from "../lib/queries.ts";
import { Badge, ErrorNotice, InfiniteBoundary, Loading, QueryBoundary, RangeBadge, Section, Table, Td, Th, Time } from "./ui.tsx";

const rangeLabel = (r: { fromBlock: number; toBlock: number }) => `${formatInt(r.fromBlock)}–${formatInt(r.toBlock)}`;

function GateTable({ detail }: { detail: RangeDetail }) {
  return (
    <Table caption={`Gate results for blocks ${rangeLabel(detail)}`}>
      <thead>
        <tr>
          <Th>Gate</Th>
          <Th>Result</Th>
          <Th numeric>Rows checked</Th>
          <Th numeric>Rows failed</Th>
          <Th>Detail</Th>
          <Th>Checked</Th>
        </tr>
      </thead>
      <tbody>
        {detail.gates.map((g) => (
          <tr key={g.gate} data-testid={`gate-${g.gate}`}>
            <Td>
              <code className="font-mono text-xs">{g.gate}</code>
            </Td>
            <Td>
              <Badge tone={g.passed ? "good" : "bad"}>{g.passed ? "passed" : "failed"}</Badge>
            </Td>
            <Td numeric>{formatInt(g.rowsChecked)}</Td>
            <Td numeric>{formatInt(g.rowsFailed)}</Td>
            <Td>{g.detail ?? "—"}</Td>
            <Td>
              <Time value={g.checkedAt} />
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function Gates({ fromBlock }: { fromBlock: number }) {
  const query = useQuery(rangeDetailQuery(fromBlock));
  return (
    <QueryBoundary query={query} what="gate results" isEmpty={(d) => d.gates.length === 0} emptyText="No gate has run for this range yet.">
      {(detail) => <GateTable detail={detail} />}
    </QueryBoundary>
  );
}

function RangeRow({ range }: { range: Range }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  return (
    <Fragment>
      <tr data-testid={`range-${range.fromBlock}`}>
        <Td numeric>{formatInt(range.fromBlock)}</Td>
        <Td numeric>{formatInt(range.toBlock)}</Td>
        <Td>
          <RangeBadge status={range.status} />
        </Td>
        <Td numeric>{formatInt(range.blockCount)}</Td>
        <Td numeric>{formatInt(range.logCount)}</Td>
        <Td numeric>{formatInt(range.transferCount)}</Td>
        <Td numeric>{formatInt(range.swapCount)}</Td>
        <Td numeric>{formatInt(range.rejectCount)}</Td>
        <Td>
          <Time value={range.publishedAt} />
        </Td>
        <Td>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => setOpen(!open)}
            className="rounded border border-blue-900 bg-white px-2 py-1 text-xs font-medium text-blue-900 hover:bg-blue-50"
          >
            <span aria-hidden="true">{open ? "▾" : "▸"} </span>Gates<span className="sr-only"> for blocks {rangeLabel(range)}</span>
          </button>
        </Td>
      </tr>
      <tr id={panelId} hidden={!open}>
        <td colSpan={10} className="bg-slate-50 p-3">
          {open ? <Gates fromBlock={range.fromBlock} /> : null}
        </td>
      </tr>
    </Fragment>
  );
}

function FailedRange({ range }: { range: Range }) {
  const query = useQuery(rangeDetailQuery(range.fromBlock));
  const titleId = `failed-${range.fromBlock}`;
  return (
    <article aria-labelledby={titleId} className="mb-5 rounded border border-red-300 bg-white p-4" data-testid={`failed-range-${range.fromBlock}`}>
      <h3 id={titleId} className="mb-2 font-semibold text-slate-900">
        Blocks {rangeLabel(range)} <Badge tone="bad">unpublished</Badge>
      </h3>
      {query.isPending ? <Loading what="gate results" /> : null}
      {query.isError ? <ErrorNotice error={query.error} onRetry={() => void query.refetch()} /> : null}
      {query.data ? (
        <>
          <p className="mb-3 text-sm text-slate-800">
            Committed <Time value={range.committedAt} />; published: {range.publishedAt ? <Time value={range.publishedAt} /> : "never"}.
          </p>
          <h4 className="mb-1 text-sm font-semibold text-slate-900">Backfill job</h4>
          {query.data.backfillJob ? (
            <dl className="mb-3 grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm" data-testid="backfill-job">
              <dt className="font-medium text-slate-700">Job</dt>
              <dd>
                <code className="font-mono">{query.data.backfillJob.id}</code>
              </dd>
              <dt className="font-medium text-slate-700">Status</dt>
              <dd>
                <Badge tone={query.data.backfillJob.status === "resolved" ? "good" : "warn"}>{query.data.backfillJob.status}</Badge>
              </dd>
              <dt className="font-medium text-slate-700">Attempts</dt>
              <dd>{formatInt(query.data.backfillJob.attempts)}</dd>
              <dt className="font-medium text-slate-700">Reason</dt>
              <dd>{query.data.backfillJob.failureReason}</dd>
              <dt className="font-medium text-slate-700">Updated</dt>
              <dd>
                <Time value={query.data.backfillJob.updatedAt} />
              </dd>
            </dl>
          ) : (
            <p className="mb-3 text-sm text-slate-700">No backfill job is recorded for this range.</p>
          )}
          <GateTable detail={query.data} />
        </>
      ) : null}
    </article>
  );
}

function FailedRanges() {
  const query = useInfiniteQuery(rangesQuery("failed"));
  return (
    <InfiniteBoundary query={query} what="failed ranges" items={(pages) => pages.flatMap((p) => p.items)} emptyText="No range has failed a quality gate.">
      {(ranges) => ranges.map((r) => <FailedRange key={r.fromBlock} range={r} />)}
    </InfiniteBoundary>
  );
}

function isRangeStatus(value: string): value is RangeStatus {
  return (RANGE_STATUSES as readonly string[]).includes(value);
}

function AllRanges() {
  const [status, setStatus] = useState<RangeStatus | "">("");
  const selectId = useId();
  const query = useInfiniteQuery(rangesQuery(status));
  return (
    <>
      <div className="mb-3">
        <label htmlFor={selectId} className="mr-2 text-sm font-medium text-slate-900">
          Status
        </label>
        <select
          id={selectId}
          value={status}
          onChange={(e) => setStatus(isRangeStatus(e.target.value) ? e.target.value : "")}
          className="rounded border border-slate-500 bg-white px-2 py-1 text-sm"
        >
          <option value="">All</option>
          {RANGE_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </div>
      <InfiniteBoundary query={query} what="ranges" items={(pages) => pages.flatMap((p) => p.items)} emptyText="No ranges match this filter.">
        {(ranges) => (
          <Table caption="Block ranges, newest first">
            <thead>
              <tr>
                <Th numeric>From</Th>
                <Th numeric>To</Th>
                <Th>Status</Th>
                <Th numeric>Blocks</Th>
                <Th numeric>Logs</Th>
                <Th numeric>Transfers</Th>
                <Th numeric>Swaps</Th>
                <Th numeric>Rejects</Th>
                <Th>Published</Th>
                <Th>Gates</Th>
              </tr>
            </thead>
            <tbody>
              {ranges.map((r) => (
                <RangeRow key={r.fromBlock} range={r} />
              ))}
            </tbody>
          </Table>
        )}
      </InfiniteBoundary>
    </>
  );
}

export function QualityView() {
  return (
    <>
      <Section title="Failed ranges" id="failed">
        <FailedRanges />
      </Section>
      <Section title="All ranges" id="all-ranges">
        <AllRanges />
      </Section>
    </>
  );
}
