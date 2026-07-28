---
name: happyskills-sync
description: HappySkills — Sync installed skills with the registry. Use when edits diverge from remote, pulling updates, diffing local vs remote, or resolving merge conflicts. Not for first install, publish, or matching an unlinked local folder (use match).
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, AskUserQuestion
argument-hint: "[your sync request]"
---

# HappySkills Sync

You are the diagnostic conductor for merge-related scenarios — divergence detection, conflict resolution, and publish-after-merge workflows. You use `status`, `pull`, and `diff` to diagnose and resolve.

The user's request is: `$ARGUMENTS`

---

## Section 1 — Route the Request

| User Intent | Command / Section |
|---|---|
| "outdated", "out of date", "are my skills up to date", "what new versions are available", "what's new on the registry", "are my skills behind" | `check` (Section 1.5 — registry update query) |
| "status", "is my skill modified", "what's the state of my skill", "has my skill changed", "divergence state" | `status` (Section 2) |
| "pull", "pull changes", "merge remote changes", "sync my skill", "get remote changes", "update from remote" | `pull` (Section 3) |
| "take remote version for all conflicts" | `pull --theirs` (Section 3) |
| "keep my version for all conflicts" | `pull --ours` (Section 3) |
| "discard my changes and get remote" | `pull --force` (Section 3 — destructive, confirm first) |
| "diff", "what changed", "compare local and remote", "show differences", "show changes" | `diff` (Section 4) |
| "which of my local skills are on the catalog", "match this folder of skills", "do my local skills exist in HappySkills", "scan a folder against the registry" | **NOT sync** → route to `happyskills match` (owned by `happyskills-search`, Section 4.5) |
| "show all changes", "three-way diff" | `diff --full` (Section 4) |
| "why can't I publish", "publish rejected", "diverged", "publish failed" | Diagnostic Decision Tree (Section 5) |
| "merge conflict", "resolve conflicts", "I have conflicts", "conflict markers" | Conflict Resolution (Section 6) |
| "review the merge result", "AI merge review", "is the merge OK" | Post-Merge Coherence Review (Section 3.5 — mandatory after every merge) |

**Disambiguation rules:**

- **"Outdated" / "up to date" / "what's new" → registry update questions, NOT divergence questions.** Run `check` (Section 1.5), not `status`. Reasoning: the LLM-level routing can land "are my skills outdated?" in either core or sync because both touch the local-vs-remote axis. Sync's `status` command does report `outdated` as a possible value, but it's a more specific divergence sub-state. The canonical answer to "what updates are available?" is `check` — run it directly even though `check` is core-flavored. If the user actually wants divergence detail, they'll say "modified", "diverged", or "conflicts" — those route to `status`.
- "Diff" alone → `diff` (sync). Not the same as comparing two skill versions in the registry.
- "Pull" alone → `pull` (sync), even if the user means "I want to update" — clarify if they mean refreshing installed skills (route them to core's `update`) vs merging remote changes (sync's `pull`).
- "Sync" alone → ambiguous. If the user says "sync acme/X", they likely mean pull. If they say "sync my skills", they likely mean update — route them to core ("say 'update my skills' and core will refresh").
- **Linked vs unlinked is the line between sync and `match`.** Sync only operates on skills that already have a remote identity — an entry in `skills-lock.json`. "Diff local vs remote" here means an **installed** skill against *its* remote baseline. If the user instead has a **folder of unlinked skills** (never installed/published, no lock entry) and wants to know which already exist in the catalog and how they differ, that is reverse-discovery — route to `happyskills match` (`happyskills-search`, Section 4.5), not `diff`/`status`.

For the full set of merge scenario playbooks, read [references/merge-workflows.md](references/merge-workflows.md). For exact CLI syntax and JSON response shapes, read [references/cli-reference.md](references/cli-reference.md).

---

## Section 1.5 — Registry Update Check (Cross-Skill Command)

For "are my skills outdated / behind / up to date":

```bash
npx happyskills check --json
```

`check` is core's canonical command for "what updates are available on the registry." Sync routes here because the question can land in either skill depending on phrasing, and the framework treats `check` as the single canonical answer for it.

**Output shape:**
- `data.results[]` — each entry: `{ skill, installed, latest, status, via }`
- `status` value: `up-to-date` | `outdated` | `ahead` | `conflicts` | `drift` | `no-access` | `unknown` | `error`
- `via` — the parent skill if the entry is a transitive dependency; null for top-level installs
- `drift` — present and non-null when `status === 'drift'`: `{ reason, lock_version, disk_version }` (`reason` is `regression` — disk semver-LESS than lock —, `missing_skill_json`, or `missing_dir`). Note: the disk-version-GREATER-than-lock case is NOT drift; it is reported at the top level as `status === 'ahead'` with an `ahead` object.
- `ahead` — present and non-null when `status === 'ahead'`: `{ lock_version, disk_version, has_changelog_entry, changelog_version }`. The author has bumped locally but hasn't published yet. Normal state, not an error — route to `happyskills-publish` for shipping.
- Aggregates: `data.outdated_count`, `data.up_to_date_count`, `data.conflicts_count`, `data.drift_count`

**Presenting check results to the user.** Lead with the headline — "All your skills are up to date" / "N skill(s) have updates available" / "N skill(s) need attention" — before showing the detail. Don't open with the raw status values or JSON aggregates. Per-skill plain-English meanings:

| Status | Plain-English meaning (per skill) |
|---|---|
| `up-to-date` | This skill is at the latest published version. |
| `outdated` | A newer version is available on the registry. |
| `ahead` | The author bumped `skill.json` locally but hasn't published yet — normal authoring state, not an error. Route to `happyskills-publish` to ship it. |
| `conflicts` | This skill has unresolved merge conflicts — resolve them before updating. |
| `no-access` | You don't have access to this skill on the registry (likely a private/workspace skill). |
| `unknown` | The registry has no information about this skill (it may have been deleted or never published). |
| `error` | The registry check failed for this skill. |
| `drift` | Genuine inconsistency in the local install record — `regression` (disk version below lock), `missing_skill_json`, or `missing_dir`. Route to repair (Section 2.5) before doing anything else. |

After the headline, present supporting detail as a table: Skill | Installed | Latest | Status. Show the `via` column when transitive deps appear.

**If the user then wants to act on outdated skills**, the right next step depends on whether they have local modifications — run `status` (Section 2) to find out, then route:
- `clean` → route to core's `update --all` ("say 'update my installed skills' and core will refresh them")
- `modified` / `diverged` → run `pull` (Section 3) to three-way-merge instead

---

## Section 2 — Status

Run first when diagnosing any sync issue:

```bash
npx happyskills status --json                           # all installed skills
npx happyskills status owner/name --json                # specific skill
npx happyskills status -g --json                        # global skills
```

**Presenting status to the user.** Always lead with the one-sentence plain-English meaning from the table below — use it verbatim or close to it as your opening sentence, then suggest the action. Do **not** open with the raw status value (`status: diverged`), JSON field names (`base_commit`, `remote_updated`), or SHAs. Translate the tool's vocabulary into the user's. Quote raw JSON values only if the user asks to see them.

**Status values:**

| Status | Plain-English meaning (use as your opening sentence to the user) | Action |
|---|---|---|
| `clean` | Your local copy of this skill matches the registry — nothing to reconcile. | Nothing to do. Safe to publish if version bumped. |
| `modified` | You have local edits to this skill; nothing new on the registry. | Safe to publish. |
| `ahead` | You've bumped `skill.json` locally but haven't published yet — the normal authoring-ahead state. | Route to `happyskills-publish` ("say 'release X'"). `release` recognizes the state and publishes the disk version directly. |
| `outdated` | Someone else published a newer version since you last installed this skill — your local files are behind the registry. | Run `pull` (fast-forward). Then publish if needed. |
| `diverged` | Someone else published since you last pulled, AND you have local edits — both sides need to be reconciled. | Run `pull` to merge. If conflicts → resolve. Then publish. |
| `conflicts` | A previous merge left unresolved conflict markers in some files; they need to be resolved before anything else. | Show which files have conflicts (`conflict_files` in status output). Guide user to resolve markers or use `pull --theirs`/`--ours`. |
| `not_found` | This skill isn't in the lock file yet — either a draft (scaffolded by `init`, not yet published) or an external skill (hand-rolled, foreign shape). | Disambiguate via `npx happyskills list --all-scopes --json` (CLI `1.13.0+`; prefer the `scope: "local"` entry — you sync the copy in this project): if it's under `data.drafts[]`, route to `happyskills-publish` ("say 'publish this skill'") — `release` claims the workspace atomically. If it's under `data.external[]`, route to `happyskills-publish` ("say 'convert this skill' to register it"). Never use "external" / "convert" wording for a draft. |
| `drift` | Genuine inconsistency in the local install record — `regression` (disk version semver-LESS than lock), `missing_skill_json`, or `missing_dir`. The baseline is broken. | Route to Section 2.5 (Drift Repair), which wraps `reconcile`. **Do NOT recommend `pull` — pull cannot fix this.** Pull is for remote-vs-local divergence; drift is local-vs-local. |

After the plain-English opener, present the supporting detail as a table: Skill | Status | Local Modified | Remote Updated. Show conflict files if status is `conflicts`. For drift, show lock_version and disk_version from the `drift` object. Summarize: "N clean, M modified, K diverged, J drifted".

---

## Section 2.5 — Drift Repair

When `status` reports `drift` for a skill, the lock file and the on-disk content are genuinely inconsistent. Drift narrows to three cases: **regression** (disk version semver-LESS than lock — suspicious downgrade), **missing_skill_json** (file gone), and **missing_dir** (directory gone). The previously-conflated `ahead` state (disk > lock) is NOT drift — that's normal authoring, handled directly by `happyskills-publish`.

### Step 1 — Run the `reconcile` primitive

```bash
npx happyskills reconcile <ws>/<skill> --json
```

`reconcile` is the deterministic CLI command for this job. It diagnoses the drift subtype and either fixes it on the spot (with `--apply`) or returns a structured `next_step` envelope listing the options for user adjudication. It NEVER calls `install --fresh` — the old data-loss path is gone.

### Step 2 — Read the response

- **`data.no_drift == true` AND `data.status == "ahead"`** → not drift. The skill is in the normal authoring-ahead state. Tell the user: *"Your `skill.json` is ahead of the lock — that's normal. Say 'publish X' and publish will recognize it and proceed."* Do NOT mutate anything.
- **`data.no_drift == true` AND `data.status == "clean"`** → nothing to repair. Surface "Skill is clean."
- **`next_step.action: resolve_regression`** → present `next_step.context.options` via AskUserQuestion. Common picks:
   - `restore_from_lock_version` → re-invoke `reconcile <skill> --apply restore_from_lock_version --json`. `reconcile` sets `skill.json`'s version field back to the lock version (no file content is destroyed; only the version field is reset).
   - `accept_disk_as_explicit_downgrade` → operator-driven path. Warn the user that publishing a downgrade is unusual; route to publish via `release`.
   - `investigate_with_diff` → run `npx happyskills diff <ws>/<skill> --json`, present, ask again.
- **`next_step.action: resolve_missing_skill_json`** → AskUserQuestion with `restore_from_git`, `restore_from_registry_at_lock_version`, or `abandon`. The registry-restore option is safe here because `lock_version` is guaranteed to exist on the registry (otherwise it wouldn't be in the lock). For preserving adjacent files during restore, snapshot first via `npx happyskills snapshot create <ws>/<skill>`.
- **`next_step.action: resolve_missing_dir`** → AskUserQuestion with `reinstall_at_lock_version` or `abandon`. The reinstall path is non-destructive (no `--fresh` needed; there's no local content to wipe).
- **Unrecognised `next_step.action`** (forward-compat: newer CLI, older skill) → surface `next_step.instructions` verbatim and **stop; do not improvise**.
- **`warnings[]` non-empty** → surface each entry to the user (non-fatal advisories), even on success.

### Step 3 — Verify

Re-run `npx happyskills reconcile <ws>/<skill> --json`. Confirm `data.no_drift == true`. If drift persists, the repair failed; restore from the most recent snapshot (`npx happyskills snapshot list <ws>/<skill> --json` to find it).

---

## Section 3 — Pull

Pull merges remote changes into local files. **For LLM-driven operations, prefer `--rebase`**: it captures local edits as patches, fast-forwards to the registry HEAD, and reapplies the patches — emitting a structured per-hunk rejection envelope on failure instead of writing conflict markers into files. The standard 3-way merge mode remains the human-driven default.

```bash
# LLM-preferred — snapshot-backed; structured rejection envelope on failure
npx happyskills pull owner/name --rebase --json --full-report

# Standard 3-way merge (writes conflict markers to files on overlap)
npx happyskills pull owner/name --json --full-report
```

**Always pass `--full-report`.** The merge report (inline `merged_content` per file plus `resolution_steps`) is produced *only* by the pull that performs the merge — it cannot be requested afterwards. You need it for the mandatory coherence review (Section 3.5), so request it on the pull itself, every time. It works in both `--rebase` and 3-way modes.

**Flags:**

| Flag | Behavior |
|---|---|
| `--rebase` | Capture local edits as patches, fast-forward, reapply. Snapshot-first. On rejection, returns `next_step.action: resolve_patch_rejections` with per-hunk context. |
| (none) | Auto-merge (3-way). Conflicts get `<<<<<<< LOCAL` / `>>>>>>> REMOTE` markers in files. |
| `--theirs [files]` | Take remote version for conflicts. No value = all files; comma-separated list = only those files. |
| `--ours [files]` | Keep local version for conflicts. Same syntax as `--theirs`. |
| `--theirs file1,file2 --ours file3` | Per-file strategy |
| `--force` | Discard ALL local changes, fast-forward to remote (DESTRUCTIVE — confirm via AskUserQuestion first) |
| `-g`, `--global` | Pull globally installed skill |
| `--strict` | Fail on incompatible dependency ranges instead of warning |
| `--full-report` | Include inline file content and resolution steps in JSON output (requires `--json`). For AI merge review. |

**Pull outcomes — present the plain-English meaning first, then the detail:**

| Status (JSON) | Plain-English meaning (use as your opening sentence) | Follow-up |
|---|---|---|
| `up_to_date` | Nothing to pull — you were already in sync with the registry. | No further action. |
| `fast_forward` | No local changes existed, so your files have been updated to the latest remote version. | Show files changed. |
| `merged` | Both sides had changes; they merged cleanly with no conflicts. The next publish will create a merge commit recording both parents. | Show files changed and note the upcoming merge commit. |
| `conflicts` | Some files couldn't be auto-merged — conflict markers have been written and need manual resolution before publishing. | List affected files and offer the three resolution options (Section 6). |

Do **not** open with the raw status value (`status: merged`) or the JSON field names (`merge_parents`, `conflict_files`). Translate first, then quote the detail only if the user asks.

---

## Section 3.5 — Mandatory Post-Merge Coherence Review

A mechanically clean merge is not necessarily a *coherent* one: diff3 interleaves line regions without reading meaning, so the merged text can be syntactically fine yet semantically broken. **Whenever a pull returns `status: merged` — or after you finish resolving conflicts and `status` returns to clean — you MUST run a coherence review before suggesting publish.** This is the operator's job: the CLI supplies the `--full-report` payload, you supply the judgment.

For each modified/added file in the report (the `semantic_review` step lists them), read `merged_content` and check:

- **(a) Internal coherence** — no half-sentences, no instructions stitched from both sides that now contradict each other, no duplicated or orphaned sections.
- **(b) Fidelity to purpose** — the merged text still serves the skill's stated purpose, judged against `skill.json`'s `description` and the SKILL.md frontmatter.
- **(c) Harness intactness** — frontmatter present and well-formed, no leftover `<<<<<<<` / `=======` / `>>>>>>>` marker lines, every referenced file still exists.

Then surface a verdict to the user **before** routing to publish — either *"the merge is coherent — safe to publish"* or *"these passages need attention: …"* naming the specific files/passages. You MAY run `npx happyskills validate <skill> --json` (read-only) to confirm structural integrity locally as part of this step.

Full procedure and the no-report fallback: [references/merge-workflows.md](references/merge-workflows.md) § Post-Merge Coherence Review.

---

## Section 4 — Diff

Show what's changed between local, base, and remote.

```bash
npx happyskills diff owner/name --json                   # local vs base (default)
npx happyskills diff owner/name --remote --json           # base vs remote
npx happyskills diff owner/name --full --json             # three-way comparison
npx happyskills diff owner/name --no-content --json       # file list only, no content diffs
npx happyskills diff owner/name -g --json                 # global skill
```

By default, diff produces unified content diffs for every changed file. The JSON response includes a `diff` field on each changed file entry. For `both_modified` files, `local_diff` and `remote_diff` are provided instead.

**Diff warns on drift, does not block.** If the target skill is drifted (lock-vs-disk disagreement), `diff` prints a one-line warning to stderr (`<skill> has drift: lock <X>, disk <Y>. Diff is shown against the lock-recorded base (<X>).`) and proceeds. JSON output in `local` and `full` modes includes a top-level `drift: { reason, lock_version, disk_version }` field (or `null` when clean). Drift is exactly the case where diff is most useful as a diagnostic, and `install --fresh` (the "obvious" remediation) would destroy the local state the user is trying to inspect — so the command surfaces the drift and lets the user see what they have. If the drift field is non-null in the JSON, narrate it ("the lock thinks you're at X but skill.json on disk says Y") and route to Section 2.5 (Drift Repair) for the user to decide; do not auto-route on diff alone.

**Diff hard-fails on registry-side content corruption.** Since `happyskills@0.45.0`, `diff` and `pull` verify two content-address properties at the API boundary: (1) the response must be pinned to the commit they asked for, and (2) every file's bytes must hash to the SHA the server advertises. On mismatch they exit with `INTERNAL_ERROR` (exit code 1) and the message names the requested vs returned commit (or the offending file). The two error shapes:

- `Clone commit mismatch for <skill>: requested commit <X> but the response is pinned to <Y>.`
- `Clone integrity check failed for <skill> file "<path>": server reported sha <S> but content hashes to <C>.`

This is **not** a local-state problem. It is a transient registry/CDN issue — usually a stale CloudFront cache entry serving wrong content for a commit lookup. **Do not** suggest `install --fresh`, do not start a reconciliation workflow, and do not assume the user's lock or files are broken. Recommended response:

1. Retry the command once — if a cache slot was just refilled, it may now be healthy.
2. If it persists, surface plainly: *"The registry returned inconsistent content for `<skill>` — likely a stale CDN cache entry. Try again in a few minutes; if it keeps happening, report it to the maintainers."*
3. Do NOT proceed with any sync/merge/publish action against this skill until the registry returns trustworthy content.

**Modes:**

| Flag | Mode | Shows |
|---|---|---|
| (default) | local | What you changed since install (local vs base) |
| `--remote` | remote | What changed on the registry (base vs remote) |
| `--full` | full | Three-way comparison (local + remote vs base) |
| `--no-content` | (any) | Show only the file list without unified content diffs |

File classifications: `M (local)` modified locally, `M (remote)` modified on remote, `M (both)` modified on both sides, `A (local/remote)` added, `D (local/remote)` deleted.

In presentation, show the file table first, then the line-by-line diffs below. For `--full` mode, group by: local-only changes, remote-only changes, both-side changes.

---

## Section 5 — Diagnostic Decision Tree

When the user asks "why can't I publish" or reports "publish rejected" / "diverged":

1. Run `npx happyskills status <skill> --json`.
2. Read the `status` field and act:

| Status | Diagnosis | Action |
|---|---|---|
| `diverged` | Remote changed since your last pull | "The remote has new changes since your last pull. I'll run pull to merge." Then run pull (Section 3). |
| `conflicts` | Unresolved markers from a previous pull | "You have unresolved conflict markers from a previous pull. Let's resolve them." Go to Section 6. |
| `outdated` | Remote advanced, no local changes | "The remote has advanced. I'll pull to get the latest." Then run pull (fast-forward). |
| `modified` or `clean` | Sync is fine | "Sync is healthy — the issue isn't divergence. Try `validate` (via `happyskills-publish` — say 'validate my skill') or check that you're logged in (via core — say 'who am I')." |
| `ahead` | Author bumped locally; not yet published | "Your `skill.json` is ahead of the lock — that's normal authoring, not divergence. Say 'release X' and publish will recognize it and proceed." Do NOT block. |
| `drift` | Genuine baseline inconsistency (regression / missing files) | "Your install record is inconsistent — the lock file and on-disk content disagree about what's installed." Route to Section 2.5 (Drift Repair), which wraps `reconcile`. Do NOT recommend pull — it cannot fix drift. |

**If `status`, `diff`, or `pull` itself errors with `Clone commit mismatch` or `Clone integrity check failed`** (added in `happyskills@0.45.0`), the registry is returning content whose SHA doesn't match what was asked for. This is registry-side, not local-state. Do not run `--fresh`, do not propose reconciliation, and do not treat the user's working tree as suspect. Retry once; if it persists, surface as a transient registry/CDN issue (see Section 4 for the verbatim phrasing).

If the user says "publish failed" without naming a skill, ask them which skill they tried to publish.

---

## Section 6 — Conflict Resolution

When status is `conflicts` or pull returns `conflicts`:

1. Show the user which files have conflicts (from `conflict_files` array).
2. Use AskUserQuestion to offer three options:
   - **"Resolve manually"** — Guide the user to read each conflict file, see the `<<<<<<< LOCAL` / `=======` / `>>>>>>> REMOTE` markers, and decide what to keep. Once resolved, they remove all three markers.
   - **"Take all remote (--theirs)"** — Run `npx happyskills pull <skill> --theirs --json`.
   - **"Keep all my changes (--ours)"** — Run `npx happyskills pull <skill> --ours --json`.
3. After resolution, re-run `npx happyskills status <skill> --json` to verify status is no longer `conflicts`.
4. Then run the mandatory Post-Merge Coherence Review (Section 3.5) before routing to publish. A `--theirs`/`--ours` re-pull resolves markers locally and does not emit a merge report, so use the disk + `diff --remote` fallback described there.

**skill.json field-level suggestions:** The `json_conflicts` array contains advisory suggestions from the structured JSON merge — these are NOT conflict markers (skill.json is always valid JSON after merge). Present them to the user for review; they may want to adjust the merged values.

**Important:** Publishing is BLOCKED when conflict markers are present — even with `--force` (the `--force` flag bypasses divergence check, not conflict validation). Resolve before publishing.

For full conflict-marker formats, per-scenario playbooks, and TOCTOU handling, read [references/merge-workflows.md](references/merge-workflows.md).

---

## Section 7 — The Full Report Payload (input to the coherence review)

The `--full-report` payload is produced by the pull in Section 3 — it is the input the mandatory coherence review (Section 3.5) consumes, not something you run separately afterwards. A report **cannot be requested after the fact**: only the pull that performs the merge emits one. That is why Section 3 always pulls with `--full-report`.

What the payload carries, per file in `report.files`:

- Inline content: `base_content`, `local_content`, `remote_content`, `merged_content`.
- `resolution_steps` — an array of action-typed steps:
  - `resolve_conflict_markers` — files with markers needing manual resolution
  - `review_json_suggestions` — auto-applied JSON field defaults to verify
  - `semantic_review` — modified/added files to check for cross-file logical contradictions
  - `verify` — run `happyskills status` to confirm resolution

**Fallback — an earlier pull already ran without `--full-report`.** You cannot recover the report by re-pulling: the merge is already done, so a bare re-pull reports `up_to_date` (or, if markers remain, the pending conflict state) — never a report. Instead, review the merged files on disk directly: read each modified/added file, and run `npx happyskills diff <skill> --remote --json` to see what the registry side contributed. Then apply the same (a)/(b)/(c) checks from Section 3.5. **Never instruct a bare re-pull to obtain a report.**

---

## Section 8 — Publish Failure Recovery (TOCTOU)

Rare but possible: someone publishes between your pull and your publish.

If `publish` returns DIVERGED after you already pulled:

1. Run `npx happyskills pull <skill> --json` again.
2. If new conflicts → Section 6.
3. After resolution → tell the user: "Someone published while you were preparing — pulled the latest changes. Please re-run publish." Then route them to `happyskills-publish` ("say 'publish my skill' again").

---

## Section 9 — Authentication

`status`, `pull`, and `diff` do not require authentication for public skills. They DO require auth for private skills.

If the command returns `AUTH_REQUIRED` (exit code 3), run the auth flow:

```bash
npx happyskills login --json --browser
```

Use a Bash timeout of 360000ms (6 minutes). The CLI auto-opens the browser. Single command handles both checking and authenticating:
- Already logged in → returns `{"data": {"status": "already_logged_in", ...}}` and proceeds.
- Not logged in → opens browser, returns `{"data": {"status": "logged_in", ...}}` after approval.

If the browser flow fails (headless environment), tell the user to run `npx happyskills login --password` manually in a separate terminal, then re-check.

Then retry the original command.

---

## Section 10 — Constraints

- **ALWAYS** use `--json` on every command.
- **ALWAYS** run `status` first when diagnosing a sync issue (divergence, modification, conflicts, publish rejection). For *registry update* questions ("outdated", "up to date"), run `check` (Section 1.5) — not `status`.
- **NEVER** run `pull --force` without confirming via AskUserQuestion — it discards all local changes.
- **NEVER** run `npx happyskills login --password` — exposes credentials in the LLM context. Use the browser flow only.
- **NEVER** fabricate CLI flags or subcommands not documented in this skill or [references/cli-reference.md](references/cli-reference.md).
- **ALWAYS** run `npx happyskills` from the **project root** (the directory containing `.claude/`) — `status`, `pull`, and `diff` resolve paths from CWD and read the project lock file.
- **NEVER** suggest publishing when `conflict_files` are present — guide resolution first.
- **NEVER** recommend `pull` to fix a `drift` status — pull operates on remote-vs-base divergence, drift is local lock-vs-disk disagreement. Route drift to Section 2.5 (Drift Repair) instead.
- **NEVER** modify skill files directly during sync operations — let `pull` write conflict markers and let the user (or `--theirs`/`--ours`) resolve them.
- **NEVER** invoke `publish`, `bump`, `convert`, or `fork` yourself — those live in `happyskills-publish`; when the user needs them, route by stating the trigger phrase. The **one exception** is read-only `npx happyskills validate <skill> --json`, which you MAY run after a merge (or after conflict resolution) to confirm structural integrity locally before handing off to publish — it mutates nothing and closes the unvalidated pull→publish window. `validate` invoked for any other reason still routes to `happyskills-publish`.
- **PREFER** showing the user `diff` output before they decide on a pull strategy when the situation is ambiguous.
- **STOP if `diff` output contradicts ground truth.** If the diff reports a file as modified that you have strong reason to believe was not touched (e.g., the user just opened a fresh session, the file is in a `references/` subdirectory the user didn't mention editing, the session log shows no edits to that path), do **not** silently treat the diff as authoritative and propose reconciliation. Verify against an independent source first — the cleanest check is to install the same version into a temp directory (`mktemp -d && cd $TMPDIR && mkdir -p .claude && echo '{}' > .claude/settings.json && npx happyskills install <owner>/<skill>@<version> --json -y`) and run `diff -rq <temp>/.claude/skills/<skill> <project>/.claude/skills/<skill>`. If the byte-level comparison disagrees with what `happyskills diff` reports, the registry returned bad content — treat it as the registry-side error class in Section 4 (do not reconcile, surface as transient, recommend retry). Cache-shaped failures look exactly like local modifications until you eliminate the possibility of bad registry data. This is a real failure mode (see the May 2026 CloudFront cache-key incident that led to `0.45.0` integrity checks); when in doubt, verify before acting.
- **NEVER** recommend or invoke `npx happyskills install <skill>@<version> --fresh` as part of drift repair, or in any flow where `<version>` may not be present in the registry. The CLI silently falls back to the latest published version when `<version>` is missing and overwrites every file in the skill directory with the registry's content. There is no error in the JSON envelope — it reports success at the fallback version. Recovery requires manually reconstructing the lost edits. Use local reconciliation instead (`Edit` + `bump` for version drift; `git checkout` for missing files; non-destructive `install` without `--fresh` for missing-version restoration). The full safe recipes are in Section 2.5 above. This rule supersedes any older guidance that recommended `install --fresh` for drift cases.
- **ALWAYS** snapshot before any operation that mutates skill files in non-trivial ways. "Non-trivial mutation" includes: running `pull`, running `install --fresh` (when routed back to core), executing a drift repair recipe (§2.5 Case B–E), or any operation that wipes-and-reinstalls or rewrites multiple files. Single-field edits like a manual `Edit` of `skill.json`'s version field are themselves trivially reversible and don't require snapshotting. If git tracks the skill directory: run `git stash` or note the current HEAD. Otherwise: copy the skill directory to `/tmp/hs-snapshot-<skill>-<timestamp>/`. After successful operation, the snapshot can be discarded. If the operation fails OR produces an unwanted result, restore from snapshot before doing anything else. This invariant turns every non-trivial mutation into a safe-to-attempt operation; without it, a single bad command can destroy work that cannot be recovered.
