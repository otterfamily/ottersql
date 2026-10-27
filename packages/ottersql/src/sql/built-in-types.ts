import type { TypeInfo } from "./type-info.ts";

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

/** How each built-in type is decoded, by its oid. */
export const builtIns: ReadonlyMap<number, TypeInfo> = new Map([
  ...Object.entries(builtInBaseOids).map(([name, oid]): [number, TypeInfo] => [
    oid,
    { kind: "base", name },
  ]),
  ...Object.entries(builtInArrayOids).map(([name, oid]): [number, TypeInfo] => [
    oid,
    { kind: "array", element: { kind: "base", name }, delimiter: "," },
  ]),
  ...Object.values(builtInRanges).flatMap((range): [number, TypeInfo][] => [
    [range.oid, { kind: "range", subtype: { kind: "base", name: range.subtype } }],
    [range.multirangeOid, { kind: "multirange", subtype: { kind: "base", name: range.subtype } }],
  ]),
]);

/** The oids whose decoding is fixed, without a lookup. */
export const builtInOids: readonly number[] = [...builtIns.keys()];
