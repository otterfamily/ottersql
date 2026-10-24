# 0003. Deliver types through TypeScript content mappers

- Status: Accepted
- Date: 2026-10-24

## Context

Generated type files drift when someone forgets to regenerate, and inferred types get heavy: Drizzle hits TS2589 at a few hundred columns and Kysely's type instantiations grew from 0.6M to 9.8M under TypeScript 7 ([research 03](https://github.com/otterfamily/ottersql-research/blob/main/03-dynamodb-ts7-ai-design.md), [05](https://github.com/otterfamily/ottersql-research/blob/main/05-types-and-mappers.md)). TypeScript 7.1 adds content mappers ([microsoft/typescript-go#4712](https://github.com/microsoft/typescript-go/pull/4712)): an external process turns non-TypeScript files into TypeScript for the checker and the editor.

A throwaway prototype (branch `prototype/content-mapper`) typed `.sql` files this way in `tsc` and VS Code. Query edits reached types in 1–2 ms, schema changes in about 20 ms after a 0.8 s cold start, with 209 type instantiations.

## Decision

- The primary way to deliver types is an ottersql content mapper for `.sql` files.
- Types are flat, named object types with no type-level computation.
- The same function that produces the mapper output can also write the types to a file, for TypeScript versions or tools without content mappers.

## Consequences

- Users need TypeScript 7.1 or later, `--runExternalCode` for `tsc`, and a trusted workspace in VS Code. 7.1 is in beta as of this ADR.
- The VS Code extension for TypeScript 7 bundles 7.0.2 today, so projects must point it at their own TypeScript.
- Runtime needs a separate loader or bundler plugin to import `.sql` files; it does not need a database.
