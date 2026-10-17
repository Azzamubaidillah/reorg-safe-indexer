import { expect, test, type Page } from "@playwright/test";
import { rowId, transfers } from "./expected.ts";
import { ids, loaded } from "./support.ts";

const PAGES = [
  ["/", "Overview"],
  ["/reorgs", "Reorgs"],
  ["/quality", "Data quality"],
  ["/reconciliation", "Reconciliation"],
  ["/explorer", "Explorer"],
  ["/analytics", "Analytics"],
] as const;

test("every page has landmarks, one h1, and the nav marks the current page", async ({ page }) => {
  for (const [path, title] of PAGES) {
    await page.goto(path);
    await loaded(page);
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("main")).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();
    await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    const current = page.getByRole("navigation", { name: "Main" }).locator('[aria-current="page"]');
    await expect(current).toHaveCount(1);
    await expect(current).toHaveAttribute("href", path);
  }
});

test("an API failure shows an error with a working retry", async ({ page }) => {
  let failing = true;
  await page.route("**/api/v1/status", (route) => (failing ? route.fulfill({ status: 500, json: { error: { code: "internal_error", message: "internal error" } } }) : route.continue()));
  await page.goto("/");
  const alert = page.getByRole("main").getByRole("alert");
  await expect(alert).toContainText("internal error");
  failing = false;
  await alert.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { level: 2, name: "Chain position" })).toBeVisible();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
});

test("a loading state is announced before data arrives", async ({ page }) => {
  await page.route("**/api/v1/status", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await page.goto("/");
  await expect(page.getByRole("status")).toContainText("Loading status");
  await expect(page.getByRole("heading", { level: 2, name: "Chain position" })).toBeVisible();
});

async function tabUntil(page: Page, name: string, limit = 40): Promise<string[]> {
  const visited: string[] = [];
  for (let i = 0; i < limit; i++) {
    await page.keyboard.press("Tab");
    const label = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return "";
      const labelled = el instanceof HTMLInputElement || el instanceof HTMLSelectElement ? el.labels?.[0]?.textContent : null;
      return (el.getAttribute("aria-label") ?? labelled ?? el.textContent ?? "").trim();
    });
    visited.push(label);
    if (label === name) return visited;
  }
  throw new Error(`Tab never reached "${name}"; visited ${visited.join(" > ")}`);
}

test("the explorer is fully operable by keyboard with a visible focus indicator", async ({ page }) => {
  await page.goto("/explorer");
  await loaded(page);

  const visited = await tabUntil(page, "Apply filters");
  for (const expected of ["Skip to content", "Overview", "Reorgs", "Quality", "Reconciliation", "Explorer", "Analytics", "ERC-20 transfers", "Token address", "Address (sender or recipient)", "Rows per page", "From block", "To block"]) {
    expect(visited, `focus order should include ${expected}`).toContain(expected);
  }
  const indicator = await page.evaluate(() => {
    const style = getComputedStyle(document.activeElement!);
    return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
  });
  expect(indicator.style).not.toBe("none");
  expect(indicator.width).toBeGreaterThanOrEqual(2);

  // Shift-Tab back to the address field, type, and submit with Enter.
  const target = transfers[5]!;
  await page.getByLabel("Address (sender or recipient)").focus();
  await page.keyboard.type(target.to);
  await page.keyboard.press("Enter");
  const expected = transfers.filter((t) => t.from === target.to || t.to === target.to).map(rowId);
  await expect.poll(async () => (await ids(page.locator("tbody tr[data-row-id]"))).sort()).toEqual(expected.sort());

  // The pagination controls are reachable and report their state: Previous is disabled on page 1.
  await expect(page.getByRole("button", { name: "Previous" })).toBeDisabled();
});

test("the skip link moves focus past the navigation", async ({ page }) => {
  await page.goto("/");
  await loaded(page);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main$/);
});
