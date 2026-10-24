import { defineConfig } from "vitest/config";
import type { ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    // Every file in its own isolated worker would start PGlite and snapshot an empty database
    // once per file, all at the same time; on small CI runners that contention timed tests out.
    isolate: false,
    fileParallelism: false,
    setupFiles: ["./src/test-setup.ts"],
  },
});

export default config;
