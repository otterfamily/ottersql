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
- Neon's serverless driver: `pgConnection(pool)` from `@ottersql/sql/pg`, for its WebSocket `Pool` and `Client`, which follow node-postgres
- postgres.js: `postgresConnection(sql)` from `@ottersql/sql/postgres`
- Bun.sql: `bunSqlConnection(sql)` from `@ottersql/sql/bun-sql`, for a client created with `{ prepare: false }` (Bun receives prepared statements' values of some types in binary)
- PGlite: `pgliteConnection(db)` from `@ottersql/sql/pglite`
