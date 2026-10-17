import { expect, type Locator, type Page } from "@playwright/test";

/** Waits for a page's data to finish loading: no status/"Loading" text left on screen. */
export async function loaded(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /^Loading/ })).toHaveCount(0);
}

export const ids = async (rows: Locator): Promise<string[]> => rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-row-id") ?? ""));
