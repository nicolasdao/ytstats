# Changelog

## [1.8.0] - 2026-06-15

### Changed
- **Example Process Flow rewritten to be manifest-first.** The worked example previously demonstrated the pre-manifest fallback end-to-end (README-link discovery + per-file frontmatter-header peek + cross-link recursion), contradicting the manifest-first Steps 2/4/6/8 added in 1.7.0. It now loads `doc-manifest.json` in Step 2, triages from the nodes in one reasoning pass, reads the gotchas format from the index, and shows the legacy header-peek only as a labeled no-manifest fallback.
- **Gotchas format read from the manifest (Step 3b).** When the manifest is loaded, the format comes from `diagnostics.gotchas.format` rather than re-globbing `docs/gotchas/` — honoring Step 2's "trust the index, don't re-scan."

### Added
- **Low-confidence-metadata caution (Step 2).** Recall now downweights nodes the manifest flags as unreliable — `parse_error`, `has_frontmatter: false`, or `dangling: true` — scoring them by `headings` and opening the file rather than trusting a wrong or empty header.
- **Cross-cutting `tags` widening (Step 4).** For themes that deliberately span sub-projects (auth, security, logging), triage scans all groups for `tags` matches instead of letting monorepo group-scoping prune them.

### Fixed
- **`skill.json` declares `systemDependencies`** (`git`) — Step 1 runs `git rev-parse` but it was previously undeclared. init-context reads the manifest as a file and never runs the generator, so it needs no `python3` dependency.
- **`skill.json` license changed MIT → `BSD-3-Clause` and author identity aligned** to match the rest of the constellation (previously mixed BSD-3-Clause, MIT, and none).

## [1.7.0] - 2026-06-14

### Added
- **Manifest-first recall.** Step 2 now loads `doc-manifest.json` (the derived machine index) right after the README. Step 4 triages from it in a single reasoning pass over the whole corpus — scoring every node by `source` → `description`/`tags` → `headings` — instead of a frontmatter-header peek per file. The manifest is the index, not content: the mandatory `docs/mission.md` + gotchas-hub content reads are unchanged.
- **Group-scoped triage (monorepos).** When the manifest has a `groups` block, Step 4 scopes to the relevant sub-project group(s) before per-doc scoring, pruning unrelated sub-projects up front.
- **Exact "Documentation not yet loaded" set.** Step 8 now computes the unloaded set as the manifest's `nodes` minus what was actually read — precise complement, no README-link approximation — emitting each unloaded node's `path`, `description`, `source` (and `group`).

### Changed
- **Cross-link recursion (Step 6) drops to a fallback** when a manifest is present (triage already saw the whole corpus); `links_to` is used only to confirm nothing closely related was missed. Without a manifest it remains the primary discovery path.
- **Graceful degradation.** With no `doc-manifest.json`, the skill falls back to the legacy per-file frontmatter-header triage and notes it in the summary. The manifest is trusted as-is and never re-scanned for freshness (that is the producers' / Inspect's job); a node pointing at a missing file is surfaced and handled by direct inspection for that entry only.

## [1.6.0] - 2026-06-14

### Added
- **Frontmatter-first recall — `source` is now the strongest relevance signal.** Step 4 is reworked from link-text evaluation into a cheap frontmatter triage (peek headers, not bodies) with an explicit priority order: **(1) `source` match** — when the question names a file, directory, or code area, the doc whose `source` globs cover it is a near-certain load; **(2) `description`/`tags`**; **(3) README link text** as fallback for docs without frontmatter. This is the precise code→doc map applied to recall. (Schema: `nicolasdao/init-doc` `references/standards.md § Frontmatter`.)
- **Gotchas domain selection via `source`** (Step 3b): gotchas domain files declare `source`, so when the user's work touches a subsystem's code, the matching domain file is flagged to load.
- **Precise ongoing progressive loading.** Step 8's "Documentation not yet loaded" index now records each unloaded doc's `source` globs; the Ongoing Progressive Documentation Loading rule matches the work's file paths against them, turning mid-session loading into a deterministic code→doc hit instead of a title guess.
- **Example Process Flow rewritten** to demonstrate `source` matching end-to-end (triage, gotchas selection, unloaded index, ongoing load).

## [1.5.1] - 2026-05-25

### Fixed
- `argument-hint` frontmatter value was parsed by YAML as a flow array (`[question or topic]`), causing validation to fail with `argument-hint must be a string (got array)`. Replaced with an unquoted plain-string form (`optional question or topic`) that satisfies the validator without introducing forbidden YAML characters.

## [1.5.0] - 2026-05-19

### Changed
- SKILL.md frontmatter description refactored to the five-slot grammar with `ProjectMemory —` Domain anchor, explicit `Use when` triggers (starting work on a project, asking how something works, before any task in a documented area), and `Not for` negative redirecting to `update-doc` and `init-doc`. Auto-invocation routing signal significantly strengthened — previously the description was compact but lacked any `Use when` or `Not for` clauses.
- skill.json description aligned with the Project Memory constellation positioning. Added `ai`, `memory`, `agent-memory`, and `project-memory` keywords to surface the skill for LLM amnesia / persistent context queries.

### Positioning
- This skill is now formally positioned as the **recall** satellite of the forthcoming `nicolasdao/project-memory` constellation.

## [1.4.0] - 2026-05-19

### Added
- Step 1: Project Root determination (`git rev-parse --show-toplevel` with CWD fallback), aligning init-context with the writer skills so all four skills agree on what "project root" means. Closes a silent-failure mode when invoked from a subdirectory of a monorepo.
- Step 3: Mandatory File Loading — an explicit procedural step for loading `docs/mission.md` (3a) and `docs/gotchas.md` (3b) before topic-driven traversal. Mission loading was previously asserted as mandatory in the preamble but had no procedural step, creating a gap where a reader following the steps mechanically might miss it.

### Changed
- All steps renumbered from the previous 1–7 (with an unnumbered "Gotchas Loading" sibling section) to a consistent 1–9. The prose steps and the Example Process Flow now agree on numbering.
- Example Process Flow updated to show the new Step 1 (project root) and Step 3 (mandatory file loading, including explicit mission load).

### Removed
- Uppercase fallback detection for `MISSION.md` and `GOTCHAS.md`. The writer skills in this framework (`init-doc`, `init-mission`, `update-doc`) only ever produce lowercase filenames, so the uppercase branches were unreachable code. Detection is now lowercase-only, simplifying the procedure.

## [1.3.1] - 2026-05-16

### Removed
- Hard-exclusion rules that blocked reading files under `specs/` and `docs/manual/`. The skill can now follow links into those directories when relevant to the user's question.

## [1.3.0] - 2026-05-14

### Changed
- Step 7 is now unconditional: the skill always stops and waits after the context-load summary, regardless of how the prompt is phrased. The "proceed with implementation" branch that allowed concrete action requests to chain straight into the task has been removed.
- Trailing reminder updated to reflect the unconditional stop.

### Why
- Concrete, confident-sounding prompts ("run X and check output", "add endpoint Y") were the exact case where the model self-justified skipping the documentation load. The conditional "proceed" branch was the rationalization vector. Removing it costs one extra turn per invocation and guarantees the load actually happens — which is precisely where unloaded gotchas matter most.

## [1.2.0] - 2026-04-23

### Added
- "Documentation not yet loaded" index in summary (Step 6) — lists all unread docs from README with paths and descriptions
- Ongoing Progressive Documentation Loading section — persistent instruction for the LLM to proactively load relevant unread documentation when the conversation shifts to new topic areas
- Updated example process flow showing ongoing progressive loading in action

### Changed
- Step 7 now conditionally proceeds or waits based on user intent: action requests proceed to implementation, analysis/question requests stop and wait
- Removed `allowed-tools` restriction from frontmatter to allow implementation after context loading
- "No modifications" guardrail scoped to Steps 1-6 (documentation discovery phase) instead of the entire skill execution

## [1.1.0] - 2026-04-08

### Added
- Smart gotchas loading with hub+domain architecture support (`docs/gotchas/` directory)
- Format detection: uses Glob to determine hub+domain vs monolithic gotchas format
- Selective domain file loading: only reads `docs/gotchas/<domain>.md` files relevant to the user's question
- Progressive discovery reminder: summary includes unloaded gotcha domains so the LLM knows to load them if the conversation shifts topics
- Prominent gotchas presentation: gotchas are presented as WARNINGS at the top of the summary, not buried in general findings
- Backward compatibility with monolithic `docs/gotchas.md` (legacy format loaded in full)
- Updated example process flow showing hub+domain gotchas loading

## [1.0.2] - 2026-04-02

### Added
- Always load docs/mission.md (or MISSION.md) alongside gotchas.md for foundational project context

## [1.0.0] - 2026-03-05

### Added
- Initial release
- Recursive documentation discovery from README.md
- Relevance-based link filtering for targeted context loading
- Safeguards against infinite loops and duplicate file reads
