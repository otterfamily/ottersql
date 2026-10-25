import { queryModule } from "./query-module.ts";
import { queryRuntimePath } from "./query-runtime.ts";

/**
 * Loads `.sql` files as modules of typed queries in webpack, Rspack and Next.js (webpack and
 * Turbopack), the same modules `@ottersql/sql/register` gives Node. Name `@ottersql/sql/webpack`
 * as the loader of a rule for `.sql` files.
 */
export default function ottersqlLoader(
  this: { readonly resourcePath: string },
  source: string,
): string {
  return queryModule(source, this.resourcePath, queryRuntimePath);
}
