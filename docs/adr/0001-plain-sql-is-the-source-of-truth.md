# 0001. Plain SQL is the source of truth

- Status: Accepted
- Date: 2026-10-24

## Context

ORMs keep the schema in a DSL (Prisma) or in TypeScript (Drizzle) and generate SQL from it. Each DSL covers only part of Postgres: none of the tools we compared covers all 32 basic Postgres 18 schema features, and views, functions and triggers are mostly missing or paid ([research 07](https://github.com/otterfamily/ottersql-research/blob/main/07-db-objects-and-temporal.md), [09](https://github.com/otterfamily/ottersql-research/blob/main/09-postgres-schema-coverage.md)). Drizzle also never checks that the database matches its TypeScript schema. SQL is the language coding agents know best.

## Decision

- `schema.sql` describes the database as it should be. `migrations/*.sql` record how it got there. Both are plain Postgres SQL; there is no DSL.
- ottersql reads the schema by running `schema.sql` in a throwaway Postgres (PGlite) and reading the catalog. It does not parse SQL itself.
- CI checks that a database built from all migrations equals one built from `schema.sql`.
- `push` applies the difference between `schema.sql` and a local database directly. It shares the diff engine with migration generation and refuses to run against production.
- What SQL cannot express is added with `@` annotations in `COMMENT ON`, which survive into the catalog. Annotations stay small; anything bigger needs a new ADR.

## Consequences

- Every Postgres feature can be written from day one, including views, functions and triggers.
- Diffing, safe apply plans and type inference must understand the full catalog.
- Databases that are not SQL (DynamoDB) need their own source format later.
