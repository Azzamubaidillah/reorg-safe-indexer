import { expect, test } from "@playwright/test";
import { FIRST_BLOCK, PUBLISHED_TO, RANGE_SIZE, publishedTotals } from "./fixture.ts";
import { swaps, timestampOf, transfers, units } from "./expected.ts";
import { loaded } from "./support.ts";

const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);

test("analytics shows daily volume, active addresses and hourly OHLC for published data only", async ({ page }) => {
  await page.goto("/analytics");
  await loaded(page);
  await expect(page.getByTestId("analytics-meta")).toContainText(`Exported through block ${(FIRST_BLOCK + 8 * RANGE_SIZE - 1).toLocaleString("en-US")}`);
  expect(PUBLISHED_TO).toBe(FIRST_BLOCK + 8 * RANGE_SIZE - 1);

  const expectedDays = new Map<string, { transfers: number; volume: bigint; addresses: Set<string> }>();
  for (const t of transfers) {
    const d = day(timestampOf(t.blockNumber));
    const entry = expectedDays.get(d) ?? { transfers: 0, volume: 0n, addresses: new Set<string>() };
    entry.transfers += 1;
    entry.volume += BigInt(t.value);
    entry.addresses.add(t.from).add(t.to);
    expectedDays.set(d, entry);
  }
  expect(expectedDays.size).toBeGreaterThan(0);

  await page.getByText("Show data table").first().click();
  for (const [d, e] of expectedDays) {
    const row = page.getByTestId(`daily-${d}`);
    await expect(row).toBeVisible();
    const cells = row.getByRole("cell");
    await expect(cells.nth(1)).toHaveText(String(e.transfers));
    await expect(cells.nth(2)).toHaveText(units(e.volume.toString(), 6));
    await expect(cells.nth(3)).toHaveText(String(e.addresses.size));
  }

  // The charts exist and carry text alternatives.
  await expect(page.getByRole("img", { name: /Bar chart of daily USDC transfer volume/ })).toBeVisible();
  await expect(page.getByRole("img", { name: /Bar chart of distinct sending or receiving addresses per day/ })).toBeVisible();
  await expect(page.getByRole("img", { name: /Line chart of USDC\/WETH 0.05% price/ })).toBeVisible();
  await expect(page.locator(".recharts-bar-rectangle").first()).toBeVisible();

  const buckets = new Map<string, number>();
  for (const s of swaps) {
    const bucket = new Date(Math.floor(timestampOf(s.blockNumber) / 3600) * 3600 * 1000).toISOString();
    buckets.set(bucket, (buckets.get(bucket) ?? 0) + 1);
  }
  expect(buckets.size).toBe(2);
  expect([...buckets.values()].reduce((a, b) => a + b, 0)).toBe(publishedTotals.swaps);
  await page.getByText("Show data table").last().click();
  const ohlc = page.getByRole("table", { name: "USDC/WETH 0.05% OHLC, 1h buckets" });
  await expect(ohlc.getByRole("row")).toHaveCount(1 + buckets.size);
  for (const [bucket, count] of buckets) {
    const cells = page.getByTestId(`ohlc-${bucket.replace(".000Z", "Z")}`).getByRole("cell");
    await expect(cells.nth(5)).toHaveText(String(count));
  }
});

test("a day window with no data shows the empty state", async ({ page }) => {
  await page.goto("/analytics");
  await loaded(page);
  await page.getByLabel("From day (UTC)").fill("2030-01-01");
  await expect(page.getByText("No transfer volume in this window.")).toBeVisible();
  await expect(page.getByText("No swaps in this window.")).toBeVisible();
});
