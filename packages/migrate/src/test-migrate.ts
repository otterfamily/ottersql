import { loadCatalog, openSchema } from "@ottersql/catalog";
import type { Catalog } from "@ottersql/catalog";

import { planMigration } from "./index.ts";
import type { Plan, Step } from "./index.ts";

/** Columns cannot be reordered in Postgres, so a migrated table keeps its columns in another order. */
export function withSortedColumns(catalog: Catalog): Catalog {
  return {
    ...catalog,
    tables: catalog.tables.map((table) => ({
      ...table,
      columns: table.columns.toSorted((left, right) => left.name.localeCompare(right.name)),
    })),
  };
}

/** Plans from `fromSql` to `toSql`, runs the plan on `fromSql`, and reads what it left behind. */
export async function migrate(
  fromSql: string,
  toSql: string,
): Promise<{ readonly plan: Plan; readonly after: Catalog; readonly target: Catalog }> {
  const target = await loadCatalog(toSql);
  const schema = await openSchema(fromSql);
  try {
    const plan = planMigration(schema.catalog, target);
    for (const statement of plan.steps.flatMap((step) => step.statements)) {
      await schema.database.exec(statement);
    }
    const after = await schema.readCatalog();
    return { plan, after: withSortedColumns(after), target: withSortedColumns(target) };
  } finally {
    await schema.close();
  }
}

/** A step on one line, such as `expand addColumn public.users.name (lossy, inside, access exclusive)`. */
export function summary({ kind, object, phase, reversal, transaction, lock }: Step): string {
  return `${phase} ${kind} ${object} (${reversal}, ${transaction}, ${lock})`;
}

export const users = "create table users (id int8 primary key, email text)";
export const uuid7 =
  "create function my_uuid7() returns uuid language sql volatile as 'select gen_random_uuid()'";
