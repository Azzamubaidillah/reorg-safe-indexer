import { ApiError } from "@rsi/contracts";

/** Same-origin prefix rewritten to the API by next.config.ts. */
const BASE = "/api";

/** What getJson needs from a contracts (zod) schema; structural so the web app need not depend on zod itself. */
export interface Schema<T> {
  safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: { message: string }[] } };
}

export type QueryParams = Record<string, string | number | undefined>;

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/** Empty-string params are dropped so blank form fields mean "no filter". */
export function toSearch(params: QueryParams): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/** GETs `path` and validates the body with the contracts schema, so a drifting API fails loudly instead of rendering garbage. */
export async function getJson<T>(path: string, schema: Schema<T>, params: QueryParams = {}, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${BASE}${path}${toSearch(params)}`, { signal, headers: { accept: "application/json" } });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new ApiRequestError("The API is unreachable.", 0, "network");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ApiError.safeParse(body);
    throw new ApiRequestError(parsed.success ? parsed.data.error.message : `HTTP ${response.status}`, response.status, parsed.success ? parsed.data.error.code : "http");
  }
  const result = schema.safeParse(body);
  if (!result.success) throw new ApiRequestError(`Unexpected response shape from ${path}: ${result.error.issues[0]?.message ?? "invalid"}`, response.status, "contract");
  return result.data;
}
