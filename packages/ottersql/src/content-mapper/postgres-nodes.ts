import { scalar } from "./node-tree.ts";
import type { NodeObject } from "./node-tree.ts";

// Node field values from Postgres 18 (parsenodes.h, primnodes.h).
export const COMMAND_SELECT = "1";
export const COMMAND_UPDATE = "2";
export const COMMAND_INSERT = "3";
export const COMMAND_DELETE = "4";
export const COMMAND_MERGE = "5";
export const RTE_RELATION = "0";
export const RTE_SUBQUERY = "1";
export const RTE_JOIN = "2";
export const RTE_VALUES = "5";
export const RTE_CTE = "6";
/** Since Postgres 18, grouped columns are read through a group RTE holding the grouping expressions. */
export const RTE_GROUP = "9";
export const PARAM_EXTERN = "0";
export const RETURNING_OLD = "1";
export const RETURNING_NEW = "2";
const COERCE_EXPLICIT_CAST = "1";
const COERCE_IMPLICIT_CAST = "2";
export const EXISTS_SUBLINK = "0";
export const ARRAY_SUBLINK = "6";
/** SQLValueFunctionOp up to SVFOP_LOCALTIMESTAMP_N: dates and times, never null. */
export const LAST_DATE_TIME_VALUE_FUNCTION = 8;

/** Whether a function call is a cast, as Postgres records explicit and implicit ones. */
export function isCast(node: NodeObject): boolean {
  const format = scalar(node, "funcformat");
  return format === COERCE_EXPLICIT_CAST || format === COERCE_IMPLICIT_CAST;
}

/** A built-in cast is strict and never turns a value into null; a user-defined one may do either. */
export function isBuiltInCast(
  node: NodeObject,
  facts: { readonly nonNullCasts: ReadonlySet<string> },
): boolean {
  return isCast(node) && facts.nonNullCasts.has(scalar(node, "funcid") ?? "");
}
