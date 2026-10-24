/** The strongest lock a step takes on a table that already exists, weakest first. */
export type Lock = "none" | "share update exclusive" | "share row exclusive" | "access exclusive";

/** The steps that bring one schema to another, and the differences left to a person (ADR 0004). */
export interface Plan {
  readonly steps: readonly Step[];
  readonly manual: readonly ManualChange[];
}

export interface Step {
  readonly kind: StepKind;
  /** What the step changes, such as `public.users.email`. */
  readonly object: string;
  /** Run in order; a step's statements belong together. */
  readonly statements: readonly string[];
  /** `expand` runs before the app deploys, `contract` after it, so the app can always be rolled back. */
  readonly phase: "expand" | "contract";
  /** `lossy`: undoing the step loses data written since; `irreversible`: it cannot be undone. */
  readonly reversal: "reversible" | "lossy" | "irreversible";
  /** `outside` steps, such as `CREATE INDEX CONCURRENTLY`, cannot run in a transaction block. */
  readonly transaction: "inside" | "outside";
  readonly lock: Lock;
  /** Why the step takes the form it does, when that is not the obvious statement. */
  readonly reason: string | null;
}

export type StepKind =
  | "createEnum"
  | "addEnumValue"
  | "dropEnum"
  | "createTable"
  | "dropTable"
  | "addColumn"
  | "dropColumn"
  | "setDefault"
  | "dropDefault"
  | "dropNotNull"
  | "setNotNull"
  | "addCheck"
  | "validateCheck"
  | "dropCheck"
  | "addForeignKey"
  | "validateForeignKey"
  | "dropForeignKey"
  | "addUnique"
  | "addPrimaryKey"
  | "dropConstraint"
  | "createIndex"
  | "dropIndex"
  | "comment";

/** A difference the plan leaves out, because it needs a decision or a procedure ottersql does not generate. */
export interface ManualChange {
  readonly object: string;
  readonly reason: string;
}
