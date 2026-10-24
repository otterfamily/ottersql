import { isSignificant, tokens } from "./lexer.ts";
import type { Token } from "./lexer.ts";

/** A range of a file, in UTF-16 code units like JavaScript string offsets. */
export interface Span {
  readonly start: number;
  readonly length: number;
}

export interface QueryFile {
  /** The queries that can be typed; a query with any problem is left out. */
  readonly queries: readonly Query[];
  readonly problems: readonly QueryFileProblem[];
}

export interface QueryFileProblem {
  readonly message: string;
  readonly span: Span;
}

export interface Query {
  readonly name: string;
  readonly nameSpan: Span;
  /** The SQL sent to Postgres: `:name` parameters become `$1`, `$2`, ... in order of first use. */
  readonly sql: string;
  /** Parameters in the order of their `$n` numbers. */
  readonly parameters: readonly Parameter[];
  /** How ranges of `sql` correspond to ranges of the file; read it through `fileOffset`. */
  readonly sourceMap: readonly SourceMapEntry[];
}

export interface Parameter {
  readonly name: string;
  /** Every place the parameter is written, including the colon. */
  readonly spans: readonly Span[];
}

export interface SourceMapEntry {
  readonly sqlStart: number;
  readonly sqlLength: number;
  readonly fileStart: number;
  readonly fileLength: number;
}

interface Section {
  readonly name: string;
  readonly nameSpan: Span;
  readonly tokens: readonly Token[];
}

const header = /^--[\t ]*@name[\t ]+(?<name>\S+)[\t ]*$/v;
const identifier = /^[\p{L}$_][\p{L}\p{N}$_]*$/v;

/** Whether `name` can be written as a JavaScript identifier (reserved words aside). */
export function isIdentifier(name: string): boolean {
  return identifier.test(name);
}

// Each query becomes an exported function of that name, so it cannot be a reserved word
// (ECMAScript 2025, 13.1 and strict mode).
const reservedWords: ReadonlySet<string> = new Set([
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/** Splits a `.sql` file into its `-- @name` queries and turns their `:name` parameters into `$n`. */
export function readQueryFile(content: string): QueryFile {
  const all = [...tokens(content)];
  const { preamble, sections } = splitSections(content, all);
  const problems: QueryFileProblem[] = [...tokenProblems(all), ...strayStatements(preamble)];
  const queries: Query[] = [];
  for (const section of sections) {
    const problem = sectionProblem(content, section, queries);
    if (problem !== null) {
      problems.push(problem);
    } else if (tokenProblems(statementTokens(content, section)).length === 0) {
      queries.push(buildQuery(content, section));
    }
  }
  return { queries, problems };
}

/** Maps an offset in `query.sql`, such as the position of a Postgres error, to an offset in the file. */
export function fileOffset(query: Query, sqlOffset: number): number {
  const entry =
    query.sourceMap.find(({ sqlStart, sqlLength }) => sqlOffset < sqlStart + sqlLength) ??
    query.sourceMap.at(-1);
  if (entry === undefined) {
    return query.nameSpan.start;
  }
  const verbatim = entry.sqlLength === entry.fileLength;
  return verbatim ? entry.fileStart + Math.max(0, sqlOffset - entry.sqlStart) : entry.fileStart;
}

function splitSections(
  content: string,
  all: readonly Token[],
): { readonly preamble: readonly Token[]; readonly sections: readonly Section[] } {
  const preamble: Token[] = [];
  const sections: { name: string; nameSpan: Span; tokens: Token[] }[] = [];
  for (const token of all) {
    const name = headerName(content, token);
    if (name === null) {
      (sections.at(-1)?.tokens ?? preamble).push(token);
    } else {
      const nameStart = content.indexOf(name, token.start + "--".length);
      sections.push({ name, nameSpan: { start: nameStart, length: name.length }, tokens: [] });
    }
  }
  return { preamble, sections };
}

/** The query name of a `-- @name` line comment that starts its line, or `null`. */
function headerName(content: string, token: Token): string | null {
  if (token.kind !== "lineComment") {
    return null;
  }
  const lineStart = content.lastIndexOf("\n", token.start - 1) + 1;
  if (content.slice(lineStart, token.start).trim() !== "") {
    return null;
  }
  return header.exec(content.slice(token.start, token.end))?.groups?.["name"] ?? null;
}

function tokenProblems(all: readonly Token[]): QueryFileProblem[] {
  return all.flatMap((token): QueryFileProblem[] => {
    const span = { start: token.start, length: token.end - token.start };
    if (token.kind === "unterminated") {
      return [{ message: token.message, span }];
    }
    if (token.kind === "positional") {
      return [{ message: `Use :name parameters instead of ${token.text}`, span }];
    }
    return [];
  });
}

function strayStatements(preamble: readonly Token[]): QueryFileProblem[] {
  const significant = preamble.filter((token) => isSignificant(token));
  const [first] = significant;
  const last = significant.at(-1);
  if (first === undefined || last === undefined) {
    return [];
  }
  const span = { start: first.start, length: last.end - first.start };
  return [{ message: "SQL must follow a -- @name line", span }];
}

function sectionProblem(
  content: string,
  section: Section,
  queries: readonly Query[],
): QueryFileProblem | null {
  const span = section.nameSpan;
  if (!isIdentifier(section.name)) {
    return { message: `"${section.name}" is not a valid query name`, span };
  }
  if (reservedWords.has(section.name)) {
    return { message: `"${section.name}" is a reserved word in JavaScript`, span };
  }
  if (queries.some((query) => query.name === section.name)) {
    return { message: `Query "${section.name}" is already defined`, span };
  }
  if (statementTokens(content, section).length === 0) {
    return { message: `Query "${section.name}" has no SQL`, span };
  }
  return null;
}

/** The tokens from the first to the last significant one, without a final semicolon. */
function statementTokens(content: string, section: Section): readonly Token[] {
  const significant = section.tokens.filter((token) => isSignificant(token));
  const endsWithSemicolon = content.charAt(significant.at(-1)?.start ?? -1) === ";";
  const statement = endsWithSemicolon ? significant.slice(0, -1) : significant;
  const [first] = statement;
  const last = statement.at(-1);
  if (first === undefined || last === undefined) {
    return [];
  }
  return section.tokens.slice(section.tokens.indexOf(first), section.tokens.indexOf(last) + 1);
}

function buildQuery(content: string, section: Section): Query {
  const statement = statementTokens(content, section);
  const parameters = numberParameters(statement);
  return {
    name: section.name,
    nameSpan: section.nameSpan,
    ...substituteParameters(content, statement, parameters),
    parameters,
  };
}

function substituteParameters(
  content: string,
  statement: readonly Token[],
  parameters: readonly Parameter[],
): Pick<Query, "sql" | "sourceMap"> {
  const numbers = new Map(parameters.map(({ name }, index) => [name, index + 1]));
  const sourceMap: SourceMapEntry[] = [];
  let sql = "";
  for (const token of statement) {
    const number = token.kind === "parameter" ? numbers.get(token.name) : undefined;
    const text =
      number === undefined ? content.slice(token.start, token.end) : `$${String(number)}`;
    const fileLength = token.end - token.start;
    sourceMap.push({
      sqlStart: sql.length,
      sqlLength: text.length,
      fileStart: token.start,
      fileLength,
    });
    sql += text;
  }
  return { sql, sourceMap };
}

function numberParameters(statement: readonly Token[]): Parameter[] {
  const parameters = new Map<string, Span[]>();
  for (const token of statement) {
    if (token.kind === "parameter") {
      const spans = parameters.get(token.name) ?? [];
      spans.push({ start: token.start, length: token.end - token.start });
      parameters.set(token.name, spans);
    }
  }
  return [...parameters].map(([name, spans]) => ({ name, spans }));
}
