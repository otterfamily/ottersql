import { defineConfig } from "vitest/config";
import type { ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    // Tests start PGlite or reach the Postgres container, which takes seconds on a busy machine.
    testTimeout: 30_000,
    globalSetup: ["./src/global-setup.ts"],
  },
});

export default config;
