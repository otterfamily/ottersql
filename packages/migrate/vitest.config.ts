import { defineConfig } from "vitest/config";
import type { ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    // One worker for every file, so PGlite's empty-database snapshot is made once.
    isolate: false,
    fileParallelism: false,
    setupFiles: ["./src/test-setup.ts"],
  },
});

export default config;
