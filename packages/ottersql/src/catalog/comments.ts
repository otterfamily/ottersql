import type { Annotation, Comment } from "./model/shared.ts";

const annotationLine = /^\s*@(?<name>[a-z][\d\-a-z]*)(?:\s+(?<argument>\S(?:.*\S)?))?\s*$/v;

export function parseComment(text: string | null): Comment | null {
  if (text === null) {
    return null;
  }
  const annotations: Annotation[] = [];
  for (const line of text.split("\n")) {
    const groups = annotationLine.exec(line)?.groups;
    const name = groups?.["name"];
    if (name !== undefined) {
      annotations.push({ name, argument: groups?.["argument"] ?? null });
    }
  }
  return { text, annotations };
}
