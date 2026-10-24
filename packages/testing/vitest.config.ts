import { defineConfig } from "vitest/config";
import type { ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    globalSetup: ["./src/global-setup.ts"],
  },
});

export default config;
