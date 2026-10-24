/**
 * A lexical token of a `.sql` file. The lexer follows only Postgres's lexical rules (strings,
 * quoted identifiers, dollar quotes, comments) so that `:name` parameters and `-- @name` lines are
 * never found inside them; the SQL's grammar is left to Postgres (ADR 0001).
 */
export type Token = { readonly start: number; readonly end: number } & (
  | { readonly kind: "space" | "lineComment" | "blockComment" | "quoted" | "other" }
  | { readonly kind: "parameter"; readonly name: string }
  | { readonly kind: "positional"; readonly text: string }
  | { readonly kind: "unterminated"; readonly message: string }
);

type Scanner = (text: string, start: number) => Token;

const PAIR = 2;
const identifierPart = /[\p{L}\p{N}$_]/v;
const dollarTag = /\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/vy;
const parameterName = /[\p{L}_][\p{L}\p{N}_]*/vy;
const positional = /\$\d+/vy;
const plainString = /'(?:''|[^'])*'/vy;
const escapeString = /'(?:''|\\.|[^'\\])*'/svy;
const quotedIdentifier = /"(?:""|[^"])*"/vy;

export function* tokens(text: string): Generator<Token, void, undefined> {
  let start = 0;
  while (start < text.length) {
    const token = (scannerAt(text, start) ?? scanCharacter)(text, start);
    yield token;
    start = token.end;
  }
}

/** The tokens that are part of a statement rather than whitespace or a comment. */
export function isSignificant(token: Token): boolean {
  return token.kind !== "space" && token.kind !== "lineComment" && token.kind !== "blockComment";
}

function scannerAt(text: string, start: number): Scanner | null {
  const pair = text.slice(start, start + PAIR);
  if (pair === "--") {
    return scanLineComment;
  }
  if (pair === "/*") {
    return scanBlockComment;
  }
  if (pair === "::") {
    return (_text, from) => ({ kind: "other", start: from, end: from + PAIR });
  }
  return characterScanners[text.charAt(start)] ?? null;
}

const characterScanners: Readonly<Record<string, Scanner>> = {
  "'": scanString,
  '"': (text, start) =>
    scanQuoted(text, start, {
      pattern: quotedIdentifier,
      problem: "Unterminated quoted identifier",
    }),
  $: scanDollar,
  ":": scanParameter,
};

function scanCharacter(text: string, start: number): Token {
  const kind = /\s/v.test(text.charAt(start)) ? "space" : "other";
  return { kind, start, end: start + 1 };
}

function scanLineComment(text: string, start: number): Token {
  const newline = text.indexOf("\n", start);
  return { kind: "lineComment", start, end: newline === -1 ? text.length : newline };
}

function scanBlockComment(text: string, start: number): Token {
  let depth = 0;
  for (const marker of text.slice(start).matchAll(/\/\*|\*\//gv)) {
    depth += marker[0] === "/*" ? 1 : -1;
    if (depth === 0) {
      return { kind: "blockComment", start, end: start + marker.index + PAIR };
    }
  }
  return unterminated(text, start, "Unterminated comment");
}

/** `E'...'` strings take backslash escapes; other strings only double their quotes. */
function scanString(text: string, start: number): Token {
  const escapes =
    /e/iv.test(text.charAt(start - 1)) && !identifierPart.test(text.charAt(start - PAIR));
  const pattern = escapes ? escapeString : plainString;
  return scanQuoted(text, start, { pattern, problem: "Unterminated quoted string" });
}

function scanQuoted(
  text: string,
  start: number,
  { pattern, problem }: { readonly pattern: RegExp; readonly problem: string },
): Token {
  pattern.lastIndex = start;
  const match = pattern.exec(text)?.[0];
  return match === undefined
    ? unterminated(text, start, problem)
    : { kind: "quoted", start, end: start + match.length };
}

/** `$` continues an identifier, starts `$1`, or opens a `$tag$` dollar quote. */
function scanDollar(text: string, start: number): Token {
  if (identifierPart.test(text.charAt(start - 1))) {
    return { kind: "other", start, end: start + 1 };
  }
  positional.lastIndex = start;
  const number = positional.exec(text)?.[0];
  if (number !== undefined) {
    return { kind: "positional", text: number, start, end: start + number.length };
  }
  dollarTag.lastIndex = start;
  const tag = dollarTag.exec(text)?.[0];
  return tag === undefined
    ? { kind: "other", start, end: start + 1 }
    : scanDollarQuote(text, start, tag);
}

function scanDollarQuote(text: string, start: number, tag: string): Token {
  const close = text.indexOf(tag, start + tag.length);
  return close === -1
    ? unterminated(text, start, "Unterminated dollar-quoted string")
    : { kind: "quoted", start, end: close + tag.length };
}

function scanParameter(text: string, start: number): Token {
  parameterName.lastIndex = start + 1;
  const name = parameterName.exec(text)?.[0];
  return name === undefined
    ? { kind: "other", start, end: start + 1 }
    : { kind: "parameter", name, start, end: start + 1 + name.length };
}

function unterminated(text: string, start: number, message: string): Token {
  return { kind: "unterminated", message, start, end: text.length };
}
