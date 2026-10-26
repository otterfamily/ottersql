import type { IDatabase } from "pg-promise";

import { clientConnection } from "./connection.ts";
import type { Connection, DriverTransaction } from "./connection.ts";
import { pgQuery } from "./pg-driver.ts";
import { databaseErrorFields, reportingQueryErrors } from "./query-error.ts";
import type { TransactionMode } from "./transaction.ts";

/**
 * A `Connection` over a pg-promise database object, receiving every value as text. Transactions
 * run in pg-promise's own (`db.tx`). The same object gives the same connection, which remembers
 * the types it has looked up.
 */
export function pgPromiseConnection(db: IDatabase<unknown>): Connection {
  // The types pg-promise declares ask for all of node-postgres's type registry, of which
  // node-postgres calls only getTypeParser.
  const registry = db.$config.pgp.pg.types;
  // An object with `text` is a parameterized query to pg-promise: Postgres binds the values,
  // instead of pg-promise formatting them into the SQL.
  const queryOn = (context: Pick<IDatabase<unknown>, "result">) =>
    pgQuery(async (config) =>
      context.result({
        ...config,
        values: [...config.values],
        types: { ...registry, getTypeParser: config.types.getTypeParser },
      }),
    );
  // A transaction inside one is a savepoint to pg-promise.
  const transactionOn = (task: Pick<IDatabase<unknown>, "result" | "tx">): DriverTransaction => ({
    query: queryOn(task),
    savepoint: async (run) => task.tx(async (inner) => run(transactionOn(inner))),
  });
  return clientConnection(db, () => ({
    query: queryOn(db),
    transaction: async (run, mode) =>
      reportingQueryErrors(
        async () =>
          db.tx({ mode: pgPromiseMode(db, mode) }, async (task) => run(transactionOn(task))),
        databaseErrorFields,
      ),
  }));
}

/** `mode` as pg-promise takes it, which writes the same BEGIN as `transactionModeSql`. */
function pgPromiseMode(
  db: IDatabase<unknown>,
  { isolation, readOnly, deferrable }: TransactionMode,
): InstanceType<IDatabase<unknown>["$config"]["pgp"]["txMode"]["TransactionMode"]> {
  const { TransactionMode, isolationLevel } = db.$config.pgp.txMode;
  const levels = {
    "read committed": isolationLevel.readCommitted,
    "repeatable read": isolationLevel.repeatableRead,
    serializable: isolationLevel.serializable,
  };
  return new TransactionMode({
    tiLevel: isolation === undefined ? isolationLevel.none : levels[isolation],
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(deferrable === undefined ? {} : { deferrable }),
  });
}
