import { field, isNode, list, scalar } from "./node-tree.ts";
import type { NodeObject, NodeValue } from "./node-tree.ts";
import type { NullabilityFacts } from "./nullability.ts";
import {
  COMMAND_INSERT,
  COMMAND_UPDATE,
  PARAM_EXTERN,
  RTE_VALUES,
  isBuiltInCast,
} from "./postgres-nodes.ts";

/**
 * The parameters (`$n` numbers) an INSERT or UPDATE writes straight into NOT NULL columns of the
 * table it changes, through its values, VALUES rows, SELECT list or SET. Postgres rejects null
 * for those whenever the statement writes a row, so they are typed without it. A parameter anywhere else, such as in a
 * comparison where null only matches no rows, or inside an expression, may stay null.
 */
export function nonNullParameters(
  query: NodeObject,
  facts: Pick<NullabilityFacts, "isNotNullColumn" | "nonNullCasts">,
): ReadonlySet<number> {
  const command = scalar(query, "commandType");
  const rtable = list(field(query, "rtable"));
  const target = rtable[Number(scalar(query, "resultRelation")) - 1];
  if (
    (command !== COMMAND_INSERT && command !== COMMAND_UPDATE) ||
    !isNode(target, "RANGETBLENTRY")
  ) {
    return new Set();
  }
  const relation = Number(scalar(target, "relid"));
  // Not ON CONFLICT DO UPDATE SET: without a conflict it never runs, and the row is inserted.
  const entries = list(field(query, "targetList"));
  return new Set(
    entries.flatMap((entry) =>
      isNode(entry, "TARGETENTRY") &&
      facts.isNotNullColumn(relation, Number(scalar(entry, "resno")))
        ? written(field(entry, "expr"), rtable, facts)
        : [],
    ),
  );
}

/** The parameters `expression` writes as they are: a parameter, a cast of one, or a VALUES column. */
function written(
  expression: NodeValue | undefined,
  rtable: readonly NodeValue[],
  facts: Pick<NullabilityFacts, "nonNullCasts">,
): number[] {
  const value = uncast(expression, facts);
  if (isNode(value, "PARAM")) {
    return scalar(value, "paramkind") === PARAM_EXTERN ? [Number(scalar(value, "paramid"))] : [];
  }
  if (!isNode(value, "VAR")) {
    return [];
  }
  const entry = rtable[Number(scalar(value, "varno")) - 1];
  if (!isNode(entry, "RANGETBLENTRY") || scalar(entry, "rtekind") !== RTE_VALUES) {
    return [];
  }
  const column = Number(scalar(value, "varattno")) - 1;
  return list(field(entry, "values_lists")).flatMap((row) =>
    written(list(row)[column], rtable, facts),
  );
}

/**
 * `expression` without the casts around it that pass null through: relabelling, I/O conversion
 * and built-in cast functions, which are strict. A user-defined cast may turn null into a value.
 */
function uncast(
  expression: NodeValue | undefined,
  facts: Pick<NullabilityFacts, "nonNullCasts">,
): NodeValue | undefined {
  if (isNode(expression, "RELABELTYPE") || isNode(expression, "COERCEVIAIO")) {
    return uncast(field(expression, "arg"), facts);
  }
  if (isNode(expression, "FUNCEXPR") && isBuiltInCast(expression, facts)) {
    return uncast(list(field(expression, "args"))[0], facts);
  }
  return expression;
}
