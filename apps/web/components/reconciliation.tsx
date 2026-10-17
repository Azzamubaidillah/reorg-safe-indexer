"use client";

import type { Reconciliation } from "@rsi/contracts";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { formatInt } from "../lib/format.ts";
import { reconciliationsQuery, statusQuery, type ReconciliationFilter } from "../lib/queries.ts";
import { Badge, InfiniteBoundary, QueryBoundary, Section, Stat, Table, Td, Th, Time } from "./ui.tsx";

const FILTERS: { value: ReconciliationFilter; label: string }[] = [
  { value: "all", label: "All checks" },
  { value: "mismatch", label: "Mismatches only" },
  { value: "unexplained", label: "Unexplained mismatches only" },
];

const isUnexplained = (r: Reconciliation) => r.status === "mismatch" && !r.explanation;

function Counts() {
  const query = useQuery(statusQuery());
  return (
    <QueryBoundary query={query} what="reconciliation counts">
      {({ reconciliation }) => (
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Stat label="Matches" value={formatInt(reconciliation.match)} />
          <Stat label="Mismatches" value={formatInt(reconciliation.mismatch)} />
          <Stat label="Unexplained" value={formatInt(reconciliation.unexplained)} note={reconciliation.unexplained > 0 ? "Needs an explanation before the gate can pass." : "All mismatches are explained."} />
        </dl>
      )}
    </QueryBoundary>
  );
}

function Checks() {
  const [filter, setFilter] = useState<ReconciliationFilter>("all");
  const selectId = useId();
  const query = useInfiniteQuery(reconciliationsQuery(filter));
  return (
    <>
      <div className="mb-3">
        <label htmlFor={selectId} className="mr-2 text-sm font-medium text-slate-900">
          Show
        </label>
        <select
          id={selectId}
          value={filter}
          onChange={(e) => setFilter(FILTERS.find((f) => f.value === e.target.value)?.value ?? "all")}
          className="rounded border border-slate-500 bg-white px-2 py-1 text-sm"
        >
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
      </div>
      <InfiniteBoundary query={query} what="reconciliations" items={(pages) => pages.flatMap((p) => p.items)} emptyText="No reconciliation checks match this filter.">
        {(rows) => (
          <Table caption="Second-source checks, newest first">
            <thead>
              <tr>
                <Th>Blocks</Th>
                <Th>Provider</Th>
                <Th>Checked</Th>
                <Th>Result</Th>
                <Th numeric>Blocks checked</Th>
                <Th numeric>Hash mismatches</Th>
                <Th numeric>Stored logs</Th>
                <Th numeric>Observed logs</Th>
                <Th>Explanation</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const unexplained = isUnexplained(r);
                return (
                  <tr key={r.id} data-testid={`reconciliation-${r.id}`} data-unexplained={unexplained} className={unexplained ? "bg-red-50 outline outline-2 -outline-offset-2 outline-red-800" : undefined}>
                    <Td>
                      {formatInt(r.fromBlock)}–{formatInt(r.toBlock)}
                    </Td>
                    <Td>{r.provider}</Td>
                    <Td>
                      <Time value={r.checkedAt} />
                    </Td>
                    <Td>
                      {r.status === "match" ? <Badge tone="good">match</Badge> : <Badge tone="bad">{unexplained ? "mismatch, unexplained" : "mismatch, explained"}</Badge>}
                    </Td>
                    <Td numeric>{formatInt(r.blocksChecked)}</Td>
                    <Td numeric>{formatInt(r.hashMismatches)}</Td>
                    <Td numeric>{formatInt(r.storedLogCount)}</Td>
                    <Td numeric>{formatInt(r.observedLogCount)}</Td>
                    <Td>{r.explanation ?? "—"}</Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </InfiniteBoundary>
    </>
  );
}

export function ReconciliationView() {
  return (
    <>
      <Section title="Summary" id="summary">
        <Counts />
      </Section>
      <Section title="Checks" id="checks">
        <Checks />
      </Section>
    </>
  );
}
