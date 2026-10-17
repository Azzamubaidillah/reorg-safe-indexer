import type { PlaywrightTestConfig } from "@playwright/test";
import { API_PORT, API_URL, DATABASE_URL, PARQUET_DIR, WEB_PORT, WEB_URL } from "./fixture.ts";

// E2E_DEV=1 runs `next dev` (no build, slower pages) for quick local iteration; CI uses the production build.
const web = process.env.E2E_DEV ? `next dev --port ${WEB_PORT}` : `next build && next start --port ${WEB_PORT}`;

// E2E_REUSE=1 attaches to servers that are already running (and already seeded) for quick local iteration.
const reuse = Boolean(process.env.E2E_REUSE);

/** Shared by the E2E and Lighthouse configs: a freshly seeded API plus the dashboard pointed at it. */
export const webServers: NonNullable<PlaywrightTestConfig["webServer"]> = [
  {
    // Seeding must finish before the API serves, so it is part of the API's command.
    command: "tsx e2e/seed.ts && exec tsx ../api/src/main.ts",
    url: `${API_URL}/healthz`,
    timeout: 120_000,
    reuseExistingServer: reuse,
    env: { DATABASE_URL, CHAIN_ID: "1", API_PORT: String(API_PORT), ANALYTICS_DIR: PARQUET_DIR, LOG_LEVEL: "warn" },
  },
  {
    command: web,
    url: WEB_URL,
    timeout: 300_000,
    reuseExistingServer: reuse,
    // API_URL is read by next.config.ts at build time (rewrites are baked into the production build).
    env: { API_URL },
  },
];
