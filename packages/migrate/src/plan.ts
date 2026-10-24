/** The strongest lock a step takes on a table that already exists. */
export type Lock = (typeof locks)[number];

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
  readonly phase: (typeof phases)[number];
  /** `lossy`: undoing the step loses data written since; `irreversible`: it cannot be undone. */
  readonly reversal: (typeof reversals)[number];
  /** `outside` steps, such as `CREATE INDEX CONCURRENTLY`, cannot run in a transaction block. */
  readonly transaction: (typeof transactions)[number];
  /**
   * Run before an `outside` step, to remove what an earlier run that failed halfway left behind,
   * such as an invalid index; an `inside` step leaves nothing, since its transaction rolls back.
   */
  readonly cleanup: readonly string[];
  readonly lock: Lock;
  /** Why the step takes the form it does, when that is not the obvious statement. */
  readonly reason: string | null;
}

export const stepKinds = [
  "createEnum",
  "addEnumValue",
  "dropEnum",
  "createTable",
  "dropTable",
  "addColumn",
  "dropColumn",
  "setDefault",
  "dropDefault",
  "dropNotNull",
  "setNotNull",
  "addCheck",
  "validateCheck",
  "dropCheck",
  "addForeignKey",
  "validateForeignKey",
  "dropForeignKey",
  "addUnique",
  "addPrimaryKey",
  "dropConstraint",
  "createIndex",
  "dropIndex",
  "comment",
] as const;

export type StepKind = (typeof stepKinds)[number];

export const phases = ["expand", "contract"] as const;
export const reversals = ["reversible", "lossy", "irreversible"] as const;
export const transactions = ["inside", "outside"] as const;
export const locks = [
  "none",
  "share update exclusive",
  "share row exclusive",
  "access exclusive",
] as const;

/** Locks that stop writes to the table while held; steps under them must not scan or rewrite it. */
export const writeBlockingLocks: ReadonlySet<Lock> = new Set([
  "access exclusive",
  "share row exclusive",
]);

/** A difference the plan leaves out, because it needs a decision or a procedure ottersql does not generate. */
export interface ManualChange {
  readonly object: string;
  readonly reason: string;
}
