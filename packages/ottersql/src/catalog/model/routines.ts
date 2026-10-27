import type { Comment, TypeRef } from "./shared.ts";

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
  /**
   * The body as written. `null` for an aggregate, and for a SQL-standard body (`RETURN` or `BEGIN
   * ATOMIC`), which Postgres keeps only parsed and prints differently from one major to the next.
   */
  readonly definition: string | null;
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
