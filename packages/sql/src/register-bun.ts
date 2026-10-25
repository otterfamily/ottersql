import { readFileSync } from "node:fs";

import { queryModule } from "./query-module.ts";
import { queryRuntimePath } from "./query-runtime.ts";

/** The part of Bun's plugin API this file uses; ottersql does not depend on Bun's types. */
interface BunRuntime {
  readonly plugin: (plugin: {
    readonly name: string;
    readonly setup: (build: {
      readonly onLoad: (
        options: { readonly filter: RegExp },
        load: (args: { readonly path: string }) => { contents: string; loader: "js" },
      ) => void;
    }) => void;
  }) => void;
}

function isBunRuntime(value: unknown): value is BunRuntime {
  return typeof value === "object" && value !== null && "plugin" in value;
}

const bun: unknown = Reflect.get(globalThis, "Bun");
if (!isBunRuntime(bun)) {
  throw new Error("@ottersql/sql/register loaded its Bun entry outside Bun");
}

// Bun's `bun` export condition picks this file for `@ottersql/sql/register`.
bun.plugin({
  name: "ottersql",
  setup: (build) => {
    build.onLoad({ filter: /\.sql$/v }, ({ path }) => ({
      contents: queryModule(readFileSync(path, "utf8"), path, queryRuntimePath),
      loader: "js",
    }));
  },
});
