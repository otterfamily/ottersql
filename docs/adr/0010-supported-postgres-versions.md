# 0010. Supported Postgres versions

- Status: Accepted
- Date: 2026-10-24

## Context

Users run Postgres on Amazon Aurora and RDS, Neon, Supabase and their own servers, on different major versions. Majors differ in ways ottersql sees: catalog columns (NOT NULL constraints moved into `pg_constraint` in 18), the analyzed query tree ADR 0009 reads (`varnullingrels` exists only since 16), the functions and syntax that exist (`uuidv7()` in 18), and what some functions return (`json_array()` over no rows returns `[]` instead of NULL in 19).

ottersql type-checks without a database by running `schema.sql` in PGlite, which embeds one major: 18.6 in PGlite 0.5.11. Hosts that subset Postgres report a version they do not fully implement: Aurora DSQL is based on 16 but has no triggers or PL/pgSQL.

Aurora keeps a major in standard support at least until the community's end of life and usually a few months longer (14: community end of life 12 Nov 2026, Aurora 28 Feb 2027). RDS uses the same dates, and Neon supports the latest five majors.

## Decision

- ottersql supports every Postgres major that is both supported by the community and in Aurora PostgreSQL standard support. A major leaves when either ends. Today that is 15 to 18: 14's community support ends on 12 Nov 2026, before ottersql's first release.
- Queries are analyzed on the PGlite major only, so the ADR 0009 tree reader follows one major. A project declares the major its database runs. ottersql rejects syntax, functions and catalog features that major lacks, and functions whose results differ between majors are listed per major.
- Code that reads or changes a real database (catalog reading, migrations, the runtime) detects what the database supports from its catalog, not from its version number. A host that subsets Postgres is a capability profile, not a version.
- That code is tested against a container of each supported major; the analyzer is tested on PGlite. A major is added when Aurora releases it.

## Consequences

- Users on any supported major get types from one analyzer, and features their major lacks fail at type-check time instead of in production.
- The per-major list of syntax, functions and changed results must be kept from each major's release notes.
- Moving PGlite to a new major means updating the tree reader and its fixtures in one change.
- CI runs the database-facing tests once per supported major.
