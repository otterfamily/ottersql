import { bitmapset, field, isNode, isNodeObject, list, scalar } from "./node-tree.ts";
import type { NodeObject, NodeValue } from "./node-tree.ts";

/** What the rules need to know about the schema and built-in functions, keyed by Postgres oids. */
export interface NullabilityFacts {
  /** Whether column `attnum` of relation `relationOid` is a validated NOT NULL table column. */
  readonly isNotNullColumn: (relationOid: number, attnum: number) => boolean;
  /** Aggregates and window functions that never return null, such as `count` and `row_number`. */
  readonly nonNullAggregates: ReadonlySet<string>;
  /** Functions and operators whose result is non-null whenever every argument is. */
  readonly nonNullWhenArgumentsAre: ReadonlySet<string>;
  /** Functions that never return null, whatever their arguments, such as `concat`. */
  readonly neverNull: ReadonlySet<string>;
}

// Node field values from Postgres 18 (parsenodes.h, primnodes.h); the reader is pinned to that major.
const COMMAND_SELECT = "1";
const RTE_RELATION = "0";
const RTE_SUBQUERY = "1";
const RTE_JOIN = "2";
const RTE_CTE = "6";
const RETURNING_OLD = "1";
const COERCE_EXPLICIT_CAST = "1";
const COERCE_IMPLICIT_CAST = "2";
const EXISTS_SUBLINK = "0";
const ARRAY_SUBLINK = "6";
/** SQLValueFunctionOp up to SVFOP_LOCALTIMESTAMP_N: dates and times, never null. */
const LAST_DATE_TIME_VALUE_FUNCTION = 8;

/** A query being read, and the queries it is nested in (for outer references and CTEs). */
interface Scope {
  readonly query: NodeObject;
  readonly parent: Scope | null;
  readonly facts: NullabilityFacts;
  /** CTEs whose columns are being proven, so a recursive CTE stops instead of looping. */
  readonly visiting: ReadonlySet<string>;
}

/**
 * Which visible result columns of an analyzed query may be null, in result order (ADR 0009).
 * A column is non-null only when a rule proves it; anything unrecognised is nullable.
 */
export function nullableColumns(query: NodeObject, facts: NullabilityFacts): boolean[] {
  const scope: Scope = { query, parent: null, facts, visiting: new Set() };
  return visibleEntries(query).map((entry) => !provesColumn(scope, Number(scalar(entry, "resno"))));
}

function visibleEntries(query: NodeObject): NodeObject[] {
  const select = scalar(query, "commandType") === COMMAND_SELECT;
  return list(field(query, select ? "targetList" : "returningList")).filter(
    (entry): entry is NodeObject =>
      isNode(entry, "TARGETENTRY") && scalar(entry, "resjunk") !== "true",
  );
}

/** Whether result column `resno` of the scope's query is never null; a set operation needs every branch. */
function provesColumn(scope: Scope, resno: number): boolean {
  const setOperations = field(scope.query, "setOperations");
  if (isNodeObject(setOperations)) {
    return branches(setOperations).every((rtindex) => {
      const subquery = field(rangeEntry(scope, rtindex) ?? emptyNode, "subquery");
      return isNode(subquery, "QUERY") && provesColumn(child(scope, subquery), resno);
    });
  }
  const entry = visibleEntries(scope.query).find(
    (candidate) => Number(scalar(candidate, "resno")) === resno,
  );
  return entry !== undefined && provesNonNull(field(entry, "expr"), scope);
}

const emptyNode: NodeObject = { type: "", fields: new Map() };

/** The range table indexes of the leaf queries of a set operation tree. */
function branches(node: NodeObject): number[] {
  if (isNode(node, "RANGETBLREF")) {
    return [Number(scalar(node, "rtindex"))];
  }
  return [field(node, "larg"), field(node, "rarg")].flatMap((side) =>
    isNodeObject(side) ? branches(side) : [Number.NaN],
  );
}

function child(scope: Scope, query: NodeObject): Scope {
  return { query, parent: scope, facts: scope.facts, visiting: scope.visiting };
}

function rangeEntry(scope: Scope, rtindex: number): NodeObject | undefined {
  const entry = list(field(scope.query, "rtable"))[rtindex - 1];
  return isNode(entry, "RANGETBLENTRY") ? entry : undefined;
}

function ancestor(scope: Scope, levelsUp: number): Scope | null {
  let current: Scope | null = scope;
  for (let level = 0; level < levelsUp && current !== null; level += 1) {
    current = current.parent;
  }
  return current;
}

function provesNonNull(expression: NodeValue | undefined, scope: Scope): boolean {
  return isNodeObject(expression) ? (rules[expression.type]?.(expression, scope) ?? false) : false;
}

function allArguments(node: NodeObject, scope: Scope): boolean {
  return list(field(node, "args")).every((argument) => provesNonNull(argument, scope));
}

function someArgument(node: NodeObject, scope: Scope): boolean {
  return list(field(node, "args")).some((argument) => provesNonNull(argument, scope));
}

const rules: Readonly<Record<string, (node: NodeObject, scope: Scope) => boolean>> = {
  VAR: (node, scope) => provesVar(node, scope),
  CONST: (node) => scalar(node, "constisnull") === "false",
  AGGREF: (node, scope) => scope.facts.nonNullAggregates.has(scalar(node, "aggfnoid") ?? ""),
  WINDOWFUNC: (node, scope) => scope.facts.nonNullAggregates.has(scalar(node, "winfnoid") ?? ""),
  RELABELTYPE: (node, scope) => provesNonNull(field(node, "arg"), scope),
  COERCEVIAIO: (node, scope) => provesNonNull(field(node, "arg"), scope),
  COERCETODOMAIN: (node, scope) => provesNonNull(field(node, "arg"), scope),
  FUNCEXPR: (node, scope) => provesFunction(node, scope),
  OPEXPR: (node, scope) =>
    scope.facts.nonNullWhenArgumentsAre.has(scalar(node, "opno") ?? "") &&
    allArguments(node, scope),
  BOOLEXPR: (node, scope) => allArguments(node, scope),
  COALESCEEXPR: (node, scope) => someArgument(node, scope),
  MINMAXEXPR: (node, scope) => someArgument(node, scope),
  CASEEXPR: (node, scope) =>
    provesNonNull(field(node, "defresult"), scope) &&
    list(field(node, "args")).every(
      (when) => isNode(when, "CASEWHEN") && provesNonNull(field(when, "result"), scope),
    ),
  NULLTEST: () => true,
  BOOLEANTEST: () => true,
  SQLVALUEFUNCTION: (node) => Number(scalar(node, "op")) <= LAST_DATE_TIME_VALUE_FUNCTION,
  SUBLINK: (node) => [EXISTS_SUBLINK, ARRAY_SUBLINK].includes(scalar(node, "subLinkType") ?? ""),
};

function provesFunction(node: NodeObject, scope: Scope): boolean {
  const format = scalar(node, "funcformat");
  if (format === COERCE_EXPLICIT_CAST || format === COERCE_IMPLICIT_CAST) {
    return provesNonNull(list(field(node, "args"))[0], scope);
  }
  const oid = scalar(node, "funcid") ?? "";
  return (
    scope.facts.neverNull.has(oid) ||
    (scope.facts.nonNullWhenArgumentsAre.has(oid) && allArguments(node, scope))
  );
}

/** A column reference not nulled by an outer join or the `old` side of RETURNING, whose source is non-null. */
function provesVar(node: NodeObject, scope: Scope): boolean {
  const owner = ancestor(scope, Number(scalar(node, "varlevelsup")));
  if (
    owner === null ||
    bitmapset(field(node, "varnullingrels")).length > 0 ||
    scalar(node, "varreturningtype") === RETURNING_OLD
  ) {
    return false;
  }
  const entry = rangeEntry(owner, Number(scalar(node, "varno")));
  return entry !== undefined && provesRangeColumn(owner, entry, Number(scalar(node, "varattno")));
}

const rangeColumnRules: Readonly<
  Record<string, (owner: Scope, entry: NodeObject, attnum: number) => boolean>
> = {
  [RTE_RELATION]: (owner, entry, attnum) =>
    owner.facts.isNotNullColumn(Number(scalar(entry, "relid")), attnum),
  [RTE_SUBQUERY]: (owner, entry, attnum) => {
    const subquery = field(entry, "subquery");
    return isNode(subquery, "QUERY") && provesColumn(child(owner, subquery), attnum);
  },
  [RTE_JOIN]: (owner, entry, attnum) =>
    provesNonNull(list(field(entry, "joinaliasvars"))[attnum - 1], owner),
  [RTE_CTE]: (owner, entry, attnum) => provesCteColumn(owner, entry, attnum),
};

function provesRangeColumn(owner: Scope, entry: NodeObject, attnum: number): boolean {
  return rangeColumnRules[scalar(entry, "rtekind") ?? ""]?.(owner, entry, attnum) ?? false;
}

function provesCteColumn(owner: Scope, entry: NodeObject, attnum: number): boolean {
  const name = scalar(entry, "ctename") ?? "";
  const definer = ancestor(owner, Number(scalar(entry, "ctelevelsup")));
  const cte = list(definer === null ? undefined : field(definer.query, "cteList")).find(
    (candidate) => isNode(candidate, "COMMONTABLEEXPR") && scalar(candidate, "ctename") === name,
  );
  const query = isNodeObject(cte) ? field(cte, "ctequery") : undefined;
  if (definer === null || !isNode(query, "QUERY") || owner.visiting.has(name)) {
    return false;
  }
  const visiting = new Set([...owner.visiting, name]);
  return provesColumn({ query, parent: definer, facts: owner.facts, visiting }, attnum);
}
