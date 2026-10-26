// IdentifierName in ECMAScript 2025, 12.7.
const identifier = /^[\p{ID_Start}$_][\p{ID_Continue}\p{Join_Control}$]*$/v;

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

// Not reserved, but strict mode code cannot declare them (ECMAScript 2025, 13.1.1).
const strictModeRestricted: ReadonlySet<string> = new Set(["arguments", "eval"]);

/** Why `name` cannot be exported from a JavaScript module, or `null` when it can. */
export function nameProblem(name: string): string | null {
  if (!isIdentifier(name)) {
    return `"${name}" is not a valid query name`;
  }
  if (reservedWords.has(name)) {
    return `"${name}" is a reserved word in JavaScript`;
  }
  if (name === "then") {
    return `"then" would make the module look like a promise to await`;
  }
  return strictModeRestricted.has(name)
    ? `"${name}" cannot name a binding in strict mode JavaScript`
    : null;
}
