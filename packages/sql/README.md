# @ottersql/sql

Typed SQL at runtime: reads .sql query files and decodes values with ottersql's codecs.

Part of [ottersql](https://github.com/otterfamily/ottersql), a TypeScript toolkit for Postgres. The repository's README says what it is, what it needs and how far along it is.

## Importing `.sql` files

Each `.sql` file becomes a module that exports its queries. Load it with:

- Node: `node --import @ottersql/sql/register app.ts`
- Vite, Vitest, Rolldown and Rollup: add the plugin to the config.

  ```ts
  import { ottersql } from "@ottersql/sql/vite";

  export default defineConfig({ plugins: [ottersql()] });
  ```
