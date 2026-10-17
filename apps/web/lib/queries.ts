import {
  AnalyticsMeta,
  DailyVolume,
  PoolOhlc,
  RangeDetail,
  RangesPage,
  ReconciliationsPage,
  ReorgsPage,
  Status,
  SwapsPage,
  TransfersPage,
  type OhlcInterval,
  type RangeStatus,
} from "@rsi/contracts";
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { getJson, type QueryParams } from "./api.ts";

/** Dashboard data is polled so a long-lived tab does not show stale head positions. */
const POLL_MS = 15_000;

export const statusQuery = () =>
  queryOptions({ queryKey: ["status"], queryFn: ({ signal }) => getJson("/v1/status", Status, {}, signal), refetchInterval: POLL_MS });

/** The first page has no cursor. */
const FIRST_PAGE = undefined as string | undefined;

export const reorgsQuery = () =>
  infiniteQueryOptions({
    queryKey: ["reorgs"],
    queryFn: ({ pageParam, signal }) => getJson("/v1/reorgs", ReorgsPage, { limit: 50, cursor: pageParam }, signal),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const rangesQuery = (status: RangeStatus | "") =>
  infiniteQueryOptions({
    queryKey: ["ranges", status],
    queryFn: ({ pageParam, signal }) => getJson("/v1/ranges", RangesPage, { limit: 50, cursor: pageParam, status }, signal),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export const rangeDetailQuery = (fromBlock: number) =>
  queryOptions({ queryKey: ["range", fromBlock], queryFn: ({ signal }) => getJson(`/v1/ranges/${fromBlock}`, RangeDetail, {}, signal) });

export type ReconciliationFilter = "all" | "mismatch" | "unexplained";

export const reconciliationsQuery = (filter: ReconciliationFilter) =>
  infiniteQueryOptions({
    queryKey: ["reconciliations", filter],
    queryFn: ({ pageParam, signal }) =>
      getJson(
        "/v1/reconciliations",
        ReconciliationsPage,
        { limit: 50, cursor: pageParam, status: filter === "mismatch" ? "mismatch" : undefined, unexplained: filter === "unexplained" ? "true" : undefined },
        signal,
      ),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

export interface ExplorerParams extends QueryParams {
  limit: number;
  cursor: string | undefined;
  address: string;
  fromBlock: string;
  toBlock: string;
}

export const transfersQuery = (params: ExplorerParams & { token: string }) =>
  queryOptions({ queryKey: ["transfers", params], queryFn: ({ signal }) => getJson("/v1/transfers", TransfersPage, params, signal) });

export const swapsQuery = (params: ExplorerParams & { pool: string }) =>
  queryOptions({ queryKey: ["swaps", params], queryFn: ({ signal }) => getJson("/v1/swaps", SwapsPage, params, signal) });

export interface DayWindow extends QueryParams {
  from: string;
  to: string;
}

export const dailyVolumeQuery = (params: DayWindow & { token: string }) =>
  queryOptions({ queryKey: ["daily-volume", params], queryFn: ({ signal }) => getJson("/v1/analytics/daily-volume", DailyVolume, params, signal) });

export const poolOhlcQuery = (params: DayWindow & { pool: string; interval: OhlcInterval }) =>
  queryOptions({ queryKey: ["pool-ohlc", params], queryFn: ({ signal }) => getJson("/v1/analytics/pool-ohlc", PoolOhlc, params, signal) });

export const analyticsMetaQuery = () =>
  queryOptions({ queryKey: ["analytics-meta"], queryFn: ({ signal }) => getJson("/v1/analytics/meta", AnalyticsMeta, {}, signal) });
