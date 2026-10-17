import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";

const run = promisify(execFile);

// Playwright only orchestrates the servers; the audit itself runs in a plain Node process (see run.ts).
test("Lighthouse accessibility score is at least 90 on every page", async ({ baseURL }) => {
  test.setTimeout(600_000);
  const result = await run("tsx", ["lighthouse/run.ts"], { env: { ...process.env, BASE_URL: baseURL } }).catch((error: { stdout?: string; stderr?: string }) => {
    throw new Error(`${error.stdout ?? ""}${error.stderr ?? ""}`);
  });
  console.log(result.stdout);
  expect(result.stdout).toContain("lighthouse accessibility");
});
