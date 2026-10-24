/**
 * A value in the text form Postgres writes its node trees in (`nodeToString`, read back by
 * `stringToNode`; src/backend/nodes/outfuncs.c and read.c). It is Postgres's analysis of a query,
 * not SQL, so reading it keeps ADR 0001: ottersql never parses SQL itself.
 */
export type NodeValue = NodeObject | readonly NodeValue[] | string | null;

export interface NodeObject {
  readonly type: string;
  readonly fields: ReadonlyMap<string, NodeValue>;
}

/** Reads one node tree. Throws on text that is not in the node format. */
export function readNodeTree(text: string): NodeValue {
  const reader = new NodeReader(tokenize(text));
  const value = reader.value();
  reader.expectEnd();
  return value;
}

export function isNodeObject(value: NodeValue | undefined): value is NodeObject {
  return typeof value === "object" && value !== null && !isList(value);
}

export function isNode(value: NodeValue | undefined, type: string): value is NodeObject {
  return isNodeObject(value) && value.type === type;
}

function isList(value: NodeValue | undefined): value is readonly NodeValue[] {
  return Array.isArray(value);
}

export function field(node: NodeObject, name: string): NodeValue | undefined {
  return node.fields.get(name);
}

/** A field that holds a scalar token, such as a number or a name. */
export function scalar(node: NodeObject, name: string): string | undefined {
  const value = node.fields.get(name);
  return typeof value === "string" ? value : undefined;
}

export function list(value: NodeValue | undefined): readonly NodeValue[] {
  return isList(value) ? value : [];
}

/** A bitmapset such as `(b 3 4)` as its members; `(b)` is the empty set. */
export function bitmapset(value: NodeValue | undefined): readonly string[] {
  const [tag, ...members] = list(value);
  return tag === "b" ? members.filter((member) => typeof member === "string") : [];
}

// Tokens are separated by whitespace; parentheses and braces stand alone; a backslash escapes the
// next character and a double-quoted token is one token even with spaces.
const token = /\s*(?<token>[\(\)\{\}]|"(?:\\.|[^"\\])*"|(?:\\.|[^\s"\(\)\\\{\}])+)/gsvy;

function tokenize(text: string): string[] {
  return [...text.matchAll(token)].map((match) => match.groups?.["token"] ?? "");
}

class NodeReader {
  readonly #tokens: readonly string[];
  #position = 0;

  constructor(tokens: readonly string[]) {
    this.#tokens = tokens;
  }

  value(): NodeValue {
    const next = this.#next();
    if (next === "{") {
      return this.#node();
    }
    if (next === "(") {
      return this.#list();
    }
    return next === "<>" ? null : unescape(next);
  }

  expectEnd(): void {
    if (this.#position !== this.#tokens.length) {
      throw new Error(`unexpected ${String(this.#tokens[this.#position])} after the node tree`);
    }
  }

  #next(): string {
    const next = this.#tokens[this.#position];
    if (next === undefined) {
      throw new Error("the node tree ends early");
    }
    this.#position += 1;
    return next;
  }

  #node(): NodeObject {
    const type = this.#next();
    const fields = new Map<string, NodeValue>();
    while (this.#tokens[this.#position] !== "}") {
      const name = this.#next();
      if (!name.startsWith(":")) {
        throw new Error(`expected a field name in ${type}, got ${name}`);
      }
      fields.set(name.slice(1), this.value());
      this.#skipDatumBytes();
    }
    this.#position += 1;
    return { type, fields };
  }

  #list(): NodeValue[] {
    const items: NodeValue[] = [];
    while (this.#tokens[this.#position] !== ")") {
      items.push(this.value());
    }
    this.#position += 1;
    return items;
  }

  /** A constant's value is written as its length followed by `[ byte ... ]`, which typing never needs. */
  #skipDatumBytes(): void {
    if (this.#tokens[this.#position] === "[") {
      const close = this.#tokens.indexOf("]", this.#position);
      this.#position = close === -1 ? this.#tokens.length : close + 1;
    }
  }
}

function unescape(raw: string): string {
  const unquoted = raw.startsWith('"') ? raw.slice(1, -1) : raw;
  return unquoted.replaceAll(/\\(?<character>.)/gsv, "$<character>");
}
