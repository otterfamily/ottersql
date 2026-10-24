import type { PGliteInterface } from "@electric-sql/pglite";

import type { Connection } from "./values.ts";

type Passthrough = (value: string) => string;

const asText: Passthrough = (value) => value;

/**
 * A `Connection` over PGlite, receiving every value as text. PGlite takes parsers per type oid, so
 * each statement is described once to learn its oids; arrays need their own oid's parser.
 */
export function pgliteConnection(db: PGliteInterface): Connection {
  const passthroughs = new Map<string, Readonly<Record<number, Passthrough>>>();
  return {
    query: async (sql, parameters) => {
      let parsers = passthroughs.get(sql);
      if (parsers === undefined) {
        const described = await db.describeQuery(sql);
        const oids = [...described.queryParams, ...described.resultFields].map(
          (field) => field.dataTypeID,
        );
        parsers = Object.fromEntries(oids.map((oid) => [oid, asText]));
        passthroughs.set(sql, parsers);
      }
      const result = await db.query<(string | null)[]>(sql, [...parameters], {
        rowMode: "array",
        parsers,
        serializers: parsers,
      });
      return {
        fields: result.fields.map((field) => ({ name: field.name, typeOid: field.dataTypeID })),
        rows: result.rows,
      };
    },
  };
}
