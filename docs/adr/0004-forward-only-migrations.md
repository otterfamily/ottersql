# 0004. Forward-only migrations

- Status: Accepted
- Date: 2026-10-24

## Context

Down migrations give a false sense of safety: if an up migration fails halfway, its down often fails too, and a dropped column's data does not come back when the column is re-added. Prisma 8 and graphile-migrate are forward-only; GitLab and Google SRE practice is to keep the database compatible with every running version of the app and roll back only the app (research note 04). On Aurora PostgreSQL, restoring the database is slow and loses later writes.

## Decision

- ottersql has no down migrations. Undoing a change is a new migration toward the earlier schema.
- Every operation in a plan is classified: reversible, loses data when reversed, irreversible, or cannot run inside a transaction.
- Every operation is marked to run before the app deploys (expand) or after it (contract), so the app can always be rolled back on its own.
- Plans choose safe procedures by default, such as adding foreign keys as `NOT VALID` then `VALIDATE`, and building indexes `CONCURRENTLY`.
- A migration that fails halfway can be cleaned up and re-run.

## Consequences

- The safety promise moves from "you can run down" to "every deployed state can serve the previous app version".
- Plans need to know which operations Postgres runs outside transactions and which lock tables.
