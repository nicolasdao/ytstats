# Changelog

## [0.6.4] - 2026-07-08

### Added
- Declared `authors` and `license` (BSD-3-Clause) in `skill.json`.

### Changed
- Raised the `requires` floor to `happyskills >=1.13.0` to match the `list --all-scopes` feature the skill uses (below 1.13 the disambiguation silently no-ops).

### Fixed
- Corrected a stale section pointer in `references/merge-workflows.md` (Section 10 → Section 5, the Diagnostic Decision Tree).

## [0.6.3] - 2026-06-30

### Changed
- Disambiguate against the new `happyskills match` command so "which of my local skills exist in the catalog" intents route to `happyskills-search` (its Section 4.5), not sync. Add a Section 1 routing row plus a linked-vs-unlinked disambiguation rule, and sharpen the description object to "installed skills" with a `Not for ... matching an unlinked local folder (use match)` boundary. Sync stays scoped to skills already linked to a remote (an entry in `skills-lock.json`); discovering whether an unlinked folder has a catalog counterpart is `match`.

## [0.6.2] - 2026-06-29

### Changed
- Disambiguate a `not_found` sync target with `list --all-scopes` (CLI `1.13.0+`), preferring the `scope: "local"` entry — you sync the copy in this project. `data.skills` is an array in that mode.

## [0.6.1] - 2026-06-13

### Changed
- Raise the minimum CLI requirement from `happyskills >=0.49.0` to `happyskills >=1.11.0`. The 0.6.0 conflict-resolution and review recipes depend on CLI behavior shipped in 1.11.0 — re-pull with `--theirs`/`--ours` resolving pending markers locally, and `pull --rebase --json --full-report` emitting the review payload. On an older CLI those recipes silently no-op, so the requirement is now enforced.

## [0.6.0] - 2026-06-12

### Added
- **Mandatory post-merge coherence review (Section 3.5).** After any `merged` pull — or once conflict resolution completes — the skill must read each merged file and verify internal coherence, fidelity to the skill's purpose, and harness intactness before routing to publish.

### Changed
- **Section 3 pull invocations now default to `--full-report`** (both `--rebase` and 3-way modes). The merge report is produced only by the pull that performs the merge and cannot be requested afterwards, so it is requested up front.
- **Section 7 reframed** from a standalone "run this to review" command into the payload the coherence review consumes, with a disk + `diff --remote` fallback for when an earlier pull ran without `--full-report`.
- **Section 10 now permits read-only `npx happyskills validate` after a merge** to confirm structural integrity locally; `publish`/`bump`/`convert`/`fork` remain routed to this skill.
- **Conflict-resolution recipes corrected.** Re-pull with `--theirs`/`--ours` now resolves pending markers locally and clears `conflict_files`; a bare re-pull surfaces the pending conflict state instead of reporting up-to-date. Removed the dead "bare re-pull to obtain a report" recipe from SKILL.md Section 7 and `references/merge-workflows.md`.

## [0.5.5] - 2026-06-06

### Changed
- Restructured `capabilities` into per-area clusters (`check-divergence`, `pull-and-merge`, `repair-drift`) with richer, synonym-varied intents for sharper `happyskills resolve` matching (spec 260606-01). Additive metadata; no behavior change.

## [0.5.4] - 2026-06-06

### Added
- Declared the `sync-skill` capability in `skill.json` (owns status/pull/diff/reconcile) so `happyskills schema` and `happyskills resolve` can route sync/divergence intents to this skill (spec 260606-01). Additive metadata — older CLIs ignore it; no behavior change.

## [0.5.3] - 2026-06-01

### Changed
- **Reference + status dispatch aligned to the canonical six-key envelope.** `references/cli-reference.md` now uses `data.results` / `meta.exit_code` and `INTERNAL_ERROR` for the generic error (dropping the non-emitted `ERROR`/`API_ERROR` and the `DIVERGED` prose-match); the content-corruption note in SKILL.md names `INTERNAL_ERROR`. Status dispatch (Step 2) surfaces `warnings[]` and stops on an unrecognised `next_step.action`.

## [0.5.2] - 2026-05-25

### Changed
- **`not_found` status branch in the status-narration table** updated to distinguish drafts (`data.drafts[]`, `happyskills@0.51.0+`) from external skills (`data.external[]`). Drafts route to `happyskills-publish` for `release` (no convert); externals route to publish for `convert` + publish. The previous wording said "external (on disk but not in the lock file)" universally, which surfaced "external" / "convert" jargon to users whose skills came from `happyskills init`. Aligns with spec 260522-02.

## [0.5.1] - 2026-05-24

### Changed
- **SKILL.md `description` tightened per `constellation-pattern.md §6` recommendation.** `checking if a skill is modified` → `your edits diverge from remote`. This is the exact phrasing called out in the constellation pattern reference doc as the residual fix for the documented `check`/`status` semantic collision (§8 case study). Specificity at the description level reduces the LLM's ambiguity budget on prompts that are semantically equidistant between core's "outdated" and sync's "modified" — the residual `out of date` ambiguity flagged in §6.

## [0.5.0] - 2026-05-23

### Added
- **`requires.happyskills >= 0.49.0` declared in `skill.json`.** The skill now formally requires the new CLI that ships the `reconcile` command, the `pull --rebase` mode, and the narrowed `ahead`/`drift` taxonomy.
- **`pull --rebase` documented as the LLM-preferred pull mode** in Section 3. New table row + `JSON shape` documentation. Captures local edits as patches, fast-forwards to the registry head, reapplies the patches; on rejection emits a structured per-patch envelope with `expected_context_before` / `actual_context_before` so the operator can produce a corrected patch without re-reading the file. The standard 3-way merge mode remains the default for human-driven workflows.
- **`reconcile` command documented** in Section 2.5 and `references/cli-reference.md`. The deterministic CLI command for repairing genuine drift. It diagnoses the subtype and either applies a deterministic fix (with `--apply <action>`) or returns a structured `next_step` envelope listing options for user adjudication. **No-ops on the `ahead` state** — that's normal authoring, not drift.
- **`ahead` row added to every status table** (Section 1.5 check, Section 2 status, Section 5 diagnostic decision tree). The plain-English opener routes the user to `happyskills-publish` ("say 'release X'") rather than treating the state as drift to repair.
- **Cross-skill constraint paragraphs in Section 10 (Constraints).** Two new constraints: (1) NEVER recommend `install --fresh` for drift repair (the silent-fallback footgun closed in `happyskills@0.49.0`); (2) ALWAYS snapshot before non-trivial mutations.

### Changed
- **Section 2.5 (Drift Repair) — rewritten to call `reconcile`.** The previous multi-step prose procedure that routed through `install --fresh` is replaced with a single CLI invocation: `npx happyskills reconcile <ws>/<skill> --json`. The skill is now a `next_step` router: read the envelope and dispatch (`resolve_regression`, `resolve_missing_skill_json`, `resolve_missing_dir`). The procedure NEVER calls `install --fresh` — the old data-loss path is removed across all recipes.
- **Section 2.5 — narrowed scope.** The previous "Case A" handling for disk-version-GREATER-than-lock-version (the `ahead` case) is removed entirely. Under spec § 4.5, that state is `ahead`, not drift — it routes back to `happyskills-publish` directly. Sync's Drift Repair now covers only genuine drift (`regression`, `missing_skill_json`, `missing_dir`).
- **Section 1.5 (Registry Update Check) — drift `reason` enum updated.** The previous `version_mismatch | missing_skill_json | missing_dir` set is replaced with `regression | missing_skill_json | missing_dir`. The `version_mismatch` reason is removed; the disk-greater-than-lock case is now reported under top-level `status: "ahead"` with an `ahead` object instead.
- **Section 2 status table — outranking order documented.** The seven canonical states are now: `clean` < `modified` / `outdated` / `diverged` < `ahead` < `conflicts` < `drift`. Drift outranks everything else because the install-record baseline is broken; ahead is reported above local/remote composites because it represents authoring intent the system should preserve.
- **Section 5 (Diagnostic Decision Tree) — `ahead` row added; `drift` row updated** to reflect that drift now means genuine inconsistency (`regression` or missing files) and that the repair path is `reconcile`.
- **`references/cli-reference.md`** overhauled: status enum updated for the new taxonomy; `--rebase` flag documented on `pull` with full `next_step` envelope shape; new top-level `reconcile` section with per-subtype envelope shapes and `--apply` action documentation; `drift` field shape updated; pointer added to the core skill's `snapshot` command.

### Rationale
Spec 260523-02's narrowed lock-as-registry-view semantic (§ 4.5) moves the disk > lock case out of "drift" entirely — it's the normal authoring-ahead state and belongs in publish, not sync. The remaining genuine drift cases get a deterministic CLI command (`reconcile`) that replaces the prose-driven procedure. The `pull --rebase` mode adds a snapshot-backed alternative to 3-way merge that's better suited to LLM-driven workflows (structured rejection envelopes instead of conflict markers in files).

## [0.4.1] - 2026-05-13

### Changed
- **Section 4 (Diff) — drift no longer blocks.** Replaced the stale "Diff refuses on drift" paragraph (which described `happyskills@0.43.x` behavior) with the current `happyskills@0.44.1+` behavior: diff warns and proceeds against drifted skills, and JSON output gains a top-level `drift: { reason, lock_version, disk_version }` field. Agents should narrate the drift from the JSON and route to Section 2.5, not refuse the operation. Drift is precisely the case where diff is most useful as a diagnostic, and the prior `install --fresh` "remediation" destroys the local state the user is trying to inspect.

### Added
- **Section 4 (Diff) — registry-side content-corruption error class.** New paragraph documenting the two errors introduced by `happyskills@0.45.0`'s API-boundary integrity checks: `Clone commit mismatch for <skill>: requested commit <X> but the response is pinned to <Y>` and `Clone integrity check failed for <skill> file "<path>"`. Explains the failure mode in plain English (transient registry/CDN issue, not local-state corruption), prescribes the response (retry once → if persistent, surface as a registry-side transient with the verbatim phrasing supplied), and explicitly forbids `--fresh`/reconciliation/working-tree suspicion. Without this guidance, an agent encountering the error in the wild was likely to misroute it as local corruption and destroy the user's work via `--fresh`.
- **Section 5 (Diagnostic Decision Tree) — pointer for the new error class.** Adds a paragraph below the status table telling agents to route `Clone commit mismatch` / `Clone integrity check failed` errors to Section 4's handling (registry-side, retry, do not reconcile).
- **Section 10 (Constraints) — "STOP if diff output contradicts ground truth."** New constraint that captures the durable lesson from the May 2026 CloudFront cache-key incident: when diff reports a file as modified that the agent has strong reason to believe was not touched, the agent must verify against an independent source (install the same version into a temp directory and `diff -rq`) before treating the diff as authoritative. Cache-shaped failures look exactly like local modifications until bad-registry-data is ruled out. Includes the exact bash recipe for the temp-install verification. This is the rule that, applied retroactively to the May 2026 session, would have caught the cache poisoning in seconds instead of dragging through a full reconciliation discussion.

## [0.4.0] - 2026-05-12

### Added
- **Drift handling — Section 2.5 (Drift Repair).** New section that explains lock-vs-disk drift in plain English and routes the user to the two named remediations (restore the install record, or accept the disk version as the new baseline). Drift is a distinct failure class from divergence: `pull` cannot fix it (pull operates on remote-vs-base; drift is local-vs-local). The section uses AskUserQuestion to frame the choice as "Which version do you actually want installed?" and routes to core's `install --fresh` rather than running anything itself.
- **`drift` row added to every status table** in Section 1.5 (`check`), Section 2 (`status`), and Section 5 (diagnostic decision tree). Each row carries the plain-English opener the agent should use verbatim ("The skill on disk doesn't match what was installed…"), and points at Section 2.5 for the repair routing.
- **Diff refusal handling — Section 4.** Documents that `diff` exits with `USAGE_ERROR` (exit 2) on drifted skills and tells the agent not to retry — instead run `status` to confirm the drift, then route to Section 2.5.

### Changed
- `check` JSON-shape documentation in Section 1.5 now lists `drift` as a possible `status` value and documents the `drift_count` aggregate and the per-result `drift` object (`{ reason, lock_version, disk_version }`). Same for `status` in Section 2.
- Section 10 (Constraints) adds: **NEVER recommend `pull` to fix a `drift` status** — pull operates on remote-vs-base divergence, drift is a local lock-vs-disk disagreement. Route drift to Section 2.5 instead.

### Rationale
The CLI gained drift detection in `happyskills@0.44.0` — `status`/`check`/`list`/`update` now surface a new `drift` status when the lock file and the on-disk `skill.json` disagree about which version is installed (e.g. after an interrupted `update`, manual `skill.json` edit, partial refresh). Without this release, the sync skill would route drifted states through the wrong remediation (pull won't help) or fail silently when `diff` started exiting with usage errors. Drift is mission-critical to surface because it's a class of bug the CLI was previously hiding under "modified" or silent "up-to-date" — the skill must teach the agent how to handle it.

## [0.3.0] - 2026-05-11

### Added
- **Plain-English opening-sentence prescription for `status` (Section 2).** The status-values table now includes a "Plain-English meaning (use as your opening sentence to the user)" column. Replaces the prior "Meaning" column. Every status (`clean`, `modified`, `outdated`, `diverged`, `conflicts`, `not_found`) now has an explicit one-sentence translation the agent should use verbatim — e.g., `diverged` → "Someone else published since you last pulled, and you also have local edits — both sides need to be reconciled."
- **Plain-English prescription for `check` (Section 1.5).** New per-status meaning table for `up-to-date / outdated / conflicts / no-access / unknown / error`, plus a headline-first presentation rule ("All your skills are up to date" / "N skill(s) have updates available" / etc.).
- **Plain-English prescription for `pull` outcomes (Section 3).** The pull-outcomes list is now a four-column table mapping each JSON status (`up_to_date`, `fast_forward`, `merged`, `conflicts`) to its plain-English opener and follow-up action.

### Changed
- Section 2 now opens with an explicit framing rule: "Always lead with the one-sentence plain-English meaning from the table below — use it verbatim or close to it as your opening sentence. Do not open with the raw status value, JSON field names, or SHAs." Same pattern applied at the head of Section 1.5 (`check`) and Section 3 (`pull`).

### Rationale
Follow-up to v0.2.0: a separate gap was discovered in how the skill prescribed *what to do* (clearly) versus *how to narrate the result to the user* (not at all). Under uncertainty, the agent's default was to transcribe the JSON vocabulary (`status: diverged`, `base_commit`, `merge_parents`) into prose — producing walls of jargon. This release closes the gap structurally: every status value the agent surfaces now ships with a prescribed plain-English opener. See `happyskills-design` Best Practice #14 and the matching anti-pattern row in skill-authoring.md for the generalized rule.

## [0.2.0] - 2026-05-11

### Added
- Section 1.5 "Registry Update Check (Cross-Skill Command)" — routes "outdated / up to date / what's new on the registry" questions to `check` (core's canonical update-check command), with full output-shape documentation so sync can present results without falling back to `status`.
- New routing-table row for "outdated / out of date / are my skills up to date / what new versions are available / what's new on the registry / are my skills behind" → `check` (Section 1.5).
- New disambiguation rule explaining that "outdated" / "up to date" are *registry update* questions, not divergence questions — and why sync routes to a core-flavored command (the Canonical-Command Escape Hatch from the Suite Pattern, suite-pattern.md §2.4).

### Changed
- Section 10 constraint on running `status` first clarified — applies to sync issues (divergence, modification, conflicts, publish rejection). For registry update questions, the canonical command is `check`.

### Rationale
Production failure: an agent asked "which skills are out of date?", routed to sync (the description's "checking if a skill is modified" semantically attracts "outdated"), and ran `status` instead of `check`. Both commands emit a `status: "outdated"` value, so the agent had no signal it had picked the wrong tool. The fix admits the routing overlap and converges both skills on the canonical command. Full case study in `happyskills-design/references/suite-pattern.md` §8.

## [0.1.1] - 2026-05-03

### Fixed
- Constraints now include "NEVER fabricate CLI flags or subcommands" and "ALWAYS run `npx happyskills` from the project root" — both were missing relative to the v1.30.0 mega-skill.
- Constraints now echo "NEVER run `npx happyskills login --password`" — credentials-leakage prohibition is now consistent across the whole family.
- Section 9 (Authentication) expanded with the headless-environment fallback message and the `already_logged_in` vs `logged_in` status detail — now consistent with the rest of the family.

## [0.1.0] - 2026-05-03

### Added
- Initial release of the HappySkills sync skill.
- Owns `status`, `pull`, `diff`, merge-conflict resolution, publish-failure diagnosis, and AI merge review.
- `references/merge-workflows.md` — full playbooks for status diagnosis, pull strategies, three-way merge mechanics, conflict resolution, publish-after-merge, TOCTOU handling, and `--full-report` AI review (lifted from the original `happyskills` skill v1.30.0).
- `references/cli-reference.md` — exact CLI syntax and JSON response shapes for `status`, `pull`, and `diff`.
- Created as part of the mega-skill refactor (spec 260501-mega-skill-refactor) — the original 57-intent `happyskills` skill was split into 5 default skills + 1 opt-in. Sync owns the Git-aligned sync layer: divergence detection, conflict resolution, and publish-after-merge intelligence.
