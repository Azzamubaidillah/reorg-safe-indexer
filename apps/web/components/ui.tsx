"use client";

import type { InfiniteData, UseInfiniteQueryResult, UseQueryResult } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { formatUtc, shortHash } from "../lib/format.ts";

export function PageTitle({ children, lead }: { children: ReactNode; lead?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold text-slate-900">{children}</h1>
      {lead ? <p className="mt-1 max-w-3xl text-slate-700">{lead}</p> : null}
    </div>
  );
}

export function Section({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="mb-8">
      <h2 id={id} className="mb-3 text-lg font-semibold text-slate-900">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p role="status" className="text-slate-700">
      Loading {what}…
    </p>
  );
}

export function ErrorNotice({ error, onRetry }: { error: Error; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded border border-red-300 bg-red-50 p-3 text-red-900">
      <p>Could not load data: {error.message}</p>
      <button type="button" onClick={onRetry} className="mt-2 rounded border border-red-800 bg-white px-3 py-1 text-sm font-medium text-red-900 hover:bg-red-100">
        Try again
      </button>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded border border-dashed border-slate-400 bg-white p-4 text-slate-700">{children}</p>;
}

/** Loading / error / success switch shared by every page; `empty` decides when to show the empty state instead of `children`. */
export function QueryBoundary<T>({
  query,
  what,
  isEmpty,
  emptyText,
  children,
}: {
  query: UseQueryResult<T>;
  what: string;
  isEmpty?: (data: T) => boolean;
  emptyText?: string;
  children: (data: T) => ReactNode;
}) {
  if (query.isPending) return <Loading what={what} />;
  if (query.isError) return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  if (isEmpty?.(query.data)) return <Empty>{emptyText ?? `No ${what} yet.`}</Empty>;
  return <>{children(query.data)}</>;
}

export function InfiniteBoundary<Page, Item>({
  query,
  what,
  items,
  emptyText,
  children,
}: {
  query: UseInfiniteQueryResult<InfiniteData<Page>>;
  what: string;
  items: (pages: Page[]) => Item[];
  emptyText?: string;
  children: (items: Item[]) => ReactNode;
}) {
  if (query.isPending) return <Loading what={what} />;
  if (query.isError) return <ErrorNotice error={query.error} onRetry={() => void query.refetch()} />;
  const all = items(query.data.pages);
  if (all.length === 0) return <Empty>{emptyText ?? `No ${what} yet.`}</Empty>;
  return (
    <>
      {children(all)}
      {query.hasNextPage ? (
        <button
          type="button"
          onClick={() => void query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
          className="mt-3 rounded border border-blue-900 bg-white px-4 py-2 text-sm font-medium text-blue-900 hover:bg-blue-50 disabled:opacity-60"
        >
          {query.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </>
  );
}

const TONES: Record<string, string> = {
  good: "bg-green-100 text-green-900 border-green-800",
  bad: "bg-red-100 text-red-900 border-red-800",
  warn: "bg-amber-100 text-amber-900 border-amber-800",
  neutral: "bg-slate-100 text-slate-900 border-slate-600",
};

/** Status is always spelled out in text; colour only reinforces it. */
export function Badge({ tone, children }: { tone: "good" | "bad" | "warn" | "neutral"; children: ReactNode }) {
  return <span className={`inline-block rounded border px-2 py-0.5 text-xs font-semibold ${TONES[tone]}`}>{children}</span>;
}

export const RANGE_TONE: Record<string, "good" | "bad" | "warn"> = { published: "good", failed: "bad", candidate: "warn" };

export function RangeBadge({ status }: { status: string }) {
  return <Badge tone={RANGE_TONE[status] ?? "neutral"}>{status}</Badge>;
}

export function Table({ caption, children, className }: { caption: string; children: ReactNode; className?: string }) {
  return (
    <div className={`overflow-x-auto rounded border border-slate-300 bg-white ${className ?? ""}`}>
      <table className="w-full border-collapse text-left text-sm">
        <caption className="px-3 py-2 text-left text-sm font-semibold text-slate-900">{caption}</caption>
        {children}
      </table>
    </div>
  );
}

export function Th({ children, numeric }: { children: ReactNode; numeric?: boolean }) {
  return (
    <th scope="col" className={`border-b border-slate-300 bg-slate-100 px-3 py-2 font-semibold text-slate-900 ${numeric ? "text-right" : ""}`}>
      {children}
    </th>
  );
}

export function Td({ children, numeric, className }: { children: ReactNode; numeric?: boolean; className?: string }) {
  return <td className={`border-b border-slate-200 px-3 py-2 align-top text-slate-900 ${numeric ? "text-right tabular-nums" : ""} ${className ?? ""}`}>{children}</td>;
}

export function RowTh({ children }: { children: ReactNode }) {
  return (
    <th scope="row" className="border-b border-slate-200 px-3 py-2 text-left align-top font-medium text-slate-900">
      {children}
    </th>
  );
}

export function Hash({ value, full }: { value: string; full?: boolean }) {
  return (
    <code title={value} className={`font-mono text-xs text-slate-900 ${full ? "break-all" : "whitespace-nowrap"}`}>
      {full ? value : shortHash(value)}
    </code>
  );
}

export function Time({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{formatUtc(value)}</time> : <span>—</span>;
}

export function Stat({ label, value, note }: { label: string; value: ReactNode; note?: ReactNode }) {
  return (
    <div className="rounded border border-slate-300 bg-white p-4">
      <dt className="text-sm font-medium text-slate-700">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">{value}</dd>
      {note ? <dd className="mt-1 text-sm text-slate-700">{note}</dd> : null}
    </div>
  );
}
