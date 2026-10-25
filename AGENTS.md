# AGENTS.md

Rules for anyone changing ottersql, human or AI. Read `docs/adr` first; it holds the decisions that are not up for re-debate without a new ADR.

## Principles

- Write code you would be proud to see in a well-known OSS project. Review it with that eye before handing it over: no bolted-on fixes, no second way to do the same thing, no duplication, no names that hide intent, no files with an unclear home.
- Do not act on guesses. Check the code, logs or primary sources (official docs, specs, source code) first, and write "unverified" next to anything you could not check.
- Types say only what the database guarantees. Never add a type the database cannot enforce.
- Keep one way to do each thing. Prefer the simpler design over compatibility layers.
- Design by the principles in ADR 0007. Before designing a module, say in its issue which of them the design relies on and why.
- Performance is a feature (see the README goals). Choose algorithms and queries for their cost at realistic sizes, measure before and after a change that could affect speed or load, and record the numbers in the commit or issue. Keep the cost of tests and tools in mind too.
- Don't repeat yourself: one piece of knowledge lives in one place, in code as in docs.
- Refactor as you go. When a change shows a better structure, reshape the code to it instead of working around the old one; before 1.0 there are no users to stay compatible with.
- Choose tools and patterns by current best practice: primary sources and what well-maintained TypeScript projects do today, not habit or what another project used.
- Fix security bugs first, in small changes.

## Where things go

Each kind of information has one home.

- Code says how (through names and structure). A doc comment on an exported declaration states what its types cannot: invariants, units, error cases. Every other comment says only why not (why another way was not chosen); no comments that restate the code, history or TODOs.
- Tests say what is guaranteed (in their names).
- Commit messages say why.
- GitHub issues hold designs, open questions and units of work. A spec is a parent issue; its work items are sub-issues.
- Docs hold only rules and procedures that are still in force. Only major decisions, the pillars that shape the whole project, go in `docs/adr` with their reasons (never rewritten; a changed decision gets a new ADR that supersedes the old one). Detailed design is decided in issues and closed there.
- Research notes go in the private `otterfamily/ottersql-research` repository, not here. Records that cite it must summarise what they rely on, since outside readers cannot open it.

## Tests

- The specification lives in tests. Write a failing test before adding or changing behaviour. When behaviour is removed, delete its test or turn it into a test that the behaviour is rejected.
- Test observable behaviour: public functions, CLI output, what ends up in the database, boundaries, errors and the bug a fix addresses. Use table-driven tests for combinations.
- Do not test implementation details, what libraries or types already guarantee, or unread snapshots.
- Fake only external boundaries (network, time, randomness). Use a real Postgres (PGlite or a container) rather than mocks.
- Tests must be deterministic. Fix or delete flaky tests; never hide them with retries.
- Coverage is not a goal. Check that the changed branches are exercised.

## Commands

Install pnpm 11 or later; it fetches the pinned pnpm and Node.js versions from `devEngines` in `package.json`. The tests start a Postgres container, so Docker must be running.

- `pnpm install`: install dependencies.
- `pnpm format`: format every file.
- `pnpm lint`: lint with type information.
- `pnpm knip`: find unused files, exports and dependencies.
- `pnpm typecheck`: type-check every package.
- `pnpm build`: compile the published packages to `dist`, as npm gets them. Development and tests run the TypeScript sources; `publishConfig` points the published `exports`, `imports` and `bin` at `dist`.
- `pnpm test`: run every package's tests against PGlite and a Postgres container, and the published packages installed from their tarballs.
- `pnpm verify`: everything CI checks. `pnpm install` sets up a git pre-push hook that runs it, because changes go straight to `main`.

## Dependencies and tools

- pnpm and Node.js versions are pinned in `devEngines` in `package.json`. Add dependencies with `pnpm add` (latest unless there is a reason), never by editing `package.json` by hand. Use `pnpm dlx`, not `npx`.
- Keep dependency versions in the `catalog:` of `pnpm-workspace.yaml`. Read the release notes of every major upgrade.
- Lint, format and type checks are as strict as the tools allow; the code is mostly written by agents. A rule is turned off in the config only with a comment saying why, and only when it contradicts another rule or a deliberate convention.
- Do not suppress lint, format or type errors (ignore comments, baselines) without the maintainer's approval and a stated reason.

## Changes

- Commits follow Conventional Commits. The first line summarises; the body says why, briefly. Do not list what changed; the diff shows that.
- Pull requests are squash-merged, and the squash commit takes the pull request's title and body. Write them as that commit: a Conventional Commits title and a body that says why.
- For now changes go straight to `main`. Every push must pass CI. Never rewrite pushed history.
- This repository is public. Never commit secrets, `.env` files, keys, personal data, or paths and names from other private projects.
- Code, commit messages, the README, ADRs and other docs in this repository are in English. GitHub issues, milestones and the roadmap project are in Japanese, the maintainer's working language.

## Releases

- Every package under `packages/` that is not private is published, all at one version, so users never have to work out which versions go together.
- Before 1.0, a release that breaks users moves the minor version (0.1.x to 0.2.0), since `^0.1.0` takes patches only; every other release is a patch. Hold breaking changes back and release them together. The release notes come from the commits, so a breaking change says so with `!` or a `BREAKING CHANGE:` footer.
- `pnpm release <patch|minor|major>` commits the new version on `main` and tags it; `git push --follow-tags` sends both, and `.github/workflows/release.yml` publishes to npm and writes the GitHub release. Publishing a release needs the maintainer's go-ahead.
- Only that workflow publishes, through npm trusted publishing: no npm tokens exist, and npm records where each version was built (provenance).
