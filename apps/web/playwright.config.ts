import { defineConfig, devices } from "@playwright/test";
import { webServers } from "./e2e/servers.ts";
import { WEB_URL } from "./e2e/fixture.ts";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "*.spec.ts",
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [["list"], ["json", { outputFile: "test-results/report.json" }]],
  use: {
    baseURL: WEB_URL,
    // A zone far from UTC proves the dashboard renders UTC rather than the browser's local time.
    timezoneId: "America/Los_Angeles",
    locale: "en-US",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: webServers,
});
