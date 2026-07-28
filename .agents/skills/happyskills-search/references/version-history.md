# Version History — Reference

Exhaustive reference for the two read-only registry-lookup commands the concierge owns: `versions` and `changelog`. Both inform the user's *install decision* — they help the user pick which version to install, then hand off to `happyskills` (core) for the actual install.

If the user asks for either, run the command yourself. Do not route to another family member — these belong to `happyskills-help`.

---

## When to use which

| User says | Command | Why |
|---|---|---|
| "what versions of acme/foo exist" | `versions` | They want the list |
| "list every version of X" | `versions` | They want the list |
| "how many versions of X are there" | `versions` | They want the count (it's in the JSON) |
| "show me the last 10 versions of X" | `versions --limit 10` | They explicitly asked to limit |
| "show me the changelog for X" | `changelog` | They want the narrative |
| "what changed in X" | `changelog` | They want the narrative |
| "release notes for X" | `changelog` | They want the narrative |
| "when did feature Y ship in X" | `changelog` | They're tracing a feature through history |
| "what's in version 1.2.0 of X" | `changelog --version 1.2.0` | They named a specific version |
| "should I install 1.4.2 or 1.5.0" | Both — `versions` for the list, then `changelog` for the rationale | Help them decide |

If both signals are present (the user wants the list AND the narrative), run `versions` first so they see the structure, then offer `changelog` as a follow-up: "Want the changelog for context? I can show release notes."

---

## Command 1 — `versions`

### Signature

```
npx happyskills versions <owner/name> --json [--limit N]
```

### Required arguments

- `<owner/name>` — fully qualified skill identifier, e.g., `acme/deploy-aws`. Must include the slash. If the user gives only a short name ("foo"), ask for the full `owner/name` rather than guessing the workspace.

### Flags

| Flag | When to use |
|---|---|
| `--json` | Always. Without it, the CLI prints a table you'd then have to parse. |
| `--limit N` | Only when the user says "last N", "recent N", "top N versions". Otherwise omit — return all versions, sorted newest first. |

There is no `--workspace`, no `--mine`, no scope flags. The skill is identified by `owner/name` directly.

### JSON response shape

```json
{
  "data": {
    "skill": "acme/deploy-aws",
    "count": 12,
    "versions": [
      {
        "version": "1.4.2",
        "ref": "refs/tags/v1.4.2",
        "commit": "abc1234567890...",
        "message": "fix(install): handle empty deps",
        "published_at": "2026-05-01T14:23:11Z"
      },
      {
        "version": "1.4.1",
        "ref": "refs/tags/v1.4.1",
        "commit": "def4567890abc...",
        "message": "chore: bump deps",
        "published_at": "2026-04-18T09:11:43Z"
      }
    ]
  }
}
```

### Field reference

| Field | Type | Notes |
|---|---|---|
| `skill` | string | Echoes the input `owner/name` |
| `count` | integer | Total versions returned (before/after limiting) |
| `versions[]` | array | Always sorted newest first (descending `published_at`) |
| `versions[].version` | string | Plain semver, no `v` prefix (e.g., `"1.4.2"`) |
| `versions[].ref` | string | Full git ref (e.g., `"refs/tags/v1.4.2"`) — useful when piping to other CLI commands |
| `versions[].commit` | string | Full SHA — useful for divergence checks but rarely shown to users |
| `versions[].message` | string | Release message authored at publish time. Doubles as a one-line "what changed" summary. |
| `versions[].published_at` | ISO 8601 string \| `null` | Publish timestamp |

### How to present results

Render a compact table, newest first. Show date as `YYYY-MM-DD` (slice the first 10 chars of `published_at`). Truncate `message` to fit the terminal width if needed:

```
acme/deploy-aws — 12 versions:

  VERSION   PUBLISHED     MESSAGE
  1.4.2     2026-05-01    fix(install): handle empty deps
  1.4.1     2026-04-18    chore: bump deps
  1.4.0     2026-04-02    feat: add --fresh flag
  1.3.5     2026-03-21    fix: skip bad hashes
  ...

Want the changelog for context? Or pick one and say `install acme/deploy-aws@1.4.0` and core will install it.
```

If the count is large (> 20), show the newest 10 and offer to show more: "Showing the newest 10 of 47. Want all of them?" Don't dump 50+ rows by default — it overwhelms the conversation.

### Edge cases

| Situation | Behavior |
|---|---|
| Skill has 0 published versions | The CLI returns `{ "data": { "skill": "...", "count": 0, "versions": [] } }`. Tell the user "No versions published yet for `<owner/name>`." Don't run `changelog` as a follow-up — there's nothing to read. |
| Skill doesn't exist | The CLI returns `ok: false` with `error.code` set (e.g. `NOT_FOUND`). Tell the user "I can't find `<owner/name>` in the registry. Want me to search for similar skills?" and offer to run `search`. |
| User isn't authenticated and skill is private | The API returns 401 / 403. Run the auth flow from SKILL.md Section 7 (`npx happyskills login --json --browser`), then retry. |
| User passed a short name ("foo" not "owner/foo") | The CLI exits with a usage error. Don't retry — ask the user for the full `owner/name`. |

---

## Command 2 — `changelog`

### Signature

```
npx happyskills changelog <owner/name> --json [--version <ver>]
```

### Required arguments

- `<owner/name>` — same rules as `versions`. Must include the slash.

### Flags

| Flag | When to use |
|---|---|
| `--json` | Always. The CLI's plain-text mode prints raw markdown to stdout — you want the structured envelope so you can detect `synthesized: true`. |
| `--version <ver>` | Only when the user names a specific version ("changelog of acme/foo at 1.2.0"). Accepts plain semver (`1.2.0`) or a full ref (`refs/tags/v1.2.0`). When omitted, the CLI reads the latest version's `CHANGELOG.md`, which already contains the full history. |

There is no `--limit`, no `--workspace`, no scope flags.

### Why omit `--version` by default

`CHANGELOG.md` files follow Keep-a-Changelog convention: each release adds entries to the top of the file. Reading the latest version's `CHANGELOG.md` gives you the entire history. Pinning to an older version with `--version` only makes sense when the user is literally asking "what did the changelog look like *back then*" — a rare diagnostic question, not the default.

### JSON response shape

```json
{
  "data": {
    "skill": "acme/deploy-aws",
    "version": "1.4.2",
    "ref": "refs/tags/v1.4.2",
    "commit": "abc1234567890...",
    "synthesized": false,
    "content": "# Changelog\n\n## [1.4.2] - 2026-05-01\n\n### Fixed\n- Handle empty deps in install...\n"
  }
}
```

### Field reference

| Field | Type | Notes |
|---|---|---|
| `skill` | string | Echoes the input `owner/name` |
| `version` | string | The version whose tree was read — either the latest, or whatever the user passed via `--version` |
| `ref` | string | Full git ref of the version that was read |
| `commit` | string | Full SHA of the commit pointed to by `ref` |
| `synthesized` | boolean | `false` = real `CHANGELOG.md` from the skill. `true` = no `CHANGELOG.md` exists; `content` was generated from registry release messages. |
| `content` | string | Raw markdown. Render directly. |

### The `synthesized` fallback — IMPORTANT

When a skill has no `CHANGELOG.md` file, the CLI does not error. Instead, it builds a synthetic changelog from the registry's release messages (one section per published version, newest first) and returns it with `synthesized: true`.

When you encounter this, you MUST be honest with the user. Prefix your output with a one-liner:

> "This skill doesn't ship a `CHANGELOG.md`, so I'm showing release messages from the registry instead — these are the commit-style messages authored at publish time, not curated release notes."

Do NOT present synthesized content as if it were an authored changelog. Transparency is a core HappySkills value.

### How to present results

For real changelogs (`synthesized: false`):

> "Here's the changelog for `acme/deploy-aws@1.4.2`:
>
> [render `content` directly as markdown]"

For synthesized changelogs (`synthesized: true`):

> "`acme/deploy-aws` doesn't ship a `CHANGELOG.md`. Here are the release messages from the registry (one entry per published version):
>
> [render `content` directly]"

If the changelog is very long (> ~200 lines of content), consider summarizing the top 3-5 entries instead of dumping all of it: "The most recent changes are: [bullet summary]. Want the full changelog?"

### Edge cases

| Situation | Behavior |
|---|---|
| Skill has 0 published versions | The CLI errors (no ref to resolve). Tell the user "No versions published yet for `<owner/name>` — there's no changelog to read." |
| Skill exists but `--version` doesn't | The API returns 404 on the ref lookup. Tell the user the version doesn't exist and offer to run `versions` to show what's available. |
| User isn't authenticated and skill is private | Same as `versions` — run the auth flow, retry. |
| `CHANGELOG.md` is enormous | Summarize. Don't dump 1000-line files into the conversation. |
| `synthesized: true` and the user asked "when did feature X ship" | The synthesized content is just commit messages — it may not mention features by name. Be honest: "I can't tell from the release messages alone. Want me to list the versions and you can install one to inspect?" |

---

## Combined workflow — "Help me pick a version to install"

This is the canonical multi-command flow. Run it when the user is clearly trying to *decide*, not just browse.

1. Run `npx happyskills versions <owner/name> --json` and present the table.
2. If the list is small (≤ 5 versions): also run `npx happyskills changelog <owner/name> --json` and show the narrative — the extra context is cheap.
3. If the list is large: ask the user "Want the full changelog? Or do you have a specific feature you're tracing?" Then run `changelog` only if they want it.
4. End with the install trigger phrase: "Once you've picked a version, say `install <owner/name>@<version>` and core will handle it."

Do NOT install on their behalf. Even if the user says "install 1.4.0 then", route to core: "Say `install <owner/name>@1.4.0` — core handles installs."

---

## Authentication recap

Both commands inherit the registry's standard read-access rules:

| Skill visibility | Auth needed? |
|---|---|
| `public` | No auth. Anyone can run `versions` / `changelog`. |
| `workspace` | Read access. The user must be a member of the owning workspace. |
| `private` | Read access. The user must be the owner or have explicit collaborator/group access. |

If the API returns 401 / 403, run the auth flow from SKILL.md Section 7 (`npx happyskills login --json --browser`, 6-minute Bash timeout) and retry the command. Never tell the user to fetch the data manually.

---

## What these commands are NOT for

- **Not for installing.** That's `happyskills` (core). Always hand off with the trigger phrase.
- **Not for publishing or bumping.** That's `happyskills-publish`. If the user says "show me my changelog so I can publish", route to publish: "Say `release my skill` and `happyskills-publish` will handle the bump + changelog stamp."
- **Not for diffing local vs remote.** That's `happyskills-sync` (`status` / `diff`). `versions` / `changelog` show the *registry's* history, not the user's local state.
- **Not for searching for skills.** That's `search`. If the user doesn't know which skill to look up, run `search` first.

If the user's intent is unclear ("show me what's going on with foo"), ask one focused question rather than guessing between `versions` / `changelog` / `status` / `diff`.

---

## Constraints (echo from SKILL.md)

- **NEVER** invent or infer versions not returned by `versions`.
- **NEVER** present synthesized changelog content as authored — always disclose `synthesized: true`.
- **NEVER** install on behalf of the user as part of these flows — hand off to core.
- **ALWAYS** use `--json`.
- **ALWAYS** include the version and the install trigger phrase when ending the response.
