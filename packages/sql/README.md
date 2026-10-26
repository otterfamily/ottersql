# @ottersql/sql

Typed SQL at runtime: reads .sql query files and decodes values with ottersql's codecs.

Part of [ottersql](https://github.com/otterfamily/ottersql), a TypeScript toolkit for Postgres. The repository's README says what it is, what it needs and how far along it is.

## Importing `.sql` files

Each `.sql` file becomes a module that exports its queries. Load it with:

- Node: `node --import @ottersql/sql/register app.ts`
- Bun: `bun --preload @ottersql/sql/register app.ts`, or `preload = ["@ottersql/sql/register"]` in `bunfig.toml` (under `[test]` too for `bun test`)
- Vite, Vitest, Rolldown and Rollup: add the plugin to the config.

  ```ts
  import { ottersql } from "@ottersql/sql/vite";

  export default defineConfig({ plugins: [ottersql()] });
  ```

- esbuild and `Bun.build`: `plugins: [ottersql()]` with `ottersql` from `@ottersql/sql/esbuild`.
- webpack and Rspack: a rule `{ test: /\.sql$/, loader: "@ottersql/sql/webpack" }`.
- Next.js with Turbopack: `turbopack: { rules: { "*.sql": { loaders: ["@ottersql/sql/webpack"], as: "*.js" } } }` in `next.config`.

## Connections

Queries run on a `Connection`, made from the driver the application already uses:

- node-postgres: `pgConnection(pool)` from `@ottersql/sql/pg`
- pg-promise: `pgPromiseConnection(db)` from `@ottersql/sql/pg-promise`, for its database object
- Neon's serverless driver: `pgConnection(pool)` from `@ottersql/sql/pg`, for its WebSocket `Pool` and `Client`, which follow node-postgres
- postgres.js: `postgresJsConnection(sql)` from `@ottersql/sql/postgres-js`
- Bun.sql: `bunSqlConnection(sql)` from `@ottersql/sql/bun-sql`, for a client created with `{ prepare: false }` (Bun receives prepared statements' values of some types in binary)
- PGlite: `pgliteConnection(db)` from `@ottersql/sql/pglite`

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

A `Connection` runs only typed queries. Tools built on ottersql run SQL as it is with `rawQuery` from `@ottersql/sql/driver`, which also has `driverConnection` for drivers ottersql has no adapter for.

## Errors

An error Postgres reports rejects with a `QueryError`, the same whatever the driver: `code` is the SQLSTATE (`"23505"` for a unique violation), with `constraint`, `table`, `column`, `schema`, `detail` and `hint` where Postgres gives them, and the driver's own error as `cause`.
