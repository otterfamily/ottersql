# 0002. Types say only what the database guarantees

- Status: Accepted
- Date: 2026-10-24

## Context

Some ORMs let TypeScript promise more than the database enforces. Drizzle's `text({ enum })` types a column as a union while the database accepts any string. Agents and people trust types, so a type the database does not back is a bug waiting to happen.

## Decision

- Every type ottersql produces is derived from what Postgres enforces: column types, `NOT NULL`, `CHECK`, `ENUM`, domains, keys and the result description Postgres gives for a query.
- Allowed values are written in the database (`ENUM` or `CHECK (... IN (...))`) and become TypeScript unions from there.
- Where the database cannot vouch for a shape (for example the contents of `jsonb`), the type is `unknown`. A value gets a narrower type only after runtime validation, through any [Standard Schema](https://standardschema.dev) library the user chooses (Zod, Valibot, ArkType and others).
- When nullability cannot be proven (outer joins, expressions, view columns), the type includes `null`.

## Consequences

- Some types are wider than users expect until ottersql can prove more, so nullability inference must keep improving.
- The rule decides future features: anything that would type data the database does not guarantee is rejected.
