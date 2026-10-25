import { defineConfig } from "vitest/config";
import type { ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    // Packing, installing and running the packages takes tens of seconds.
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});

export default config;
