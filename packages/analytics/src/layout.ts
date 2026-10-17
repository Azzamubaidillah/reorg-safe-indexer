import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";

export const KINDS = ["transfers", "swaps"] as const;
export type Kind = (typeof KINDS)[number];

export const MANIFEST_FILE = "_manifest.json";
export const MANIFEST_VERSION = 1;

/** One day's file for one kind, as recorded at write time. */
export interface PartitionEntry {
  rows: number;
  /** SHA-256 of the Parquet bytes. */
  sha256: string;
}

export interface DayEntry {
  /** Lowest/highest block seen in this day among exported ranges. Block timestamps increase with height, so a day is one contiguous block span. */
  minBlock: number;
  maxBlock: number;
  transfers?: PartitionEntry;
  swaps?: PartitionEntry;
}

export interface Manifest {
  version: typeof MANIFEST_VERSION;
  chainId: number;
  /** When the export last changed anything. */
  exportedAt: string;
  /** Highest block of any exported range. Earlier ranges may be missing if they are not yet published. */
  exportedThroughBlock: number;
  /** Merged, sorted, inclusive block intervals of the published ranges already in the files. */
  exported: [number, number][];
  days: Record<string, DayEntry>;
}

export function partitionPath(dir: string, kind: Kind, day: string): string {
  return join(dir, kind, `day=${day}`, "data.parquet");
}

/** Glob DuckDB reads with `hive_partitioning`; the temp name `data.parquet.tmp` deliberately does not match. */
export function partitionGlob(dir: string, kind: Kind): string {
  return join(dir, kind, "day=*", "data.parquet");
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function assertDay(day: string): void {
  if (!DAY_PATTERN.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new RangeError(`not a YYYY-MM-DD day: ${day}`);
}

export function dayBounds(day: string): { start: Date; end: Date } {
  assertDay(day);
  const start = Date.parse(`${day}T00:00:00Z`);
  return { start: new Date(start), end: new Date(start + 86_400_000) };
}

export async function readManifest(dir: string): Promise<Manifest | null> {
  let text: string;
  try {
    text = await readFile(join(dir, MANIFEST_FILE), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const manifest = JSON.parse(text) as Manifest;
  if (manifest.version !== MANIFEST_VERSION) throw new Error(`unsupported analytics manifest version ${String(manifest.version)}`);
  return manifest;
}

/** Write-then-rename so a reader or a crash never sees half a file; fsync before the rename so the rename cannot outlive the bytes. */
export async function writeFileAtomic(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tmp, path);
}

export async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
  await writeFileAtomic(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

export async function sha256FileIfExists(path: string): Promise<string | null> {
  try {
    return await sha256File(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Inclusive intervals, merged when overlapping or adjacent. */
export function mergeIntervals(intervals: readonly (readonly [number, number])[]): [number, number][] {
  const sorted = intervals.map(([from, to]): [number, number] => [from, to]).sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const [from, to] of sorted) {
    const last = merged.at(-1);
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/** True when `[from, to]` lies inside one interval of the merged list. */
export function isCovered(merged: readonly (readonly [number, number])[], from: number, to: number): boolean {
  return merged.some(([a, b]) => a <= from && to <= b);
}
