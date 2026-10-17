/** `2026-10-17 12:34:56 UTC`; always UTC and locale-free so server and browser render the same text. */
export function formatUtc(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

export function formatInt(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : n.toLocaleString("en-US");
}

export function formatLag(n: number | null | undefined): string {
  return n === null || n === undefined ? "—" : `${formatInt(n)} blocks`;
}

function group(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Renders a base-10 integer string (possibly negative, up to uint256) as a decimal amount without going through
 * floating point, so no digit is ever rounded away. Trailing fraction zeros are dropped.
 */
export function formatUnits(raw: string, decimals: number): string {
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(decimals + 1, "0");
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${group(whole)}${fraction ? `.${fraction}` : ""}`;
}

export function shortHash(hash: string): string {
  return hash.length > 14 ? `${hash.slice(0, 8)}…${hash.slice(-6)}` : hash;
}
