import { describe, expect, test as base } from "vitest";

import { openDrivers } from "./test-drivers.ts";
import { builtInOids, typeInfos } from "./type-info.ts";
import type { TypeInfo } from "./type-info.ts";
import type { Connection } from "./values.ts";

const test = base.extend<{ drivers: readonly Connection[] }>({
  drivers: [openDrivers, { scope: "file" }],
});

function expectedTypeInfo([typtype, name, element, subtype]: readonly (
  | string
  | null
  | undefined
)[]): TypeInfo {
  if (element !== null && element !== undefined) {
    return { kind: "array", element: { kind: "base", name: element } };
  }
  if (typtype === "r" || typtype === "m") {
    const kind = typtype === "r" ? "range" : "multirange";
    return { kind, subtype: { kind: "base", name: subtype ?? "" } };
  }
  return { kind: "base", name: name ?? "" };
}

describe("built-in types", () => {
  test("match what pg_type says about their oids", async ({ drivers }) => {
    for (const connection of drivers) {
      const { rows } = await connection.query(
        `select t.oid, t.typtype, t.typname, element.typname, subtype.typname
         from pg_type t
         left join pg_type element on element.oid = t.typelem and t.typcategory = 'A'
         left join pg_range r on t.oid in (r.rngtypid, r.rngmultitypid)
         left join pg_type subtype on subtype.oid = r.rngsubtype
         where t.oid = any($1::oid[])`,
        [`{${builtInOids.join(",")}}`],
      );
      const expected = new Map(rows.map(([oid, ...type]) => [Number(oid), expectedTypeInfo(type)]));
      await expect(typeInfos(connection, builtInOids)).resolves.toStrictEqual(expected);
    }
  });
});
