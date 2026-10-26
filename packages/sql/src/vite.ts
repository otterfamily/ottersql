import { readFile } from "node:fs/promises";

import { queryModule } from "./query-module.ts";
import { queryRuntimeFrom } from "./query-runtime.ts";

/**
 * The part of a Vite plugin this one uses. Vite, Vitest, Rolldown and Rollup all accept it, so
 * ottersql does not depend on any of them.
 */
export interface SqlPlugin {
  readonly name: string;
  /** Before Vite's own plugins, which would read a `.sql` file as JavaScript. */
  readonly enforce: "pre";
  readonly load: (id: string) => Promise<string | null>;
}

/**
 * Imports `.sql` files as modules of typed queries in Vite, Vitest, Rolldown and Rollup, the same
 * modules `@ottersql/sql/register` gives Node. Add it to `plugins` in the config.
 */
export function ottersql(): SqlPlugin {
  return {
    name: "ottersql",
    enforce: "pre",
    load: async (id) => {
      // Vite appends queries such as `?import` to ids; virtual modules start with a null byte.
      const [path = id] = id.split("?");
      if (!path.endsWith(".sql") || path.startsWith("\0")) {
        return null;
      }
      return queryModule(await readFile(path, "utf8"), path, queryRuntimeFrom(path));
    },
  };
}
