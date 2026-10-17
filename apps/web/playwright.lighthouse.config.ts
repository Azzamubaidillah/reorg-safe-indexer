import { defineConfig } from "@playwright/test";
import { WEB_URL } from "./e2e/fixture.ts";
import { webServers } from "./e2e/servers.ts";

// Separate from the E2E config: Lighthouse is slow and drives its own Chromium.
export default defineConfig({
  testDir: "./lighthouse",
  testMatch: "accessibility.lh.ts",
  reporter: [["list"]],
  use: { baseURL: WEB_URL },
  webServer: webServers,
});
