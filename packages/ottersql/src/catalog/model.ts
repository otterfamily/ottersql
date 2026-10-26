export interface Catalog {
  readonly capabilities: Capabilities;
  readonly tables: readonly Table[];
  readonly enums: readonly Enum[];
  readonly ranges: readonly RangeType[];
  readonly domains: readonly Domain[];
  readonly views: readonly View[];
  readonly routines: readonly Routine[];
}

export interface Table {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly Column[];
  readonly primaryKey: PrimaryKey | null;
  readonly uniqueConstraints: readonly UniqueConstraint[];
  readonly foreignKeys: readonly ForeignKey[];
  readonly checks: readonly Check[];
  readonly indexes: readonly Index[];
  readonly triggers: readonly Trigger[];
  readonly comment: Comment | null;
}

export type TriggerEvent = "insert" | "update" | "delete" | "truncate";

/** A trigger the schema declares on a table; Postgres's internal ones, such as foreign keys', are left out. */
export interface Trigger {
  readonly name: string;
  readonly timing: "before" | "after" | "instead of";
  readonly events: readonly TriggerEvent[];
  /** FOR EACH ROW, rather than once per statement. */
  readonly forEachRow: boolean;
}

export interface Column {
  readonly name: string;
  readonly type: TypeRef;
  /** The type as Postgres prints it, including modifiers such as `numeric(10,2)`. */
  readonly typeSql: string;
  readonly notNull: boolean;
  /** NOT NULL NO INHERIT: it holds for this table's own rows, not for those of tables inheriting from it. */
  readonly notNullNoInherit: boolean;
  readonly value: ColumnValue;
  readonly comment: Comment | null;
}

/** A default expression, of a column or a domain. */
export interface DefaultValue {
  readonly expression: string;
  /** Whether the default calls a volatile function, so each row gets its own value. */
  readonly volatile: boolean;
}

/** How a column gets its value when an insert does not give one. Postgres allows only one of these. */
export type ColumnValue =
  | { readonly kind: "none" }
  | ({ readonly kind: "default" } & DefaultValue)
  | { readonly kind: "identity"; readonly generation: "always" | "by default" }
  | {
      readonly kind: "generated";
      readonly storage: "stored" | "virtual";
      readonly expression: string;
    };

export type TypeRef = { readonly kind: "array"; readonly element: NamedTypeRef } | NamedTypeRef;

export interface NamedTypeRef {
  readonly kind: "base" | "enum" | "domain" | "composite" | "range" | "multirange" | "pseudo";
  readonly schema: string;
  readonly name: string;
}

export interface PrimaryKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly include: readonly string[];
  readonly deferral: Deferral;
}

export interface UniqueConstraint {
  readonly name: string;
  readonly columns: readonly string[];
  readonly include: readonly string[];
  readonly nullsNotDistinct: boolean;
  readonly deferral: Deferral;
}

export interface ForeignKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly references: {
    readonly schema: string;
    readonly table: string;
    readonly columns: readonly string[];
  };
  readonly match: "simple" | "full" | "partial";
  readonly onUpdate: ForeignKeyAction;
  readonly onDelete: ForeignKeyAction;
  readonly deferral: Deferral;
  readonly enforcement: Enforcement;
}

export type ForeignKeyAction = "no action" | "restrict" | "cascade" | "set null" | "set default";

export type Deferral = "not deferrable" | "initially immediate" | "initially deferred";

/** `not valid` constraints hold for new rows only; `not enforced` ones are never checked. */
export type Enforcement = "validated" | "not valid" | "not enforced";

export interface Check {
  readonly name: string;
  readonly expression: string;
  readonly columns: readonly string[];
  /**
   * Set when a validated, enforced check limits one column to a list of strings, so types can
   * narrow it to a union.
   */
  readonly allowedValues: { readonly column: string; readonly values: readonly string[] } | null;
  /**
   * Columns a validated, enforced check proves non-null, by requiring `IS NOT NULL` of them alone
   * or as a term of a top-level AND, the way NOT NULL does.
   */
  readonly notNullColumns: readonly string[];
  /** NO INHERIT: it holds for this table's own rows, not for those of tables inheriting from it. */
  readonly noInherit: boolean;
  readonly enforcement: Enforcement;
}

/** A range type the schema defines; its multirange type is created with it, in the same schema. */
export interface RangeType {
  readonly schema: string;
  readonly name: string;
  readonly multirange: string;
  readonly subtype: TypeRef;
  readonly comment: Comment | null;
}

export interface Enum {
  readonly schema: string;
  readonly name: string;
  readonly values: readonly string[];
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

export interface QualifiedName {
  readonly schema: string;
  readonly name: string;
}

export interface Index {
  readonly name: string;
  /** The access method, such as `btree`, `hash`, `gin` or `gist`. */
  readonly method: string;
  readonly unique: boolean;
  readonly nullsNotDistinct: boolean;
  readonly keys: readonly IndexKey[];
  readonly include: readonly string[];
  /** The `WHERE` condition of a partial index. */
  readonly predicate: string | null;
}

export type IndexKey = (
  | { readonly kind: "column"; readonly column: string }
  | { readonly kind: "expression"; readonly expression: string }
) & {
  readonly order: "asc" | "desc";
  readonly nulls: "first" | "last";
  /** Set only when the key uses an operator class other than its type's default. */
  readonly operatorClass: QualifiedName | null;
  /** Set only when the key uses a collation other than its column's or the database default. */
  readonly collation: QualifiedName | null;
};

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

/**
 * A view or materialized view. Its columns carry no nullability: Postgres does not record whether a
 * view column can be null, so that is inferred elsewhere.
 */
export interface View {
  readonly schema: string;
  readonly name: string;
  readonly materialized: boolean;
  readonly columns: readonly ViewColumn[];
  readonly comment: Comment | null;
}

export interface ViewColumn {
  readonly name: string;
  readonly type: TypeRef;
  readonly typeSql: string;
  readonly comment: Comment | null;
}

/** A function, procedure, aggregate or window function. Overloads are separate routines. */
export interface Routine {
  readonly schema: string;
  readonly name: string;
  readonly kind: "function" | "procedure" | "aggregate" | "window";
  /**
   * The parameters a caller passes, in order. A function's OUT and TABLE parameters are only in
   * `returns`.
   */
  readonly arguments: readonly RoutineArgument[];
  readonly returns: RoutineResult;
  readonly volatility: "immutable" | "stable" | "volatile";
  readonly comment: Comment | null;
}

export interface RoutineArgument {
  readonly name: string | null;
  /** `out` appears only on procedures, whose callers pass a placeholder for each OUT parameter. */
  readonly mode: "in" | "inout" | "out" | "variadic";
  readonly type: TypeRef;
  readonly typeSql: string;
  readonly hasDefault: boolean;
}

/**
 * What a routine gives back: rows of its OUT, INOUT and TABLE parameters when it has any, otherwise
 * a value of one type for a function and nothing for a procedure.
 */
export type RoutineResult =
  | { readonly kind: "none" }
  | {
      readonly kind: "value";
      readonly setOf: boolean;
      readonly type: TypeRef;
      readonly typeSql: string;
    }
  | { readonly kind: "row"; readonly setOf: boolean; readonly columns: readonly RoutineColumn[] };

export interface RoutineColumn {
  /** `null` for an unnamed OUT parameter; Postgres then chooses the result column's name. */
  readonly name: string | null;
  readonly type: TypeRef;
  readonly typeSql: string;
}

/** What the database the catalog was read from supports. */
export interface Capabilities {
  readonly engine: "postgres";
  readonly version: { readonly major: number; readonly minor: number };
}
