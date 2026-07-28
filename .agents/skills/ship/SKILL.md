---
name: ship
description: ytstats shipping — chain update-doc, commit the entire working tree, then release-cli. Use when shipping end to end. Not for a plain commit (git-commit) or a bump alone (release-cli).
argument-hint: "[patch|minor|major|unreleased|auto] [note]"
disable-model-invocation: true
allowed-tools: Bash, Read, Skill
---

# Ship

Run the full release chain for this project, in one pass:

```
update-doc  →  git-commit (entire working tree)  →  release-cli
```

**User arguments:** `$ARGUMENTS`

## Why this order

The order is load-bearing, not cosmetic. `release-cli` refuses to run unless the working tree is clean, because a release commits only `package.json` and `CHANGELOG.md` — any uncommitted code would produce a tag whose commit does not contain the changes it ships.

So documentation must be written *before* the commit, and everything must be committed *before* the release. Reordering the chain breaks the third step.

## Scope boundary

This chain stops after the annotated tag, because `release-cli` does. It never runs `git push` and never runs `npm publish`. Those stay manual by design — see `docs/contributing.md`.

## Step 1 — Update documentation

Invoke the `update-doc` skill via the Skill tool, forwarding any note the user supplied as context for what changed.

If it reports no documentation changes were warranted, that is a valid outcome. Continue to Step 2.

## Step 2 — Commit the entire working tree

Invoke the `git-commit` skill via the Skill tool. `git-commit` is **session-aware by default** — it commits only files touched in the current session. That default is wrong for this chain, so override it through the freeform guidance its Step 0 accepts.

Pass guidance to this effect:

> Commit the ENTIRE working tree, not only files changed during this session. Stage every modification, addition, deletion, and untracked file — including changes that predate this session — then commit them. Do not filter by session provenance. Stage them by listing every path explicitly on the `git add` command line; do not use `git add -A` or `git add .`.

**Say how to stage, not only what to stage.** "Everything in the tree" invites `git add -A`, which both `git-commit` and this project's `CLAUDE.md` forbid outright — `CLAUDE.md` because untracked tooling under `.agents/skills/` must not be swept in unreviewed. Naming every path explicitly reaches the same 100% coverage while keeping that protection, so the guidance must carry the mechanism or the conflict resurfaces on every run.

Before invoking it, show the user what is about to be swept up, so the breadth of the commit is visible rather than implied:

```bash
git status --short
```

This is a display, not a gate — report it and continue.

## Step 3 — Verify the tree is clean

`release-cli`'s first gate is a clean working directory. Confirm it directly rather than assuming Step 2 succeeded:

```bash
git status --porcelain
```

Empty output means proceed. Any remaining output means the commit did not capture everything — **halt** and report exactly what is still uncommitted. Do not invoke `release-cli` against a dirty tree; it will refuse, and a halt here is the clearer message.

## Step 4 — Cut the release

Invoke the `release-cli` skill via the Skill tool, forwarding the user's arguments verbatim.

- `/ship minor "Added --json-lines"` → forward `minor "Added --json-lines"`
- `/ship` with no arguments → forward nothing; `release-cli` analyzes the changes and proposes a bump

Do not pause for confirmation before this step. `release-cli` runs its own three gates (clean tree, `npm test` passes, non-empty `## [Unreleased]`) and prompts on its own when it detects a breaking change.

## Halting

Stop the chain and report plainly whenever:

- `update-doc` or `git-commit` fails.
- The tree is still dirty after Step 2.
- `release-cli` refuses at one of its gates.

A halt is a normal outcome, not an error to work around. Report which step stopped, what it said, and what remains uncommitted or unreleased. Never retry a gate by loosening it — the gates exist because a tag that does not contain its own changes is worse than no tag.

If `## [Unreleased]` is empty, `release-cli` will refuse to stamp a version. That usually means the work was already released, or that `/ship unreleased` is the command actually wanted — it records changes into the ledger without bumping or tagging.

## Constraints

- **NEVER** reorder the three steps. Step 3 depends on Step 2 having completed.
- **NEVER** instruct `git-commit` to use `git add -A` or `git add .` — forbidden by both that skill and `CLAUDE.md`. Achieve full coverage by naming every path instead.
- **NEVER** run `git push` or `npm publish`, and never offer to as part of this chain.
- **NEVER** substitute your own commit for the `git-commit` skill — it owns the conventional-commit message format that the changelog depends on.
- **ALWAYS** verify the tree with `git status --porcelain` between the commit and the release.
- **ALWAYS** forward the user's arguments to `release-cli` unchanged.

## Requirements

Requires the `update-doc` and `git-commit` skills (declared in `skill.json`), plus a **local `release-cli` skill** for this project. `release-cli` is generated per-project by `create-release-skill` and is not published, so it cannot be declared as a dependency — if it is missing, run `/create-release-skill` before using this chain.
