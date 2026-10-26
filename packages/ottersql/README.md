# ottersql

Typed SQL, safe migrations and an agent-first CLI for Postgres, in one package with no dependencies. Import only the entry points you use:

| Entry point                                                                                         | What it is                                                                               |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `ottersql`                                                                                          | The runtime: typed queries from `.sql` files, transactions, `QueryError`                 |
| `ottersql/pg`, `ottersql/postgres-js`, `ottersql/bun-sql`, `ottersql/pglite`, `ottersql/pg-promise` | A connection over the driver you use                                                     |
| `ottersql/register`, `ottersql/vite`, `ottersql/esbuild`, `ottersql/webpack`                        | Importing `.sql` files                                                                   |
| `ottersql/content-mapper`                                                                           | Types `.sql` files for TypeScript 7.1 content mappers, from a `schema.sql` run in PGlite |
| `ottersql/catalog`                                                                                  | Reads a Postgres schema into ottersql's catalog model                                    |
| `ottersql/migrate`                                                                                  | Plans and applies forward-only migrations with lock-safe procedures                      |
| `ottersql/driver`                                                                                   | The driver interface, for adapters and tools                                             |
| the `ottersql` command                                                                              | Generates, checks and applies migrations, with JSON output for agents                    |

Drivers and PGlite are optional peer dependencies: install the driver your application uses, and `@electric-sql/pglite` as a dev dependency for type checking and migration planning.

Part of [ottersql](https://github.com/otterfamily/ottersql), a TypeScript toolkit for Postgres. The repository's README says what it is, what it needs and how far along it is.

## Importing `.sql` files

Each `.sql` file becomes a module that exports its queries. Load it with:

- Node: `node --import ottersql/register app.ts`
- Bun: `bun --preload ottersql/register app.ts`, or `preload = ["ottersql/register"]` in `bunfig.toml` (under `[test]` too for `bun test`)
- Vite, Vitest, Rolldown and Rollup: add the plugin to the config.

  ```ts
  import { ottersql } from "ottersql/vite";

  export default defineConfig({ plugins: [ottersql()] });
  ```

- esbuild and `Bun.build`: `plugins: [ottersql()]` with `ottersql` from `ottersql/esbuild`.
- webpack and Rspack: a rule `{ test: /\.sql$/, loader: "ottersql/webpack" }`.
- Next.js with Turbopack: `turbopack: { rules: { "*.sql": { loaders: ["ottersql/webpack"], as: "*.js" } } }` in `next.config`.

## Connections

Queries run on a `Connection`, made from the driver the application already uses:

- node-postgres: `pgConnection(pool)` from `ottersql/pg`
- pg-promise: `pgPromiseConnection(db)` from `ottersql/pg-promise`, for its database object
- Neon's serverless driver: `pgConnection(pool)` from `ottersql/pg`, for its WebSocket `Pool` and `Client`, which follow node-postgres
- postgres.js: `postgresJsConnection(sql)` from `ottersql/postgres-js`
- Bun.sql: `bunSqlConnection(sql)` from `ottersql/bun-sql`, for a client created with `{ prepare: false }` (Bun receives prepared statements' values of some types in binary)
- PGlite: `pgliteConnection(db)` from `ottersql/pglite`

## Running queries

Each query in a `.sql` file is a function of the connection and its parameters:

- `userById(db, { id })` resolves with the rows.
- `userById.one(db, { id })` resolves with the only row, and rejects unless there is exactly one.
- `userById.maybeOne(db, { id })` resolves with the only row or `null`.
- `deleteExpired.affected(db)` resolves with how many rows the statement wrote, as Postgres counts them.

## Transactions

```ts
const order = await db.transaction(
  async (tx) => {
    const order = await createOrder.one(tx, { userId });
    await tx.savepoint(async (sp) => addPoints(sp, { userId })); // undone alone if it rejects
    return order;
  },
  { isolation: "serializable", settings: { "app.user_id": userId }, retry: { attempts: 3 } },
);
```

The transaction commits when the callback resolves and rolls back when it rejects, on one connection the driver holds for it; pass node-postgres a pool, not a client. `settings` last for the transaction only, as `SET LOCAL` does. `retry` runs the callback again after a serialization failure or a deadlock, so give it only callbacks that do nothing but query. `readOnly` and, for serializable read-only transactions, `deferrable` are there too.

Inside the callback, run queries on `tx`: a query on `db` runs outside the transaction, and on PGlite waits for the transaction to end, so the two wait on each other forever.

A `Connection` runs only typed queries. Tools built on ottersql run SQL as it is with `rawQuery` from `ottersql/driver`, which also has `driverConnection` for drivers ottersql has no adapter for.

## Errors

An error Postgres reports rejects with a `QueryError`, the same whatever the driver: `code` is the SQLSTATE (`"23505"` for a unique violation), with `constraint`, `table`, `column`, `schema`, `detail` and `hint` where Postgres gives them, and the driver's own error as `cause`.

`code`, `constraint`, `table`, `column` and `schema` name things in the schema and never hold values. `message`, `detail`, `hint` and `cause` can: a unique violation's `detail` is `Key (email)=(otter@example.com) already exists.`, and a driver's error can carry the parameters. Where personal data must stay out of logs and responses, pass on the safe fields:

```ts
} catch (error) {
  if (error instanceof QueryError) {
    logger.error({ code: error.code, constraint: error.constraint, table: error.table }, "query failed");
  }
  throw error;
}
```

ottersql's own errors, such as a value that does not fit its column's type, name the column and the type but never the value, and ottersql writes no logs.

## The command

`ottersql` connects with node-postgres to `DATABASE_URL`. For a connection it cannot make that way, such as one that signs in with a short-lived token, call the library from your own script with a connection you make: `applyMigrations(connection, …)` from `ottersql/migrate` takes any driver's connection.
