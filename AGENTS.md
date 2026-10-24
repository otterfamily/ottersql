# AGENTS.md

Rules for anyone changing ottersql, human or AI. Read `docs/adr` first; it holds the decisions that are not up for re-debate without a new ADR.

## Principles

- Write code you would be proud to see in a well-known OSS project. Review it with that eye before handing it over: no bolted-on fixes, no second way to do the same thing, no duplication, no names that hide intent, no files with an unclear home.
- Do not act on guesses. Check the code, logs or primary sources (official docs, specs, source code) first, and write "unverified" next to anything you could not check.
- Types say only what the database guarantees. Never add a type the database cannot enforce.
- Keep one way to do each thing. Prefer the simpler design over compatibility layers.
- Design by the principles in ADR 0007. Before designing a module, say in its issue which of them the design relies on and why.
- Refactor as you go. When a change shows a better structure, reshape the code to it instead of working around the old one; before 1.0 there are no users to stay compatible with.
- Choose tools and patterns by current best practice: primary sources and what well-maintained TypeScript projects do today, not habit or what another project used.
- Fix security bugs first, in small changes.

## Where things go

Each kind of information has one home.

- Code says how (through names and structure). Comments say only why not (why another way was not chosen); no comments that restate the code, history or TODOs.
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
- `pnpm typecheck`: type-check every package.
- `pnpm test`: run every package's tests against PGlite and a Postgres container.
- `pnpm verify`: everything CI checks. Run it before every push.

## Dependencies and tools

- pnpm and Node.js versions are pinned in `devEngines` in `package.json`. Add dependencies with `pnpm add` (latest unless there is a reason), never by editing `package.json` by hand. Use `pnpm dlx`, not `npx`.
- Keep dependency versions in the `catalog:` of `pnpm-workspace.yaml`. Read the release notes of every major upgrade.
- Do not suppress lint, format or type errors (ignore comments, baselines) without the maintainer's approval and a stated reason.

## Changes

- Commits follow Conventional Commits. The first line summarises; the body says why, briefly. Do not list what changed; the diff shows that.
- Pull requests are squash-merged, and the squash commit takes the pull request's title and body. Write them as that commit: a Conventional Commits title and a body that says why.
- For now changes go straight to `main`. Every push must pass CI. Never rewrite pushed history.
- This repository is public. Never commit secrets, `.env` files, keys, personal data, or paths and names from other private projects.
- Code, commit messages, the README, ADRs and other docs in this repository are in English. GitHub issues, milestones and the roadmap project are in Japanese, the maintainer's working language.
