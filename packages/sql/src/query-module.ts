import { lineAndColumn, readQueryFile } from "./query-file.ts";

/**
 * The JavaScript module a `.sql` file stands for: one `defineQuery` export per query, importing it
 * from `runtime`. Throws when the file has problems, rather than leaving their queries out, so a
 * mistake surfaces where the file is imported instead of as a missing export.
 */
export function queryModule(content: string, path: string, runtime: string): string {
  const file = readQueryFile(content);
  if (file.problems.length > 0) {
    const problems = file.problems.map(({ message, span }) => {
      const { line, column } = lineAndColumn(content, span.start);
      return `${path}:${String(line)}:${String(column)} ${message}`;
    });
    throw new SyntaxError(`${path} has problems:\n${problems.join("\n")}`);
  }
  const exports = file.queries.map(
    (query) =>
      `export const ${query.name} = defineQuery(${JSON.stringify(query.sql)}, ${JSON.stringify(query.parameters.map(({ name }) => name))});`,
  );
  return [`import { defineQuery } from ${JSON.stringify(runtime)};`, ...exports, ""].join("\n");
}
