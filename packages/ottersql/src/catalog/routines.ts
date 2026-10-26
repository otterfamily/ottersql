import type { Transaction } from "../sql/index.ts";
import { array, boolean, fields, nullable, number, queryRows, string } from "./catalog-json.ts";
import type { Shape } from "./catalog-json.ts";
import { decode } from "./codes.ts";
import { parseComment } from "./comments.ts";
import type { Routine, RoutineArgument, RoutineResult } from "./model.ts";
import { scopeParameters, userObject } from "./scope.ts";
import { parseTypeRef, typeRefJson, typeRow } from "./type-ref.ts";
import type { TypeRow } from "./type-ref.ts";

interface RoutineRow {
  readonly schema: string;
  readonly name: string;
  readonly kind: string;
  readonly volatility: string;
  readonly setOf: boolean;
  readonly resultType: TypeRow;
  readonly resultTypeSql: string;
  readonly defaults: number;
  readonly parameters: readonly ParameterRow[];
  readonly comment: string | null;
}

interface ParameterRow {
  readonly name: string | null;
  readonly mode: string;
  readonly type: TypeRow;
  readonly typeSql: string;
}

const parameterRow: Shape<ParameterRow> = (value, path) => {
  const field = fields(value, path);
  return {
    name: field("name", nullable(string)),
    mode: field("mode", string),
    type: field("type", typeRow),
    typeSql: field("typeSql", string),
  };
};

const routineRow: Shape<RoutineRow> = (value, path) => {
  const field = fields(value, path);
  return {
    schema: field("schema", string),
    name: field("name", string),
    kind: field("kind", string),
    volatility: field("volatility", string),
    setOf: field("setOf", boolean),
    resultType: field("resultType", typeRow),
    resultTypeSql: field("resultTypeSql", string),
    defaults: field("defaults", number),
    parameters: field("parameters", array(parameterRow)),
    comment: field("comment", nullable(string)),
  };
};

export async function readRoutines(
  transaction: Transaction,
  omitSchemas: readonly string[],
): Promise<Routine[]> {
  const rows = await queryRows(transaction, {
    select: `select n.nspname as schema, p.proname as name, p.prokind as kind,
        p.provolatile as volatility, p.proretset as "setOf",
        ${typeRefJson("p.prorettype")} as "resultType",
        format_type(p.prorettype, null) as "resultTypeSql",
        p.pronargdefaults as defaults,
        coalesce((
          select json_agg(json_build_object(
            'name', nullif(param.name, ''),
            'mode', coalesce(param.mode, 'i'),
            'type', ${typeRefJson("param.type")},
            'typeSql', format_type(param.type, null)
          ) order by param.pos)
          from unnest(
            coalesce(p.proallargtypes, p.proargtypes::oid[]),
            p.proargmodes,
            p.proargnames
          ) with ordinality as param(type, mode, name, pos)
        ), '[]') as parameters,
        obj_description(p.oid, 'pg_proc') as comment,
        pg_get_function_identity_arguments(p.oid) as "identityArguments"
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where ${userObject("pg_proc", "p.oid", "p.pronamespace")}`,
    orderBy: 'rows.schema, rows.name, rows."identityArguments"',
    row: routineRow,
    label: "routines",
    parameters: scopeParameters(omitSchemas),
  });
  return rows.map((row) => parseRoutine(row));
}

const routineKinds = {
  a: "aggregate",
  f: "function",
  p: "procedure",
  w: "window",
} as const satisfies Record<string, Routine["kind"]>;

const volatilities = {
  i: "immutable",
  s: "stable",
  v: "volatile",
} as const satisfies Record<string, Routine["volatility"]>;

// Since Postgres 14 a procedure's callers pass its OUT parameters too, so they are arguments.
const functionArgumentModes = {
  b: "inout",
  i: "in",
  v: "variadic",
} as const satisfies Record<string, RoutineArgument["mode"]>;
const procedureArgumentModes = { ...functionArgumentModes, o: "out" } as const;

const resultModes = new Set(["b", "o", "t"]);

function parseRoutine(row: RoutineRow): Routine {
  const kind = decode(routineKinds, row.kind, "pg_proc.prokind");
  const argumentModes = kind === "procedure" ? procedureArgumentModes : functionArgumentModes;
  const callable = row.parameters.filter((parameter) =>
    Object.hasOwn(argumentModes, parameter.mode),
  );
  const firstDefault = callable.length - row.defaults;
  return {
    schema: row.schema,
    name: row.name,
    kind,
    arguments: callable.map((parameter, position) => ({
      name: parameter.name,
      mode: decode(argumentModes, parameter.mode, "pg_proc.proargmodes"),
      type: parseTypeRef(parameter.type),
      typeSql: parameter.typeSql,
      hasDefault: position >= firstDefault,
    })),
    returns: parseResult(row, kind),
    volatility: decode(volatilities, row.volatility, "pg_proc.provolatile"),
    comment: parseComment(row.comment),
  };
}

function parseResult(row: RoutineRow, kind: Routine["kind"]): RoutineResult {
  const columns = row.parameters.filter((parameter) => resultModes.has(parameter.mode));
  if (columns.length > 0) {
    return {
      kind: "row",
      setOf: row.setOf,
      columns: columns.map((column) => ({
        name: column.name,
        type: parseTypeRef(column.type),
        typeSql: column.typeSql,
      })),
    };
  }
  if (kind === "procedure") {
    return { kind: "none" };
  }
  return {
    kind: "value",
    setOf: row.setOf,
    type: parseTypeRef(row.resultType),
    typeSql: row.resultTypeSql,
  };
}
