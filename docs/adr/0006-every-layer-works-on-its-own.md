# 0006. Every layer works on its own

- Status: Accepted
- Date: 2026-10-24

## Context

ottersql should drop into any project, including ones that already have an ORM, a migration tool or a hosting choice. All-in-one tools force a project to adopt everything or nothing: Prisma's types, client and migrations come as one unit, and Drizzle's types come from its own schema definitions.

## Decision

ottersql is a set of layers, each usable without the ones above it:

1. **Catalog**: reads a schema into the catalog model.
2. **Typed SQL**: the content mapper and runtime loading for `.sql` query files.
3. **Relational API**: typed reads and writes derived from the schema.
4. **Migrations**: diff, plans, safe apply, `generate` and `push`.
5. **CLI**: the agent-first front end to all of the above.

- A layer depends only on layers below it, and each ships as its own package.
- A project can use typed SQL alone next to another ORM or migration tool. `schema.sql` can then come from `pg_dump --schema-only` or the other tool's output, so ADR 0001 still holds.
- Database access goes through a small driver interface, so the user keeps their own driver and connection setup.

## Consequences

- Package boundaries follow the layers from the first commit, and tests check each layer without the ones above it.
- Adoption guides start from the smallest layer that helps, usually typed SQL.
