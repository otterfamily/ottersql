import type { PGlite } from "@electric-sql/pglite";

import { parseComment } from "./comments.ts";
import type { Routine, RoutineArgument, RoutineResult } from "./model.ts";
import { userObject } from "./scope.ts";
import { parseTypeRef, typeRefJson } from "./type-ref.ts";
import type { TypeRow } from "./type-ref.ts";

interface RoutineRow {
  readonly schema: string;
  readonly name: string;
  readonly kind: "a" | "f" | "p" | "w";
  readonly volatility: "i" | "s" | "v";
  readonly setOf: boolean;
  readonly resultType: TypeRow;
  readonly resultTypeSql: string;
  readonly defaults: number;
  readonly parameters: readonly ParameterRow[];
  readonly comment: string | null;
}

interface ParameterRow {
  readonly name: string | null;
  readonly mode: InputMode | OutputMode;
  readonly type: TypeRow;
  readonly typeSql: string;
}

export async function readRoutines(db: PGlite): Promise<Routine[]> {
  const { rows } = await db.query<RoutineRow>(`
    select n.nspname as schema, p.proname as name, p.prokind as kind,
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
      obj_description(p.oid, 'pg_proc') as comment
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where ${userObject("pg_proc", "p.oid", "p.pronamespace")}
    order by n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)
  `);
  return rows.map((row) => parseRoutine(row));
}

function parseRoutine(row: RoutineRow): Routine {
  const inputs = row.parameters.filter((parameter) => isInput(parameter));
  const firstDefault = inputs.length - row.defaults;
  return {
    schema: row.schema,
    name: row.name,
    kind: routineKinds[row.kind],
    arguments: inputs.map((parameter, position) =>
      parseArgument(parameter, position >= firstDefault),
    ),
    returns: parseResult(row),
    volatility: volatilities[row.volatility],
    comment: parseComment(row.comment),
  };
}

type InputMode = "b" | "i" | "v";
type OutputMode = "b" | "o" | "t";

const argumentModes = {
  b: "inout",
  i: "in",
  v: "variadic",
} as const satisfies Record<InputMode, RoutineArgument["mode"]>;

const routineKinds = {
  a: "aggregate",
  f: "function",
  p: "procedure",
  w: "window",
} as const satisfies Record<RoutineRow["kind"], Routine["kind"]>;

const volatilities = {
  i: "immutable",
  s: "stable",
  v: "volatile",
} as const satisfies Record<RoutineRow["volatility"], Routine["volatility"]>;

function isInput(row: ParameterRow): row is ParameterRow & { readonly mode: InputMode } {
  return row.mode === "i" || row.mode === "b" || row.mode === "v";
}

function isOutput(row: ParameterRow): boolean {
  return row.mode === "o" || row.mode === "b" || row.mode === "t";
}

function parseArgument(
  row: ParameterRow & { readonly mode: InputMode },
  hasDefault: boolean,
): RoutineArgument {
  return {
    name: row.name,
    mode: argumentModes[row.mode],
    type: parseTypeRef(row.type),
    typeSql: row.typeSql,
    hasDefault,
  };
}

function parseResult(row: RoutineRow): RoutineResult {
  if (row.kind === "p") {
    return { kind: "none" };
  }
  const columns = row.parameters.filter((parameter) => isOutput(parameter));
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
  return {
    kind: "value",
    setOf: row.setOf,
    type: parseTypeRef(row.resultType),
    typeSql: row.resultTypeSql,
  };
}
