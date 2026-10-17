import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["apps/**/test/**/*.test.ts", "packages/**/test/**/*.test.ts"],
          exclude: ["**/*.int.test.ts", "**/*.anvil.test.ts", "**/node_modules/**"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["apps/**/test/**/*.int.test.ts", "packages/**/test/**/*.int.test.ts"],
          fileParallelism: false,
          testTimeout: 180_000,
          hookTimeout: 60_000,
        },
      },
      {
        // Needs `anvil` on PATH and the same Postgres as `integration`: never run both projects at once.
        extends: true,
        test: {
          name: "anvil",
          include: ["apps/indexer/test/anvil/**/*.anvil.test.ts"],
          fileParallelism: false,
          testTimeout: 120_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
