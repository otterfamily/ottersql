import { queryModule } from "./query-module.ts";
import { queryRuntimeFrom } from "./query-runtime.ts";

/**
 * Loads `.sql` files as modules of typed queries in webpack, Rspack and Next.js with
 * Turbopack, the same modules `ottersql/register` gives Node. Name `ottersql/webpack`
 * as the loader of a rule for `.sql` files.
 */
export default function ottersqlLoader(
  this: { readonly resourcePath: string },
  source: string,
): string {
  return queryModule(source, this.resourcePath, queryRuntimeFrom(this.resourcePath));
}
