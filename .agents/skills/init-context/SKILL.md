---
name: init-context
description: ProjectMemory — Load project docs into context at session start. Use when starting work on a project, asking how something works, or before any task in a documented area. Not for modifying or generating docs (update-doc / init-doc).
argument-hint: optional question or topic
---

You are being asked to load context about this project to help answer a specific question or explore a particular topic.

**IMPORTANT:**
**1. During the documentation loading phase (Steps 1–8), you are ONLY gathering information. DO NOT modify any files or make any changes during this phase.**
**2. Two files under `docs/` MUST be loaded regardless of the topic or question, if they exist:**
**   - `docs/gotchas.md` — critical project-specific pitfalls and edge cases (see [Step 3: Mandatory File Loading](#step-3-mandatory-file-loading) for hub+domain handling)**
**   - `docs/mission.md` — project vision, values, and decision-making compass**
**   These files contain foundational context that is always relevant. Step 3 below names them explicitly so they cannot be skipped.**

## Your Task

The user has provided this question or topic:
```
$ARGUMENTS
```

## Process: Recursive Documentation Discovery

Follow this iterative process to build up context:

### Step 1: Determine the project root

Before reading any documentation, determine the project root. All paths in this skill are relative to that root.

1. Run `git rev-parse --show-toplevel`. If it succeeds, use that path as the project root.
2. If the project is not a git repository (`git rev-parse` fails), assume the current working directory is the project root, and surface a one-line warning:
   > *"Not in a git repository — assuming the current directory is the project root. If this is incorrect, please re-invoke from the correct directory."*

This matches the procedure documented in the writer skills (init-doc, update-doc, init-mission) so all four skills agree on what "project root" means.

### Step 2: Read the README.md

Read the `README.md` file at the project root (if it exists). This is your entry point. Use it to understand:
1. What this project does
2. Its main features and capabilities
3. Links to other documentation files (the doc graph you will traverse in Steps 4–6)

If no `README.md` exists at the project root, proceed to Step 3 but note this in your summary — the project is missing its documentation hub and the user may want to run `/init-doc`.

**Then load `doc-manifest.json` if it exists** (at the project root). This is the **derived machine-first retrieval index** (see [../init-doc/references/standards.md § Documentation Manifest](../init-doc/references/standards.md#documentation-manifest)) — a single complete record of every doc's `description`, `tags`, `source`, `headings`, cross-links, and (in a monorepo) its `group`. It is the **index, not content**: loading it does not replace the mandatory *content* reads in Step 3 (`docs/mission.md`, the gotchas hub) — those are still read in full. The manifest is what makes triage (Step 4) a single reasoning pass instead of a header-peek-per-file traversal.

- **Trust it as-is.** The manifest is kept fresh by the producer skills and `project-memory` Inspect; do **not** re-scan the corpus to re-verify it — re-scanning would defeat its purpose. Freshness is their job, not recall's.
- **Graceful degradation.** If `doc-manifest.json` is absent, fall back to the per-file frontmatter-header triage described in Step 4 and **note in your summary** that no manifest was present (the user may want to run a producer skill to generate one).
- **Stale-pointer caution.** If the manifest lists a node whose file does not exist on disk, do not silently trust it: note the discrepancy in your summary and fall back to direct inspection for that entry only.
- **Low-confidence metadata.** Some nodes flag that their own header is unreliable — `parse_error` (frontmatter unparseable, so `description`/`tags` may be wrong or empty), `has_frontmatter: false` (no header at all — score by `headings`, not the null `description`), or `dangling: true` (the doc's `source` no longer resolves, so its code→doc map is stale). Don't rank these on `description`/`tags` alone: fall back to `headings`, and when one still looks relevant, open the file rather than trust the header. Surface any `dangling` doc you relied on in your summary.

### Step 3: Mandatory File Loading

Two files are loaded unconditionally before any topic-driven traversal, because they carry foundational context that applies regardless of the question:

#### 3a. Mission

If `docs/mission.md` exists, read it in full. This is the project's decision-making compass — vision, values, non-goals, users, UX compass. It should inform every subsequent decision in the conversation, even ones not obviously connected to "business context."

If `docs/mission.md` does not exist, note this in the summary (the user can run `/init-mission` later) and move on.

#### 3b. Gotchas

Gotchas are project-specific pitfalls — things that WILL bite you if ignored. They must be loaded early and treated as high-priority warnings, not background documentation.

**Detection.** Determine which gotchas format this project uses:

**If the manifest was loaded (Step 2), read the format from it** — `diagnostics.gotchas.format` is `hub+domain`, `monolithic`, or `missing`, computed deterministically. Trust it; do not re-scan. Only **without** a manifest, fall back to Glob:

1. **Check for `docs/gotchas/` directory** using Glob: `docs/gotchas/*.md`
2. **Check for `docs/gotchas.md`**

**Format A — Hub + Domain files** (the `docs/gotchas/` directory exists):

1. **Read the hub file** (`docs/gotchas.md`). This is a small index (~30–50 lines) listing all gotcha domains with descriptions and links to `docs/gotchas/<domain>.md` files. Always read it in full.
2. **Select relevant domain files**. From the hub, identify which `docs/gotchas/<domain>.md` files are relevant to the user's question/topic. Use the same frontmatter-first triage as Step 4 — gotchas domain files declare `source` for their subsystem, so when the user's work touches that subsystem's code, the `source` match flags the domain file to load (the strongest signal). Read only the relevant domain file(s).
3. **Record unloaded domains**. Note which domain files you did NOT load. Include them in your summary (Step 7) as a progressive discovery reminder.

**Format B — Monolithic file** (no `docs/gotchas/` directory, only `docs/gotchas.md`):

Read `docs/gotchas.md` in full. This is the legacy format — the entire file is loaded regardless of size.

**Attention framing**: When you encounter gotchas content (from either format), treat each gotcha as a warning. These are not reference documentation — they are lessons learned from production incidents. In your summary, present gotchas prominently under their own heading, not buried inside general findings.

### Step 4: Triage candidate docs from the manifest

**When `doc-manifest.json` was loaded (Step 2), triage from it — a single reasoning pass over the whole corpus, not a header-peek per file.** Every node already carries what the frontmatter header would tell you (`description`, `tags`, `source`) plus its headings, cross-links, and group — so you can score every doc at once without opening any of them. The manifest *is* the retrieval index; this is exactly what it exists for.

**(Monorepo) Scope by group first.** If the manifest has a `groups` block, decide which group(s) the user's question/topic belongs to — by the code area it names (match against each group's `roots`) or by sub-project name — and **restrict triage to nodes in those group(s)** before per-doc scoring. This prunes unrelated sub-projects up front. Widen to other groups only if the in-group docs don't answer the topic. **Exception — cross-cutting concerns:** when the question is about a theme that deliberately spans sub-projects (e.g. `auth`, `security`, `logging`), don't let group-scoping prune it — also scan **all** groups for nodes whose `tags` match the theme. `tags` is the cross-cutting axis that `group`/`source` intentionally don't capture (see [../init-doc/references/standards.md § Groups](../init-doc/references/standards.md#groups)).

**Score each candidate node in this priority order — do not skip signal 1:**

1. **`source` match — the strongest signal, check it first.** Look at what the user's question/topic is actually about: does it name a file, directory, or code area, either explicitly (`src/billing/charge.ts`) or by concept ("billing", "the auth service", "the deploy pipeline")? If a node's `source` globs cover that area, it is almost certainly one to load — `source` is the precise code→doc map (see [../init-doc/references/standards.md § `source` semantics](../init-doc/references/standards.md#source-semantics)), so a `source` hit is a near-certain match, not a guess. This is exactly why `source` exists; lead with it.
2. **`description` / `tags`.** Semantic match between the node's summary/labels and the question/topic.
3. **`headings` or README link text.** Fallback only for nodes that carry no frontmatter — link text can drift, so the frontmatter signals above override it when present.

A node that scores relevant on any signal goes on the reading list. When `source` or `description`/`tags` disagree with the README link text, trust the manifest — it is derived from the docs and kept current by the writer skills.

**Fallback when there is no manifest.** If Step 2 found no `doc-manifest.json`, triage the legacy way: from the README, identify links to `docs/` files and read **only** each candidate's frontmatter header (the leading `---` block, not the body), scoring by the same 1‑2‑3 priority. Note in the summary that triage ran without a manifest.

**Track what you've read:**
- Keep a mental list of all files you've already read to avoid infinite loops. `docs/mission.md` and the gotchas files loaded in Step 3 already count as read — don't re-load them.
- If a link points to a file you've already read, skip it.

### Step 5: Read relevant linked documentation

Read each relevant documentation file you identified. As you read each file:
1. Extract key information related to the user's question/topic
2. Look for MORE links to other documentation files within this document
3. Evaluate those new links for relevance (same criteria as Step 4)
4. Add relevant unread files to your reading list

### Step 6: Repeat recursively

**With a manifest, recursion is a fallback, not the primary path.** Manifest triage (Step 4) already saw the whole corpus at once, so your reading list is complete up front — you do not need to traverse the cross-link graph to *discover* relevant docs. Use the manifest's per-node `links_to` only to confirm you haven't missed a closely related doc, and add one if its node scores relevant. (When there is no manifest, cross-link traversal is the primary discovery mechanism — follow it fully.)

Continue the process:
- Read next relevant documentation file from your list
- Extract information and find new links (or, with a manifest, consult the node's `links_to`)
- Evaluate new links for relevance
- Read those relevant docs
- Keep going until you've exhausted all relevant documentation paths

**Important safeguards:**
- Never read the same file twice (check your tracking list)
- Stop when no new relevant documentation links are found
- Don't follow links that are clearly not relevant to the question/topic
- Limit to documentation files in the project (don't follow external URLs)
- Do not traverse into `docs/manual/` — that directory is human-authored content excluded from automated loading by framework convention

### Step 7: Summarize your findings

After completing the recursive documentation discovery, provide:

1. **Gotchas (WARNINGS)**: If any gotchas were loaded, present them FIRST under a dedicated heading. These are not suggestions — they are hard-won lessons. Frame them as: "The following gotchas are directly relevant to this work and must be respected." List each gotcha with its title and a one-line summary of the risk.

2. **Mission context** (if `docs/mission.md` was loaded): A 2–3 line summary of the vision and the most relevant values for this task. State explicitly that you will use the mission as the decision-making lens.

3. **List of files read**: Show which documentation files you read and in what order.

4. **Why each was relevant**: Brief explanation of why you chose to read each file.

5. **Key findings**: Summarize the information relevant to the user's question/topic.

6. **Context loaded**: Confirm that you now have sufficient context to help with their question.

7. **Progressive discovery reminder** (hub+domain gotchas format only): If the project uses the `docs/gotchas/` directory structure and some domain files were NOT loaded, include this notice:

   > **Additional gotcha domains available:** [list the unloaded domain names with one-line descriptions from the hub]. If the conversation shifts to any of these areas, load the relevant `docs/gotchas/<domain>.md` file before proceeding — these contain critical warnings that could prevent mistakes.

   Omit this notice if all domain files were loaded, or if the project uses the monolithic gotchas format (Format B).

### Step 8: Document the unread documentation index

In your summary, include a section called **"Documentation not yet loaded."**

**With a manifest, this set is exact:** it is the manifest's `nodes` **minus** the files you actually read this session (README, mission, the gotchas hub + any domain files, and every doc from Steps 4–6). No approximation, no guessing what the README "might" link to — the manifest is the complete corpus, so the complement is precise. For each unloaded node list its `path`, its `description`, and its `source` globs (and its `group`, in a monorepo) — all read straight from the manifest.

**Without a manifest**, fall back to the approximate set: every documentation file referenced in the README (or in any file you read) that you did NOT read, with its path, a brief description, and — if it declares frontmatter — its `source` globs (seen during the Step 4 header-peek triage).

This index is critical — it enables the ongoing progressive loading behavior described below. Capturing each unloaded doc's `source` is what makes that loading *precise*: when later work touches a specific file, you can match that path against the unloaded docs' `source` and know exactly which one to pull, instead of guessing from titles.

### Step 9: Stop and wait — always

After completing Steps 1–8, **stop**. Present the summary and wait for the user's next instruction. This is unconditional.

**This applies regardless of how the prompt is phrased.** Even if the prompt looks like a clear, unambiguous action request ("add endpoint X", "fix bug Y", "run command Z and check output"), you MUST NOT proceed to implementation in the same turn as the context load. The user will tell you to proceed in their next message.

**Why this is non-negotiable:**
- Confident-sounding action prompts are exactly where unloaded gotchas cause the most damage. The more concrete the task, the stronger your prior that "I don't need the docs" — and that prior is usually wrong.
- A single extra turn is cheap. Skipping context to look responsive is not.
- This step exists specifically to defeat the failure mode where a concrete prompt convinces the model the skill is satisfied by jumping straight to action. There is no "fast path." There is no "obvious case." Stop and wait, every time.

**What to output:**
1. The findings summary (gotchas, mission context, files read, key findings, documentation not yet loaded — per Steps 7 and 8).
2. A final line: *"Context loaded. Ready for your next instruction."*

Do not begin the task. Do not suggest the first step of the task. Do not call any non-Read tools. Wait.

---

## Ongoing Progressive Documentation Loading

**This instruction applies for the entire conversation, not just during the initial context-loading phase.**

After the initial context load, you will continue working with the user on various tasks throughout the conversation. As the conversation progresses and the user's requests shift to new areas, you MUST follow this rule:

**Before starting work on a new task or topic area, pause and ask yourself:**
> "Does the work I'm about to do touch an area of the project for which documentation exists but was not loaded during the initial context phase?"

To answer this, refer back to:
1. The **"Documentation not yet loaded"** list from your initial summary
2. The **progressive discovery reminder** for unloaded gotcha domains (if applicable)

**Use `source` to make this precise, not a guess.** When the work is about to touch specific files or a code area, match those paths against the `source` globs you recorded for the unloaded docs (Step 8). A `source` match is a near-certain signal to load that doc first — this is the same deterministic code→doc map `update-doc` uses, applied to recall. Fall back to title/description matching only for unloaded docs that carry no `source`.

**If the answer is yes — load the relevant documentation BEFORE proceeding with the task.** Read the file(s), absorb the context, and factor it into your work. Do not ask the user for permission to do this — it is expected behavior.

**If you are unsure whether a piece of unloaded documentation is relevant**, err on the side of loading it. The cost of reading an unnecessary file is negligible compared to the cost of missing critical context.

This is not optional. Skipping this step risks:
- Contradicting established patterns documented in the project
- Missing gotchas that could lead to bugs or regressions
- Duplicating work or approaches that were already tried and rejected

---

## Example Process Flow

```
User question: "How does the deployment pipeline work?"

1. Determine project root
   → `git rev-parse --show-toplevel` returns /Users/dev/myproject
   → All paths resolve from there.

2. Read README.md, then load the index
   → README gives the project's shape and entry points.
   → doc-manifest.json exists → load it. This is the retrieval index: every doc's
     description, tags, source, headings, links_to (+ group in a monorepo) in one
     record set. Trust it as-is; do NOT re-scan the corpus to re-verify it.

3. Mandatory File Loading
   3a. Mission:
       → docs/mission.md exists → read it in full
       → "Ship reliable infra over fast iteration" is the top value — relevant
   3b. Gotchas:
       → manifest diagnostics.gotchas.format = "hub+domain" (read from the index, no re-globbing)
       → Read docs/gotchas.md (hub — always read)
       → In the manifest, gotchas/deployment.md has source: [deploy/**, .github/workflows/**]
         → deployment question → source match ✓ → read it
       → Skip gotchas/database.md (source: db/**), gotchas/frontend.md (source: web/**) — no match
       → Record unloaded domains: database, frontend

4. Triage candidate docs FROM THE MANIFEST — one reasoning pass, no per-file header peek
   → Reason over the manifest nodes; score each by source → description/tags → headings:
       • docs/deployment.md   source: [deploy/**, .github/workflows/**]  → source match ✓ (strongest)
       • docs/architecture.md description: "...incl. the deploy pipeline"  → description match ✓
       • docs/api.md          source: [src/api/**]                        → no match ✗
       • docs/data-model.md   source: [db/**, models/**]                  → no match ✗
   → Confidence check: none of these carry parse_error / dangling / has_frontmatter:false
   → Reading list: docs/deployment.md, docs/architecture.md

5–6. Read the selected docs
   → Read docs/deployment.md and docs/architecture.md.
   → Recursion is a fallback here: glance at each node's links_to to confirm nothing
     closely related was missed — none scores newly relevant, so stop.

7. Summarize findings
   → Present deployment gotchas as WARNINGS first
   → Surface mission's "reliable infra over fast iteration" value as the decision lens
   → List files read and key findings
   → Include progressive discovery reminder:
     "Additional gotcha domains available: database, frontend.
      If work shifts to these areas, load the relevant gotcha file first."

8. Document "Documentation not yet loaded" = manifest nodes − files read (exact complement)
   → "- docs/api.md — API endpoint reference — source: [src/api/**]
      - docs/data-model.md — database schema and relationships — source: [db/**, models/**]"

9. Stop and wait
   → Final line: "Context loaded. Ready for your next instruction."

Later in the conversation...
   User: "Now let's update the data model to add a new table in db/schema.sql"
   → The work touches db/schema.sql → match it against the unloaded docs' source globs:
       • docs/data-model.md       source: [db/**, models/**]  → db/schema.sql matches ✓
       • docs/gotchas/database.md source: [db/**]             → matches ✓
   → Load both before starting — a deterministic code→doc hit, not a guess
   → Now proceed with the task, informed by both documents

(No doc-manifest.json? Fall back to the legacy path: discover docs via README links,
 peek ONLY each candidate's frontmatter header — not its body — score by the same
 source → description/tags → link-text priority, and traverse cross-links recursively.
 Note in the summary that triage ran without a manifest.)
```

Remember: Steps 1–8 are a context-loading phase — no modifications during documentation discovery. Step 9 always stops and waits for the user's next instruction, regardless of how the original prompt was phrased. The progressive loading behavior applies for the entire conversation.
