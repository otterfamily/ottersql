import { isDeepStrictEqual } from "node:util";

import type { Catalog, CompositeType, TypeRef } from "../catalog/index.ts";
import { identifier, literal, qualified } from "./sql-text.ts";
import { combine, manual, matchByName, notPlanned, only, step } from "./steps.ts";
import type { Changes } from "./steps.ts";

/**
 * A new composite type is created before the tables that use it. Changing or dropping one touches
 * every column of it, which ottersql does not plan yet.
 */
export function compositeChanges(from: Catalog, to: Catalog): Changes {
  const { added, removed, kept } = matchByName(withKey(from.composites), withKey(to.composites));
  return combine([
    ...dependenciesFirst(added.map(({ item }) => item)).map((item) => createType(item)),
    ...removed.map(({ name }) => manual(name, notPlanned("a composite type"))),
    ...kept
      .filter(([before, after]) => !isDeepStrictEqual(before.item, after.item))
      .map(([, { name }]) => manual(name, notPlanned("a composite type"))),
  ]);
}

function withKey(
  composites: readonly CompositeType[],
): { readonly name: string; readonly item: CompositeType }[] {
  return composites.map((item) => ({ name: `${item.schema}.${item.name}`, item }));
}

function nameOf(type: TypeRef): string {
  const named = type.kind === "array" ? type.element : type;
  return `${named.schema}.${named.name}`;
}

/** `composites` ordered so that one used by another's attribute comes before it. */
function dependenciesFirst(composites: readonly CompositeType[]): CompositeType[] {
  const pending = new Map(composites.map((item) => [`${item.schema}.${item.name}`, item]));
  const ordered: CompositeType[] = [];
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((item) =>
      item.attributes.every((attribute) => !pending.has(nameOf(attribute.type))),
    );
    // A cycle cannot be created in Postgres; this only guards against looping forever.
    const next = ready.length > 0 ? ready : [...pending.values()];
    for (const item of next) {
      pending.delete(`${item.schema}.${item.name}`);
      ordered.push(item);
    }
  }
  return ordered;
}

function createType(item: CompositeType): Changes {
  const name = qualified(item.schema, item.name);
  const attributes = item.attributes.map(({ name: attribute, typeSql, collation }) =>
    [
      identifier(attribute),
      typeSql,
      ...(collation === null ? [] : [`COLLATE ${qualified(collation.schema, collation.name)}`]),
    ].join(" "),
  );
  return only(
    step({
      kind: "createType",
      object: `${item.schema}.${item.name}`,
      statements: [
        `CREATE TYPE ${name} AS (${attributes.join(", ")})`,
        ...(item.comment === null
          ? []
          : [`COMMENT ON TYPE ${name} IS ${literal(item.comment.text)}`]),
        ...item.attributes.flatMap((attribute) =>
          attribute.comment === null
            ? []
            : [
                `COMMENT ON COLUMN ${name}.${identifier(attribute.name)} IS ${literal(attribute.comment.text)}`,
              ],
        ),
      ],
      phase: "expand",
      reversal: "lossy",
      lock: "none",
    }),
  );
}
