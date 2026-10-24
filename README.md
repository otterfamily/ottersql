# ottersql 🦦

Otters hold hands while they sleep so they don't drift apart. ottersql keeps your schema, your database and your types holding hands.

ottersql is an AI-first TypeScript ORM and migration tool for Postgres, in the design stage before its first PoC.

- **Plain SQL is the source of truth.** `schema.sql` describes the database, `migrations/*.sql` record how it got there, and `.sql` query files hold your queries.
- **Types say only what the database guarantees.** No TypeScript-only enums, no types the database cannot enforce.
- **No codegen step.** Types reach your editor through TypeScript 7.1 content mappers.
- **Forward-only migrations** with plans that say what is safe to roll back and in what order to deploy.

## Goals

- Cover Postgres fully: composite foreign keys, unique constraints, every index option, views, functions, triggers, and history tables.
- Work on Postgres-compatible databases such as Aurora PostgreSQL and Aurora DSQL by detecting what each one supports.
- Fast at runtime and in the type checker.
- Easy to run locally and to debug, through a CLI built for coding agents.
- Safe to migrate automatically in CI/CD: the app can always roll back on its own, and a failed migration can be cleaned up.
- Not tied to one database or host, extensible, and later able to treat DynamoDB the same way where the semantics match.

## Status

Not usable yet.

- [`docs/adr`](docs/adr): decisions so far and why
- [ottersql-research](https://github.com/otterfamily/ottersql-research): the primary-source research behind them (in Japanese)
- branch `prototype/content-mapper`: a throwaway prototype showing `.sql` files typed through content mappers

## License

[Apache-2.0](LICENSE)
