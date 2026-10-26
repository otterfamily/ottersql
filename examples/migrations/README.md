# Migrations

Migrations generated from `db/schema.sql` and applied to Postgres in Docker, including the failures production migrations run into.

- `db/schema.sql` describes the database as it should be.
- `db/migrations/` holds the migrations ottersql generated, one per change of `schema.sql`. Each step's SQL follows a `-- ottersql:step` line that says when it runs (`expand` before the app deploys, `contract` after), which lock it takes, whether it runs in a transaction, and whether it can be undone.

## Run the scenario

Docker must be running.

```sh
pnpm db:up      # Postgres 18 on localhost:54329
pnpm scenario   # applies the migrations one at a time
pnpm db:down
```

The scenario:

1. Creates the tables and adds users, one without an email and two sharing one.
2. Requires an email. Validating existing rows fails on the user without one; after the row is fixed, applying again resumes at the step that failed.
3. Makes emails unique. The concurrent index build fails on the duplicate and leaves an invalid index; after the duplicate is removed, applying again drops it and builds it anew.
4. Adds a column while a long transaction reads the table. The migration waits for its lock at most 300 ms at a time, so queries behind it are not held up, and retries until the transaction ends.
5. Adds an enum value. A step that cannot be undone runs only with an approval, so applying stops first and lists the step; applying again with the approval it gave runs exactly those pending steps.
6. Refuses a migration edited after it was applied, and a new migration older than ones already applied.
7. Checks that the migrations build exactly what `db/schema.sql` describes, by replaying them in PGlite.

## Try a change

The `ottersql` command does the same with your own changes. It reads the database to migrate from `DATABASE_URL`:

```sh
export DATABASE_URL=postgres://ottersql:ottersql@localhost:54329/example
```

1. Edit `db/schema.sql`, for example add `bio text` to `users`.
2. `pnpm generate add_bio` writes the next migration to `db/migrations/`.
3. `pnpm apply --phase expand` and `pnpm apply --phase contract` apply the steps before and after a deploy; `pnpm apply` applies both.
4. `pnpm test` checks that the migrations build `db/schema.sql`, as CI would; this repository's CI runs it too.

Add `--json` to any of them to see what an agent reads. A step that cannot be undone, such as dropping a column, stops `apply` with exit code 3 and an approval to pass back with `--approve`; an AI agent cannot pass it, so it has to ask you.

A change that would rewrite a table under an exclusive lock, such as changing a column's type, is not planned: `generate` says why and how to do it by hand.
