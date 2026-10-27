import type { Comment, DefaultValue, Enforcement, QualifiedName, TypeRef } from "./shared.ts";
import type { ViewColumn } from "./views.ts";

export interface Enum {
  readonly schema: string;
  readonly name: string;
  readonly values: readonly string[];
  readonly comment: Comment | null;
}

/** A composite type `CREATE TYPE ... AS (...)` makes; the row types of tables and views are not. */
export interface CompositeType {
  readonly schema: string;
  readonly name: string;
  readonly attributes: readonly CompositeAttribute[];
  readonly comment: Comment | null;
}

export interface CompositeAttribute extends ViewColumn {
  /** The attribute's collation, when it is not the one its type has. */
  readonly collation: QualifiedName | null;
}

/** A range type the schema defines; its multirange type is created with it, in the same schema. */
export interface RangeType {
  readonly schema: string;
  readonly name: string;
  readonly multirange: string;
  readonly subtype: TypeRef;
  readonly comment: Comment | null;
}

export interface Domain {
  readonly schema: string;
  readonly name: string;
  readonly baseType: TypeRef;
  readonly baseTypeSql: string;
  readonly notNull: boolean;
  readonly default: DefaultValue | null;
  readonly checks: readonly DomainCheck[];
  readonly comment: Comment | null;
}

export interface DomainCheck {
  readonly name: string;
  readonly expression: string;
  /**
   * Set when a validated, enforced check limits the domain to a list of strings, so types can
   * narrow it to a union.
   */
  readonly allowedValues: readonly string[] | null;
  readonly enforcement: Enforcement;
}
