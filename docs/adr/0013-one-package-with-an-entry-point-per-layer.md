# 0013. One package with an entry point per layer

- Status: Accepted
- Date: 2026-10-26
- Supersedes: in ADR 0006, "each ships as its own package"

## Context

ADR 0006 split ottersql into layers and shipped each as a package: `@ottersql/sql`, `@ottersql/catalog`, `@ottersql/content-mapper`, `@ottersql/migrate` and the `ottersql` command. The catalog then had to depend on `@ottersql/sql` for the driver interface, a layer above it, and the packages had to publish internal APIs to one another (`@ottersql/sql/tooling`, catalog lookups only the content mapper uses).

Tools of this kind now keep layers inside and show users few packages (checked 2026-10-26): Hono is one package with 77 entry points and no dependencies, Vite is close to one package, Drizzle and Kysely are one package each with entry points per driver, and Vue and Vitest keep internal packages behind one that users install. Bundlers include only the entry points an application imports.

What a single package would carry is the cost: PGlite, which type checking and migration planning run, unpacks to 25.6 MB, and the command used `pg`, `jsonc-parser`, `std-env` and `vscode-jsonrpc`.

## Decision

- ottersql ships as one package, `ottersql`, with an entry point per piece: the runtime at `ottersql`, drivers at `ottersql/pg`, `ottersql/postgres-js` and so on, loaders at `ottersql/register`, `ottersql/vite`, `ottersql/esbuild` and `ottersql/webpack`, `ottersql/driver` for adapters and tools, and `ottersql/catalog`, `ottersql/content-mapper` and `ottersql/migrate`. The command is its `bin`.
- The package has no dependencies. Drivers, PGlite and pgvector are optional peer dependencies, installed by the projects that use them; what needs a missing one says which to install. Small helpers the command and the content mapper used (reading JSONC, detecting an agent, JSON-RPC framing) are written in ottersql, after those libraries.
- ADR 0006's layers stay as directories, `src/sql` (the runtime and the driver interface, which every layer uses), `src/catalog`, `src/content-mapper`, `src/migrate` and `src/cli`, and lint rules forbid importing a layer above. What one layer offers another is imported inside the package, not exported.

## Consequences

- Users install one package, at one version, and an application's production install holds nothing it does not run.
- Every layer still works on its own: a project can use typed SQL alone, next to another ORM, as ADR 0006 intends.
- Type checking needs `@electric-sql/pglite` installed as a dev dependency, and the command needs a driver.
- The packages published before, `@ottersql/sql` and the others, are deprecated in favour of `ottersql`.
