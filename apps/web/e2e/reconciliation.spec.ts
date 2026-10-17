import { expect, test } from "@playwright/test";
import { RECONCILIATIONS } from "./fixture.ts";
import { loaded } from "./support.ts";

const n = (v: number) => v.toLocaleString("en-US");

test("reconciliation counts and the unexplained mismatch is highlighted and filterable", async ({ page }) => {
  await page.goto("/reconciliation");
  await loaded(page);

  const stat = (label: string) => page.locator("dl > div").filter({ has: page.getByText(label, { exact: true }) });
  await expect(stat("Matches")).toContainText(String(RECONCILIATIONS.matchCount));
  await expect(stat("Mismatches")).toContainText("2");
  await expect(stat("Unexplained")).toContainText("1");

  const rows = page.getByTestId(/^reconciliation-/);
  await expect(rows).toHaveCount(4);
  const unexplained = page.locator('tr[data-unexplained="true"]');
  await expect(unexplained).toHaveCount(1);
  await expect(unexplained).toContainText(`${n(RECONCILIATIONS.unexplained.fromBlock)}–${n(RECONCILIATIONS.unexplained.toBlock)}`);
  await expect(unexplained).toContainText("mismatch, unexplained");
  // Highlight is not colour alone: the row has a visible outline.
  expect(await unexplained.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("solid");

  const explained = page.locator("tr", { hasText: "mismatch, explained" });
  await expect(explained).toContainText(RECONCILIATIONS.explained.explanation);
  await expect(explained).toHaveAttribute("data-unexplained", "false");

  await page.getByLabel("Show").selectOption("unexplained");
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("mismatch, unexplained");
  await page.getByLabel("Show").selectOption("mismatch");
  await expect(rows).toHaveCount(2);
});
