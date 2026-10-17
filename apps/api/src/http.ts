import { z } from "zod";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** Parses client input; a failure becomes a 400 listing every offending field. */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const message = result.error.issues.map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message)).join("; ");
  throw new HttpError(400, "bad_request", message);
}

/**
 * Cursors are base64url JSON of the last row's sort key. They are opaque to clients but not
 * secret, so decoding re-validates the shape: a forged or truncated cursor is a 400, never SQL input.
 */
export function encodeCursor(key: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

export function decodeCursor<T extends z.ZodType>(schema: T, cursor: string | undefined): z.infer<T> | undefined {
  if (cursor === undefined) return undefined;
  const bad = () => new HttpError(400, "invalid_cursor", "cursor is not valid for this endpoint");
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  const result = schema.safeParse(json);
  if (!result.success) throw bad();
  return result.data;
}

/** Callers fetch `limit + 1` rows; the extra one only proves another page exists. */
export function paginate<T>(rows: T[], limit: number, cursorOf: (last: T) => string): { items: T[]; nextCursor: string | null } {
  if (rows.length <= limit) return { items: rows, nextCursor: null };
  const items = rows.slice(0, limit);
  return { items, nextCursor: cursorOf(items[limit - 1] as T) };
}

const nonNegative = z.number().int().nonnegative();
export const blockCursor = z.strictObject({ b: nonNegative });
export const eventCursor = z.strictObject({ b: nonNegative, l: nonNegative });
export const jobCursor = z.strictObject({ f: nonNegative, t: nonNegative });
export const idCursor = z.strictObject({ id: nonNegative });
