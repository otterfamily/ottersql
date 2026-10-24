import { bitmapset, field, isNode, isNodeObject, list, scalar } from "./node-tree.ts";
import type { NodeObject, NodeValue } from "./node-tree.ts";

/** What the rules need to know about the schema, keyed by Postgres oids. */
export interface NullabilityFacts {
  /** Whether column `attnum` of relation `relationOid` is a validated NOT NULL table column. */
  readonly isNotNullColumn: (relationOid: number, attnum: number) => boolean;
  /** Aggregate and window functions that never return null, such as `count`. */
  readonly nonNullFunctions: ReadonlySet<string>;
}

// Node field values from Postgres 18 (parsenodes.h, primnodes.h); the reader is pinned to that major.
const RTE_RELATION = "0";
const RETURNING_OLD = "1";
const COMMAND_SELECT = "1";

/**
 * Which visible result columns of an analyzed query may be null, in result order (ADR 0009).
 * A column is non-null only when a rule proves it; anything unrecognised is nullable.
 */
export function nullableColumns(query: NodeObject, facts: NullabilityFacts): boolean[] {
  const select = scalar(query, "commandType") === COMMAND_SELECT;
  const entries = list(field(query, select ? "targetList" : "returningList")).filter(
    (entry): entry is NodeObject =>
      isNode(entry, "TARGETENTRY") && scalar(entry, "resjunk") !== "true",
  );
  const rtable = list(field(query, "rtable"));
  return entries.map((entry) => !provesNonNull(field(entry, "expr"), { rtable, facts }));
}

interface Scope {
  readonly rtable: readonly NodeValue[];
  readonly facts: NullabilityFacts;
}

const rules: Readonly<Record<string, (node: NodeObject, scope: Scope) => boolean>> = {
  VAR: (node, scope) => isNonNullVar(node, scope),
  CONST: (node) => scalar(node, "constisnull") === "false",
  AGGREF: (node, scope) => scope.facts.nonNullFunctions.has(scalar(node, "aggfnoid") ?? ""),
  WINDOWFUNC: (node, scope) => scope.facts.nonNullFunctions.has(scalar(node, "winfnoid") ?? ""),
  RELABELTYPE: (node, scope) => provesNonNull(field(node, "arg"), scope),
  COERCEVIAIO: (node, scope) => provesNonNull(field(node, "arg"), scope),
};

function provesNonNull(expression: NodeValue | undefined, scope: Scope): boolean {
  return isNodeObject(expression) ? (rules[expression.type]?.(expression, scope) ?? false) : false;
}

/** A column read directly from a table, not nulled by an outer join or the `old` side of RETURNING. */
function isNonNullVar(node: NodeObject, scope: Scope): boolean {
  if (
    scalar(node, "varlevelsup") !== "0" ||
    bitmapset(field(node, "varnullingrels")).length > 0 ||
    scalar(node, "varreturningtype") === RETURNING_OLD
  ) {
    return false;
  }
  const entry = scope.rtable[Number(scalar(node, "varno")) - 1];
  if (!isNode(entry, "RANGETBLENTRY") || scalar(entry, "rtekind") !== RTE_RELATION) {
    return false;
  }
  return scope.facts.isNotNullColumn(
    Number(scalar(entry, "relid")),
    Number(scalar(node, "varattno")),
  );
}
