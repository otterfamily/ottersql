import { nameKey } from "../catalog/find.ts";
import type { QualifiedName, TypeRef } from "../catalog/index.ts";
import { manual, objectName } from "./steps.ts";
import type { Changes } from "./steps.ts";

/** What a column or a composite type's attribute refers to: its type and collation. */
interface TypedItem {
  readonly type: TypeRef;
  readonly collation: QualifiedName | null;
}

/**
 * The name of the first of `unplanned` (`nameKey`s) that `items` use, or `null` when they use
 * none.
 */
export function unplannedUse(
  items: readonly TypedItem[],
  unplanned: ReadonlySet<string>,
): string | null {
  for (const { type, collation } of items) {
    const named = type.kind === "array" ? type.element : type;
    for (const used of [named, ...(collation === null ? [] : [collation])]) {
      if (unplanned.has(nameKey(used.schema, used.name))) {
        return objectName(used);
      }
    }
  }
  return null;
}

/** Leaves `object`, which uses `used`, to the person who creates `used`. */
export function usesUnplanned(
  object: string,
  used: string,
  action: "create the table" | "add the column" | "create the type",
): Changes {
  return manual(
    object,
    `${object} uses ${used}, which this plan leaves to a person; ${action} by hand after it`,
  );
}
