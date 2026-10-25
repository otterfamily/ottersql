import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";
import type { ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    // One worker for every file, so PGlite's empty-database snapshot is made once.
    isolate: false,
    fileParallelism: false,
    // Tests start PGlite or reach the Postgres container, which takes seconds on a busy machine.
    testTimeout: 30_000,
    globalSetup: [fileURLToPath(import.meta.resolve("@ottersql/testing/global-setup"))],
  },
});

export default config;
