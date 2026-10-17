/**
 * uint256/int256 amounts do not fit any Parquet or DuckDB integer (DECIMAL tops out at 38 digits, HUGEINT
 * at 127 bits; DuckDB writes HUGEINT to Parquet as a lossy DOUBLE). So each amount is stored twice:
 *   - the canonical base-10 string, lossless, readable by any tool;
 *   - its absolute value split into three DECIMAL(26,0) chunks of base 10^26 (3 x 26 = 78 digits covers
 *     NUMERIC(78,0)), which DuckDB sums exactly: a chunk sum overflows DECIMAL(38,0) only past 10^12 rows
 *     in one group, and then it errors instead of wrapping.
 * Totals are recombined here in BigInt, so they are exact at any size.
 */
const CHUNK_DIGITS = 26;
const CHUNK_COUNT = 3;
const WIDTH = CHUNK_DIGITS * CHUNK_COUNT;
const CHUNK_BASE = 10n ** BigInt(CHUNK_DIGITS);

/** SQL expression for chunk `index` (0 = least significant) of |amount|, from a VARCHAR column holding base-10 text. */
function chunkSql(column: string, index: number): string {
  const start = WIDTH - CHUNK_DIGITS * (index + 1) + 1;
  return `cast(substr(lpad(ltrim(${column}, '-'), ${WIDTH}, '0'), ${start}, ${CHUNK_DIGITS}) as decimal(${CHUNK_DIGITS}, 0))`;
}

/** Name of the chunk column for `prefix`, e.g. `chunkColumn("value", 1)` = `value_c1`. */
export function chunkColumn(prefix: string, index: number): string {
  return `${prefix}_c${index}`;
}

/** `select` list fragment producing `<prefix>_c0..c2` from the VARCHAR column `source`. */
export function chunkSelect(source: string, prefix: string): string {
  return Array.from({ length: CHUNK_COUNT }, (_, i) => `${chunkSql(source, i)} as ${chunkColumn(prefix, i)}`).join(", ");
}

/** `select` list fragment summing every chunk of `prefix`, cast to VARCHAR so JS never sees a lossy number. */
export function chunkSumSelect(prefix: string): string {
  return Array.from({ length: CHUNK_COUNT }, (_, i) => `cast(sum(${chunkColumn(prefix, i)}) as varchar) as ${chunkColumn(`sum_${prefix}`, i)}`).join(", ");
}

/** Recombines the row produced by `chunkSumSelect(prefix)` into a base-10 string. */
export function sumFromChunks(row: Record<string, unknown>, prefix: string): string {
  let total = 0n;
  for (let i = CHUNK_COUNT - 1; i >= 0; i--) total = total * CHUNK_BASE + BigInt(String(row[chunkColumn(`sum_${prefix}`, i)]));
  return total.toString();
}
