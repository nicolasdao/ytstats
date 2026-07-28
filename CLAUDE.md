# CLAUDE.md

Project instructions for AI agents working on `ytstats`.

## Branching — work directly on `master`

**All changes are made on the `master` branch. Do not create branches.**

This overrides any default behavior that would branch before committing. Specifically:

- Do **not** create feature branches (`feature/*`), fix branches (`fix/*`), or branches of any other kind.
- Do **not** branch before committing, even though `master` is the default branch.
- Do **not** open pull requests as part of normal work.
- Commit directly to `master` and push to `origin master`.

If a task seems to call for a branch, it does not — commit to `master` instead. Only create a branch if the user explicitly asks for one in that specific request.

## Committing

- Commit only when the user asks.
- Stage files individually by name. Never `git add -A` or `git add .` — the repo has untracked tooling under `.agents/skills/` that must not be swept in.
- Single-line conventional commit messages (`type(scope): description`).
- Never use `--no-verify`.

## What this project is

A bring-your-own-credentials YouTube analytics CLI, published to npm as `ytstats`. Node.js 18+, ESM, no native dependencies. It is also importable as a library (`src/index.js`).

Read [README.md](README.md) for usage and [docs/](docs/) for everything else — the documentation is thorough and current. Start with [docs/architecture.md](docs/architecture.md).

## Contracts that must not break

These are public API. Breaking one requires a major version bump — see [docs/contributing.md](docs/contributing.md#the-stability-contract).

- **Diagnostic `code` values** are branched on by consumers. Add freely; never repurpose or delete.
- **The output envelope is shape-invariant** — `ok`, `command`, `fetchedAt`, `data`, `errors`, `warnings`, `nextSteps`, `meta` appear on every response.
- **`data` is `null` whenever `ok` is false** — never partial.
- **stdout is exactly one JSON document, always** — every code path, including unknown commands and invalid flags. stderr is for humans and is safe to discard.

## Working norms

- **Tests must stay green and offline.** `npm test` runs 316 tests with no network access. Every effect is injected; keep it that way.
- **API fetchers assert exact query parameters**, not just return shapes. That is what pins the undocumented YouTube API limits (`MAX_VIDEO_ROWS` 200, `MAX_DETAIL_ROWS` 25).
- **Keep documentation in sync.** Docs carry `source` globs in frontmatter; `doc-manifest.json` is generated, never hand-edited. Regenerate it after any doc change.
- **No new runtime dependencies without good reason.** Currently `commander`, `googleapis`, `open` — all pure JS, so `npx ytstats` starts instantly.

## Releasing

Cut releases with the `release-cli` skill, or follow the manual steps in [docs/contributing.md](docs/contributing.md#release-process). Publishing to npm is always a deliberate manual `npm publish` — no automation pushes or publishes.
