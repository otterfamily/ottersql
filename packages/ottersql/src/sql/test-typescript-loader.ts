import { stripTypeScriptTypes } from "node:module";

/**
 * A webpack loader for the tests only: in this repository the queries' runtime is TypeScript
 * source, which webpack cannot read; published packages give it JavaScript.
 */
export default function typescriptLoader(source: string): string {
  return stripTypeScriptTypes(source);
}
