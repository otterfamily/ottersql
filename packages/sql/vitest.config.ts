import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";
import type { ViteUserConfig } from "vitest/config";

const config: ViteUserConfig = defineConfig({
  test: {
    globalSetup: [fileURLToPath(import.meta.resolve("@ottersql/testing/global-setup"))],
  },
});

export default config;
