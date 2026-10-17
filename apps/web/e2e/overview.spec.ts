import { expect, test, type Page } from "@playwright/test";
import { FINALIZED_BLOCK, HEAD_BLOCK, LAST_BLOCK, PUBLISHED_TO, REORG_DEPTH, REORG_FORK, RPC_CALLS, RUN_ID, allTotals, chain, FIRST_BLOCK, FAILED_FROM, FAILED_TO } from "./fixture.ts";
import { loaded } from "./support.ts";

const n = (v: number) => v.toLocaleString("en-US");
const stat = (page: Page, label: string) => page.locator("dl > div").filter({ has: page.getByText(label, { exact: true }) });

test("overview shows the seeded chain position, lag, ranges, last run and last reorg", async ({ page }) => {
  await page.goto("/");
  await loaded(page);
  await expect(page).toHaveTitle(/Overview/);

  await expect(stat(page, "Head block")).toContainText(n(HEAD_BLOCK));
  await expect(stat(page, "Finalized block")).toContainText(n(FINALIZED_BLOCK));
  await expect(stat(page, "Stored tip")).toContainText(n(LAST_BLOCK));
  await expect(stat(page, "Last published block")).toContainText(n(PUBLISHED_TO));
  await expect(stat(page, "Head lag")).toContainText(`${HEAD_BLOCK - LAST_BLOCK} blocks`);
  await expect(stat(page, "Finalized lag")).toContainText(`${FINALIZED_BLOCK - PUBLISHED_TO} blocks`);
  // Every sample has the same lag, so each percentile equals it.
  await expect(stat(page, "p95")).toContainText(String(HEAD_BLOCK - LAST_BLOCK));
  await expect(stat(page, "Samples")).toContainText("10");

  const published = chain.totals(FIRST_BLOCK, PUBLISHED_TO);
  const failed = chain.totals(FAILED_FROM, FAILED_TO);
  const candidate = chain.totals(FAILED_TO + 1, LAST_BLOCK);
  const ranges = page.getByRole("table", { name: "Committed block ranges by publication status" });
  for (const [status, count, totals] of [
    ["published", 8, published],
    ["candidate", 3, candidate],
    ["failed", 1, failed],
  ] as const) {
    const cells = ranges.getByRole("row", { name: new RegExp(`^${status}`) }).getByRole("cell");
    await expect(cells.nth(1)).toHaveText(String(count));
    await expect(cells.nth(2)).toHaveText(n(totals.blocks));
    await expect(cells.nth(3)).toHaveText(n(totals.logs));
  }
  expect(allTotals.blocks).toBe(published.blocks + failed.blocks + candidate.blocks);

  await expect(page.getByText("1 open backfill job")).toBeVisible();
  await expect(page.getByText("1 unexplained")).toBeVisible();

  await expect(page.getByText(RUN_ID)).toBeVisible();
  const total = Object.values(RPC_CALLS).reduce((sum, methods) => sum + Object.values(methods).reduce((a, b) => a + b, 0), 0);
  const calls = page.getByRole("table", { name: `RPC calls of the last run (${n(total)} total)` });
  await expect(calls.getByRole("row", { name: /mock-a eth_getLogs/ })).toContainText(String(RPC_CALLS["mock-a"].eth_getLogs));
  await expect(calls.getByRole("row", { name: /mock-b eth_getLogs/ })).toContainText(String(RPC_CALLS["mock-b"].eth_getLogs));

  // detectedAt is 12:00 UTC; the browser runs in America/Los_Angeles, so a local-time render would differ.
  await expect(page.getByText(`at block ${n(REORG_FORK)}, depth ${REORG_DEPTH}`)).toBeVisible();
  await expect(page.getByText("2026-10-10 12:00:00 UTC")).toBeVisible();
});
