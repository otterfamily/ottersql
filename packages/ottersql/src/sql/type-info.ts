import { builtIns } from "./built-in-types.ts";
import { cacheKey, rawQuery } from "./connection.ts";
import type { Connection, Transaction } from "./connection.ts";

/** How values of a Postgres type are decoded. */
export type TypeInfo =
  | { readonly kind: "base"; readonly name: string }
  /** Enums, composites and types without a codec arrive as Postgres's text. */
  | { readonly kind: "text" }
  /** `delimiter` separates elements in the text: a comma for every type but `box`'s semicolon. */
  | { readonly kind: "array"; readonly element: TypeInfo; readonly delimiter: string }
  | { readonly kind: "range"; readonly subtype: TypeInfo }
  | { readonly kind: "multirange"; readonly subtype: TypeInfo };

interface PgTypeRow {
  readonly schema: string;
  readonly name: string;
  readonly typtype: string;
  readonly element: number;
  readonly subtype: number;
  readonly base: number;
  /** The delimiter of the element type, for an array type. */
  readonly delimiter: string;
}

/** What a connection has looked up, and the lookups under way, so concurrent queries share one. */
interface Lookups {
  readonly known: Map<number, PgTypeRow>;
  readonly pending: Map<number, Promise<void>>;
}

const lookupsByConnection = new WeakMap<object, Lookups>();

/** The decoding information for each oid, looking up oids that are not built in through `connection`. */
export async function typeInfos(
  connection: Connection | Transaction,
  oids: readonly number[],
): Promise<ReadonlyMap<number, TypeInfo>> {
  const key = cacheKey(connection);
  const lookups = lookupsByConnection.get(key) ?? { known: new Map(), pending: new Map() };
  lookupsByConnection.set(key, lookups);
  await lookUp(connection, lookups, oids);
  return new Map(oids.map((oid) => [oid, typeInfo(oid, lookups.known)]));
}

/** Looks up `oids` and the element, range and base types they lead to. */
async function lookUp(
  connection: Connection | Transaction,
  { known, pending }: Lookups,
  oids: readonly number[],
): Promise<void> {
  const unknown = (oid: number): boolean => oid !== 0 && !isBuiltIn(oid) && !known.has(oid);
  let wanted = [...new Set(oids)].filter((oid) => unknown(oid));
  while (wanted.length > 0) {
    const elsewhere = new Set(wanted.filter((oid) => pending.has(oid)));
    startReading(
      connection,
      { known, pending },
      wanted.filter((oid) => !elsewhere.has(oid)),
    );
    const missed = await missedElsewhere(pending, wanted, elsewhere);
    if (missed.length > 0) {
      await readInto(connection, known, missed);
    }
    wanted = wanted
      .flatMap((oid) => {
        const row = known.get(oid);
        return row === undefined ? [] : [row.element, row.subtype, row.base];
      })
      .filter((oid) => unknown(oid));
  }
}

/**
 * Waits for the lookups of `oids`, and returns those whose lookup another transaction started and
 * failed: it can fail for reasons of its own, such as that transaction having failed, so the
 * caller reads them itself.
 */
async function missedElsewhere(
  pending: ReadonlyMap<number, Promise<void>>,
  oids: readonly number[],
  elsewhere: ReadonlySet<number>,
): Promise<number[]> {
  const missed = await Promise.all(
    oids.map(async (oid) => {
      try {
        await pending.get(oid);
        return [];
      } catch (error) {
        if (elsewhere.has(oid)) {
          return [oid];
        }
        throw error;
      }
    }),
  );
  return missed.flat();
}

/** Looks `oids` up, marking them as under way until the lookup settles. */
function startReading(
  connection: Connection | Transaction,
  { known, pending }: Lookups,
  oids: readonly number[],
): void {
  if (oids.length > 0) {
    const reading = readInto(connection, known, oids);
    for (const oid of oids) {
      pending.set(oid, reading);
    }
    void forget(pending, oids, reading);
  }
}

async function readInto(
  connection: Connection | Transaction,
  known: Map<number, PgTypeRow>,
  oids: readonly number[],
): Promise<void> {
  for (const [oid, row] of await readPgTypes(connection, oids)) {
    known.set(oid, row);
  }
}

/** Drops `oids` from the lookups under way once `reading` settles, failed or not. */
async function forget(
  pending: Map<number, Promise<void>>,
  oids: readonly number[],
  reading: Promise<void>,
): Promise<void> {
  try {
    await reading;
  } catch {
    // Reported to the queries that wait for the lookup.
  } finally {
    for (const oid of oids) {
      pending.delete(oid);
    }
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
    return { kind: "array", element: typeInfo(row.element, known), delimiter: row.delimiter };
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
  connection: Connection | Transaction,
  oids: readonly number[],
): Promise<ReadonlyMap<number, PgTypeRow>> {
  const { rows } = await rawQuery(
    connection,
    `select t.oid, n.nspname, t.typname, t.typtype,
       case when t.typinput = 'array_in'::regproc then t.typelem else 0 end,
       coalesce(r.rngsubtype, multi.rngsubtype, 0), t.typbasetype, coalesce(element.typdelim, ',')
     from pg_type t
     join pg_namespace n on n.oid = t.typnamespace
     left join pg_type element on element.oid = t.typelem
     left join pg_range r on r.rngtypid = t.oid
     left join pg_range multi on multi.rngmultitypid = t.oid
     where t.oid = any($1::oid[])`,
    [`{${oids.join(",")}}`],
  );
  return new Map(
    rows.map(([oid, schema, name, typtype, element, subtype, base, delimiter]) => [
      Number(oid),
      {
        schema: schema ?? "",
        name: name ?? "",
        typtype: typtype ?? "",
        element: Number(element),
        subtype: Number(subtype),
        base: Number(base),
        delimiter: delimiter ?? ",",
      },
    ]),
  );
}
