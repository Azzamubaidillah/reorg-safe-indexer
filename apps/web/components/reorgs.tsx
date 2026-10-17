"use client";

import type { BlockRef, Reorg } from "@rsi/contracts";
import { useInfiniteQuery } from "@tanstack/react-query";
import { formatInt } from "../lib/format.ts";
import { reorgsQuery } from "../lib/queries.ts";
import { Badge, Hash, InfiniteBoundary, Section, Table, Td, Th, Time } from "./ui.tsx";

const ACTION_LABEL: Record<Reorg["action"], string> = { rolled_back: "Rolled back", halted: "Halted" };

/** Pairs orphaned and canonical blocks by height; either side may be missing at a height. */
function byHeight(reorg: Reorg): { height: number; orphaned?: BlockRef; canonical?: BlockRef }[] {
  const rows = new Map<number, { height: number; orphaned?: BlockRef; canonical?: BlockRef }>();
  for (const b of reorg.orphaned) rows.set(b.number, { height: b.number, orphaned: b });
  for (const b of reorg.canonical) rows.set(b.number, { ...rows.get(b.number), height: b.number, canonical: b });
  return [...rows.values()].sort((a, b) => a.height - b.height);
}

function Timeline({ reorgs }: { reorgs: Reorg[] }) {
  return (
    <ol className="relative ml-3 border-l-2 border-slate-400" aria-label="Reorgs, newest first">
      {reorgs.map((r) => (
        <li key={r.id} className="mb-5 ml-5" data-testid="timeline-item">
          <span aria-hidden="true" className={`absolute -left-[7px] mt-1.5 h-3 w-3 rounded-full border-2 border-white ${r.action === "halted" ? "bg-red-700" : "bg-amber-600"}`} />
          <p className="text-sm text-slate-700">
            <Time value={r.detectedAt} />
          </p>
          <p className="text-slate-900">
            <a href={`#reorg-${r.id}`} className="font-medium text-blue-800 underline">
              Reorg #{r.id}
            </a>{" "}
            <Badge tone={r.action === "halted" ? "bad" : "warn"}>{ACTION_LABEL[r.action]}</Badge> at block {formatInt(r.forkBlock)}, depth {formatInt(r.depth)}
          </p>
          <p className="mt-1 text-sm text-slate-800">
            {r.orphaned.length} orphaned → {r.canonical.length} canonical block{r.canonical.length === 1 ? "" : "s"}
          </p>
        </li>
      ))}
    </ol>
  );
}

function Detail({ reorg }: { reorg: Reorg }) {
  const rows = byHeight(reorg);
  return (
    <article id={`reorg-${reorg.id}`} aria-labelledby={`reorg-${reorg.id}-title`} className="mb-6 scroll-mt-4" data-testid="reorg-detail">
      <h3 id={`reorg-${reorg.id}-title`} className="mb-2 font-semibold text-slate-900">
        Reorg #{reorg.id}: {ACTION_LABEL[reorg.action].toLowerCase()} at block {formatInt(reorg.forkBlock)}
      </h3>
      <Table caption={`Block hashes per height for reorg #${reorg.id}`}>
        <thead>
          <tr>
            <Th numeric>Height</Th>
            <Th>Orphaned hash</Th>
            <Th>Canonical hash</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.height}>
              <Td numeric>{formatInt(row.height)}</Td>
              <Td>{row.orphaned ? <Hash value={row.orphaned.hash} full /> : "—"}</Td>
              <Td>{row.canonical ? <Hash value={row.canonical.hash} full /> : "—"}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </article>
  );
}

function Summary({ reorgs }: { reorgs: Reorg[] }) {
  return (
    <Table caption="Reorg summary">
      <thead>
        <tr>
          <Th>ID</Th>
          <Th>Detected</Th>
          <Th>Action</Th>
          <Th numeric>Depth</Th>
          <Th numeric>Fork block</Th>
          <Th numeric>Ancestor block</Th>
          <Th numeric>Rollback from</Th>
          <Th numeric>Finalized block</Th>
        </tr>
      </thead>
      <tbody>
        {reorgs.map((r) => (
          <tr key={r.id}>
            <Td>#{r.id}</Td>
            <Td>
              <Time value={r.detectedAt} />
            </Td>
            <Td>{ACTION_LABEL[r.action]}</Td>
            <Td numeric>{formatInt(r.depth)}</Td>
            <Td numeric>{formatInt(r.forkBlock)}</Td>
            <Td numeric>{formatInt(r.ancestorBlock)}</Td>
            <Td numeric>{formatInt(r.rollbackFrom)}</Td>
            <Td numeric>{formatInt(r.finalizedBlock)}</Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function ReorgsView() {
  const query = useInfiniteQuery(reorgsQuery());
  return (
    <InfiniteBoundary query={query} what="reorgs" items={(pages) => pages.flatMap((p) => p.items)} emptyText="No reorg has been detected.">
      {(reorgs) => (
        <>
          <Section title="Timeline" id="timeline">
            <Timeline reorgs={reorgs} />
          </Section>
          <Section title="Summary" id="summary">
            <Summary reorgs={reorgs} />
          </Section>
          <Section title="Hashes by height" id="hashes">
            {reorgs.map((r) => (
              <Detail key={r.id} reorg={r} />
            ))}
          </Section>
        </>
      )}
    </InfiniteBoundary>
  );
}
