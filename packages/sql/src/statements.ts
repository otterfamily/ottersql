import { isSignificant, tokens } from "./lexer.ts";
import type { Token } from "./lexer.ts";

/** A piece of SQL text, and the offset in the text it was found in where it starts. */
export interface Located {
  readonly text: string;
  readonly start: number;
}

/**
 * The statements of `sql`, split at semicolons outside strings, quoted names, dollar quotes and
 * comments. Each is trimmed of the whitespace and comments around it, and of its semicolon.
 */
export function splitStatements(sql: string): Located[] {
  const groups: Token[][] = [[]];
  for (const token of tokens(sql)) {
    if (token.kind === "other" && sql.charAt(token.start) === ";") {
      groups.push([]);
    } else if (isSignificant(token)) {
      groups.at(-1)?.push(token);
    }
  }
  return groups.flatMap((group) => {
    const [first] = group;
    const last = group.at(-1);
    return first === undefined || last === undefined
      ? []
      : [{ text: sql.slice(first.start, last.end), start: first.start }];
  });
}

/** The `--` comments of `sql` outside strings, quoted names and dollar quotes, without their newline. */
export function lineComments(sql: string): Located[] {
  return [...tokens(sql)].flatMap((token) =>
    token.kind === "lineComment"
      ? [{ text: sql.slice(token.start, token.end).trimEnd(), start: token.start }]
      : [],
  );
}
