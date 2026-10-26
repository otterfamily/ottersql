import type { Deferral, Enforcement } from "./model.ts";

export interface PrimaryKey {
  readonly name: string;
  readonly columns: readonly string[];
  readonly include: readonly string[];
  /** The last column is WITHOUT OVERLAPS (Postgres 18): rows may share the others while it does not overlap. */
  readonly withoutOverlaps: boolean;
  readonly deferral: Deferral;
}

export interface UniqueConstraint {
  readonly name: string;
  readonly columns: readonly string[];
  readonly include: readonly string[];
  readonly nullsNotDistinct: boolean;
  /** The last column is WITHOUT OVERLAPS (Postgres 18): rows may share the others while it does not overlap. */
  readonly withoutOverlaps: boolean;
  readonly deferral: Deferral;
}

/** An EXCLUDE constraint, as Postgres prints it from `EXCLUDE USING` on, deferral included. */
export interface ExclusionConstraint {
  readonly name: string;
  readonly definition: string;
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
}

export type ForeignKeyAction = "no action" | "restrict" | "cascade" | "set null" | "set default";
