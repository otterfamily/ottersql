import type { Catalog, Enum } from "../catalog/index.ts";
import { combine, manual, objectName, only, step } from "./changes.ts";
import type { Changes } from "./changes.ts";
import { commentChange } from "./comments.ts";
import { matchByQualifiedName } from "./match.ts";
import { literal, qualified } from "./sql-text.ts";

export function enumChanges(from: Catalog, to: Catalog): Changes {
  const { added, removed, kept } = matchByQualifiedName(from.enums, to.enums);
  return combine([
    ...added.map((item) => createEnum(item)),
    ...removed.map((item) => dropEnum(item)),
    ...kept.map(([before, after]) => changeEnum(before, after)),
  ]);
}

function createEnum(item: Enum): Changes {
  const values = item.values.map((value) => literal(value)).join(", ");
  return only(
    step({
      kind: "createEnum",
      object: objectName(item),
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
      object: objectName(item),
      statements: [`DROP TYPE ${qualified(item.schema, item.name)}`],
      phase: "contract",
      reversal: "irreversible",
      lock: "none",
    }),
  );
}

function changeEnum(before: Enum, after: Enum): Changes {
  const object = objectName(after);
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
              object: objectName(after, value),
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
