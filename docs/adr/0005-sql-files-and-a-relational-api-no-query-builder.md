# 0005. SQL files and a relational API, no query builder

- Status: Accepted
- Date: 2026-10-24

## Context

Query builders (Kysely, Drizzle's core API) make TypeScript compute result types, which is what makes them heavy, and they always trail Postgres features. Typed SQL (sqlc, PgTyped) covers all of Postgres but is awkward for everyday CRUD, nested results and filters that come and go. Relational APIs (Prisma, Drizzle's relational queries) are pleasant for those but cannot express aggregates, window functions or complex joins ([research 01](https://github.com/otterfamily/ottersql-research/blob/main/01-ts-orm-landscape.md), [08](https://github.com/otterfamily/ottersql-research/blob/main/08-active-record-in-ts.md)).

## Decision

There are exactly two ways to query, split by one rule: if a query touches one relation (a table, view, function or history table) and its relations, use the relational API; otherwise write a `.sql` file.

- **`.sql` query files.** Named queries with `:param` placeholders become typed functions through the content mapper. A `.sql` file sits next to the repository code that uses it.
- **Relational API**, derived from `schema.sql`: find by key, create, update, delete, load relations on request, and filters built as plain objects (`undefined` is a type error, not "no filter"). Views are read-only unless Postgres reports them updatable; materialized views add `refresh()`; set-returning functions are typed calls; tables annotated `@history` add `history()` and `asOf()`.
- There is no query builder.

## Consequences

- Neither way makes TypeScript compute types, so type checking stays fast.
- Search screens with many optional filters go through the relational API; the rest goes through SQL.
- The relational API is the part that can later map onto DynamoDB; `.sql` files will not.
