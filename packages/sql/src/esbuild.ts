import { readFile } from "node:fs/promises";

import { queryModule } from "./query-module.ts";
import { queryRuntimePath } from "./query-runtime.ts";

/**
 * The part of an esbuild plugin this one uses. esbuild and `Bun.build` both accept it, so
 * ottersql does not depend on either.
 */
export interface SqlBuildPlugin {
  readonly name: string;
  readonly setup: (build: {
    readonly onLoad: (
      options: { readonly filter: RegExp },
      load: (args: { readonly path: string }) => Promise<{ contents: string; loader: "js" }>,
    ) => void;
  }) => void;
}

/**
 * Bundles `.sql` files as modules of typed queries with esbuild or `Bun.build`, the same modules
 * `@ottersql/sql/register` gives Node. Add it to `plugins` in the build options.
 */
export function ottersql(): SqlBuildPlugin {
  return {
    name: "ottersql",
    setup: (build) => {
      build.onLoad({ filter: /\.sql$/ }, async ({ path }) => ({
        contents: queryModule(await readFile(path, "utf8"), path, queryRuntimePath),
        loader: "js",
      }));
    },
  };
}
