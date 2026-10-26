# ottersql

The ottersql command: generates, checks and applies migrations, with JSON output for agents.

Part of [ottersql](https://github.com/otterfamily/ottersql), a TypeScript toolkit for Postgres. The repository's README says what it is, what it needs and how far along it is.

The command connects with node-postgres to `DATABASE_URL`. For a connection it cannot make that way, such as one that signs in with a short-lived token, call the library from your own script with a connection you make: `applyMigrations(connection, …)` from `@ottersql/migrate` takes any driver's connection.
