---
name: release-cli
description: ytstats releases — bump version, stamp CHANGELOG.md, commit and tag the ytstats npm package. Use when releasing ytstats, cutting a version, or recording unreleased changes. Not for plain commits, pushing, or npm publish.
argument-hint: "[patch|minor|major|unreleased|auto] [note]"
allowed-tools: Bash, Read, Write, Edit, Grep, AskUserQuestion
---

# Release ytstats

Cut a release of the `ytstats` npm CLI package — bump the version, stamp the changelog, commit, and tag.

**Scope boundary.** This skill stops after the annotated tag. It never runs `git push` and never runs `npm publish`. Those stay manual by design.

## Arguments

| Argument | Position | Values |
|---|---|---|
| `$action` | 0 | `patch`, `minor`, `major`, `unreleased`, `auto` (default when omitted) |
| `$note` | 1 | Free-text description of what is shipping |

`$note` is **additive** to git analysis, never a replacement. It must appear in the changelog entries and must factor into the bump decision — if the note describes a breaking change, that raises the bump.

## Project facts

Verify these at runtime rather than trusting them blindly, but they are the expected shape:

| Fact | Value |
|---|---|
| Version file | `package.json` → `version` |
| Changelog | `CHANGELOG.md` in the project root, Keep a Changelog 1.1.0 |
| Repo layout | Standalone — the git root **is** the project root |
| Tag format | `v<version>`, annotated |
| Commit message | `chore(release): ytstats v<version>` |
| Test command | `npm test` (vitest, 316 tests as of v0.1.0) |

There are no tags in this repo yet. `v0.1.0` shipped per the changelog but was never tagged — treat the first run as having **no baseline tag** and diff across all history.

## Step 1 — Detect the mode

| Mode | Condition | Behavior |
|---|---|---|
| **C — ledger** | `$action` is `unreleased` | Record changes into `## [Unreleased]` only. No version bump, no tag. |
| **A — hot** | This session contains substantial ytstats work | Use session context **and** git. Highest changelog quality. |
| **B — cold** | Thin session, or work was elsewhere | Reconstruct from git, then ask the user what the commits do not capture. |

Mode A versus B is a judgment call about *this conversation*. If you edited ytstats source, debugged it, or discussed its behavior in this session, you are in Mode A — say so, and use what you know.

## Step 2 — Pre-flight gates

Run the bundled script from the project root:

```bash
bash "${CLAUDE_SKILL_DIR}/scripts/preflight.sh" <mode>
```

Pass `full` for Modes A/B, or `ledger` for Mode C. It reports each gate and exits non-zero on the first hard failure.

**Modes A and B — three hard gates. Do NOT offer a "proceed anyway" option.**

1. **Clean working directory.** A release commits only `package.json` and `CHANGELOG.md`. With uncommitted code present, the tag would point at a commit that does not contain the changes it claims to ship — a silent, high-blast-radius bug.
2. **`npm test` passes.** All tests must be green. This mirrors the `prepublishOnly` guard so a release can never be cut on a red suite.
3. **`## [Unreleased]` is non-empty.** Refuse to stamp an empty version. If it is empty, that is the signal to run Mode C first or to pass a `$note`.

On failure, print the script's output verbatim, explain which gate failed, and stop.

**Mode C relaxes gate 1 only** — uncommitted work is expected mid-session. Still verify `CHANGELOG.md` itself has no conflicting unstaged edits, and recommend committing the feature code first, since a ledger entry for uncommitted code is misleading.

## Step 3 — Analyze the changes

Source-of-truth priority, highest first:

1. **Session context** (Mode A only) — knows intent and trade-offs, not just the diff
2. **`$note`** — always respected
3. **Existing `[Unreleased]` notes** — from a prior Mode C run
4. **Git log** — `git log <last-tag>..HEAD` or all history when no tag exists
5. **Git diff** — read the actual changes when commit messages are unclear

Find the baseline: read `package.json` for the current version, then look for a `v<version>` tag. If the two disagree, trust `package.json` — tags may be missing, as they are today. With no tags at all, diff against the initial commit.

Squash related commits into one bullet per **logical change**, not per commit. Ignore merge commits unless the message carries real context.

In **Mode B**, before classifying, pause and ask: *"I don't have session context for ytstats. Here's what I found in git — is there anything the commits don't capture, like intent or trade-offs?"*

**If nothing meaningful changed**, say so plainly and ask whether to cut a patch anyway or skip, via AskUserQuestion. Do not manufacture a release.

## Step 4 — Classify and determine the bump

Classify into Keep a Changelog categories. Full category table and writing rules: [references/changelog-format.md](references/changelog-format.md).

Standard bump rules:

| Condition | Bump |
|---|---|
| Breaking change | major |
| New feature or capability | minor |
| Fixes, perf, refactors, dependency bumps, docs | patch |
| Nothing meaningful | no release |

**Then run the ytstats breaking-change scan.** This project documents its own major-bump triggers, and they are not obvious from a generic diff read — a removed diagnostic `code` looks like a one-line deletion but is a public-API break. Read [references/breaking-changes.md](references/breaking-changes.md) and apply it.

When the scan finds a candidate breaking change, **warn and ask** — present what you found and let the user confirm the bump level. Do not silently force major.

**Override handling.** If `$action` names a bump *lower* than the changes warrant, warn and ask for confirmation — never silently downgrade. If it names a *higher* bump, proceed without comment; the user may have reasons.

## Step 4b — Check the agent skill is in sync

The `ytstats` agent skill (`.agents/skills/ytstats/`, published as `nicolasdao/ytstats`) pilots the CLI on a user's behalf. It is a **second consumer of the same contracts** as `docs/` — commands, flags, diagnostic codes, `data` shapes, env vars — and nothing detects drift between them. `doc-manifest.json`'s `--affects` map covers `README.md` and `docs/**` only, so a release can update every doc correctly and still ship a skill describing behaviour that no longer exists. That is worse than a stale doc, because an agent *acts* on it.

Run the coverage check:

```bash
bash "/Users/nicolasdao/Documents/projects/cloudless/tools/ytstats/.claude/skills/release-cli/scripts/skill-sync-check.sh"
```

It reports any command, diagnostic code, or environment variable the CLI has and the skill never mentions. It always exits 0 — this **warns, it never blocks**, because only the user knows whether a given change is observable to a caller or purely internal.

Coverage is the mechanical half. The judgement half is yours, and the check prints the reminder: read the release diff for **behaviour** changes that keep the same identifiers.

| Change in this release | Skill file |
|---|---|
| A command, flag, or default | `references/commands.md`, and the routing table in `SKILL.md` |
| A diagnostic code, or its `recoverable` / `retryable` | `references/troubleshooting.md` |
| The shape of any command's `data` | the shapes table in `SKILL.md` |
| A value whose correct reading is non-obvious | `references/interpreting-results.md` |
| Any behaviour a user on an older CLI would see differently | `systemDependencies.ytstats.version` in `skill.json` |

**The version floor is the case most often missed.** A pure bug fix that merely restores already-documented behaviour teaches the skill nothing — but it still moves the floor, because the skill's guidance only becomes true at that version. v0.2.1 is the worked example: `reach` returned silently empty CTR on 0.2.0, so a skill declaring `>=0.2.0` would confidently tell a user they had no impressions data when they had plenty.

When the check warns, or the diff shows a behaviour change, tell the user in Step 5 what the skill needs and that it must be republished separately — the skill has its own version and lifecycle. Do **not** block the release on it, and never edit the skill yourself here; that is `happyskills-design`'s job.

## Step 5 — Confirm before writing

Use AskUserQuestion. Present:

- **Current version → new version**, and the bump type with its reason
- **The full changelog entry** that will be written, verbatim
- **What will change** — `package.json`, `CHANGELOG.md`, the commit message, the tag name
- **What will not** — no push, no publish

Offer: proceed · change the bump type · edit the changelog first · abort.

Nothing is written before this confirmation.

## Step 6 — Execute the release

In order:

1. **Stamp the changelog.** Move everything under `## [Unreleased]` into a new `## [<version>] - <YYYY-MM-DD>` section, leaving `## [Unreleased]` present but empty. Update the link references at the bottom of the file — see [references/changelog-format.md](references/changelog-format.md).
2. **Bump the version** in `package.json`. Edit the `version` field only; leave formatting and key order untouched.
3. **Stage exactly two files.**
   ```bash
   git add package.json CHANGELOG.md
   ```
   Never `git add -A`. The release commit carries release metadata and nothing else.
4. **Commit.**
   ```bash
   git commit -m "chore(release): ytstats v<version>"
   ```
5. **Tag, annotated.**
   ```bash
   git tag -a v<version> -m "Release v<version>"
   ```

Then **stop**. Report what was done and state the two things deliberately left to the user.

## Step 7 — Hand off

Report:

- The new version and the tag created
- The changelog entry as written
- That nothing was pushed and nothing was published

Then remind them of the manual next steps, which this skill does not perform:

```bash
git push && git push --tags   # once a remote is configured
npm publish                   # prepublishOnly re-runs the test suite
```

Note if `git remote -v` is still empty — the push will fail until a remote exists.

## Mode C — the unreleased ledger

`$action` is `unreleased`. Record **your own** changes so the next real release sweeps them up.

1. Identify your own changes — session context, `$note`, and your commits since the last release. In a shared repo, do **not** inventory other agents' work; each agent records its own.
2. Create-or-amend `## [Unreleased]`:
   - If the section is missing, create it below the header and above the newest version entry.
   - Ensure the right `### <Category>` subsection exists, then **append** your bullets.
   - **Amend, never replace.** Leave other agents' bullets intact. Skip anything already recorded.
3. Do **not** bump the version, write a date, or create a tag.
4. Stage **only** `CHANGELOG.md`.
5. Commit: `docs(changelog): record unreleased ytstats change(s) — <short summary>`
6. Do **not** push — this matches the project's release posture.
7. Report which bullets landed under which categories.

Why this exists: when several sessions work the same branch, whoever cuts the release otherwise has to reconstruct everyone's scope from `git log`, which is how changes ship unrecorded. Each session recording its own work makes the release a promotion of the ledger rather than an archaeology exercise.

When a later full release finds `[Unreleased]` notes, treat them as the primary description of what ships — but still cross-check git for anything added after the last ledger run. The ledger is a head start, not a contract.

## Constraints

- **NEVER** run `git push` or `npm publish`. Out of scope by explicit design decision.
- **NEVER** offer a "proceed anyway" option on the Mode A/B pre-flight gates.
- **NEVER** stage anything beyond `package.json` and `CHANGELOG.md` (Mode C — `CHANGELOG.md` alone).
- **NEVER** use `git add -A` or `git add .`.
- **NEVER** write any file before the Step 5 confirmation.
- **NEVER** silently downgrade a bump below what the changes warrant.
- **NEVER** force a major bump from the breaking-change scan without asking — warn and confirm.
- **ALWAYS** create an annotated tag (`-a`), never a lightweight one.
- **ALWAYS** squash related commits into one bullet per logical change.
- If `CHANGELOG.md` is missing, create it with the Keep a Changelog header before adding entries.
- If this is the first release with no prior version, start at `0.1.0`.
