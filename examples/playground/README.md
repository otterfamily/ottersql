# Playground

Typed SQL through the TypeScript 7.1 content mapper, to try in an editor.

- `schema.sql` describes the database; `queries.sql` holds queries; `app.ts` runs them with the types ottersql derives.
- `mistakes/` holds code that is wrong on purpose, to show how errors are reported. CI checks everything else (`tsconfig.ci.json`).

## Open it in VS Code

1. Run `pnpm install` at the repository root.
2. Install the "TypeScript (Native Preview)" extension.
3. Open this folder (`examples/playground`) in VS Code and trust the workspace; content mappers only run in trusted workspaces.
4. `.vscode/settings.json` points the extension at this project's TypeScript 7.1.

## Run it

`pnpm start` runs `app.ts` on an in-process Postgres (PGlite). `--import ottersql/register` lets Node import `.sql` files.
