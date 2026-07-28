# happyskills-sync — CLI Reference

Detailed CLI syntax and JSON response shapes for `status`, `pull`, and `diff`. SKILL.md has the routing decision tree — this file has exact flag semantics and response shape per command.

## Envelopes

Every `--json` response is the canonical six-key envelope `{ ok, data, error, next_step, warnings, meta }`:

- `ok` — `true` on success, `false` on failure.
- `data` — **always an object** (never null, never a bare array; a top-level array payload is wrapped as `data.results`).
- `error` — `{}` on success, else `{ code, message, details? }`. The exit/HTTP status is in **`meta.exit_code`**, never inside `error`.
- `next_step` — `{}` when none, else a closed-enum `{ kind, action, instructions, context }`; dispatch on `next_step.action`.
- `warnings` — array of non-fatal advisories; surface them to the user.
- `meta` — includes `command`, `cli_version`, `exit_code`, `envelope_schema_version`.

The per-command examples below show only the `data` payload — assume the six-key wrapper around each.

Error codes: `INTERNAL_ERROR` (1), `USAGE_ERROR` (2), `AUTH_REQUIRED` (3), `NETWORK_ERROR` (4), `INTERACTIVE_REQUIRED` (1), `DIVERGED` (handled per Section 5 of SKILL.md).

---

## status

**Usage:**

```bash
npx happyskills status --json
npx happyskills status owner/name --json
npx happyskills status -g --json
```

**Flags:**

| Flag | Description |
|---|---|
| (positional) | Optional: limit to a single skill (`owner/name`). Without it, all installed skills are checked. |
| `-g`, `--global` | Check globally installed skills |

**Status values:** `clean`, `modified`, `ahead`, `outdated`, `diverged`, `conflicts`, `drift`, `not_found`. (Spec 260523-02 § 10.5 — `ahead` and `drift` were split out from the previous conflated `drift.version_mismatch` reason.)

**JSON shape:**

```json
{
  "data": {
    "results": [
      {
        "skill": "owner/name",
        "base_version": "1.0.0",
        "base_commit": "abc123",
        "local_modified": true,
        "remote_updated": true,
        "remote_version": "1.1.0",
        "remote_commit": "def456",
        "conflict_files": [],
        "drift": { "reason": "regression|missing_skill_json|missing_dir", "lock_version": "1.0.0", "disk_version": "0.9.0" },
        "ahead": { "lock_version": "1.0.0", "disk_version": "1.1.0", "has_changelog_entry": true, "changelog_version": "1.1.0" },
        "status": "clean|modified|ahead|outdated|diverged|conflicts|drift|not_found"
      }
    ]
  }
}
```

- `local_modified`: `true` if local files differ from base integrity hash
- `remote_updated`: `true` if remote head commit differs from `base_commit`
- `conflict_files`: array of file paths with unresolved conflict markers (from a prior pull)
- `drift`: present only when `status === "drift"` (genuine inconsistency). Routes to `reconcile`.
- `ahead`: present only when `status === "ahead"` (author bumped locally, not yet published). Routes to `happyskills-publish`.
- `status`: outranking order — `drift` > `conflicts` > `ahead` > (`diverged` | `modified` | `outdated`) > `clean`.

---

## pull

**Usage:**

```bash
npx happyskills pull owner/name --rebase --json                # LLM-preferred — snapshot-backed, per-patch rejection envelope
npx happyskills pull owner/name --json                          # 3-way merge (default)
npx happyskills pull owner/name --theirs --json
npx happyskills pull owner/name --ours --json
npx happyskills pull owner/name --theirs SKILL.md,skill.json --ours references/foo.md --json
npx happyskills pull owner/name --force --json
npx happyskills pull owner/name -g --json
npx happyskills pull owner/name --json --full-report
npx happyskills pull owner/name --strict --json
```

**Flags:**

| Flag | Description |
|---|---|
| `--rebase` | Capture local edits as patches, fast-forward to remote head, reapply patches. Snapshot-backed. On rejection, emits `next_step.action: resolve_patch_rejections` with per-file expected/actual context. Preferred for LLM-driven flows over the 3-way merge default. |
| `--theirs [files]` | Take remote version on conflicts. No value = all files. Comma-separated list = only those files. |
| `--ours [files]` | Keep local version on conflicts. Same syntax as `--theirs`. |
| `--force` | Discard ALL local changes, fast-forward to remote (DESTRUCTIVE — confirm via AskUserQuestion first) |
| `-g`, `--global` | Pull globally installed skill |
| `--strict` | Fail on incompatible dependency ranges instead of warning |
| `--full-report` | Include inline file content and resolution steps in JSON output (requires `--json`). Designed for AI agent semantic review. |

**JSON shape — `--rebase` success (clean reapply):**

```json
{
  "data": {
    "operation": "pull_rebase",
    "status": "rebased",
    "skill": "owner/name",
    "fast_forward_to": "abc123...",
    "patches_applied": [{ "path": "SKILL.md", "type": "modified" }],
    "patches_rejected": [],
    "version": "1.1.0"
  },
  "next_step": null,
  "error": null
}
```

**JSON shape — `--rebase` with rejections (operator must resolve):**

```json
{
  "data": {
    "operation": "pull_rebase",
    "skill": "owner/name",
    "fast_forward_to": "abc123...",
    "patches_applied": [...],
    "patches_rejected": [
      {
        "file": "SKILL.md",
        "patch_type": "modified",
        "reason": "context_changed",
        "expected_context_before": "...",
        "actual_context_before": "...",
        "patch": "<unified diff>",
        "intended_change_summary": "..."
      }
    ],
    "snapshot_id": "snap_..."
  },
  "next_step": {
    "action": "resolve_patch_rejections",
    "context": {
      "rejection_count": 1,
      "options": ["resolve_and_continue", "abandon_and_restore"],
      "instructions": "Either resolve each rejection by re-applying corrected patches, or abandon with `npx happyskills snapshot restore <snapshot_id>`."
    },
    "snapshot_id": "snap_..."
  },
  "error": null
}
```

**Pull outcomes:** `up_to_date`, `fast_forward`, `merged`, `conflicts`.

**JSON shape — up to date:**

```json
{ "data": { "status": "up_to_date", "skill": "owner/name" } }
```

**JSON shape — fast forward:**

```json
{ "data": { "status": "fast_forward", "skill": "owner/name", "version": "1.1.0" } }
```

**JSON shape — merged or conflicts:**

```json
{
  "data": {
    "status": "merged|conflicts",
    "report": {
      "files": [{ "path": "SKILL.md", "classification": "both_modified", "conflict_written": false, "merge_result": {} }],
      "summary": { "auto_merged": 2, "conflicts": 0 }
    },
    "conflict_files": ["SKILL.md"],
    "json_conflicts": [{ "field": "description", "suggestion": "..." }],
    "resolution_steps": []
  }
}
```

- `status`: `merged` = all files auto-merged cleanly, `conflicts` = some files have conflict markers
- `report.files[].classification`: file change type (e.g., `both_modified`, `remote_only_modified`, `local_only_added`)
- `report.files[].conflict_written`: boolean — `true` if conflict markers were written to this file
- `report.files[].merge_result`: object with merge details. Shape depends on file type:
  - Text files: `{ type: "text", conflict_count: N, conflict_regions: [...] }`
  - skill.json: `{ type: "json", conflicts: [...] }` (field-level suggestions)
  - CHANGELOG.md: `{ type: "changelog", has_conflicts: bool, used_fallback: bool }`
- `conflict_files`: array of file paths that have unresolved conflict markers (empty if status is `merged`)
- `json_conflicts`: array of skill.json field-level merge suggestions (review, not errors)
- `resolution_steps`: only present with `--full-report`. Array of action-typed steps: `resolve_conflict_markers`, `review_json_suggestions`, `semantic_review`, `verify`

**Full report mode** (`--json --full-report`): each file entry in `report.files` is enriched with `base_content`, `local_content`, `remote_content`, `merged_content` (inline text) so the LLM can reason about the merge without extra file reads.

---

## diff

**Usage:**

```bash
npx happyskills diff owner/name --json                  # local vs base (default)
npx happyskills diff owner/name --remote --json          # base vs remote
npx happyskills diff owner/name --full --json            # three-way comparison
npx happyskills diff owner/name --no-content --json      # file list only
npx happyskills diff owner/name -g --json                # global skill
```

**Flags:**

| Flag | Mode | Shows |
|---|---|---|
| (default) | local | What you changed since install (local vs base) |
| `--remote` | remote | What changed on the registry (base vs remote) |
| `--full` | full | Three-way comparison (local + remote vs base) |
| `--no-content` | (any) | Show only the file list without unified content diffs |
| `-g`, `--global` | (any) | Diff a globally installed skill |

**File classifications:** `M (local)` modified locally, `M (remote)` modified on remote, `M (both)` modified on both sides, `A (local/remote)` added, `D (local/remote)` deleted.

**JSON shape:**

```json
{
  "data": {
    "mode": "local|remote|full",
    "report": {
      "files": [{ "path": "SKILL.md", "classification": "local_only_modified", "base_sha": "...", "local_sha": "...", "remote_sha": null, "diff": "--- base/SKILL.md\n+++ local/SKILL.md\n@@ -10,3 +10,3 @@..." }],
      "summary": { "total": 12, "clean": 11, "auto_merged": 1, "conflicted": 0 }
    }
  }
}
```

- `mode`: `local` (default, local vs base), `remote` (base vs remote), `full` (three-way)
- `report.files`: array of file entries with path, classification, SHAs, and unified diff
- `diff`: unified diff text for the changed file (present on all changed files except `both_modified`)
- `local_diff` + `remote_diff`: for `both_modified` files, separate diffs showing base→local and base→remote changes
- Use `--no-content` to omit the `diff`/`local_diff`/`remote_diff` fields (file list only)

---

## reconcile

Diagnose and repair GENUINE drift deterministically. Drift is now narrowed to `regression` (disk < lock), `missing_skill_json`, and `missing_dir`. **`reconcile` no-ops on the `ahead` state** (disk > lock is not drift — route to `happyskills-publish`).

**Usage:**

```bash
# Diagnose only — returns next_step with options
npx happyskills reconcile owner/name --json

# Apply a specific option directly
npx happyskills reconcile owner/name --apply restore_from_lock_version --json
```

**Flags:**

| Flag | Description |
|---|---|
| `(positional)` | Skill to inspect. Bare short name resolves from lock. |
| `--apply <action>` | Execute the action directly. Allowed actions are listed in the diagnostic response's `next_step.context.options`. |
| `-g`, `--global` | Reconcile a globally-installed skill |

**JSON shape — clean / ahead (no work to do):**

```json
{
  "data": { "skill": "owner/name", "no_drift": true, "status": "ahead", "ahead": { "lock_version": "1.0.0", "disk_version": "1.1.0", "has_changelog_entry": true, "changelog_version": "1.1.0" } },
  "next_step": null,
  "hint": "ahead is a valid precondition for publish, not drift — use `release` or `publish` to advance the lock"
}
```

**JSON shape — genuine drift, options envelope:**

```json
{
  "data": { "skill": "owner/name", "drift_state": "regression", "lock_version": "1.0.0", "disk_version": "0.9.0" },
  "next_step": {
    "action": "resolve_regression",
    "context": {
      "skill": "owner/name",
      "drift": { "reason": "regression", "lock_version": "1.0.0", "disk_version": "0.9.0" },
      "options": ["restore_from_lock_version", "accept_disk_as_explicit_downgrade", "investigate_with_diff"],
      "hint": "Choose: restore_from_lock_version (Edit skill.json back to lock), accept_disk_as_explicit_downgrade (publish disk version as a downgrade), or investigate_with_diff (run happyskills diff first)."
    }
  }
}
```

**JSON shape — `--apply restore_from_lock_version` success:**

```json
{
  "data": {
    "skill": "owner/name",
    "drift_state": "regression",
    "applied": { "applied": "restore_from_lock_version", "new_disk_version": "1.0.0" },
    "lock_version": "1.0.0",
    "disk_version": "1.0.0"
  },
  "next_step": null
}
```

Per-subtype `next_step.action` values:
- `resolve_regression` — options: `restore_from_lock_version`, `accept_disk_as_explicit_downgrade`, `investigate_with_diff`
- `resolve_missing_skill_json` — options: `restore_from_registry_at_lock_version`, `restore_from_git`, `abandon`
- `resolve_missing_dir` — options: `reinstall_at_lock_version`, `abandon`

`reconcile` NEVER calls `install --fresh` internally — the old silent-fallback path is gone (spec 260523-02 § 2.3 / § 8.5).

---

## snapshot (owned by `happyskills` core)

Snapshot create/restore/list/delete/prune is owned by core (see core's cli-reference). Sync's `pull --rebase` snapshots internally before reapplying patches; the `snapshot_id` is exposed in the response envelope so the operator can restore manually on patch rejection.

---

## Error Recovery

| Error Code | Recovery |
|---|---|
| `INTERACTIVE_REQUIRED` | Trigger auth flow (Section 9 of SKILL.md) |
| `AUTH_REQUIRED` | Trigger auth flow, then retry the original command |
| `USAGE_ERROR` | Show correct command syntax. Common: missing `owner/name` format. |
| `NETWORK_ERROR` | Tell user: "Cannot reach the HappySkills API. Check your internet connection." |
| `INTERNAL_ERROR` | Show the error message verbatim and suggest possible fixes based on context. |
| `DIVERGED` | Remote has advanced. Run `pull` to merge, resolve any conflicts, then retry. See Section 5 of SKILL.md. |

If a sync command fails with `AUTH_REQUIRED` (exit code 3), automatically trigger the auth flow from Section 9 of SKILL.md and retry once.
