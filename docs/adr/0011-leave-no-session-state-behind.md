# 0011. Leave no session state behind

- Status: Accepted
- Date: 2026-10-26

## Context

Applications share database connections. A pool in the application (`pg.Pool`, postgres.js) hands the connection one request used to the next, and a pooler between the application and the database (RDS Proxy, PgBouncer, the poolers of Supabase and Neon) hands it to other clients at each transaction's end. State a statement leaves on a connection, such as a `SET` parameter, a session advisory lock, a temporary table or a `LISTEN`, either leaks into whoever gets the connection next or forces the pooler to keep the connection for one client.

RDS Proxy does the latter on PostgreSQL. AWS's "Avoiding pinning an RDS Proxy" lists `SET` commands, session advisory locks, temporary objects, cursors, `LISTEN` and statements over 16 KB as pinning a client connection to one database connection for the rest of its session; transaction-level advisory locks do not. Since November 2023 the extended query protocol no longer pins. PgBouncer's transaction mode cannot carry session state at all.

ottersql's runtime used `SET TRANSACTION` for isolation levels until fa48bf7 moved them into `BEGIN`.

## Decision

- What ottersql runs on a `Connection` or a `Transaction` (typed queries, transactions, savepoints, type lookups) leaves no state on the connection once the transaction or statement ends. Transaction modes go into `BEGIN`, settings are local to the transaction (`set_config(…, true)`), and locks are transaction-level.
- Work that needs one session for longer, such as a migration run's advisory lock or a step that runs outside a transaction, takes a connection of its own for that time (issue #59) and resets it before handing it back. It connects directly, not through a pooler.
- Tests record what ottersql sends and fail on statements that leave session state.

## Consequences

- ottersql works behind any pooler without pinning connections, and users can rely on that rather than on how each driver happens to behave.
- Some features take a longer route: a transaction mode is passed to each driver's begin instead of one `SET TRANSACTION`, and features built on session state (`LISTEN`, session locks, temporary tables) stay out of the runtime.
- Whether RDS Proxy pins on `set_config(…, true)` and on named prepared statements is not documented; it is checked against PgBouncer in CI and against RDS Proxy before a release claims it (issue #61).
