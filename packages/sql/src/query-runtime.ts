import { fileURLToPath } from "node:url";

/**
 * Where the module a `.sql` file becomes imports `defineQuery` from: a file URL for Node's hooks,
 * which take URLs, and a path for bundlers and Bun, which take paths.
 */
export const queryRuntimeUrl: string = import.meta.resolve("#query");
export const queryRuntimePath: string = fileURLToPath(queryRuntimeUrl);
