import { isDeepStrictEqual } from "node:util";

import { nameKey } from "../catalog/find.ts";
import type { Catalog, CompositeType, TypeRef } from "../catalog/index.ts";
import { initialComment } from "./comments.ts";
import { identifier, qualified } from "./sql-text.ts";
import {
  combine,
  manual,
  matchByQualifiedName,
  notPlanned,
  objectName,
  only,
  step,
} from "./steps.ts";
import type { Changes } from "./steps.ts";
import { unplannedUse, usesUnplanned } from "./unplanned-uses.ts";

/**
 * A new composite type is created before the tables that use it, unless it uses what the plan
 * leaves to a person (`unplanned`). Changing or dropping one touches every column of it, which
 * ottersql does not plan yet.
 */
export function compositeChanges(
  from: Catalog,
  to: Catalog,
  unplanned: ReadonlySet<string>,
): Changes {
  const { added, removed, kept } = matchByQualifiedName(from.composites, to.composites);
  const create = (item: CompositeType): Changes => {
    const used = unplannedUse(item.attributes, unplanned);
    return used === null
      ? createType(item)
      : usesUnplanned(objectName(item), used, "create the type");
  };
  return combine([
    ...dependenciesFirst(added).map((item) => create(item)),
    ...removed.map((item) => manual(objectName(item), notPlanned("a composite type"))),
    ...kept
      .filter(([before, after]) => !isDeepStrictEqual(before, after))
      .map(([, after]) => manual(objectName(after), notPlanned("a composite type"))),
  ]);
}

function keyOf(type: TypeRef): string {
  const named = type.kind === "array" ? type.element : type;
  return nameKey(named.schema, named.name);
}

/** `composites` ordered so that one used by another's attribute comes before it. */
function dependenciesFirst(composites: readonly CompositeType[]): CompositeType[] {
  const pending = new Map(composites.map((item) => [nameKey(item.schema, item.name), item]));
  const ordered: CompositeType[] = [];
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((item) =>
      item.attributes.every((attribute) => !pending.has(keyOf(attribute.type))),
    );
    // A cycle cannot be created in Postgres; this only guards against looping forever.
    const next = ready.length > 0 ? ready : [...pending.values()];
    for (const item of next) {
      pending.delete(nameKey(item.schema, item.name));
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
      object: objectName(item),
      statements: [
        `CREATE TYPE ${name} AS (${attributes.join(", ")})`,
        ...initialComment("TYPE", name, item.comment),
        ...item.attributes.flatMap((attribute) =>
          initialComment("COLUMN", `${name}.${identifier(attribute.name)}`, attribute.comment),
        ),
      ],
      phase: "expand",
      reversal: "lossy",
      lock: "none",
    }),
  );
}
