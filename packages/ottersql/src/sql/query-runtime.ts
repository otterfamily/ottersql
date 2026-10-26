import { dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the module a `.sql` file becomes imports `defineQuery` from under Node's hooks, which take URLs. */
export const queryRuntimeUrl: string = import.meta.resolve("#query");

const queryRuntimePath = fileURLToPath(queryRuntimeUrl);

/**
 * Where the module made from the `.sql` file at `file` imports `defineQuery` from in a bundler or
 * Bun: a relative path, because Turbopack does not resolve absolute ones.
 */
export function queryRuntimeFrom(file: string): string {
  const path = relative(dirname(file), queryRuntimePath).split(sep).join("/");
  return path.startsWith("../") ? path : `./${path}`;
}
