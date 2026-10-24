# ottersql 🦦

Otters hold hands while they sleep so they don't drift apart. ottersql keeps your schema, your database and your types holding hands.

ottersql is an AI-first TypeScript ORM and migration tool for Postgres, in the design stage before its first PoC.

- **Plain SQL is the source of truth.** `schema.sql` describes the database, `migrations/*.sql` record how it got there, and `.sql` query files hold your queries.
- **Types say only what the database guarantees.** No TypeScript-only enums, no types the database cannot enforce.
- **No codegen step.** Types reach your editor through TypeScript 7.1 content mappers.
- **Forward-only migrations** with plans that say what is safe to roll back and in what order to deploy.

## Status

Not usable yet. The direction and research are in this repository:

- `requirements.md`: decisions so far
- `research/`: primary-source research (start at `research/00-summary.md`)
- branch `prototype/content-mapper`: a throwaway prototype showing `.sql` files typed through content mappers

Design notes are in Japanese for now.

## License

[Apache-2.0](LICENSE)
