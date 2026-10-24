import { isSignificant, tokens } from "./lexer.ts";

/**
 * The statements of `sql`, split at semicolons outside strings, quoted names, dollar quotes and
 * comments. Each is trimmed of the whitespace and comments around it, and of its semicolon.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let first: number | null = null;
  let last = 0;
  for (const token of tokens(sql)) {
    if (token.kind === "other" && sql.charAt(token.start) === ";") {
      statements.push(...(first === null ? [] : [sql.slice(first, last)]));
      first = null;
    } else if (isSignificant(token)) {
      first ??= token.start;
      last = token.end;
    }
  }
  return first === null ? statements : [...statements, sql.slice(first, last)];
}
