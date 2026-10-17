import { expect, test, type Page } from "@playwright/test";
import { FAILED_FROM, FIRST_BLOCK, PUBLISHED_TO } from "./fixture.ts";
import { rowId, swaps, transfers, units } from "./expected.ts";
import { ids, loaded } from "./support.ts";

const rows = (page: Page) => page.locator("tbody tr[data-row-id]");

async function apply(page: Page) {
  await page.getByRole("button", { name: "Apply filters" }).click();
}

/** Newest first: height descending, then log index descending. */
const newestFirst = (a: { blockNumber: number; logIndex: number }, b: { blockNumber: number; logIndex: number }) => b.blockNumber - a.blockNumber || b.logIndex - a.logIndex;

test("transfers paginate without duplicates and cover exactly the published ranges", async ({ page }) => {
  await page.goto("/explorer");
  await loaded(page);
  await page.getByLabel("Rows per page").selectOption("100");
  await apply(page);
  await expect(rows(page)).toHaveCount(100);

  const seen: string[] = [];
  const next = page.getByRole("button", { name: "Next" });
  const previous = page.getByRole("button", { name: "Previous" });
  await expect(previous).toBeDisabled();
  let current = await ids(rows(page));
  seen.push(...current);

  while (await next.isEnabled()) {
    const before = current;
    await next.click();
    // The new page replaces the old one after a loading state; wait until the rows actually changed.
    await expect.poll(async () => {
      const now = await ids(rows(page));
      return now.length > 0 && now.join() !== before.join();
    }).toBe(true);
    current = await ids(rows(page));
    seen.push(...current);
  }

  expect(new Set(seen).size).toBe(seen.length);
  expect(seen).toEqual([...transfers].sort(newestFirst).map(rowId));
  // Fail-closed: nothing from the failed or candidate ranges.
  expect(Math.max(...seen.map((id) => Number(id.split(":")[0])))).toBeLessThanOrEqual(PUBLISHED_TO);
  expect(seen.some((id) => Number(id.split(":")[0]) >= FAILED_FROM)).toBe(false);

});

test("Previous from page 2 returns the first page unchanged", async ({ page }) => {
  await page.goto("/explorer");
  await loaded(page);
  await page.getByLabel("Rows per page").selectOption("10");
  await apply(page);
  // The page label changes synchronously; rows arrive after the fetch, so wait on the rows themselves.
  await expect(rows(page)).toHaveCount(10);
  const first = await ids(rows(page));
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Page 2")).toBeVisible();
  await expect.poll(async () => {
    const now = await ids(rows(page));
    return now.length === 10 && now.join() !== first.join();
  }).toBe(true);
  const second = await ids(rows(page));
  expect(second.filter((id) => first.includes(id))).toEqual([]);
  await page.getByRole("button", { name: "Previous" }).click();
  await expect(page.getByText("Page 1")).toBeVisible();
  await expect.poll(() => ids(rows(page))).toEqual(first);
});

test("swaps and the address filter match sender or recipient", async ({ page }) => {
  await page.goto("/explorer");
  await loaded(page);
  await page.getByLabel("Uniswap v3 swaps").check();
  await page.getByLabel("Rows per page").selectOption("200");
  await apply(page);
  await expect(rows(page)).toHaveCount(Math.min(200, swaps.length));
  expect(swaps.length).toBeLessThanOrEqual(200);

  const target = swaps[3]!;
  await page.getByLabel("Address (sender or recipient)").fill(target.recipient.toUpperCase().replace("0X", "0x"));
  await apply(page);
  const expected = swaps.filter((s) => s.sender === target.recipient || s.recipient === target.recipient).sort(newestFirst).map(rowId);
  expect(expected.length).toBeGreaterThan(0);
  await expect.poll(() => ids(rows(page))).toEqual(expected);
});

test("block range and token filters, empty state, and raw vs formatted amounts", async ({ page }) => {
  await page.goto("/explorer");
  await loaded(page);
  await page.getByLabel("Rows per page").selectOption("200");

  const [from, to] = [FIRST_BLOCK + 20, FIRST_BLOCK + 39];
  await page.getByLabel("From block").fill(String(from));
  await page.getByLabel("To block").fill(String(to));
  await apply(page);
  const inWindow = transfers.filter((t) => t.blockNumber >= from && t.blockNumber <= to).sort(newestFirst);
  expect(inWindow.length).toBeGreaterThan(0);
  await expect.poll(() => ids(rows(page))).toEqual(inWindow.map(rowId));

  const sample = inWindow[0]!;
  const row = page.locator(`tr[data-row-id="${rowId(sample)}"]`);
  await expect(row).toContainText(`${units(sample.value, 6)} USDC`);
  await page.getByLabel("Show raw amounts (base units)").check();
  await expect(row.getByText(sample.value, { exact: true })).toBeVisible();
  await page.getByLabel("Show raw amounts (base units)").uncheck();
  // The raw value stays reachable on hover/assistive tech even when formatted.
  await expect(row.getByTitle(`${sample.value} base units`)).toBeVisible();

  await page.getByLabel("Token address").fill(`0x${"1".repeat(40)}`);
  await apply(page);
  await expect(page.getByText("No transfers match these filters in published ranges.")).toBeVisible();

  await page.getByLabel("Token address").fill("not-an-address");
  await apply(page);
  await expect(page.getByRole("main").getByRole("alert")).toContainText("Could not load data");
});
