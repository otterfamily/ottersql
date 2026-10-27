import type {
  Comment,
  DefaultValue,
  Deferral,
  Enforcement,
  QualifiedName,
  TypeRef,
} from "./shared.ts";

export interface Table {
  readonly schema: string;
  readonly name: string;
  readonly columns: readonly Column[];
  readonly primaryKey: PrimaryKey | null;
  readonly uniqueConstraints: readonly UniqueConstraint[];
  readonly foreignKeys: readonly ForeignKey[];
  readonly checks: readonly Check[];
  readonly exclusionConstraints: readonly ExclusionConstraint[];
  readonly indexes: readonly Index[];
  readonly triggers: readonly Trigger[];
  readonly rowSecurity: RowSecurity;
  readonly policies: readonly Policy[];
  /** The partition key of a partitioned table as Postgres prints it, such as `RANGE (at)`. */
  readonly partitionedBy: string | null;
  readonly partitionOf: Partition | null;
  /** The tables it inherits from with INHERITS, in order; a partition's parent is `partitionOf`. */
  readonly inherits: readonly QualifiedName[];
  /** UNLOGGED: not written to the write-ahead log, so emptied after a crash and not replicated. */
  readonly unlogged: boolean;
  /** Storage parameters as Postgres prints them, such as `fillfactor=70`. */
  readonly options: readonly string[];
  readonly comment: Comment | null;
}

export interface Column {
  readonly name: string;
  readonly type: TypeRef;
  /** The type as Postgres prints it, including modifiers such as `numeric(10,2)`. */
  readonly typeSql: string;
  readonly notNull: boolean;
  /** NOT NULL NO INHERIT: it holds for this table's own rows, not for those of tables inheriting from it. */
  readonly notNullNoInherit: boolean;
  /** The column's collation, when it is not the one its type has. */
  readonly collation: QualifiedName | null;
  /** How values are stored (`STORAGE`), when it is not the way its type has. */
  readonly storage: "plain" | "external" | "extended" | "main" | null;
  /** How long values are compressed (`COMPRESSION`), when it is not the server's default. */
  readonly compression: "pglz" | "lz4" | null;
  readonly value: ColumnValue;
  readonly comment: Comment | null;
}

/** How a column gets its value when an insert does not give one. Postgres allows only one of these. */
export type ColumnValue =
  | { readonly kind: "none" }
  | ({ readonly kind: "default" } & DefaultValue)
  | {
      readonly kind: "identity";
      readonly generation: "always" | "by default";
      /** The sequence it numbers rows from, with its settings. */
      readonly sequence: Sequence;
    }
  /** Numbered from a sequence the column owns, as `serial` makes it: `DEFAULT nextval(...)`. */
  | { readonly kind: "sequence"; readonly sequence: Sequence }
  | {
      readonly kind: "generated";
      readonly storage: "stored" | "virtual";
      readonly expression: string;
    };

/** A sequence's numbers, as text since a bigint sequence's can exceed a JavaScript number. */
export interface Sequence {
  readonly schema: string;
  readonly name: string;
  /** `smallint`, `integer` or `bigint`. */
  readonly dataType: string;
  readonly start: string;
  readonly increment: string;
  readonly minimum: string;
  readonly maximum: string;
  readonly cache: string;
  readonly cycle: boolean;
}

export interface PrimaryKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly include: readonly string[];
  /** The last column is WITHOUT OVERLAPS (Postgres 18): rows may share the others while it does not overlap. */
  readonly withoutOverlaps: boolean;
  readonly deferral: Deferral;
  readonly comment: Comment | null;
}

export interface UniqueConstraint {
  readonly name: string;
  readonly columns: readonly string[];
  readonly include: readonly string[];
  readonly nullsNotDistinct: boolean;
  /** The last column is WITHOUT OVERLAPS (Postgres 18): rows may share the others while it does not overlap. */
  readonly withoutOverlaps: boolean;
  readonly deferral: Deferral;
  readonly comment: Comment | null;
}

/** An EXCLUDE constraint, as Postgres prints it from `EXCLUDE USING` on, deferral included. */
export interface ExclusionConstraint {
  readonly name: string;
  readonly definition: string;
  readonly comment: Comment | null;
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
  /** The columns ON DELETE SET NULL or SET DEFAULT sets when it names them; empty for all of them. */
  readonly onDeleteColumns: readonly string[];
  /**
   * The last column on each side is a PERIOD (Postgres 18): each row must be covered by referenced
   * rows over its whole range.
   */
  readonly period: boolean;
  readonly deferral: Deferral;
  readonly enforcement: Enforcement;
  readonly comment: Comment | null;
}

export type ForeignKeyAction = "no action" | "restrict" | "cascade" | "set null" | "set default";

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
  readonly comment: Comment | null;
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
  /** Storage parameters as Postgres prints them, such as `fillfactor=50`. */
  readonly options: readonly string[];
  readonly comment: Comment | null;
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

/** A trigger the schema declares on a table; Postgres's internal ones, such as foreign keys', are left out. */
export interface Trigger {
  readonly name: string;
  readonly timing: "before" | "after" | "instead of";
  readonly events: readonly TriggerEvent[];
  /** FOR EACH ROW, rather than once per statement. */
  readonly forEachRow: boolean;
  /** The CREATE TRIGGER statement as Postgres prints it. */
  readonly definition: string;
}

export type TriggerEvent = "insert" | "update" | "delete" | "truncate";

/** Whether a table's row-level security is off, on for all but its owner, or on for its owner too. */
export type RowSecurity = "disabled" | "enabled" | "forced";

/** A row-level security policy, its rule as Postgres keeps it. */
export interface Policy {
  readonly name: string;
  /** What the policy applies to and allows, such as `PERMISSIVE FOR ALL TO public USING (true)`. */
  readonly definition: string;
}

/** The table a partition belongs to, and the bound of the rows it holds as Postgres prints it. */
export interface Partition {
  readonly schema: string;
  readonly table: string;
  readonly bound: string;
}
