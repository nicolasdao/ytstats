# happyskills-publish — CLI Reference

Detailed CLI syntax and JSON response shapes for `bump`, `validate`, `publish`, `convert`, `fork`, `delete`, and `visibility`. SKILL.md has the routing and pre-flight checks — this file has exact flag semantics and response shapes per command.

## Envelopes

Every `--json` response is the canonical six-key envelope `{ ok, data, error, next_step, warnings, meta }`:

- `ok` — `true` on success, `false` on failure.
- `data` — **always an object** (never null, never a bare array; a top-level array payload is wrapped as `data.results`).
- `error` — `{}` on success, else `{ code, message, details? }`. The exit/HTTP status is in **`meta.exit_code`**, never inside `error`.
- `next_step` — `{}` when none, else a closed-enum `{ kind, action, instructions, context }`; dispatch on `next_step.action`.
- `warnings` — array of non-fatal advisories; surface them to the user.
- `meta` — includes `command`, `cli_version`, `exit_code`, `envelope_schema_version`.

The per-command examples below show only the `data` payload — assume the six-key wrapper around each.

Error codes: `INTERNAL_ERROR` (1), `USAGE_ERROR` (2), `AUTH_REQUIRED` (3), `NETWORK_ERROR` (4), `INTERACTIVE_REQUIRED` (1), `DIVERGED` (route to `happyskills-sync` to pull; the `release` primitive emits `next_step.action: pull_rebase_first` automatically), `NOT_FOUND` (1), `FORBIDDEN` (1), `CONFIRMATION_REQUIRED` (1), `VALIDATION_FAILED` (1 — release/publish; emits `next_step.action: fix_validation_errors`), `MISSING_CHANGELOG_ENTRY` (1 — release; emits `next_step.action: provide_changelog`), `MISSING_VERSION` (2 — release with `--no-bump` on clean state), `INVALID_BUMP` (2), `BUMP_DISAGREEMENT` (2), `WORKSPACE_UNRESOLVED` (2), `DRIFT_DETECTED` (1 — release; emits `next_step.action: reconcile_first`).

---

## release

The atomic ship pipeline. Wraps snapshot + validate + bump (when needed) + changelog verification + publish + lock update. On failure restores the snapshot and emits a structured `next_step` envelope. This is the canonical happy path — bare `publish` is the lower-level CLI command it wraps.

```bash
# Skill already bumped (ahead state) — release recognizes and publishes
npx happyskills release my-skill --workspace <slug> --json

# Apply a bump first
npx happyskills release my-skill --workspace <slug> --bump patch --json

# First publish — specify visibility (private is the default; workspace shares with the
# whole owning workspace; public lists it openly)
npx happyskills release my-skill --workspace <slug> --bump patch --visibility workspace --json

# Validate + plan only, no mutation
npx happyskills release my-skill --workspace <slug> --dry-run --json
```

**Flags:**

| Flag | Description |
|---|---|
| `<skill-name>` | Positional. The skill to release. |
| `--workspace <slug>` | Target workspace. |
| `--bump <type\|version>` | `patch` / `minor` / `major` / explicit semver. Omit if `skill.json` is already `ahead`. |
| `--no-bump` | Refuse to bump; require disk to be already ahead. |
| `--changelog-from <file>` | Read CHANGELOG entry from file and prepend to CHANGELOG.md. |
| `--visibility <value>` | Visibility on first publish only: `private` (default), `workspace` (every member of the owning workspace can find and install it — internal, not public), or `public` (listed for anyone). |
| `--public` | Shorthand for `--visibility public`. First-publish only. |
| `--dry-run` | Validate + plan, do not mutate. Snapshot is captured and then restored. |

**JSON shape — success:**

```json
{
  "data": {
    "published": true,
    "skill": "owner/name",
    "version": "1.0.1",
    "workspace": "acme",
    "commit": "abc123...",
    "ref": "refs/tags/v1.0.1",
    "ahead_recognized": true,
    "bump_applied": false,
    "warnings": [],
    "snapshot_id_preserved": false
  }
}
```

**JSON shape — failure with `next_step`:**

```json
{
  "error": { "code": "MISSING_CHANGELOG_ENTRY", "message": "..." },
  "next_step": {
    "action": "provide_changelog",
    "context": { "target_version": "1.0.1", "current_top_entry": "1.0.0" }
  }
}
```

Possible `next_step.action` values: `fix_validation_errors`, `specify_bump_type`, `provide_changelog`, `pull_rebase_first`, `specify_workspace`, `reconcile_first`, `resolve_bump_disagreement`.

---

## bump

```bash
npx happyskills bump patch my-skill --json                     # patch/minor/major
npx happyskills bump 2.0.0 my-skill --json                     # explicit version
```

`bump` modifies `skill.json`'s `version` field ONLY — the lock file is NOT touched. The skill enters the `ahead` state (reported by `list`/`status`/`check`) until the next publish, which catches the lock up atomically with registry acceptance. Spec 260523-02 § 8.6.

**Flags:**

| Flag | Description |
|---|---|
| `<bump-type>` | Positional. `patch`, `minor`, `major`, or an explicit semver string. |
| `<skill-name>` | Positional. The skill to bump. |
| `-g`, `--global` | Bump a globally installed skill |

**JSON shape:**

```json
{ "data": { "skill": "skill-name", "old_version": "1.0.0", "new_version": "1.1.0", "bump_type": "patch|minor|major|explicit" } }
```

---

## validate

```bash
npx happyskills validate my-skill --json
npx happyskills validate my-skill -g --json    # global skill
```

**JSON shape:**

```json
{
  "data": {
    "valid": true,
    "errors": [],
    "warnings": [],
    "checks_passed": 12,
    "checks_failed": 0,
    "checks_warned": 1
  }
}
```

If `data.valid` is `false`, present each error with file/field/message and follow Section 11 of SKILL.md (Validate Error Handling). Warnings are advisory.

Errors may include a `recommendations` array — follow those steps in order and exactly as written.

---

## publish

```bash
# ALWAYS include --workspace
npx happyskills publish my-skill --workspace <slug> --json

# Set visibility on first publish (private is the default; workspace shares with the
# whole owning workspace without going public; public lists it for anyone)
npx happyskills publish my-skill --workspace <slug> --visibility workspace --json

# Auto-bump before publishing
npx happyskills publish my-skill --workspace <slug> --bump patch --json
```

**Flags:**

| Flag | Description |
|---|---|
| `<skill-name>` | Positional. The skill to publish. |
| `--workspace <slug>` | **Required**. Workspace to publish into. |
| `--visibility <value>` | First-publish only. `private` (default), `workspace` (whole owning workspace, not public), or `public` (catalog-listed). Confirm before `public`; NEVER default to `public`. |
| `--public` | Shorthand for `--visibility public`. First-publish only. NEVER default. |
| `--bump <patch\|minor\|major>` | Auto-bump version before publishing. (Prefer `release` instead — it adds snapshot, validate, changelog verification, and structured failure envelopes around the same call.) |

**JSON shape:**

```json
{ "data": { "skill": "owner/name", "version": "1.0.0", "ref": "refs/tags/v1.0.0", "bumped_from": "0.9.0" } }
```

`bumped_from`: present if `--bump` was used; otherwise null.

**Pre-flight checks:** the `release` primitive (Section 3 of SKILL.md) wraps these atomically — snapshot, validate, ahead/clean/drift classification (drift routes via `reconcile_first`; ahead is recognized and published directly), changelog verification, workspace resolution, publish, snapshot cleanup. Bare `publish` is for explicit "just push what's already bumped" invocations.

**NEVER pipe `publish` (or any `--json` command that emits progress lines) through a strict JSON parser** — the CLI prints non-JSON status text to stdout before the JSON envelope. Strict parsers report a parse error, masking whether the underlying operation succeeded.

**If publish returns DIVERGED** (TOCTOU — someone published in your pull-to-publish window): route the user to `happyskills-sync` to pull and re-merge, then re-run publish.

---

## convert

```bash
# Authenticated — auto-resolves workspace and checks registry for conflicts
npx happyskills convert skill-name -y --json

# Not authenticated — must provide --workspace (registry check skipped)
npx happyskills convert skill-name --workspace myorg -y --json

# With version override
npx happyskills convert skill-name --workspace myorg --version 1.0.0 -y --json

# Convert a global skill
npx happyskills convert skill-name -g -y --json
```

**Two modes:**
- **Authenticated:** Resolves workspace automatically from user's workspaces. Checks registry for name conflicts before converting. Recommended before publishing.
- **Not authenticated:** Requires `--workspace <slug>`. Skips registry conflict check. The skill is converted locally — login before publishing.

**JSON shape:**

```json
{ "data": { "skill": "owner/name", "version": "1.0.0", "workspace": "workspace-slug", "description": "..." } }
```

After successful conversion, **always run Post-Convert Enrichment** ([workflows.md § Post-Convert Enrichment](workflows.md)).

---

## fork

```bash
npx happyskills fork owner/name --json

# Fork to a specific workspace
npx happyskills fork owner/name --workspace myorg --json
```

**Flags:**

| Flag | Description |
|---|---|
| `<owner/name>` | Positional. The published skill to fork. |
| `--workspace <slug>` | Optional. Defaults to user's default workspace. |

**JSON shape:**

```json
{ "data": { "skill": "owner/name", "forked_version": "1.2.0", "new_version": "0.1.0", "workspace": "workspace-slug", "directory": "/absolute/path" } }
```

After successful fork, **always run Post-Fork Enrichment** ([workflows.md § Post-Fork Enrichment](workflows.md)).

---

## delete

```bash
npx happyskills delete owner/name --json -y
```

**Flags:**

| Flag | Description |
|---|---|
| `<owner/name>` | Positional. The skill to delete from the registry. |
| `-y` | Skip CLI confirmation prompt (we confirm via AskUserQuestion). |

**JSON shape — success:**

```json
{ "data": { "deleted": true, "skill": "owner/name" } }
```

**JSON shape — errors:**

```json
{ "error": { "code": "NOT_FOUND", "message": "..." } }
{ "error": { "code": "FORBIDDEN", "message": "..." } }
{ "error": { "code": "CONFIRMATION_REQUIRED", "message": "..." } }
```

Confirm via AskUserQuestion before running — this is irreversible.

---

## visibility

**Get current visibility:**

```bash
npx happyskills visibility owner/name --json
```

**Set visibility:**

```bash
npx happyskills visibility owner/name public --json            # public/private/workspace
```

**Flags:**

| Flag | Description |
|---|---|
| `<owner/name>` | Positional. |
| `<visibility>` | Optional positional. `public`, `private`, or `workspace`. Omit to GET. |

**JSON shape — get:**

```json
{ "data": { "skill": "owner/name", "visibility": "public" } }
```

**JSON shape — set:**

```json
{ "data": { "skill": "owner/name", "visibility": "private" } }
```

**JSON shape — errors:**

```json
{ "error": { "code": "NOT_FOUND", "message": "..." } }
{ "error": { "code": "FORBIDDEN", "message": "..." } }
```

Confirm via AskUserQuestion before changing visibility to `public` — it makes the skill visible to all users in the public catalog.

---

## whoami (used internally for workspace resolution)

```bash
npx happyskills whoami --json
```

Used by the Workspace Resolution procedure ([workflows.md § Workspace Resolution](workflows.md)). Returns the user's workspaces.

**JSON shape:**

```json
{ "data": { "username": "...", "email": "...", "workspaces": [{ "slug": "...", "type": "personal|org" }] } }
```

`whoami` is owned by `happyskills` (core) — call it as a one-off for workspace resolution but route the user to core if they ask "who am I" directly.

---

## list (used internally for first-publish classification)

```bash
npx happyskills list --all-scopes --json   # CLI 1.13.0+; spans local + global
```

Used by Section 3's first-publish classification step to bucket the target skill. In `--all-scopes` mode `data.skills` is an **array** (each entry carries `scope` + `native`), so match by `name`. Publishing acts on the copy in **this project** — when the target name appears in both scopes, classify and publish the `scope: "local"` instance:

- `data.skills.find(s => s.name === "<ws>/<name>" && s.scope === "local")` → already managed; normal release path.
- `data.drafts[]` (entry with `name === <skill-name>`, prefer `scope: "local"`) → scaffolded by `init`, never published. **First publish via `release` directly — no `convert`.** `release` claims the workspace atomically.
- `data.external[]` (entry with `name === <skill-name>`, prefer `scope: "local"`) → genuinely foreign (no HappySkills-shaped `skill.json`). Route to Section 7 (`convert`) first.

`list` is owned by `happyskills` (core) — call it as a one-off for this classification but route the user to core for general "what's installed" queries.

---

## check (used internally for first-publish detection)

```bash
npx happyskills check <workspace>/<skill-name> --json
```

Used to detect whether a publish is a first publish (returns error → first publish; returns version data → existing skill). `check` is owned by `happyskills` (core) — call it as a one-off here.

---

## status (used internally for divergence pre-flight)

```bash
npx happyskills status <workspace>/<skill-name> --json
```

Used inside `release` to classify the lock-vs-disk state before publish. Status values: `clean` / `modified` (safe to publish), `ahead` (author already bumped — release publishes the disk version), `outdated` / `diverged` / `conflicts` (route via `next_step.action: pull_rebase_first`), `drift` (genuine inconsistency — route via `next_step.action: reconcile_first`). `status` itself is owned by `happyskills-sync` — call it as a one-off here, route the user there for general diagnostics.
