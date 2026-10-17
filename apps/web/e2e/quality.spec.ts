import { expect, test } from "@playwright/test";
import { FAILED_FROM, FAILED_GATE, FAILED_GATE_DETAIL, FAILED_JOB_ID, FAILED_JOB_REASON, FAILED_TO, FIRST_BLOCK, LAST_BLOCK, PUBLISHED_TO, RANGE_COUNT } from "./fixture.ts";
import { loaded } from "./support.ts";

const n = (v: number) => v.toLocaleString("en-US");

test("a range that failed a gate is unpublished and shows its queued backfill job", async ({ page }) => {
  await page.goto("/quality");
  await loaded(page);

  const failed = page.getByTestId(`failed-range-${FAILED_FROM}`);
  await expect(failed).toBeVisible();
  await expect(failed.getByRole("heading", { level: 3 })).toContainText(`${n(FAILED_FROM)}–${n(FAILED_TO)}`);
  await expect(failed.getByRole("heading", { level: 3 })).toContainText("unpublished");
  await expect(failed).toContainText("published: never");

  const job = failed.getByTestId("backfill-job");
  await expect(job).toContainText(FAILED_JOB_ID);
  await expect(job).toContainText("queued");
  await expect(job).toContainText("Attempts");
  await expect(job.getByText("1", { exact: true })).toBeVisible();
  await expect(job).toContainText(FAILED_JOB_REASON);

  const gates = failed.getByRole("table", { name: `Gate results for blocks ${n(FAILED_FROM)}–${n(FAILED_TO)}` });
  await expect(gates.getByRole("row")).toHaveCount(8);
  const failingRow = gates.getByTestId(`gate-${FAILED_GATE}`);
  await expect(failingRow).toContainText("failed");
  await expect(failingRow).toContainText(FAILED_GATE_DETAIL);
  await expect(gates.getByText("passed")).toHaveCount(6);

  // Only the one failed range appears in the failed section.
  await expect(page.getByTestId(/^failed-range-/)).toHaveCount(1);
});

test("the range table lists every range with its status, and gate drill-down works per range", async ({ page }) => {
  await page.goto("/quality");
  await loaded(page);
  await expect(page.getByTestId(/^range-/)).toHaveCount(RANGE_COUNT);
  await expect(page.getByTestId(`range-${FAILED_FROM}`)).toContainText("failed");
  await expect(page.getByTestId(`range-${FIRST_BLOCK}`)).toContainText("published");
  await expect(page.getByTestId(`range-${LAST_BLOCK - 19}`)).toContainText("candidate");

  const show = page.getByRole("button", { name: `Gates for blocks ${n(FIRST_BLOCK)}–${n(FIRST_BLOCK + 19)}` });
  await expect(show).toHaveAttribute("aria-expanded", "false");
  await show.click();
  await expect(show).toHaveAttribute("aria-expanded", "true");
  const published = page.getByRole("table", { name: `Gate results for blocks ${n(FIRST_BLOCK)}–${n(FIRST_BLOCK + 19)}` });
  await expect(published.getByRole("row")).toHaveCount(8);
  await expect(published.getByText("failed", { exact: true })).toHaveCount(0);

  // A candidate range has not been through the gates.
  await page.getByRole("button", { name: `Gates for blocks ${n(LAST_BLOCK - 19)}–${n(LAST_BLOCK)}` }).click();
  await expect(page.getByText("No gate has run for this range yet.")).toBeVisible();

  await page.getByLabel("Status").selectOption("failed");
  await expect(page.getByTestId(/^range-/)).toHaveCount(1);
  await page.getByLabel("Status").selectOption("published");
  await expect(page.getByTestId(/^range-/)).toHaveCount((PUBLISHED_TO + 1 - FIRST_BLOCK) / 20);
});
