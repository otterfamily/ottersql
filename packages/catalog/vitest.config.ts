import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";
import type { ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    // Tests start PGlite or reach the Postgres container, which takes seconds on a busy machine.
    testTimeout: 30_000,
    // Every file in its own isolated worker would start PGlite and snapshot an empty database
    // once per file, all at the same time; on small CI runners that contention timed tests out.
    isolate: false,
    fileParallelism: false,
    setupFiles: ["./src/test-setup.ts"],
    globalSetup: [fileURLToPath(import.meta.resolve("@ottersql/testing/global-setup"))],
  },
});

export default config;
