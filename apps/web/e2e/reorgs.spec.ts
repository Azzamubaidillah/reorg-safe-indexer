import { expect, test } from "@playwright/test";
import { FINALIZED_BLOCK, FIRST_BLOCK, REORG_CANONICAL, REORG_DEPTH, REORG_FORK, REORG_ORPHANED, chain } from "./fixture.ts";
import { loaded } from "./support.ts";

test("the staged reorg is on the timeline with its orphaned and canonical hashes, newest first", async ({ page }) => {
  await page.goto("/reorgs");
  await loaded(page);

  const timeline = page.getByRole("list", { name: "Reorgs, newest first" }).getByTestId("timeline-item");
  await expect(timeline).toHaveCount(2);
  await expect(timeline.first()).toContainText("Reorg #2");
  await expect(timeline.first()).toContainText("Rolled back");
  await expect(timeline.first()).toContainText(`at block ${REORG_FORK.toLocaleString("en-US")}, depth ${REORG_DEPTH}`);
  await expect(timeline.first()).toContainText("2026-10-10 12:00:00 UTC");
  await expect(timeline.last()).toContainText("Halted");
  await expect(timeline.last()).toContainText("2026-10-01 08:30:00 UTC");

  const hashes = page.getByRole("table", { name: "Block hashes per height for reorg #2" });
  await expect(hashes.getByRole("row")).toHaveCount(1 + REORG_DEPTH);
  for (const [i, orphaned] of REORG_ORPHANED.entries()) {
    const canonical = REORG_CANONICAL[i]!;
    const row = hashes.getByRole("row", { name: new RegExp(`^${orphaned.number.toLocaleString("en-US")} `) });
    await expect(row.getByRole("cell").nth(1)).toHaveText(orphaned.hash);
    await expect(row.getByRole("cell").nth(2)).toHaveText(canonical.hash);
    expect(orphaned.hash).not.toBe(canonical.hash);
  }

  const summary = page.getByRole("table", { name: "Reorg summary" });
  const rolledBack = summary.getByRole("row", { name: /^#2 / }).getByRole("cell");
  await expect(rolledBack.nth(3)).toHaveText(String(REORG_DEPTH));
  await expect(rolledBack.nth(4)).toHaveText(REORG_FORK.toLocaleString("en-US"));
  await expect(rolledBack.nth(5)).toHaveText((REORG_FORK - 1).toLocaleString("en-US"));
  await expect(rolledBack.nth(6)).toHaveText(REORG_FORK.toLocaleString("en-US"));
  await expect(rolledBack.nth(7)).toHaveText(FINALIZED_BLOCK.toLocaleString("en-US"));

  // A halted reorg has no ancestor and no rollback point, and no canonical hash to compare with.
  const halted = summary.getByRole("row", { name: /^#1 / }).getByRole("cell");
  await expect(halted.nth(2)).toHaveText("Halted");
  await expect(halted.nth(5)).toHaveText("—");
  await expect(halted.nth(6)).toHaveText("—");
  const haltedHashes = page.getByRole("table", { name: "Block hashes per height for reorg #1" });
  await expect(haltedHashes).toContainText(chain.header(FIRST_BLOCK).hash);
});
