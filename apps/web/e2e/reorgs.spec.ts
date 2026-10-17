import { expect, test } from "@playwright/test";
import { FINALIZED_BLOCK, FIRST_BLOCK, HALT_ACKNOWLEDGEMENT, REORG_CANONICAL, REORG_DEPTH, REORG_FORK, REORG_ORPHANED, chain } from "./fixture.ts";
import { loaded } from "./support.ts";

test("the staged reorgs are on the timeline with their orphaned and canonical hashes, newest first", async ({ page }) => {
  await page.goto("/reorgs");
  await loaded(page);

  const timeline = page.getByRole("list", { name: "Reorgs, newest first" }).getByTestId("timeline-item");
  await expect(timeline).toHaveCount(3);
  await expect(timeline.first()).toContainText("Reorg #3");
  await expect(timeline.first()).toContainText("Rolled back");
  await expect(timeline.first()).toContainText(`at block ${REORG_FORK.toLocaleString("en-US")}, depth ${REORG_DEPTH}`);
  await expect(timeline.first()).toContainText("2026-10-10 12:00:00 UTC");
  // A rollback needs nothing from the operator.
  await expect(timeline.first().getByTestId("acknowledgement")).toHaveCount(0);
  await expect(timeline.nth(1)).toContainText("Reorg #2");
  await expect(timeline.nth(1)).toContainText("Halted");
  await expect(timeline.nth(1)).toContainText("2026-10-01 08:30:00 UTC");
  await expect(timeline.nth(1).getByTestId("acknowledgement")).toContainText("Acknowledged 2026-10-01 09:15:00 UTC");
  await expect(timeline.nth(1).getByTestId("acknowledgement")).toContainText(HALT_ACKNOWLEDGEMENT);
  await expect(timeline.last()).toContainText("Reorg #1");
  await expect(timeline.last()).toContainText("Halted");
  await expect(timeline.last()).toContainText("2026-09-20 08:30:00 UTC");
  await expect(timeline.last().getByTestId("acknowledgement")).toContainText("Not acknowledged: the indexer will not restart until ack-halt 1 is run.");

  const hashes = page.getByRole("table", { name: "Block hashes per height for reorg #3" });
  await expect(hashes.getByRole("row")).toHaveCount(1 + REORG_DEPTH);
  for (const [i, orphaned] of REORG_ORPHANED.entries()) {
    const canonical = REORG_CANONICAL[i]!;
    const row = hashes.getByRole("row", { name: new RegExp(`^${orphaned.number.toLocaleString("en-US")} `) });
    await expect(row.getByRole("cell").nth(1)).toHaveText(orphaned.hash);
    await expect(row.getByRole("cell").nth(2)).toHaveText(canonical.hash);
    expect(orphaned.hash).not.toBe(canonical.hash);
  }

  const summary = page.getByRole("table", { name: "Reorg summary" });
  const rolledBack = summary.getByRole("row", { name: /^#3 / }).getByRole("cell");
  await expect(rolledBack.nth(3)).toHaveText(String(REORG_DEPTH));
  await expect(rolledBack.nth(4)).toHaveText(REORG_FORK.toLocaleString("en-US"));
  await expect(rolledBack.nth(5)).toHaveText((REORG_FORK - 1).toLocaleString("en-US"));
  await expect(rolledBack.nth(6)).toHaveText(REORG_FORK.toLocaleString("en-US"));
  await expect(rolledBack.nth(7)).toHaveText(FINALIZED_BLOCK.toLocaleString("en-US"));
  await expect(rolledBack.nth(8)).toHaveText("—");

  // A halted reorg has no ancestor and no rollback point, and no canonical hash to compare with.
  const halted = summary.getByRole("row", { name: /^#2 / }).getByRole("cell");
  await expect(halted.nth(2)).toHaveText("Halted");
  await expect(halted.nth(5)).toHaveText("—");
  await expect(halted.nth(6)).toHaveText("—");
  await expect(halted.nth(8)).toHaveText("2026-10-01 09:15:00 UTC");
  await expect(summary.getByRole("row", { name: /^#1 / }).getByRole("cell").nth(8)).toHaveText("No");
  const haltedHashes = page.getByRole("table", { name: "Block hashes per height for reorg #2" });
  await expect(haltedHashes).toContainText(chain.header(FIRST_BLOCK).hash);
});
