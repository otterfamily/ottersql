import type { Comment, TypeRef } from "./shared.ts";

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
