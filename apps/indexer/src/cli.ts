const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `72h`, `30m`, `2d`, `90s` (relative to `now`) or an ISO-8601 timestamp (`Date` alone would read a bare `72` as the year 1972). */
export function parseSince(text: string, now: number): Date {
  const duration = /^(\d+)([smhd])$/.exec(text);
  if (duration) return new Date(now - Number(duration[1]) * UNIT_MS[duration[2] as keyof typeof UNIT_MS]);
  const at = /^\d{4}-\d{2}-\d{2}/.test(text) ? new Date(text) : undefined;
  if (!at || Number.isNaN(at.getTime())) throw new Error(`--since must be an ISO timestamp or a duration like 72h, got "${text}"`);
  return at;
}
