/**
 * Reads JSON with comments and trailing commas, as tsconfig.json is written, after the
 * `jsonc-parser` behaviour ottersql needs (ADR 0013). Comments and trailing commas become spaces,
 * so a position JSON.parse reports is a position in `text`.
 */
export function parseJsonc(
  text: string,
): { readonly value: unknown } | { readonly error: string; readonly offset: number | null } {
  const json = text
    .replaceAll(commentsAndStrings, blankComment)
    .replaceAll(trailingCommas, blankComma);
  try {
    return { value: JSON.parse(json) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const offset = /at position (?<offset>\d+)/v.exec(message)?.groups?.["offset"];
    return { error: message, offset: offset === undefined ? null : Number(offset) };
  }
}

// Strings are matched so that what looks like a comment or a comma inside one is left alone.
const commentsAndStrings = /"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//gv;
const trailingCommas = /"(?:[^"\\]|\\.)*"|,(?=\s*[\]\}])/gv;

function blankComment(match: string): string {
  return match.startsWith('"') ? match : blank(match);
}

function blankComma(match: string): string {
  return match === "," ? " " : match;
}

/** Spaces of the same UTF-16 length as `text`, keeping its line breaks. */
function blank(text: string): string {
  return text
    .split("")
    .map((unit) => (unit === "\n" ? "\n" : " "))
    .join("");
}
