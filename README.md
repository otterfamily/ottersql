# ottersql 🦦

Otters hold hands while they sleep so they don't drift apart. ottersql keeps your schema, your database and your types holding hands.

ottersql is an AI-first TypeScript ORM and migration tool for Postgres, still an early prototype.

- **Correct types.** Types say only what the database guarantees: a column is non-null only when Postgres's own analysis of the query proves it, `int8` and `numeric` stay exact, dates and times are Temporal values, and a CHECK that lists values becomes a union of them.
- **Safe migrations.** Forward-only plans from the difference between `schema.sql` and the database, written with the lock-safe recipes production teams apply by hand, saying what is safe to roll back, which steps run before and after a deploy, and resuming where a failed run stopped.
- **Fast.** Close to the bare driver at runtime, quick in the editor, and measured to prove it.
- **`schema.sql` is enough.** Types, checks and migration plans come from Postgres itself running in-process (PGlite), so no database is needed in the editor or in CI.
- **Plain SQL is the source of truth.** `schema.sql` describes the database, `migrations/*.sql` record how it got there, and `.sql` query files hold your queries. Types reach your editor through TypeScript 7.1 content mappers, with no codegen step.
- **Take only what you need.** Use typed SQL alone next to your current ORM, or add the relational API and migrations later.

## Goals

- Cover Postgres fully: composite foreign keys, unique constraints, every index option, views, functions, triggers, and history tables.
- Work on Postgres and Postgres-compatible hosts such as Aurora PostgreSQL, Aurora DSQL, Supabase and Neon by detecting what each one supports.
- Fast at runtime and in the type checker.
- Easy to run locally and to debug, through a CLI built for coding agents.
- Safe to migrate automatically in CI/CD: the app can always roll back on its own, and a failed migration can be cleaned up.
- Not tied to one database or host, extensible, and later able to treat DynamoDB the same way where the semantics match.

## Status

A prototype. The packages are on npm so they can be tried, and before 1.0 anything may change in a minor version (0.1 to 0.2).

```sh
npm install --save-dev ottersql @ottersql/content-mapper
npm install @ottersql/sql
```

- [`docs/adr`](docs/adr): decisions so far and why
- [Roadmap](https://github.com/orgs/otterfamily/projects/1): milestones and work items
- branch `prototype/content-mapper`: a throwaway prototype showing `.sql` files typed through content mappers

## Requirements

- Node.js 26 or later, or Bun 1.4 or later: dates and times come back as values of the global `Temporal`. Other runtimes need it too, or a polyfill.
- A Postgres driver the application already uses: node-postgres, postgres.js, Bun.sql, PGlite, pg-promise or Neon's serverless driver. [`@ottersql/sql`](packages/sql) says how to connect each, and how to import `.sql` files in Node, Bun, Vite, esbuild, webpack and Next.js.
- TypeScript 7.1 or later for typed `.sql` files. The types they get use the global `Temporal`, so `lib` in `tsconfig.json` needs `esnext.temporal` (or `esnext`).
- Tools that cannot run TypeScript 7.1 content mappers, such as older TypeScript, typescript-eslint or Deno, can read the types from declaration files instead: `ottersql types` writes `queries.d.sql.ts` next to each `queries.sql`, and they need `allowArbitraryExtensions` in `tsconfig.json`. Nothing is written unless you run it.

## License

[Apache-2.0](LICENSE)
