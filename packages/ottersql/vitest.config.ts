import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";
import type { ViteUserConfig } from "vitest/config";

import { ottersql } from "./src/sql/vite.ts";

const config: ViteUserConfig = defineConfig({
  // The runtime's tests import .sql files through the plugin.
  plugins: [ottersql()],
  test: {
    // Tests start PGlite or reach the Postgres container, which takes seconds on a busy machine.
    testTimeout: 30_000,
    // One worker for every file: PGlite's empty-database snapshot is made once, and the drivers
    // are opened once instead of once per file at the same time, which timed tests out on small
    // CI runners.
    isolate: false,
    fileParallelism: false,
    setupFiles: ["./src/catalog/test-setup.ts"],
    globalSetup: [fileURLToPath(import.meta.resolve("@ottersql/testing/global-setup"))],
  },
});

export default config;
