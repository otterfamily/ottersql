import { bitmapset, field, isNode, isNodeObject, list, scalar } from "./node-tree.ts";
import type { NodeObject, NodeValue } from "./node-tree.ts";
import { nonNullParameters } from "./parameter-nullability.ts";
import {
  ARRAY_SUBLINK,
  COMMAND_DELETE,
  COMMAND_INSERT,
  COMMAND_MERGE,
  COMMAND_SELECT,
  EXISTS_SUBLINK,
  LAST_DATE_TIME_VALUE_FUNCTION,
  RETURNING_NEW,
  RETURNING_OLD,
  RTE_CTE,
  RTE_GROUP,
  RTE_JOIN,
  RTE_RELATION,
  RTE_SUBQUERY,
  isBuiltInCast,
  isCast,
} from "./postgres-nodes.ts";

/** What the rules need to know about the schema and built-in functions, keyed by Postgres oids. */
export interface NullabilityFacts {
  /** Whether column `attnum` of relation `relationOid` is a validated NOT NULL table column. */
  readonly isNotNullColumn: (relationOid: number, attnum: number) => boolean;
  /** Aggregates and window functions that never return null, such as `count` and `row_number`. */
  readonly nonNullAggregates: ReadonlySet<string>;
  /** Functions and operators whose result is non-null whenever every argument is. */
  readonly nonNullWhenArgumentsAre: ReadonlySet<string>;
  /** Functions that never return null for any list of arguments, such as `concat`. */
  readonly neverNull: ReadonlySet<string>;
  /** Built-in cast functions; a user-defined cast may return null for a non-null value. */
  readonly nonNullCasts: ReadonlySet<string>;
}

/** The Postgres major whose node format the reader below knows (ADR 0009, ADR 0010). */
export const NODE_FORMAT_MAJOR = 18;

/** A query being read, and the queries it is nested in (for outer references and CTEs). */
interface Scope {
  readonly query: NodeObject;
  readonly parent: Scope | null;
  readonly facts: NullabilityFacts;
  /** CTEs whose columns are being proven, so a recursive CTE stops instead of looping. */
  readonly visiting: ReadonlySet<string>;
}

/**
 * What an analyzed statement's tree proves about null: which result columns may be null, in
 * order, and which parameters (`$n` numbers) may not be.
 */
export function statementNullability(
  query: NodeObject,
  facts: NullabilityFacts,
): { readonly columns: readonly boolean[]; readonly nonNullParameters: ReadonlySet<number> } {
  return {
    columns: nullableColumns(query, facts),
    nonNullParameters: nonNullParameters(query, facts),
  };
}

/**
 * Which visible result columns of an analyzed query may be null, in result order (ADR 0009).
 * A column is non-null only when a rule proves it; anything unrecognised is nullable.
 */
function nullableColumns(query: NodeObject, facts: NullabilityFacts): boolean[] {
  const scope: Scope = { query, parent: null, facts, visiting: new Set() };
  // MERGE joins its source and target after analysis, so the tree marks no column as nulled by it.
  const merge = scalar(query, "commandType") === COMMAND_MERGE;
  return visibleEntries(query).map(
    (entry) => merge || !provesColumn(scope, Number(scalar(entry, "resno"))),
  );
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
  const oid = scalar(node, "funcid") ?? "";
  if (isCast(node)) {
    return isBuiltInCast(node, scope.facts) && provesNonNull(list(field(node, "args"))[0], scope);
  }
  // A VARIADIC array argument may itself be null, which makes even `concat` return null.
  const neverNull = scope.facts.neverNull.has(oid) && scalar(node, "funcvariadic") !== "true";
  return neverNull || (isNonNullWhenArgumentsAre(scope, oid) && allArguments(node, scope));
}

function isNonNullWhenArgumentsAre(scope: Scope, oid: string): boolean {
  return scope.facts.nonNullWhenArgumentsAre.has(oid) || scope.facts.neverNull.has(oid);
}

/** A column reference not nulled by an outer join or the `old` side of RETURNING, whose source is non-null. */
function provesVar(node: NodeObject, scope: Scope): boolean {
  const owner = ancestor(scope, Number(scalar(node, "varlevelsup")));
  if (
    owner === null ||
    bitmapset(field(node, "varnullingrels")).length > 0 ||
    isMissingRow(owner, scalar(node, "varreturningtype"))
  ) {
    return false;
  }
  const entry = rangeEntry(owner, Number(scalar(node, "varno")));
  return entry !== undefined && provesRangeColumn(owner, entry, Number(scalar(node, "varattno")));
}

/** RETURNING's `old` is null for an inserted row, and `new` for a deleted one. */
function isMissingRow(owner: Scope, returning: string | undefined): boolean {
  const command = scalar(owner.query, "commandType");
  return (
    (returning === RETURNING_OLD && command === COMMAND_INSERT) ||
    (returning === RETURNING_NEW && command === COMMAND_DELETE)
  );
}

const rangeColumnRules: Readonly<
  Record<string, (owner: Scope, entry: NodeObject, attnum: number) => boolean>
> = {
  // Grouping sets null a grouped column through the Var's varnullingrels, checked before this.
  [RTE_GROUP]: (owner, entry, attnum) =>
    provesNonNull(list(field(entry, "groupexprs"))[attnum - 1], owner),
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
