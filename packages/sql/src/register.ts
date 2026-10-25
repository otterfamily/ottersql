import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";

import { queryModule } from "./query-module.ts";

const runtime = import.meta.resolve("#query");

// Synchronous, in-thread hooks: no loader thread to start, and `.sql` files load like any module.
registerHooks({
  load: (url, context, nextLoad) => {
    if (!url.startsWith("file:") || !url.endsWith(".sql")) {
      return nextLoad(url, context);
    }
    // Saying the format lets Node read a file whose extension it does not know.
    const { source } = nextLoad(url, { ...context, format: "module" });
    return {
      format: "module",
      source: queryModule(
        typeof source === "string" ? source : new TextDecoder().decode(source),
        fileURLToPath(url),
        runtime,
      ),
      shortCircuit: true,
    };
  },
});
