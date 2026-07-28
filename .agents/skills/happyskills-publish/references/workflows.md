# happyskills-publish — Workflows

Full step-by-step procedures for publish-related workflows. SKILL.md has the quick steps and routing; this file has the complete procedures with all guardrails.

## Common Procedures

### Optional Fields Prompt

When enriching a skill (post-convert, post-fork), ask about each of the following fields individually. Do NOT skip any.

**a. `authors`** — Use AskUserQuestion to ask if the user wants to add authors. Suggest a format like `"Jane Doe <jane@acme.com>"`.

**b. `license`** — Use AskUserQuestion with these exact options in this order:
   1. **"MIT"** — Description: "Permissive. Do anything, just include the license text."
   2. **"BSD-3-Clause"** — Description: "Permissive with no-endorsement clause."
   3. **"Apache-2.0"** — Description: "Permissive with patent protection."
   4. **"Show me more"** — Description: "See all available licenses."

   If the user selects **"Show me more"**, display this reference table:

   **Permissive:**
   | SPDX ID | Description |
   |---------|-------------|
   | MIT | Do anything, just include the license text |
   | ISC | Functionally identical to MIT, shorter wording |
   | BSD-2-Clause | Two conditions — retain notice, no liability |
   | BSD-3-Clause | Like BSD-2 plus no-endorsement clause |
   | Apache-2.0 | Like MIT plus patent grant, must state changes |

   **Copyleft:**
   | SPDX ID | Description |
   |---------|-------------|
   | GPL-3.0-only | Strong copyleft — derivatives must also be GPL |
   | LGPL-3.0-only | Weaker copyleft — libraries can be linked from proprietary code |
   | MPL-2.0 | File-level copyleft — modified files stay MPL, rest can be proprietary |
   | AGPL-3.0-only | Like GPL but covers network/SaaS use |

   **Public Domain:**
   | SPDX ID | Description |
   |---------|-------------|
   | CC0-1.0 | Full public domain dedication, zero restrictions |
   | 0BSD | Public domain as a formal license |

   **Proprietary:**
   | Value | Description |
   |-------|-------------|
   | UNLICENSED | All rights reserved, no reuse allowed |

   Then use a second AskUserQuestion with:
   1. **"UNLICENSED"** — Description: "All rights reserved (private/internal skills)."
   2. **"GPL-3.0-only"** — Description: "Strong copyleft — derivatives must be GPL."
   3. **"MPL-2.0"** — Description: "File-level copyleft — modified files stay MPL."
   4. **"CC0-1.0"** — Description: "Public domain dedication, zero restrictions."

   The automatic "Other" option is available at both tiers for any SPDX identifier not listed.

   **After the user selects a license, generate a LICENSE file** in the skill directory:
   - **Copyright holder**: Reuse the `authors` value from the authors prompt above. If no authors were set, use AskUserQuestion to ask for a copyright holder name (person or company name — no legal registration numbers needed, just a name).
   - **Year**: Use the current year.
   - **License text**: Write the standard license text for the chosen SPDX identifier. For licenses that include a copyright line (MIT, ISC, BSD-2-Clause, BSD-3-Clause, 0BSD, UNLICENSED), insert `Copyright (c) [year] [name]` at the top. For licenses with standardized text and no copyright line in the body (Apache-2.0, GPL-3.0-only, LGPL-3.0-only, AGPL-3.0-only, MPL-2.0), write the standard text as-is. For CC0-1.0, write the standard dedication text.
   - Write the file as `LICENSE` (no extension) in the skill directory using the Write tool.

**c. `repository`** — Before asking, run `git remote get-url origin 2>/dev/null` to detect the current git remote URL.
   - If a remote URL is found, use AskUserQuestion with:
     1. **"Yes, use <detected-url>"** — Description: "Set repository to the detected git remote."
     2. **"No, skip"** — Description: "Don't set a repository URL."
   The automatic "Other" option lets the user enter a different URL.
   - If no remote URL is found, use AskUserQuestion with:
     1. **"Enter a URL"** — Description: "Provide a repository URL manually."
     2. **"Skip"** — Description: "Don't set a repository URL."

### Invocation Model Confirmation

When an enrichment workflow needs to confirm the user's invocation preference, present these two options via AskUserQuestion:

- **"Auto-invoke (Recommended)"** — Claude automatically invokes the skill when relevant. Best for most skills.
- **"User-only (/slash command)"** — Only the user can trigger it via `/skill-name`. Claude will not know the skill exists and cannot invoke it automatically. Recommended only for destructive operations like deployments, releases, or deletes.

**Default to auto-invoke.** Action depends on the skill's current state:
- **Existing skill** (Post-Convert, Post-Fork): Remove the `disable-model-invocation: true` flag if present. NEVER keep it without confirming.

### Workspace Resolution

Resolve the target workspace for publishing by running `npx happyskills whoami --json`:

1. If exactly one workspace → use it.
2. If multiple workspaces → check `skills-lock.json` (in the project root) for a `<slug>/<skill-name>` key. Use the matching workspace.
3. If zero or multiple matches → ask via AskUserQuestion which workspace.

### First-Time Publish

Use this procedure when publishing a skill for the first time. There are two valid first-time paths, and they look almost identical to the user:

- **Draft path** (most common — skill scaffolded by `happyskills init`): the skill appears under `data.drafts[]` in `npx happyskills list --all-scopes --json` (prefer the `scope: "local"` entry — you publish the copy in this project). **Use `release` directly** — it atomically claims the workspace, validates, and publishes. There is no separate "claim" or "convert" step. Do NOT mention "external", "convert", "claim", or "lock file" to the user — call it a publish, because that's what it is.
- **Convert path** (rare — skill is genuinely foreign, e.g. hand-rolled `.claude/skills/<name>/SKILL.md` cloned from GitHub): the skill appears under `data.external[]`. Run `convert` first (Section 7 of SKILL.md), then Post-Convert Enrichment, then this First-Time Publish procedure.

For releasing updates to already-published skills, use the `release` primitive (Section 3 of SKILL.md) — it wraps the whole pipeline atomically.

1. **Authenticate** — Run the auth flow (Section 2 of SKILL.md).
2. **Resolve workspace** — Run the **Workspace Resolution** procedure above. `release` will accept the resolved slug via `--workspace`.
3. **Visibility** — Ask with exactly these three options in this order:
   1. **"Private (Recommended)"** — MUST be the FIRST option. Description: "Only people you explicitly grant access to — nobody else, not even the rest of your workspace, until you grant them."
   2. **"Workspace"** — MUST be the SECOND option. Description: "Everyone in the owning workspace can find and install it — share an internal skill with your whole team without going public."
   3. **"Public"** — MUST be the THIRD option. Description: "Listed in the public catalog — anyone can find and install it."

   NEVER present "Public" as the first or default option.
4. **Publish via release** — Run the appropriate command (ALWAYS include `--workspace`):
   - Private (default): `npx happyskills release <skill-name> --workspace <slug> --json`
   - Workspace: `npx happyskills release <skill-name> --workspace <slug> --visibility workspace --json`
   - Public: `npx happyskills release <skill-name> --workspace <slug> --visibility public --json`

   For a draft (no lock entry), `release` treats the disk version as the ahead-equivalent and publishes it directly — no bump is needed on first publish, no `--bump` flag required. If `release` returns `next_step.action: provide_changelog` (CHANGELOG.md missing or stale for the version on disk), write the entry per Section 3 step 3 and re-invoke. The bare `publish` command works too (and is what `release` delegates to internally), but `release` is the canonical entry point because it snapshots first and returns structured `next_step` envelopes on any failure.

---

## Post-Convert Enrichment

After `happyskills convert` succeeds, the skill has a basic `skill.json` (name, version, workspace) but is **not yet published** — it is missing the metadata that makes it discoverable, well-documented, and publish-ready. Run this enrichment workflow automatically after every conversion, then publish as the final step.

**Important**: Do NOT alter the SKILL.md body content — it is the user's original work. Only enrich `skill.json`, add supplementary HappySkills files, and ensure SKILL.md frontmatter has the required fields.

1. **Read the SKILL.md** — Understand what the skill does, its domain, and target audience.
2. **MANDATORY — Ensure SKILL.md frontmatter has `name` and `description`** — Check if the SKILL.md has a YAML frontmatter block (`---`). If NOT, you MUST add one. If it exists but is missing `name` or `description`, you MUST add the missing fields. The `description` is the #1 factor for Claude auto-invocation quality — without it, the skill will silently fail to trigger. Write a description following the canonical format from spec 260501-mega-skill-refactor: `<Namespace> — <verb-led action>. Use when <specific trigger context>. Not for <where to redirect>.` Target 80-180 chars (250 soft cap, 1024 hard cap). Use em-dash, not colon, for the namespace separator. Use only safe characters (no semicolons, colons, or other forbidden YAML characters per the current validator). Route the user to `happyskills-design` ("say 'review my SKILL.md description' and design will help shape it") for the full format guide. Ask the user to confirm the description before writing it. This step is NON-NEGOTIABLE.
3. **Write skill.json `description`** — A concise summary (under 200 chars) optimized for registry search. This is different from the SKILL.md `description` which targets Claude auto-invocation.
4. **Detect system dependencies (MANDATORY scan, not best-effort)** — Scan SKILL.md and every file under `scripts/` for command invocations, extract the unique binaries called, subtract the POSIX baseline, and declare **every remaining binary** in `systemDependencies` — including ubiquitous tools like `git`, `node`, `npm`, `npx`, `python`, `python3`, `pip`, `curl`, and `jq`. **Do NOT skip a tool because "it's always installed"** — the skill's host may be a Docker container, CI runner, or sandbox where it is not.
5. **Detect skill dependencies** — If the SKILL.md references other published HappySkills skills, suggest adding them to `dependencies`.
6. **Prompt for optional fields** — Run the **Optional Fields Prompt** procedure (Common Procedures above).
7. **Confirm invocation model** — Check whether the SKILL.md has `disable-model-invocation: true`. If it does, run the **Invocation Model Confirmation** procedure. For existing skills, the action is "remove the flag."
8. **Initialize CHANGELOG.md** — If none exists, create one with the initial version entry.
9. **Run validation (MANDATORY)** — Run `npx happyskills validate <skill-name> --json`. If `data.valid` is `false`, fix all errors before proceeding to publish — see Section 11 of SKILL.md.
10. **Publish to the registry** — Run the **First-Time Publish** procedure above.

---

## Post-Fork Enrichment

After `happyskills fork` succeeds, the forked skill has its version reset to `0.1.0` and dependencies cleared. Run this enrichment automatically after every fork.

1. **Read the forked SKILL.md** — Understand what the original skill does.
2. **MANDATORY — Ensure SKILL.md frontmatter has `name` and `description`** — Check that the forked SKILL.md has a YAML frontmatter block (`---`) with both `name` and `description`. If either is missing or empty, you MUST add them. The fork may serve a different purpose than the original, so ask the user what they plan to change and write a description following the canonical format from spec 260501-mega-skill-refactor: `<Namespace> — <verb-led action>. Use when <specific trigger context>. Not for <where to redirect>.` Target 80-180 chars (250 soft cap, 1024 hard cap). Use em-dash, not colon, for the namespace separator. Use only safe characters. Route the user to `happyskills-design` for the full format guide if needed. NON-NEGOTIABLE.
3. **Write skill.json `description`** — A concise summary (under 200 chars) optimized for registry search.
4. **Re-evaluate dependencies (MANDATORY scan, not best-effort)** — The original skill's dependencies were cleared. Scan SKILL.md and every file under `scripts/` for command invocations and declare every remaining binary in `systemDependencies`. Re-add any HappySkills skill dependencies referenced by the SKILL.md.
5. **Prompt for optional fields** — Run the **Optional Fields Prompt** procedure.
6. **Confirm invocation model** — Check whether the forked SKILL.md has `disable-model-invocation: true`. If it does, run the **Invocation Model Confirmation** procedure. For forked skills, the action is "remove the flag."
7. **Initialize CHANGELOG.md** — Create one with a `0.1.0` entry noting it was forked from the original (include `forked_from` info).
8. **Run validation** — Run `npx happyskills validate <skill-name> --json`. If `data.valid` is `false`, fix all errors. Present warnings to the user. This ensures the forked skill is in a valid state before the user starts modifying it.

---

## Releasing an update — call `release`

SKILL.md Section 3 is the canonical entry point. The `release` primitive atomically performs snapshot + validate + bump (when needed) + changelog verification + publish + lock update + snapshot-cleanup. On any failure it restores the snapshot and returns a structured `next_step` envelope. Do NOT re-implement the multi-step pipeline by chaining `bump` + `publish` manually — the primitive exists to remove that orchestration surface.

```bash
# Skill already bumped (ahead state) → release recognizes and publishes
npx happyskills release <skill-name> --workspace <slug> --json

# Needs a bump too
npx happyskills release <skill-name> --workspace <slug> --bump <patch|minor|major> --json
```

Read `next_step` per SKILL.md Section 3 and dispatch.

### Bump-type reference (when proposing one to the user)

When asking the user which `--bump` level to use, classify the changes you observe (conversation context + `git diff` + `git log`):

| Change Type | Bump | Examples |
|---|---|---|
| Bug fixes, typos, corrections | `patch` | Fixed typo in description, fixed broken command |
| New features, new sections, new capabilities | `minor` | Added new command support, added authoring mode |
| Breaking changes | `major` | Changed invocation model, restructured frontmatter, removed features, renamed skill |

### CHANGELOG.md format

If `release` returns `next_step.action: provide_changelog`, write a new entry at the top of `CHANGELOG.md` (below the `# Changelog` heading) using Keep a Changelog format. Only include groups that have entries.

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- New capability X

### Changed
- Modified behavior of Y

### Fixed
- Resolved Z

### Removed
- Dropped W
```

If `CHANGELOG.md` does not exist, create it with the `# Changelog` heading and the new entry, then re-invoke `release`.
