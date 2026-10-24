# 0007. Design principles

- Status: Accepted
- Date: 2026-10-24

## Context

ottersql is a set of packages that other code builds on (ADR 0006), written largely with coding agents. Without named principles each design gets argued from scratch, and agents fall back to habits such as an interface for every class or validation scattered across call sites. The principles below were chosen for what ottersql does: read a database catalog, turn it into types and plans, and talk to drivers its users choose.

## Decision

Every design names which of these it relies on, in the issue where it is decided.

- **Deep modules** (John Ousterhout, _A Philosophy of Software Design_). A package or module offers a small interface over a lot of behaviour. Example: the catalog layer is used through one function that turns `schema.sql` into a catalog, and is tested through that same function.
- **Functional core, imperative shell** ([Gary Bernhardt](https://www.destroyallsoftware.com/screencasts/catalog/functional-core-imperative-shell)). Diffing, plan classification, type rendering and nullability inference are pure functions over catalog data. Reading a database, applying a plan and file or process I/O stay in a thin shell around them.
- **Make illegal states unrepresentable** ([Yaron Minsky](https://blog.janestreet.com/effective-ml-revisited/)) and **parse, don't validate** ([Alexis King](https://lexi-lambda.github.io/blog/2019/11/05/parse-don-t-validate/)). Models use discriminated unions so that contradictory states cannot be built, and outside input (catalog rows, `.sql` files, CLI arguments) is parsed into those types once, where it enters.
- **Ports and adapters only at real seams** ([Alistair Cockburn](https://alistair.cockburn.us/hexagonal-architecture/)). A port is an interface with at least two adapters, such as the database driver (`pg`, PGlite, `Bun.sql`) or host capabilities (Postgres, Aurora DSQL). Code with a single implementation calls it directly.
- **SOLID where it fits a function-first TypeScript codebase.** Each module has one reason to change; ports stay small enough that an adapter implements all of them; every adapter passes the same contract tests, so they can replace one another. There are no class hierarchies or inheritance for reuse.
- **Every observable behaviour is a promise** ([Hyrum's law](https://www.hyrumslaw.com/)). Exports, error shapes and CLI JSON are kept to what users need, because anything public will be depended on.

## Consequences

- Design comments in issues start from these principles, and a design that needs a principle not listed here proposes a new ADR.
- Most logic can be tested as data in and data out; the shell is tested against real Postgres.
- Some code is more direct than a pattern catalogue would suggest; that is intended.
