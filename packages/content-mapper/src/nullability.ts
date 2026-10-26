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
  /** Functions that never return null for any list of arguments, such as `concat`. */
  readonly neverNull: ReadonlySet<string>;
  /** Built-in cast functions; a user-defined cast may return null for a non-null value. */
  readonly nonNullCasts: ReadonlySet<string>;
}

/** The Postgres major whose node format the reader below knows (ADR 0009, ADR 0010). */
export const NODE_FORMAT_MAJOR = 18;

// Node field values from Postgres 18 (parsenodes.h, primnodes.h).
const COMMAND_SELECT = "1";
const COMMAND_UPDATE = "2";
const COMMAND_INSERT = "3";
const COMMAND_MERGE = "5";
const RTE_RELATION = "0";
const RTE_SUBQUERY = "1";
const RTE_JOIN = "2";
const RTE_VALUES = "5";
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

function isCast(node: NodeObject): boolean {
  const format = scalar(node, "funcformat");
  return format === COERCE_EXPLICIT_CAST || format === COERCE_IMPLICIT_CAST;
}

/** A built-in cast is strict and never turns a value into null; a user-defined one may do either. */
function isBuiltInCast(node: NodeObject, facts: Pick<NullabilityFacts, "nonNullCasts">): boolean {
  return isCast(node) && facts.nonNullCasts.has(scalar(node, "funcid") ?? "");
}

/**
 * The parameters (`$n` numbers) an INSERT or UPDATE writes straight into NOT NULL columns of the
 * table it changes, through its values, VALUES rows, SELECT list, SET or ON CONFLICT DO UPDATE
 * SET. Postgres rejects null for those whenever the statement writes a row, so they are typed
 * without it. A parameter anywhere else, such as in a
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
  const onConflict = field(query, "onConflict");
  const entries = [
    ...list(field(query, "targetList")),
    ...(isNode(onConflict, "ONCONFLICTEXPR") ? list(field(onConflict, "onConflictSet")) : []),
  ];
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
    return [Number(scalar(value, "paramid"))];
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
