"use client";

import { OHLC_INTERVALS, type DailyVolumeRow, type OhlcInterval, type PoolOhlcRow } from "@rsi/contracts";
import { useQuery } from "@tanstack/react-query";
import { useId, useState, type ReactNode } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatInt, formatUnits, formatUtc } from "../lib/format.ts";
import { analyticsMetaQuery, dailyVolumeQuery, poolOhlcQuery } from "../lib/queries.ts";
import { DEFAULT_POOL, DEFAULT_TOKEN, POOLS, TOKENS } from "../lib/tokens.ts";
import { QueryBoundary, Section, Table, Td, Th } from "./ui.tsx";

/** Large uint256-scale volumes would print as 70-digit axis labels; scientific notation keeps them readable. */
const axisNumber = (n: number): string => (Math.abs(n) >= 1e6 || (n !== 0 && Math.abs(n) < 1e-3) ? n.toExponential(1) : n.toLocaleString("en-US", { maximumFractionDigits: 4 }));

function Chart({ title, summary, table, children }: { title: string; summary: string; table: ReactNode; children: ReactNode }) {
  return (
    <figure className="mb-6 rounded border border-slate-300 bg-white p-4">
      <figcaption className="mb-2 font-semibold text-slate-900">{title}</figcaption>
      {/* The SVG is decorative: the same numbers are in the table below and the summary is the accessible name. */}
      <div role="img" aria-label={summary} className="h-72 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {children as React.ReactElement}
        </ResponsiveContainer>
      </div>
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-medium text-blue-900">Show data table</summary>
        <div className="mt-2">{table}</div>
      </details>
    </figure>
  );
}

const PALETTE = { bar: "#1d4ed8", line: "#047857", high: "#b45309", low: "#7c3aed" };

interface VolumePoint {
  day: string;
  volume: number;
  activeAddresses: number;
}

function DailyCharts({ rows, decimals, symbol }: { rows: DailyVolumeRow[]; decimals: number; symbol: string }) {
  const points: VolumePoint[] = rows.map((r) => ({ day: r.day, volume: Number(formatUnits(r.volume, decimals).replaceAll(",", "")), activeAddresses: r.activeAddresses }));
  const peak = points.reduce((best, p) => (p.volume > best.volume ? p : best), points[0] as VolumePoint);
  const first = rows[0];
  const last = rows[rows.length - 1];
  return (
    <>
      <Chart
        title={`Daily transfer volume (${symbol})`}
        summary={`Bar chart of daily ${symbol} transfer volume from ${first?.day} to ${last?.day}: ${rows.length} day${rows.length === 1 ? "" : "s"}, peak ${axisNumber(peak.volume)} ${symbol} on ${peak.day}.`}
        table={
          <Table caption={`Daily ${symbol} transfer volume`}>
            <thead>
              <tr>
                <Th>Day (UTC)</Th>
                <Th numeric>Transfers</Th>
                <Th numeric>Volume ({symbol})</Th>
                <Th numeric>Active addresses</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.day} data-testid={`daily-${r.day}`}>
                  <Td>{r.day}</Td>
                  <Td numeric>{formatInt(r.transfers)}</Td>
                  <Td numeric>
                    <span title={`${r.volume} base units`}>{formatUnits(r.volume, decimals)}</span>
                  </Td>
                  <Td numeric>{formatInt(r.activeAddresses)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        }
      >
        <BarChart data={points} accessibilityLayer={false}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="day" />
          <YAxis tickFormatter={axisNumber} width={80} />
          <Tooltip formatter={(v) => axisNumber(Number(v))} />
          <Bar dataKey="volume" name={`Volume (${symbol})`} fill={PALETTE.bar} isAnimationActive={false} />
        </BarChart>
      </Chart>
      <Chart
        title="Active addresses per day"
        summary={`Bar chart of distinct sending or receiving addresses per day: ${rows.map((r) => `${r.day} ${r.activeAddresses}`).join(", ")}.`}
        table={<p className="text-sm text-slate-700">The values are listed in the daily volume table above.</p>}
      >
        <BarChart data={points} accessibilityLayer={false}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="day" />
          <YAxis allowDecimals={false} width={60} />
          <Tooltip />
          <Bar dataKey="activeAddresses" name="Active addresses" fill={PALETTE.line} isAnimationActive={false} />
        </BarChart>
      </Chart>
    </>
  );
}

function OhlcChart({ rows, label, interval }: { rows: PoolOhlcRow[]; label: string; interval: OhlcInterval }) {
  const first = rows[0];
  const last = rows[rows.length - 1];
  const points = rows.map((r) => ({ ...r, time: r.bucket.slice(0, 16).replace("T", " ") }));
  return (
    <Chart
      title={`${label} price, ${interval} candles`}
      summary={`Line chart of ${label} price per ${interval} bucket from ${first ? formatUtc(first.bucket) : "—"} to ${last ? formatUtc(last.bucket) : "—"}: ${rows.length} buckets, last close ${last?.close}.`}
      table={
        <Table caption={`${label} OHLC, ${interval} buckets`}>
          <thead>
            <tr>
              <Th>Bucket (UTC)</Th>
              <Th numeric>Open</Th>
              <Th numeric>High</Th>
              <Th numeric>Low</Th>
              <Th numeric>Close</Th>
              <Th numeric>Swaps</Th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.bucket} data-testid={`ohlc-${r.bucket}`}>
                <Td>{formatUtc(r.bucket)}</Td>
                <Td numeric>{r.open}</Td>
                <Td numeric>{r.high}</Td>
                <Td numeric>{r.low}</Td>
                <Td numeric>{r.close}</Td>
                <Td numeric>{formatInt(r.swaps)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      }
    >
      <LineChart data={points} accessibilityLayer={false}>
        <CartesianGrid strokeDasharray="3 3" />
        <XAxis dataKey="time" />
        <YAxis tickFormatter={axisNumber} width={80} domain={["auto", "auto"]} />
        <Tooltip formatter={(v) => axisNumber(Number(v))} />
        <Legend />
        <Line dataKey="high" name="High" stroke={PALETTE.high} dot={false} isAnimationActive={false} strokeDasharray="4 3" />
        <Line dataKey="close" name="Close" stroke={PALETTE.line} strokeWidth={2} dot={rows.length < 30} isAnimationActive={false} />
        <Line dataKey="low" name="Low" stroke={PALETTE.low} dot={false} isAnimationActive={false} strokeDasharray="4 3" />
      </LineChart>
    </Chart>
  );
}

function ExportMeta() {
  const query = useQuery(analyticsMetaQuery());
  return (
    <QueryBoundary query={query} what="export metadata">
      {(meta) => (
        <p className="mb-4 text-sm text-slate-800" data-testid="analytics-meta">
          {meta.exportedThroughBlock === null
            ? "No Parquet export exists yet."
            : `Exported through block ${formatInt(meta.exportedThroughBlock)} at ${formatUtc(meta.exportedAt)} · ${formatInt(meta.partitions)} partitions · ${Object.entries(meta.rowCounts)
                .map(([name, count]) => `${formatInt(count)} ${name}`)
                .join(", ")}`}
        </p>
      )}
    </QueryBoundary>
  );
}

const field = "mt-1 block rounded border border-slate-500 bg-white px-2 py-1 text-sm";

export function AnalyticsView() {
  const id = useId();
  const [token, setToken] = useState(DEFAULT_TOKEN);
  const [pool, setPool] = useState(DEFAULT_POOL);
  const [interval, setInterval] = useState<OhlcInterval>("1h");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const tokenInfo = TOKENS[token];
  const poolInfo = POOLS[pool];
  const volume = useQuery({ ...dailyVolumeQuery({ token, from, to }), enabled: tokenInfo !== undefined });
  const ohlc = useQuery({ ...poolOhlcQuery({ pool, interval, from, to }), enabled: poolInfo !== undefined });

  return (
    <>
      <ExportMeta />
      <Section title="Filters" id="analytics-filters">
        <form onSubmit={(e) => e.preventDefault()} className="flex flex-wrap gap-4 rounded border border-slate-300 bg-white p-4">
          <div>
            <label htmlFor={`${id}-token`} className="text-sm font-medium text-slate-900">
              Token
            </label>
            <select id={`${id}-token`} className={field} value={token} onChange={(e) => setToken(e.target.value)}>
              {Object.entries(TOKENS).map(([address, info]) => (
                <option key={address} value={address}>
                  {info.symbol}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-pool`} className="text-sm font-medium text-slate-900">
              Pool
            </label>
            <select id={`${id}-pool`} className={field} value={pool} onChange={(e) => setPool(e.target.value)}>
              {Object.entries(POOLS).map(([address, info]) => (
                <option key={address} value={address}>
                  {info.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-interval`} className="text-sm font-medium text-slate-900">
              Candle interval
            </label>
            <select id={`${id}-interval`} className={field} value={interval} onChange={(e) => setInterval(OHLC_INTERVALS.find((i) => i === e.target.value) ?? "1h")}>
              {OHLC_INTERVALS.map((i) => (
                <option key={i} value={i}>
                  {i}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${id}-from`} className="text-sm font-medium text-slate-900">
              From day (UTC)
            </label>
            <input id={`${id}-from`} type="date" className={field} value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label htmlFor={`${id}-to`} className="text-sm font-medium text-slate-900">
              To day (UTC)
            </label>
            <input id={`${id}-to`} type="date" className={field} value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        </form>
      </Section>

      <Section title="Transfer volume" id="volume">
        <QueryBoundary query={volume} what="daily volume" isEmpty={(rows) => rows.length === 0} emptyText="No transfer volume in this window.">
          {(rows) => tokenInfo && <DailyCharts rows={rows} decimals={tokenInfo.decimals} symbol={tokenInfo.symbol} />}
        </QueryBoundary>
      </Section>

      <Section title="Pool price" id="price">
        <QueryBoundary query={ohlc} what="pool prices" isEmpty={(rows) => rows.length === 0} emptyText="No swaps in this window.">
          {(rows) => poolInfo && <OhlcChart rows={rows} label={poolInfo.label} interval={interval} />}
        </QueryBoundary>
      </Section>
    </>
  );
}
