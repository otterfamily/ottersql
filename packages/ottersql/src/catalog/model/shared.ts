export interface QualifiedName {
  readonly schema: string;
  readonly name: string;
}

export interface Comment {
  readonly text: string;
  readonly annotations: readonly Annotation[];
}

/**
 * A line of a comment that starts with `@name`, optionally followed by an argument: the rest of the
 * line, trimmed. Names are lowercase letters, digits and hyphens, starting with a letter. Which
 * annotations mean something is up to the layer that reads them.
 */
export interface Annotation {
  readonly name: string;
  readonly argument: string | null;
}

export type TypeRef = { readonly kind: "array"; readonly element: NamedTypeRef } | NamedTypeRef;

export interface NamedTypeRef {
  readonly kind: "base" | "enum" | "domain" | "composite" | "range" | "multirange" | "pseudo";
  readonly schema: string;
  readonly name: string;
}

/** A default expression, of a column or a domain. */
export interface DefaultValue {
  readonly expression: string;
  /** Whether the default calls a volatile function, so each row gets its own value. */
  readonly volatile: boolean;
}

export type Deferral = "not deferrable" | "initially immediate" | "initially deferred";

/** `not valid` constraints hold for new rows only; `not enforced` ones are never checked. */
export type Enforcement = "validated" | "not valid" | "not enforced";
