import type { Catalog, Enum } from "@ottersql/catalog";

import { commentChange } from "./comments.ts";
import { literal, qualified } from "./sql-text.ts";
import { combine, manual, matchByName, only, step } from "./steps.ts";
import type { Changes } from "./steps.ts";

export function enumChanges(from: Catalog, to: Catalog): Changes {
  const { added, removed, kept } = matchByName(withKey(from.enums), withKey(to.enums));
  return combine([
    ...added.map(({ item }) => createEnum(item)),
    ...removed.map(({ item }) => dropEnum(item)),
    ...kept.map(([before, after]) => changeEnum(before.item, after.item)),
  ]);
}

function withKey(enums: readonly Enum[]): { readonly name: string; readonly item: Enum }[] {
  return enums.map((item) => ({ name: `${item.schema}.${item.name}`, item }));
}

function createEnum(item: Enum): Changes {
  const values = item.values.map((value) => literal(value)).join(", ");
  return only(
    step({
      kind: "createEnum",
      object: `${item.schema}.${item.name}`,
      statements: [`CREATE TYPE ${qualified(item.schema, item.name)} AS ENUM (${values})`],
      phase: "expand",
      reversal: "lossy",
      lock: "none",
    }),
  );
}

function dropEnum(item: Enum): Changes {
  return only(
    step({
      kind: "dropEnum",
      object: `${item.schema}.${item.name}`,
      statements: [`DROP TYPE ${qualified(item.schema, item.name)}`],
      phase: "contract",
      reversal: "irreversible",
      lock: "none",
    }),
  );
}

function changeEnum(before: Enum, after: Enum): Changes {
  const object = `${after.schema}.${after.name}`;
  const kept = after.values.filter((value) => before.values.includes(value));
  if (
    kept.some((value, index) => value !== before.values[index]) ||
    kept.length !== before.values.length
  ) {
    return manual(
      object,
      "Postgres cannot remove or reorder enum values; create a new type and move columns to it",
    );
  }
  return combine([
    addedValues(before, after),
    commentChange({
      on: "TYPE",
      object,
      name: qualified(after.schema, after.name),
      before: before.comment,
      after: after.comment,
    }),
  ]);
}

/** Each new value goes after the one before it in `after`, or before the first value at the start. */
function addedValues(before: Enum, after: Enum): Changes {
  const name = qualified(after.schema, after.name);
  const [first] = before.values;
  return only(
    ...after.values.flatMap((value, index) =>
      before.values.includes(value)
        ? []
        : [
            step({
              kind: "addEnumValue",
              object: `${after.schema}.${after.name}.${value}`,
              statements: [
                `ALTER TYPE ${name} ADD VALUE ${literal(value)}${position(after.values[index - 1], first)}`,
              ],
              phase: "expand",
              reversal: "irreversible",
              lock: "none",
              reason:
                "A value added in a transaction cannot be used until it commits, so it is a step of its own",
            }),
          ],
    ),
  );
}

function position(previous: string | undefined, first: string | undefined): string {
  if (previous !== undefined) {
    return ` AFTER ${literal(previous)}`;
  }
  return first === undefined ? "" : ` BEFORE ${literal(first)}`;
}
