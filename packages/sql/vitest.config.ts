import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";
import type { ViteUserConfig } from "vitest/config";

import { ottersql } from "./src/vite.ts";

const config: ViteUserConfig = defineConfig({
  // The plugin's tests import .sql files through it.
  plugins: [ottersql()],
  test: {
    // Tests start PGlite or reach the Postgres container, which takes seconds on a busy machine.
    testTimeout: 30_000,
    // One worker for every file, so the drivers are opened once instead of once per file at the
    // same time; on small CI runners that contention timed tests out.
    isolate: false,
    fileParallelism: false,
    globalSetup: [fileURLToPath(import.meta.resolve("@ottersql/testing/global-setup"))],
  },
});

export default config;
