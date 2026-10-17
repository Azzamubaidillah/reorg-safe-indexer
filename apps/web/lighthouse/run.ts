import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import lighthouse from "lighthouse";

// Plain Node, not the Playwright test runner: its TypeScript transform breaks Lighthouse's own modules.
const BASE_URL = process.env.BASE_URL;
if (!BASE_URL) throw new Error("BASE_URL is required");

const THRESHOLD = 0.9;
const DEBUG_PORT = 9341;
const PAGES = ["/", "/reorgs", "/quality", "/reconciliation", "/explorer", "/analytics"] as const;

interface PageScore {
  path: string;
  score: number;
  failing: { id: string; title: string; items: number }[];
}

// One browser with a debugging port serves every page; Lighthouse attaches to it instead of launching its own.
const browser = await chromium.launch({ args: [`--remote-debugging-port=${DEBUG_PORT}`] });
const scores: PageScore[] = [];
try {
  for (const path of PAGES) {
    const run = await lighthouse(`${BASE_URL}${path}`, {
      port: DEBUG_PORT,
      output: "json",
      logLevel: "error",
      onlyCategories: ["accessibility"],
      formFactor: "desktop",
      screenEmulation: { disabled: true },
      // Pages fetch client-side: give the data time to land before the audits read the DOM.
      pauseAfterLoadMs: 2_000,
    });
    if (!run) throw new Error(`Lighthouse returned nothing for ${path}`);
    const failing = Object.values(run.lhr.audits)
      .filter((a) => a.score !== null && a.score < 1 && a.scoreDisplayMode === "binary")
      .map((a) => ({ id: a.id, title: a.title, items: (a.details as { items?: unknown[] } | undefined)?.items?.length ?? 0 }));
    scores.push({ path, score: run.lhr.categories.accessibility?.score ?? 0, failing });
  }
} finally {
  await browser.close();
}

await mkdir("lighthouse-report", { recursive: true });
await writeFile("lighthouse-report/accessibility.json", `${JSON.stringify(scores, null, 2)}\n`);
for (const s of scores) {
  console.log(`lighthouse accessibility ${String(Math.round(s.score * 100)).padStart(3)}  ${s.path}${s.failing.length ? `  failing: ${s.failing.map((f) => f.id).join(", ")}` : ""}`);
}
const below = scores.filter((s) => s.score < THRESHOLD);
if (below.length > 0) {
  console.error(`accessibility below ${THRESHOLD * 100} on: ${below.map((s) => s.path).join(", ")}`);
  process.exit(1);
}
