import type { Connection } from "./values.ts";

/** How values of a Postgres type are decoded. */
export type TypeInfo =
  | { readonly kind: "base"; readonly name: string }
  /** Enums, composites and types without a codec arrive as Postgres's text. */
  | { readonly kind: "text" }
  | { readonly kind: "array"; readonly element: TypeInfo }
  | { readonly kind: "range"; readonly subtype: TypeInfo }
  | { readonly kind: "multirange"; readonly subtype: TypeInfo };

// Built-in oids are fixed by Postgres (src/include/catalog/pg_type.dat); a test checks them against
// pg_type. Other oids differ per database and are looked up once per connection.
const builtInBaseOids = {
  bool: 16,
  bytea: 17,
  name: 19,
  int8: 20,
  int2: 21,
  int4: 23,
  text: 25,
  oid: 26,
  json: 114,
  float4: 700,
  float8: 701,
  money: 790,
  bpchar: 1042,
  varchar: 1043,
  date: 1082,
  time: 1083,
  timestamp: 1114,
  timestamptz: 1184,
  interval: 1186,
  timetz: 1266,
  numeric: 1700,
  uuid: 2950,
  jsonb: 3802,
} as const satisfies Record<string, number>;

/** Array oids by element type name. */
const builtInArrayOids = {
  bool: 1000,
  bytea: 1001,
  int2: 1005,
  int4: 1007,
  text: 1009,
  bpchar: 1014,
  varchar: 1015,
  int8: 1016,
  float4: 1021,
  float8: 1022,
  timestamp: 1115,
  date: 1182,
  time: 1183,
  timestamptz: 1185,
  interval: 1187,
  numeric: 1231,
  uuid: 2951,
  json: 199,
  jsonb: 3807,
} as const satisfies Partial<Record<keyof typeof builtInBaseOids, number>>;

const builtInRanges = {
  int4range: { subtype: "int4", oid: 3904, multirange: "int4multirange", multirangeOid: 4451 },
  numrange: { subtype: "numeric", oid: 3906, multirange: "nummultirange", multirangeOid: 4532 },
  tsrange: { subtype: "timestamp", oid: 3908, multirange: "tsmultirange", multirangeOid: 4533 },
  tstzrange: {
    subtype: "timestamptz",
    oid: 3910,
    multirange: "tstzmultirange",
    multirangeOid: 4534,
  },
  daterange: { subtype: "date", oid: 3912, multirange: "datemultirange", multirangeOid: 4535 },
  int8range: { subtype: "int8", oid: 3926, multirange: "int8multirange", multirangeOid: 4536 },
} as const satisfies Record<
  string,
  {
    subtype: keyof typeof builtInBaseOids;
    oid: number;
    multirange: string;
    multirangeOid: number;
  }
>;

/** The subtype of each built-in range and multirange type, by name. */
export const rangeSubtypes: ReadonlyMap<string, string> = new Map(
  Object.entries(builtInRanges).flatMap(([name, range]) => [
    [name, range.subtype],
    [range.multirange, range.subtype],
  ]),
);

const builtIns: ReadonlyMap<number, TypeInfo> = new Map([
  ...Object.entries(builtInBaseOids).map(([name, oid]): [number, TypeInfo] => [
    oid,
    { kind: "base", name },
  ]),
  ...Object.entries(builtInArrayOids).map(([name, oid]): [number, TypeInfo] => [
    oid,
    { kind: "array", element: { kind: "base", name } },
  ]),
  ...Object.values(builtInRanges).flatMap((range): [number, TypeInfo][] => [
    [range.oid, { kind: "range", subtype: { kind: "base", name: range.subtype } }],
    [range.multirangeOid, { kind: "multirange", subtype: { kind: "base", name: range.subtype } }],
  ]),
]);

/** The oids whose decoding is fixed, without a lookup. */
export const builtInOids: readonly number[] = [...builtIns.keys()];

interface PgTypeRow {
  readonly schema: string;
  readonly name: string;
  readonly typtype: string;
  readonly element: number;
  readonly subtype: number;
  readonly base: number;
}

const knownByConnection = new WeakMap<Connection, Map<number, PgTypeRow>>();

/** The decoding information for each oid, looking up oids that are not built in through `connection`. */
export async function typeInfos(
  connection: Connection,
  oids: readonly number[],
): Promise<ReadonlyMap<number, TypeInfo>> {
  const known = knownByConnection.get(connection) ?? new Map<number, PgTypeRow>();
  knownByConnection.set(connection, known);
  await lookUp(connection, known, oids);
  return new Map(oids.map((oid) => [oid, typeInfo(oid, known)]));
}

async function lookUp(
  connection: Connection,
  known: Map<number, PgTypeRow>,
  oids: readonly number[],
): Promise<void> {
  let missing = [...new Set(oids)].filter((oid) => !isBuiltIn(oid) && !known.has(oid));
  while (missing.length > 0) {
    const rows = await readPgTypes(connection, missing);
    for (const [oid, row] of rows) {
      known.set(oid, row);
    }
    missing = [...rows.values()]
      .flatMap((row) => [row.element, row.subtype, row.base])
      .filter((oid) => oid !== 0 && !isBuiltIn(oid) && !known.has(oid));
  }
}

function isBuiltIn(oid: number): boolean {
  return builtIns.has(oid);
}

function typeInfo(oid: number, known: ReadonlyMap<number, PgTypeRow>): TypeInfo {
  const builtIn = builtIns.get(oid);
  if (builtIn !== undefined) {
    return builtIn;
  }
  const row = known.get(oid);
  return row === undefined ? { kind: "text" } : typeInfoOf(row, known);
}

function typeInfoOf(row: PgTypeRow, known: ReadonlyMap<number, PgTypeRow>): TypeInfo {
  if (row.element !== 0) {
    return { kind: "array", element: typeInfo(row.element, known) };
  }
  if (row.typtype === "d") {
    return typeInfo(row.base, known);
  }
  if (row.typtype === "r") {
    return { kind: "range", subtype: typeInfo(row.subtype, known) };
  }
  if (row.typtype === "m") {
    return { kind: "multirange", subtype: typeInfo(row.subtype, known) };
  }
  return row.typtype === "b" && row.schema === "pg_catalog"
    ? { kind: "base", name: row.name }
    : { kind: "text" };
}

async function readPgTypes(
  connection: Connection,
  oids: readonly number[],
): Promise<ReadonlyMap<number, PgTypeRow>> {
  const { rows } = await connection.query(
    `select t.oid, n.nspname, t.typname, t.typtype,
       case when t.typinput = 'array_in'::regproc then t.typelem else 0 end,
       coalesce(r.rngsubtype, multi.rngsubtype, 0), t.typbasetype
     from pg_type t
     join pg_namespace n on n.oid = t.typnamespace
     left join pg_range r on r.rngtypid = t.oid
     left join pg_range multi on multi.rngmultitypid = t.oid
     where t.oid = any($1::oid[])`,
    [`{${oids.join(",")}}`],
  );
  return new Map(
    rows.map(([oid, schema, name, typtype, element, subtype, base]) => [
      Number(oid),
      {
        schema: schema ?? "",
        name: name ?? "",
        typtype: typtype ?? "",
        element: Number(element),
        subtype: Number(subtype),
        base: Number(base),
      },
    ]),
  );
}
