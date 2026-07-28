---
name: happyskills-search
description: HappySkills — Find, recommend, and star skills, browse versions, and match a local folder of skills against the catalog. Use when looking for a skill, picking a version, or checking which local skills exist in HappySkills. Not for installing.
allowed-tools: Bash, Read, Glob, Grep, AskUserQuestion
argument-hint: "[what you're looking for, or a skill name]"
---

# HappySkills Search (Discovery)

You are the discovery surface for HappySkills. You handle five kinds of requests:

1. **"Find me a skill for X" / "help me figure out what I need"** — search the marketplace and recommend skills to install. This is the bulk of what you do.
2. **"What versions of X exist? When did feature Y ship in X?"** — list a skill's version history or print its changelog so the user can pick the right version before installing.
3. **"Install `happyskills-collab`"** (or another opt-in satellite the user has been routed to from elsewhere) — confirm and install, then hand back. Default-bundled satellites already exist; never offer to install them.
4. **"Star this / save it to my favorites" / "show me my favorites" / "unstar X"** — star or unstar a skill (the curation half of favorites — Section 7), or search the skills the user has already starred via the `--favorites` scope (Section 2 Step B.5 + Section 3). Favorites is a discovery loop: find → star → re-find.
5. **"Which of my local skills are already on HappySkills?" / "match this folder of skills against the catalog"** — fingerprint a folder of **unlinked** local skills and match each against the catalog into tiers (Section 4.5). This is reverse-discovery: local → catalog. (Reconciling a skill that is *already installed/linked* to a remote is `happyskills-sync`, not this.)

The user's request is: `$ARGUMENTS`

---

## Section 1 — The core question (read this before every action)

Before you run any search, ask yourself **one question**:

> *"Why am I about to run this search (or these searches)?"*

The answer drives everything. There are two cases:

| Case | What it sounds like | What to do |
|---|---|---|
| **Scope-named lookup** — the user named a workspace constraint in any form (prose, possessive, workspace name) | "in my workspace", "my personal account", "find my X skill", "from acme", "across my workspaces" | **Resolve scope first.** Go to Section 2 Step B.5 to pick `--mine` / `--personal` / `--workspace <slug>`, then re-enter this table for the underlying query shape. Scope and topic are orthogonal — both must be honored. |
| **Branching fan-out** — you're hedging across possibilities you haven't disambiguated | "I'll search legal, blockchain, and SaaS because the user said all three words and I'm not sure which they mean" | **Stop and clarify.** Go to Section 3 Step C. |
| **Decomposition fan-out** — the user's framed problem genuinely spans multiple capability areas, and you can name in one sentence why each search is needed | "I'll search deployment, database, and testing because this Next.js project clearly needs all three and they are orthogonal" | **Search.** Go to Section 3 Step E. |
| **Single search** | "I'll search 'deploy AWS Lambda with Pulumi, Node.js' because the user named one specific task" | **Search.** Go to Section 3 Step E. |
| **Slug-explicit / workspace-scoped lookup** | "The user named a specific skill (`remotion-best-practices`) or a workspace/skill form (`acme/deploy-aws`)" | **Search directly without rerank** — the server auto-routes to a fuzzy mode. Go to Section 3 Step E with `--exact` semantics in mind (no `--with-rerank`). |

The "name in one sentence why each search is needed" clause is the self-check. If you cannot articulate distinct reasons that are grounded in the user's project (not in the prompt's surface keywords), you are hedging. Clarify.

**Why this rule and not a phrasing-based router?** Phrasing-based rules ("if the user said 'help me', clarify") are fragile in the middle of the spectrum. The agent's own intent (do I need to fan out?) is observable and reliable in every case. Routing on the cause of the fan-out, not its symptom, is what makes the skill robust.

---

## Section 2 — Pre-flight (run before any rerank-bound search)

For **slug-explicit** and **workspace/skill** lookups (the bottom row of Section 1's table), skip this entire section — the user named the target, you go straight to Section 3 Step E with a fuzzy query.

For **every other query**, run Steps A and B before you do anything else. Step C is conditional (it runs only when the Section 1 rule says "clarify"). Step D runs every time, just before search.

### Step A — Gather project context (session-first)

Build a one-paragraph mental model of the user's project. Sources, in priority order:

1. **Current session context.** Has the user already told you (or shown you) their stack? Have you already read `package.json` this session? **Use what you already have.** Do not re-read files you've seen; do not re-ask questions the user has already answered.
2. **Disk** — read whichever of these exist, in this order: `package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `README.md`, `CLAUDE.md`, `Dockerfile`, `docker-compose.yml`, `.env.example`. Stop reading once you have a working mental model.
3. **Empty/greenfield directory** — note it, skip to Step B, and plan to ask a calibrated question in Step C (you cannot decompose without knowing what the user intends to build).

The model you build should cover: language/runtime, framework, deployment target, external services, and any in-progress concerns visible in the project.

### Step B — Run `npx happyskills list --all-scopes --json`

Always. Two reasons:

1. You need it to dedupe recommendations against what's already installed — and a **globally-installed** skill is just as installed as a local one (it loads in this project too), so dedup MUST span both scopes or you'll recommend something the user already has. `--all-scopes` (CLI `1.13.0+`) covers both.
2. It tells you what capability areas the user has already covered vs left open.

**Shape note:** with `--all-scopes`, `data.skills` is an **array** (not an object keyed by `owner/name`); each entry carries `scope` (`local`/`global`) and `native`. Build your installed-set for dedup from every bucket — `data.skills` + `data.drafts` + `data.external` + `data.agent_orphans` — matching on `name`.

Handle special statuses gracefully:

- **`status: "drift"`** — surface gently before continuing: *"One of your installed skills, X, has gone out of sync — say 'fix drift on X' and the sync skill will guide you through it."* Do not block discovery.
- **`status: "ahead"`** — disk version > lock version. This is the **normal authoring sequence**, not drift. Do not mention it to the user during discovery.

### Step B.5 — Detect scope intent and resolve a flag

Before formulating the query, examine the user's request for **workspace scope intent**. Scope is **orthogonal to topic**: a single request can name both ("find me a release skill **in my personal account**"). Ignoring the scope half drowns the user's actual workspace match in registry-wide noise — and any apparent success is luck (the in-scope match happening to rank #1), not design. The previous failure mode this step exists to prevent: a registry-wide semantic search that happens to surface the right private skill at the top, masquerading as a correct result.

**Resolution rules**, evaluated in order — the first match wins:

| User signal | Flag to set | Notes |
|---|---|---|
| Query already in `workspace/skill` slash form (`acme/foo`) | (no flag) | Dispatcher auto-routes to `fuzzy_scoped`. Skip the rest of this step. |
| "my workspace(s)", "my skills", "my X skill", "across my workspaces", possessive `my` over a skill type, mixed personal+org phrasing | **`--mine`** | Personal workspace ∪ every org the user is a member of — one call. |
| Explicit org-exclusion: "ONLY my personal", "just my personal account", "not my org skills" | **`--personal`** | Personal workspace only. |
| Named workspace + crisp slug ("in `acme`", "from `letta-ai`") | **`--workspace <slug>`** | Direct scope. Comma-separate to scope to multiple workspaces. |
| Named workspace + fuzzy/uncertain spelling | (rewrite query) | Rewrite to `<approx-slug>/<query>` slash form and let `fuzzy_scoped` typo-tolerate both halves. |
| "my favorites", "skills I starred", "my starred skills", "search my favorites" | **`--favorites`** | Auth required. Restricts to the skills the user has starred (their favorites). Combine with a query to search within favorites, or omit the query to browse all of them (list mode). Routes through the smart dispatcher — **not** compatible with `--exact`. Curate the set with `star` / `unstar` (Section 7). |
| No scope signal in the request | (no flag) | Registry-wide search. |

**Default to `--mine`** for any ambiguous "my workspace(s)" / "my skills" phrasing — it covers personal AND every org in a single call. Reserve `--personal` for cases where the user explicitly excludes their orgs ("only personal", "not my org skills").

**Auth gate — hard fail, no silent fallback.** `--mine`, `--personal`, and `--favorites` require authentication. If the user named such a scope but is logged out (Step B's `list --all-scopes --json` returns no installed-skill workspaces hinting at a session, or the search itself returns `AUTH_REQUIRED`):

1. **Stop.** Do not search.
2. Tell the user plainly: *"Searching your workspaces requires login. Run `npx happyskills login --browser` and re-ask, or say 'log me in' and I'll route you."*
3. **Never** silently fall back to a registry-wide search. That's exactly the "magic" the mission's transparency value rejects — it produces results that look right but answer a different question.

**Combining with other flags:**

- `--mine` / `--personal` / `--workspace` all combine cleanly with `--with-rerank` on natural-language queries. The server filters **before** RRF, MMR, and rerank, so the digests describe only in-scope candidates.
- **Never** set both `--workspace` and `--mine`/`--personal` — the CLI nulls `scope` whenever `--workspace` is set; setting both is a contradiction the user will not see.
- **Explicit slash form beats inferred prose scope.** If the user types `acme/foo` AND says "in my workspace", honor the slash form — the user has been explicit.

The resolved flag is carried into Step E and stated in Step D's preamble. If you cannot name a concrete scope signal from the user's request, do not set a flag — running an unscoped search is the right default when no scope was named.

### Step C — Apply the Section 1 rule

Formulate the search strategy you would execute right now. Count parallel calls. If 2+, run the self-check: can you name a distinct, project-grounded reason for each one?

- **Yes (decomposition)** → proceed to Step D.
- **No (hedging)** → ask **one** calibrated question via AskUserQuestion before searching.

**How to ask:**

- **One question.** Not a form, not a sequence. AskUserQuestion accepts up to 4 options; pick the highest-leverage axis of branching and offer concrete options on that axis.
- **Concrete options, not preference surveys.** Good: *"Are you building this for end-users to file IP claims themselves, or for law firms to manage cases on behalf of clients?"* Bad: *"What are your goals?"*
- **Always include "Just search anyway" as an option.** If the user picks it, proceed with your best-guess decomposition and state it explicitly in Step D — they've authorized the guess.

**Hard cap: 2 clarifying turns per discovery thread.** After turn 2, search no matter what. This applies to your out-of-band AskUserQuestion calls AND to the CLI's `--clarification-turns-used` counter on `--with-rerank` searches — they share the same budget.

**Discovery-thread state flag.** Once a clarifying question has been answered in the current thread, the gate flips: subsequent fan-outs are allowed without re-litigation. Do not re-trigger Step C just because a multi-domain search shape re-appears post-clarification — the user has given you framing, honor it.

### Step D — State the decomposition before searching

Open your search with a one-sentence preamble:

> *"Based on [what you read in `package.json` / what the user clarified / what we discussed earlier], I'll search these domains: A, B, C. Tell me if I'm off."*

This is the trust contract. It gives the user a cheap chance to redirect before you burn the search budget, and it forces you to make your reasoning legible to them. This is the **"transparency over magic"** mission value, made operational.

For a single-domain search, the preamble is still required — just shorter: *"I'll search for skills that handle [domain]. Tell me if I'm off."*

For slug/workspace lookups, the preamble is replaced by a one-liner: *"Looking up `<slug>` directly."*

**When Step B.5 resolved a scope flag, state the scope explicitly in the preamble — before the topic.** Scope is the higher-leverage axis for the user to correct (a wrong scope makes the whole search wrong), so it goes first:

> *"Searching across all your workspaces (`--mine`) for skills that handle [domain]. Tell me if I'm off."*
>
> *"Searching only your personal workspace (`--personal`) for [domain]. Tell me if I'm off."*
>
> *"Searching the `acme` workspace for [domain]. Tell me if I'm off."*

If you set no scope flag because the user named no scope, no scope statement is needed — the implicit default ("the whole registry") is well understood.

---

## Section 3 — The search loop

Once Sections 1 and 2 have cleared, run the search. The protocol below is the deterministic frame; your reasoning lives **inside** it (query formulation, domain decomposition, candidate ranking).

### Step E — Run the search(es)

For each domain, run:

```
npx happyskills search "<query>" --with-rerank --json --limit 50 > /tmp/hs-search-<domain>.json
cat /tmp/hs-search-<domain>.json
```

`--limit` is **required** — use `50` when running the rerank protocol; `10` only for targeted browse when you have decided not to rerank. The server picks `mode` automatically from the query shape:

| Query shape | Mode | When |
|---|---|---|
| Natural language (multi-word, prose) | `semantic` | Default for discovery |
| Single slug-shaped token (`^[a-z0-9][a-z0-9-]*$`, e.g. `deploy-aws`) | `fuzzy_slug` | Skill-name lookups |
| `workspace/skill` form (e.g. `acme/deploy-aws`) | `fuzzy_scoped` | Scoped lookups |

`--with-rerank` applies only to `semantic` mode (silently ignored on fuzzy modes). For slug/workspace lookups, omit `--with-rerank` and use `--limit 5`.

Use `--exact` only as the escape hatch to skip the dispatcher and force keyword-only FTS — incompatible with `--with-rerank`.

Add `--type kit` to search kits only.

**Scope flags** — set per Step B.5; do not set without resolving scope intent first:

| Flag | Effect | Auth |
|---|---|---|
| `--mine` | Personal workspace ∪ every org the user is a member of (one call) | Required |
| `--personal` | Personal workspace only | Required |
| `--workspace <slug>` | The named workspace(s); comma-separate for multiple | Public works unauthenticated; private requires auth |
| `--favorites` | Only skills the user has starred; a bare `--favorites` with no query browses all of them (list mode) | Required |

`--mine` / `--personal` / `--workspace` / `--favorites` all combine with `--with-rerank` on natural-language queries — the server applies the scope filter inside the HNSW + FTS CTEs **before** RRF, MMR, authority promotion, and digest construction, so the rerank only sees in-scope candidates. `--favorites` is the one scope that is **not** compatible with `--exact` (it is dispatcher-only). Never set `--workspace` together with `--mine` / `--personal` / `--favorites`. On `AUTH_REQUIRED`, stop per Step B.5's hard-fail rule.

Example scope-aware invocations:

```
npx happyskills search "create release skill" --mine --with-rerank --json --limit 50 > /tmp/hs-search-mine.json
npx happyskills search "design system tokens" --workspace acme --with-rerank --json --limit 50 > /tmp/hs-search-acme.json
npx happyskills search --personal --json --limit 50   # list mode — browse personal workspace, no query
npx happyskills search --favorites --json --limit 50   # list mode — browse all your starred skills, no query
npx happyskills search "deploy aws" --favorites --with-rerank --json --limit 50 > /tmp/hs-search-fav.json   # search within favorites
```

**Parallel execution:** when you've cleared Section 1's rule for a decomposition fan-out, run the per-domain searches in parallel. Each goes to its own `/tmp/hs-search-<domain>.json` file. Pass `<domain>` as a short kebab slug (`deploy`, `database`, `testing`) so the file paths are readable.

### Step F — Read the envelope

The CLI emits the canonical six-key response envelope: `ok`, `data`, `error`, `next_step`, `warnings`, `meta`. All structured fields live at the root: read `response.next_step.action` and `response.next_step.kind`. The closed `next_step.action` enum tells you exactly what to do — Step G dispatches on it.

### Step G — Dispatch on `next_step.action`

You MUST take exactly one of the paths below. If you find yourself about to render results without going through one of them, you are skipping the protocol — re-read Step F and Step G before doing anything else.

#### Path A — `next_step.action == "rank_digests_inline"`

**You — the LLM running this turn — are the reranker.** Do this NOW, inline, in this same turn.

1. Read `data.rerank_system_prompt` from the search response and treat it as your system instructions for the ranking subtask.
2. Read every entry in `data.rerank_digests`. Each has `{ candidate_id, slug, lex_tier, digest }`. Rank by what each `digest` describes the skill is FOR, per the system prompt.
3. Emit JSON matching `data.rerank_response_schema`:

   ```json
   {
     "ranking": [
       { "rank": 1, "candidate_id": 5, "rationale": "specifically targets Lambda hot-reloading with TypeScript" },
       { "rank": 2, "candidate_id": 3, "rationale": "broader serverless coverage; less Node-specific" }
     ]
   }
   ```

   Aim for 10–30 items (default ~20). Rationales describe **effect** ("specifically targets Lambda hot-reloading with TypeScript"), not jargon ("highest cosine similarity"). The JSON has exactly one top-level key: `ranking`.

4. Pipe the ranking to `postlex` with `--search-output` pointing at the file you saved in Step E. This is the **literal command**; only `<original-query>`, `<N>`, and the ranking JSON are your inputs:

   ```bash
   echo '{"ranking": [/* the ranking array you just emitted */]}' | \
     npx happyskills postlex \
       --query "<original-query>" \
       --search-output /tmp/hs-search-<domain>.json \
       --ranking - \
       --clarification-turns-used <N>
   ```

   `<N>` is `next_step.context.clarification_turns_used` from the search response (typically `0` on first pass, `1` after one clarification, etc. — this counter is shared with Step C's out-of-band clarification cap).

5. Read `postlex`'s response — it returns ANOTHER `next_step` envelope at the root. **Go back to Step G with the new value.** The most common second-pass action is `present_to_user` (Path D).

**Why `--search-output` and not constructing `{"ranking", "data"}` inline:** `postlex` requires candidate names (from `data.results`) to compute slug-overlap promotion. Two failure modes have been observed in production when agents tried to hand-assemble `{"ranking", "data"}` via stdin: (a) the agent forgot to attach `data` — `postlex` rejected with `ranking_schema_mismatch — data field is missing` and burned the one retry under Path C; (b) the agent attached `data.results` but the rows had a `skill` field instead of `name`, so every ranking entry was dropped. Both are eliminated by passing `--search-output` and letting `postlex` do the join internally.

#### Path B — `next_step.action == "clarify_query"`

The query came back weak and the CLI is asking you to clarify. Note: this is the CLI's clarification — **separate from** your Section 2 Step C clarification but sharing the same 2-turn budget.

Ask the user **one** of `next_step.context.suggested_questions[0].options` using AskUserQuestion.

- The **last** option in `options` is always **"Just search anyway"** — honor it as a literal skip. If the user picks it, re-run Step E with the **original query unchanged** and the same `--clarification-turns-used` (do not increment).
- If the user picks any other option, reformulate the query incorporating their answer and re-run Step E, setting `--clarification-turns-used` to `next_step.context.clarification_turns_used + 1` (the `next_step.instructions` field states the exact value).

The CLI enforces the hard cap of 2 clarification turns. Never exceed it.

#### Path C — `next_step.action == "retry_rank"`

Your previous ranking JSON failed schema validation. Re-emit a ranking matching the `rerank_response_schema` from the original search response and re-pipe to `postlex`. **Maximum one retry.** If the second attempt also fails, render `data.results` in baseline order and tell the user the rerank step failed — that is the **only** acceptable fallback.

#### Path D — `next_step.action == "present_to_user"`

The flow is complete. Render `data.final_ordering` (from `postlex`) — or `data.results` (when `search` emitted `present_to_user` directly because no protocol applied) — as a table. Include `data.formulated_query` in your preamble. Then go to Step H.

#### Path E — `next_step` is `null` or absent

The protocol does not apply. Reasons: query was slug-shaped (`mode: fuzzy_slug`), `workspace/skill` form (`mode: fuzzy_scoped`), `--exact` was used, or `--with-rerank` was not set. Render `data.results` as the final answer. Then go to Step H.

### Step H — Before presenting any table, state which path you took

If `--with-rerank` was set on the original search, you MUST prepend the user-facing table with **one** of these literal lines:

> **"Rerank applied — final order from `happyskills postlex` (`<N>` reranked candidates):"**

or

> **"Rerank skipped because `<reason>`. Presenting baseline relevance order:"**

If you cannot truthfully prepend one of these lines, the protocol was skipped — return to Step F.

### ❌ Anti-patterns (each of these has been observed; each is wrong)

- **Running `search --with-rerank` and presenting `data.results` in relevance_score order without going through `postlex`.** If your output table is in relevance order rather than postlex's `final_ordering`, you skipped the rerank loop. Go back to Step G Path A.
- **Treating an empty `next_step` (i.e. `next_step.action` is absent) as "no protocol applies" without checking the `--with-rerank` precondition.** When `--with-rerank` is set on a `semantic`-mode dispatch, `next_step.action` is always populated (`rank_digests_inline`, `clarify_query`, or `present_to_user`). An empty `next_step` in that combination is a bug; surface it rather than silently rendering.
- **Treating the baseline as a graceful fallback when `--with-rerank` was set.** With the flag set, `data.results` is a **candidate pool, not a presentable order**. If you can't complete the rerank loop for any reason, STOP and tell the user the protocol failed — do not silently render the pool.
- **Hand-assembling `{"ranking": [...], "data": <data.results>}` via stdin instead of using `--search-output`.** Path A's `--search-output` recipe eliminates two observed failure modes (forgetting to attach `data`; attaching `data` whose rows lack `name`). Use it.
- **Skipping the `npx happyskills search … > /tmp/hs-search-<domain>.json` redirect step in Step E.** Without the file written to disk, `--search-output` has nothing to read.
- **Re-triggering Section 2 Step C after the user has already answered a clarifying question in this thread.** The discovery-thread state flag exists specifically to prevent this loop.
- **User named a workspace scope in prose ("in my account", "from acme", "my X skill") and you ran an unscoped registry-wide search.** Even when the top result happens to be in-scope, this is the bug, not a near-miss — registry-wide rank dilution means the next-best in-scope matches are unreliable, and the `quality_fallback` (0.66) for unscored skills (typical of personal/draft workspaces) can lose to a registry-wide false-positive with a marginally higher `final_score`. Any "success" is luck, not design. Resolve scope intent to a `--mine` / `--personal` / `--workspace` flag in Step B.5 **before** Step E.
- **Silently falling back to a registry-wide search when `--mine` or `--personal` returned `AUTH_REQUIRED`.** The user named a scope; surface the auth requirement plainly and stop. Producing results that look right but answer a different question is the exact "magic" the mission's transparency value rejects.

---

## Section 4 — Version & Changelog Lookup

Two read-only registry lookups that help the user pick the right version before installing.

For the full reference — flags, JSON shape, fallback behavior, edge cases, example transcripts — read [references/version-history.md](references/version-history.md) before running either command on a non-trivial request.

### 4.1 — Version listing

```
npx happyskills versions <owner/name> --json
```

Add `--limit N` only when the user explicitly asks for "the last N" or "recent versions" — otherwise list all. The JSON returns `{ skill, count, versions: [{ version, ref, commit, message, published_at }] }` sorted newest first. Present a compact table (VERSION / PUBLISHED / MESSAGE) and end with: *"Want me to install a specific one? Just say `install acme/foo@1.2.0` and core will handle it."*

### 4.2 — Changelog lookup

```
npx happyskills changelog <owner/name> --json
```

Add `--version <ver>` only when the user names a specific version. Otherwise omit; the command reads the latest version's `CHANGELOG.md` which already contains the full history. When `synthesized: true`, tell the user honestly: *"This skill doesn't ship a CHANGELOG.md, so I'm showing release messages from the registry instead."*

### 4.3 — Boundaries

- **Never install** as part of these flows. Give the user the trigger phrase `install <owner/name>@<version>` and stop.
- **Never bump/publish/release** off the back of a version lookup. Those are `happyskills-publish` actions.
- **Never fabricate** a version that isn't in the JSON output.

### 4.4 — Authentication

Public skills require no auth. For `workspace`/`private` visibility, run `npx happyskills login --json --browser` (timeout 360000ms / 6 minutes) and retry. Never use `--password` — it exposes credentials in the LLM context.

---

## Section 4.5 — Match a local folder against the catalog

Reverse-discovery: the user has a folder of **local** skills (a directory, or skills installed globally for Claude/Codex/etc.) and wants to know which already exist in HappySkills and how their copy differs. This is `happyskills match` — read-only, makes no changes.

**When this — and not `happyskills-sync`.** `match` is for **unlinked** local skills (an arbitrary folder, possibly never published — no entry in `skills-lock.json`). It *discovers whether a catalog counterpart exists at all*. `sync` is the opposite: it reconciles a skill that is **already installed/linked** to a remote (it's in the lock). Linked skill that diverged → route to `happyskills-sync`. A folder / "which of my skills exist on HappySkills" → `match`, here.

### 4.5.1 — Run it

```
npx happyskills match <folder> --json
```

Optional flags: `--concurrency <N>` (parallel catalog lookups, default 6) and `--threshold <N>` (0..1 identical-file fraction above which a name match counts as `near`, default 0.5). It needs no login for public catalog matches; sign in only to match the user's own private skills.

### 4.5.2 — Read the envelope

`data` is an object with one array per tier plus `errored[]` and a `summary` of counts. Each local skill lands in exactly one tier:

| Tier | Meaning | Present to the user as |
|---|---|---|
| `certified` | Byte-identical to a catalog skill (same tree hash) at the **exact** version `match.version` | When `match.is_latest` is `true`: "already on HappySkills, unchanged". When `match.is_latest` is `false`: "already on HappySkills at `match.version` — but that's an older release; you're behind the latest (`match.latest_version`)" |
| `near` | Same skill, some files differ — entry carries `differing_files` | "on HappySkills, with local edits to: <differing_files>" |
| `likely` | Name match only, content differs | "a same-named skill exists; content differs" |
| `possible` | Loose semantic match | "might correspond to <match> (low confidence)" |
| `unmatched` | Nothing comparable in the catalog | "not found — could be published" |

**Certified is version-precise.** A `certified` match is byte-identical to one **specific published version**, named in `match.version` — which may be older than the latest. Read `match.is_latest` (and `match.latest_version`) and surface the gap: a copy identical to an *older* release is still certified (it's a real, exact match — never call it drift or "modified"), but the user should know they're behind. Never present a behind certified match as flatly "unchanged" — that hides the version gap.

For a `near` skill, **always surface its `differing_files` list** — that precise "only `LICENSE` differs" is the load-bearing signal, not the similarity %. Surface `errored[]` too (local skills that couldn't be read) — never drop them.

### 4.5.3 — Dispatch on `next_step`

When there is anything matched, the envelope carries a `next_step` of `action: organize_matched_skills` (`kind: decision`). Present the matched skills and let the principal choose what to do with each — `match` itself does nothing further:

- **Favorite the keepers** → `star` (Section 7): `npx happyskills star <owner/name>`.
- **Organize them into a kit** → route to `happyskills-collab` (opt-in satellite, Section 5).
- A skill that is `unmatched` and the user authored → route to `happyskills-publish` to publish it.
- A `certified` skill that is **behind** (`match.is_latest` is `false`) → if the user wants the newest content, they can pull the latest with `npx happyskills install <owner/name>` (this is an unlinked folder, so it's a fresh install of the latest version, not a `sync`).

Boundary: `match` reports; it never stars, installs, publishes, or organizes on its own. Route each follow-up to the owning skill.

---

## Section 5 — Install-on-Recommendation (opt-in satellites)

Some satellites are **opt-in** — not installed with core. When the user is routed here for one (e.g. from `happyskills-help`), or asks to install it directly, offer to install it. Current opt-in satellites:

| Opt-in satellite | Owns | Install target |
|---|---|---|
| `happyskills-collab` | workspace membership, groups, skill access permissions | `happyskillsai/happyskills-collab` |
| `happyskills-stats` | your usage analytics + the aggregate reach of skills you authored | `happyskillsai/happyskills-stats` |

1. Explain briefly what the satellite owns and that it is not installed by default — e.g. *"Workspace membership and skill access permissions live in `happyskills-collab` — that's an opt-in satellite skill, not installed by default."* or *"Usage analytics live in `happyskills-stats` — that's an opt-in satellite skill, not installed by default."*
2. Use AskUserQuestion with these options (substitute the matching install target from the table):
   - **"Install it"** — Run `npx happyskills install <target> -y --json`. After install: *"Installed. Restart Claude Code to activate the skill, then re-ask your question and the skill will handle it."*
   - **"Just show me the command"** — Show `npx happyskills install <target>` (no execution).
   - **"Not now"** — Acknowledge and stop.

**Default-bundled satellites** (`happyskills-design`, `happyskills-publish`, `happyskills-sync`, `happyskills-help`, `happyskills-search`) install with core — they're already there. Never offer to install them.

---

## Section 6 — Present Results

After running any command, parse the JSON output and present human-friendly results.

**Search results** → table with Skill | Description | Version | Quality, in the exact order returned by `postlex`'s `data.final_ordering` (when rerank applied) or `data.results` (otherwise). Prefix with one of the two literal lines from Step H. Group by domain when results come from a decomposition fan-out.

**Gloss the Quality column in plain English — lead with the meaning, quote the raw value only if asked.** A bare `quality_tier` word or `quality_score` number tells the user nothing on its own. At render time, translate each row's tier into its plain-English meaning (grounded in [references/smart-search.md § Quality Tiers](references/smart-search.md), not invented). Either render the Quality cell as the meaning (with the raw `quality_tier`/`quality_score` in parentheses), or drop a one-line "what the tiers mean" key beside the table:

| `quality_tier` (`quality_score`) | Plain-English meaning (lead with this) |
|---|---|
| High quality (80-100) | Well-structured, rich content, strong documentation |
| Good (60-79) | Solid skill with decent documentation |
| Fair (40-59) | Functional, but the documentation could be better |
| Low quality (20-39) | Minimal documentation or structure |
| _(no label)_ (< 20) | Very poor — still shown if it's the only match |

**Framing rule:** lead with the plain-English quality meaning; quote the raw `quality_tier` / `quality_score` only if the user asks. Quality is informational (it ranks, it never filters — Section 8) — so gloss it, never hide a row for it.

**Result ordering — strict rule:**

- **With `--with-rerank`:** the only valid presentable order is `data.final_ordering` from `happyskills postlex`. If the rerank loop did not complete, STOP and tell the user the protocol failed — do not render `data.results` as a graceful fallback.
- **Without `--with-rerank`:** `relevance_score` order is authoritative. Do NOT re-sort by `quality_score`, downloads, or stars. Small relevance gaps reflect the ranker's calibrated confidence, not noise.

Ad-hoc re-ranking is an exception, not the rule. You may suggest an alternative ordering only when **(a)** the user explicitly asks ("sort by quality"), or **(b)** you have a specific, stated reason tied to the user's project context. When you do: (1) show the API's order first, (2) present the alternative as a separate, clearly labeled view, (3) state your reason in one sentence.

**Star state in results.** Every search/list row carries `starred_by_me` (boolean). When it helps the user act, surface it — e.g. a ★ marker on already-starred rows — and offer the natural next step: *"Want me to star any of these? Say 'star acme/foo'"* (or 'unstar' for a row already starred). Never auto-star — star/unstar is a deliberate user action. See Section 7 for the commands.

**Versions results** → compact table (VERSION | PUBLISHED | MESSAGE), newest first. End with: *"Say `install acme/foo@<version>` and core will pick it up."*

**Changelog results** → render the markdown content directly. If `synthesized: true`, prefix with the one-line note from §4.2.

**Install results** (Section 5) → *"Installed happyskills-collab@version. Restart Claude Code to activate."*

JSON envelope: the canonical six-key envelope (`ok`, `data`, `error`, `next_step`, `warnings`, `meta`) — see Step F. The payload is under `data` (a top-level array payload is wrapped as `data.results`); the exit status is `meta.exit_code`, never inside `error`.

For the full smart-search response shape (`quality_score`, `quality_tier`, `relevance_score`, `visibility`, etc.), see [references/smart-search.md § JSON Response Shape](references/smart-search.md). For the `versions` and `changelog` response shapes, see [references/version-history.md](references/version-history.md).

---

## Section 7 — Star and unstar (curate favorites)

Starring is the curation half of favorites: the user marks skills they care about so they can re-find them later with `search --favorites` (Section 2 Step B.5). It is a **registry-side** action keyed by `owner/name` — independent of whether the skill is installed locally.

### 7.1 — Commands

```
npx happyskills star <owner/name> --json
npx happyskills unstar <owner/name> --json
```

- **Auth required** for both. On `AUTH_REQUIRED`, stop and route the user to log in (same hard-fail posture as Step B.5) — never proceed silently.
- **Idempotent.** Starring an already-starred skill (or unstarring one not starred) succeeds without error. In the canonical six-key envelope, `data.starred` is `true` after `star`, `false` after `unstar`.
- **Published-vs-not, not local-vs-remote.** You can star any skill that exists in the registry — whether or not it is installed on disk. You **cannot** star a purely local, never-published draft (no registry record to attach the star to). If the user tries to star a draft, explain it must be published first and route to `happyskills-publish`.

### 7.2 — When to invoke

- The user explicitly asks to star/unstar a skill, OR
- The user accepts your "want me to star this?" offer from a search result (Section 6).

The natural loop: **find** (search) → **star** the keepers → later **re-find** them (`search --favorites`).

### 7.3 — Boundaries

- **Never** install as a side effect of starring — they're independent. Starring downloads nothing; installing does not star.
- **Never** star on the user's behalf without an explicit request or an accepted offer.
- For anything beyond `star` / `unstar` / `search --favorites`, route to the owning skill (install → core; publish → `happyskills-publish`).

---

## Section 8 — Constraints

- **NEVER** present `data.results` in `relevance_score` order to the user when `--with-rerank` WAS set on the search. With the flag set, `data.results` is a candidate pool, not a presentable order. If the rerank loop did not complete, STOP and tell the user the protocol failed.
- **NEVER** silently re-order results when `--with-rerank` was NOT set. `relevance_score` is authoritative. With explicit user request or a stated reason, present a labeled alternative view alongside the API's order — never replace it.
- **NEVER** install a skill without confirming with the user via AskUserQuestion.
- **NEVER** perform actions other than `search`, `versions`, `changelog`, `star` / `unstar`, and `install` (the last only for opt-in satellites). For everything else, route the user to the right family-member skill.
- **NEVER** run `npx happyskills login --password` — exposes credentials in the LLM context. Use the browser flow only.
- **NEVER** fabricate CLI flags, subcommands, or skill versions not documented in this skill / [references/smart-search.md](references/smart-search.md) / [references/version-history.md](references/version-history.md) / [references/discovery-protocol.md](references/discovery-protocol.md), or returned by an actual command run.
- **NEVER** be proactive — only search/recommend/lookup when the user explicitly asks.
- **NEVER** hide low-quality search results — show them with a caveat. Quality tiers are informational, not filters.
- **NEVER** skip Section 2 Steps A and B for any non-slug query. Project context is a rerank-quality input; skipping it produces worse recommendations even when the query looks crisp.
- **ALWAYS** run Section 2 Step B.5 (scope detection) before formulating any query. NEVER run an unscoped search when the user has named a scope — topic and scope are orthogonal axes; both must be honored.
- **NEVER** silently fall back to a registry-wide search when `--mine` or `--personal` returns `AUTH_REQUIRED`. Stop, surface the auth need, and let the user decide whether to log in or drop the scope constraint.
- **NEVER** re-read files you already have in session context, or re-ask questions the user has already answered. The "session-first" rule in Section 2 Step A is load-bearing.
- **ALWAYS** run `npx happyskills` from the **project root** (the directory containing `.claude/`).
- **ALWAYS** use `--json` on every command. Always include `--limit` on `search`.
- **ALWAYS** state the decomposition before searching (Section 2 Step D). Even one-line — even for a single-domain search.
- **ALWAYS** apply the Section 1 rule before fanning out: ask yourself why, and clarify if you cannot name distinct reasons.
