"use client";

import type { Status } from "@rsi/contracts";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { formatInt, formatLag } from "../lib/format.ts";
import { statusQuery } from "../lib/queries.ts";
import { Badge, QueryBoundary, RangeBadge, Section, Stat, Table, Td, Th, Time } from "./ui.tsx";

const RANGE_ORDER = ["published", "candidate", "failed"] as const;

function RpcCalls({ calls }: { calls: NonNullable<Status["lastRun"]>["rpcCalls"] }) {
  const rows = Object.entries(calls).flatMap(([provider, methods]) => Object.entries(methods).map(([method, count]) => ({ provider, method, count })));
  if (rows.length === 0) return <p className="text-slate-700">The last run has not made any RPC calls.</p>;
  const total = rows.reduce((sum, r) => sum + r.count, 0);
  return (
    <Table caption={`RPC calls of the last run (${formatInt(total)} total)`}>
      <thead>
        <tr>
          <Th>Provider</Th>
          <Th>Method</Th>
          <Th numeric>Calls</Th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={`${r.provider}/${r.method}`}>
            <Td>{r.provider}</Td>
            <Td>{r.method}</Td>
            <Td numeric>{formatInt(r.count)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function Overview({ status }: { status: Status }) {
  const { lastRun, lastReorg, lag1h } = status;
  return (
    <>
      <p className="mb-4 text-sm text-slate-700">
        Chain {status.chainId} · generated <Time value={status.generatedAt} />
        {status.head ? (
          <>
            {" "}
            · head sampled <Time value={status.head.sampledAt} />
          </>
        ) : null}
      </p>

      <Section title="Chain position" id="position">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Stat label="Head block" value={formatInt(status.head?.block)} />
          <Stat label="Finalized block" value={formatInt(status.finalizedBlock)} />
          <Stat label="Stored tip" value={formatInt(status.storedTip)} />
          <Stat label="Last published block" value={formatInt(status.lastPublishedBlock)} />
          <Stat label="Head lag" value={formatLag(status.headLag)} note="head − stored tip" />
          <Stat label="Finalized lag" value={formatLag(status.finalizedLag)} note="finalized − last published" />
        </dl>
      </Section>

      <Section title="Head lag, last hour" id="lag">
        {lag1h ? (
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <Stat label="p50" value={formatInt(lag1h.p50)} />
            <Stat label="p95" value={formatInt(lag1h.p95)} />
            <Stat label="p99" value={formatInt(lag1h.p99)} />
            <Stat label="Max" value={formatInt(lag1h.max)} />
            <Stat label="Samples" value={formatInt(lag1h.samples)} />
          </dl>
        ) : (
          <p className="text-slate-700">No lag samples with a known stored tip in the last hour.</p>
        )}
      </Section>

      <Section title="Ranges by status" id="ranges">
        <Table caption="Committed block ranges by publication status">
          <thead>
            <tr>
              <Th>Status</Th>
              <Th numeric>Ranges</Th>
              <Th numeric>Blocks</Th>
              <Th numeric>Logs</Th>
            </tr>
          </thead>
          <tbody>
            {RANGE_ORDER.map((s) => (
              <tr key={s}>
                <Td>
                  <RangeBadge status={s} />
                </Td>
                <Td numeric>{formatInt(status.ranges[s].ranges)}</Td>
                <Td numeric>{formatInt(status.ranges[s].blocks)}</Td>
                <Td numeric>{formatInt(status.ranges[s].logs)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        <p className="mt-2 text-sm text-slate-700">
          {formatInt(status.backfill.open)} open backfill job{status.backfill.open === 1 ? "" : "s"} ·{" "}
          <Link href="/quality" className="text-blue-800 underline">
            data quality details
          </Link>
        </p>
      </Section>

      <Section title="Reconciliation" id="reconciliation">
        <p className="text-slate-900">
          {formatInt(status.reconciliation.match)} matching, {formatInt(status.reconciliation.mismatch)} mismatching,{" "}
          {status.reconciliation.unexplained > 0 ? <Badge tone="bad">{formatInt(status.reconciliation.unexplained)} unexplained</Badge> : "0 unexplained"} ·{" "}
          <Link href="/reconciliation" className="text-blue-800 underline">
            reconciliation details
          </Link>
        </p>
      </Section>

      <Section title="Last run" id="last-run">
        {lastRun ? (
          <>
            <p className="mb-3 text-slate-900">
              Run <code className="font-mono text-sm">{lastRun.id}</code> <Badge tone={lastRun.status === "failed" ? "bad" : lastRun.status === "running" ? "warn" : "good"}>{lastRun.status}</Badge>{" "}
              started <Time value={lastRun.startedAt} />
            </p>
            <RpcCalls calls={lastRun.rpcCalls} />
          </>
        ) : (
          <p className="text-slate-700">The indexer has not recorded a run yet.</p>
        )}
      </Section>

      <Section title="Last reorg" id="last-reorg">
        {lastReorg ? (
          <p className="text-slate-900">
            <Badge tone={lastReorg.action === "halted" ? "bad" : "warn"}>{lastReorg.action === "halted" ? "halted" : "rolled back"}</Badge> at block {formatInt(lastReorg.forkBlock)}, depth{" "}
            {formatInt(lastReorg.depth)}, detected <Time value={lastReorg.detectedAt} />
            {lastReorg.action === "halted" && !lastReorg.acknowledgedAt ? (
              <>
                {" "}
                <Badge tone="bad">not acknowledged</Badge>
              </>
            ) : null}{" "}
            ·{" "}
            <Link href="/reorgs" className="text-blue-800 underline">
              all reorgs
            </Link>
          </p>
        ) : (
          <p className="text-slate-700">No reorg has been detected.</p>
        )}
      </Section>
    </>
  );
}

export function OverviewView() {
  const query = useQuery(statusQuery());
  return (
    <QueryBoundary query={query} what="status">
      {(status) => <Overview status={status} />}
    </QueryBoundary>
  );
}
