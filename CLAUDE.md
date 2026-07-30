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

## The agent skill must stay in sync with the CLI

**There are two things to keep current in this repo, not one.** `docs/` explains the CLI to a human. The `ytstats` agent skill (`.agents/skills/ytstats/`, published as `nicolasdao/ytstats`) *pilots* the CLI for an agent. Both encode the same contracts. Only `docs/` is covered by the `doc-manifest.json` / `--affects` map, so **tooling will never tell you the skill went stale** — you have to check it deliberately.

A stale doc misleads a reader who can see the code. A stale skill makes an agent take wrong actions and report confident wrong answers to a user who cannot.

### Run this before finishing any CLI change

```bash
bash .agents/skills/release-cli/scripts/skill-sync-check.sh
```

It lists every command, diagnostic code, and env var the CLI has that the skill never mentions. It warns and exits 0 — it never blocks. `release-cli` runs it at Step 4b, but do not wait for release: run it in the same pass as the code change.

### Does this change need a skill update?

Ask what a *caller* observes, not what the code does:

| Change | Skill |
|---|---|
| New or changed command, flag, or default | **Update** — `references/commands.md` + the routing table in `SKILL.md` |
| New diagnostic code, or `recoverable` / `retryable` changed | **Update** — `references/troubleshooting.md` |
| A command's `data` shape changed | **Update** — the shapes table in `SKILL.md` |
| A value whose correct reading is non-obvious | **Update** — `references/interpreting-results.md` |
| Internal refactor, no observable difference | **No update** — nothing new to learn |
| Bug fix that restores already-documented behaviour | **No content update, but raise the version floor** |

That last row is the one that gets missed. A pure bug fix teaches the skill nothing new, so it *looks* like the "no update" branch — but the skill's guidance was false for every version before the fix, and `systemDependencies.ytstats.version` in `skill.json` is the only machine-readable statement of which CLI its claims hold for. **Raise the floor whenever a release changes behaviour the skill depends on, then republish.**

The worked example: `reach` returned silently empty CTR on 0.2.0 — `ok: true`, no warning, every row null. A skill declaring `>=0.2.0` would confidently tell a user they had no impressions data when two months of it existed. The fix in 0.2.1 changed no documented behaviour, yet the skill still had to move to `>=0.2.1`.

### The skill has its own lifecycle

It versions and publishes separately from the CLI. Updating it means: edit the files, bump `skill.json`, add a matching `CHANGELOG.md` entry, `npx happyskills validate ytstats --json`, then publish via `happyskills-publish`. A CLI release does **not** ship it.

Full detail: [docs/contributing.md](docs/contributing.md#keeping-the-agent-skill-in-sync).

## Working norms

- **Tests must stay green and offline.** `npm test` runs 422 tests with no network access. Every effect is injected; keep it that way.
- **API fetchers assert exact query parameters**, not just return shapes. That is what pins the undocumented YouTube API limits (`MAX_VIDEO_ROWS` 200, `MAX_DETAIL_ROWS` 25).
- **Keep documentation in sync.** Docs carry `source` globs in frontmatter; `doc-manifest.json` is generated, never hand-edited. Regenerate it after any doc change.
- **No new runtime dependencies without good reason.** Currently `commander`, `googleapis`, `open` — all pure JS, so `npx ytstats` starts instantly.

## Releasing

Cut releases with the `release-cli` skill, or follow the manual steps in [docs/contributing.md](docs/contributing.md#release-process). Publishing to npm is always a deliberate manual `npm publish` — no automation pushes or publishes.
