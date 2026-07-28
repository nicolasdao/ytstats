# Smart Skill Discovery — Reasoning Guide

You are the intelligence layer for skill discovery. The search API is a ranking engine — it embeds, matches, and ranks; YOU are the reasoning engine — you understand the user's world, figure out what they need, and use the search API as your tool.

The more thinking you do before searching, the better the results.

## Command

```
npx happyskills search "<query>" --json --limit N [--workspace <slug>]
```

Always use `--json`. `--limit` is **required** — pick `10` for targeted queries, `50` for browse mode.

## How the server picks a strategy (the dispatcher)

You send the raw query. The server inspects its *shape* and routes to one of four ranking strategies, then echoes the choice back as `mode` in the response. You do not have to pre-decide the mode — but knowing how routing works lets you write queries that get the strategy you want.

| Query shape | Mode | What it does |
|---|---|---|
| Natural language (multi-word, prose) — e.g. `deploy infrastructure to aws` | `semantic` | Hybrid vector + full-text + quality ranking. Best for "what skills exist for X?" |
| Single slug-shaped token — `^[a-z0-9][a-z0-9-]*$`, e.g. `deploy-aws`, `remotion` | `fuzzy_slug` | Trigram-similarity match on `name` / `display_name`. Typo-tolerant. Best for "find the X skill." |
| `workspace/skill` form — exactly one `/`, both halves non-empty, e.g. `letta-ai/remotion-best-practices` | `fuzzy_scoped` | Fuzzy-matches the workspace, then fuzzy-matches the skill within it. Typo-tolerant on **both** halves. |
| Empty query + at least one filter (`--workspace`, `--tags`, `--type`, `--mine`, `--personal`) | `list` | Pure filter + `ORDER BY updated_at DESC`. No ranking. Best for "browse this workspace." |

Routing is deterministic — the same input always picks the same mode. Read the `mode` field on the response to verify which one ran (useful when a query you expected to route to `fuzzy_slug` ended up `semantic`, or vice versa).

`--exact` is the **escape hatch**: it skips the dispatcher entirely and uses the legacy keyword-only FTS endpoint. Use it only when you want deterministic FTS behavior (no fuzzy tolerance, no embeddings) — most discovery flows should not need it.

## The Discovery Pipeline

Every discovery interaction — from "find me a Pulumi skill" to "what skills does my project need?" — follows the same pipeline. You enter at different stages and spend different effort at each stage depending on complexity.

### Stage 1 — Understand Intent

Before doing anything, classify what the user needs:

| Signal | Classification | Pipeline entry |
|---|---|---|
| User names a specific skill ("find deploy-aws", "is there a skill called X") | **Name lookup** | Skip to Stage 4 — write the name as a slug, server auto-routes to `fuzzy_slug` (typo-tolerant) |
| User names a workspace + skill ("the deploy-aws skill in acme", "letta-ai/remotion") | **Scoped name lookup** | Skip to Stage 4 — write `workspace/skill`, server auto-routes to `fuzzy_scoped` (typo-tolerant on both halves) |
| User describes a specific problem ("I need help with CORS errors") | **Targeted search** | Stage 2 (light context), Stage 3 (1-2 domains) |
| User describes their project or asks broadly ("what skills for my project?", "recommend skills for this codebase") | **Broad discovery** | Full pipeline, Stage 2 through 6 |
| User describes a bug or feature they're working on | **Contextual search** | Stage 2 (read session context + project), Stage 3 (1-3 domains) |

### Stage 2 — Gather Context

**What to read and why:**

| File | What it tells you |
|---|---|
| `package.json` / `requirements.txt` / `go.mod` / `Cargo.toml` | Language, framework, dependencies — the core tech stack |
| `README.md` | Project purpose, domain, architecture overview |
| `.env.example` or `.env.local` | External services (databases, APIs, cloud providers) |
| `Dockerfile` / `docker-compose.yml` | Deployment targets, infrastructure |
| `CLAUDE.md` | Project conventions, constraints, architecture decisions |

**Always run:** `npx happyskills list --all-scopes --json` (CLI `1.13.0+`) — this shows already-installed skills across **both** project-local and global scopes. You MUST know what's installed to avoid recommending duplicates and to identify gaps; a globally-installed skill counts as installed (it loads in this project too). Note `data.skills` is an **array** in `--all-scopes` mode — match dedup candidates on `name`.

**For targeted/contextual searches:** You may already know the tech stack from the current session. Don't re-read files you've already seen — use what you know.

**Skip context gathering entirely** for name lookups ("find the deploy-aws skill", "letta-ai/remotion") — the user already named what they want; route straight to Stage 4 with the slug or `workspace/skill` form.

### Stage 3 — Decompose into Search Domains

This is the most important stage. A complex project has multiple distinct capability needs. Each needs its own focused search because a single query can't cover "deployment AND database AND testing AND API patterns."

**How to decompose:**

1. List every technology and concern you identified in Stage 2
2. Group related technologies into domains (e.g., "PostgreSQL + migrations + schema" = database domain)
3. Each domain becomes one search query

**Example decomposition for a Next.js SaaS with Supabase on Vercel:**

| Domain | Search query |
|---|---|
| Framework | `"Next.js app router React server components"` |
| Database | `"Supabase PostgreSQL database queries authentication"` |
| Deployment | `"deploy Next.js Vercel production"` |
| Payments | `"Stripe payments subscriptions webhooks"` |

**Example decomposition for "I keep getting CORS errors calling my Express API":**

| Domain | Search query |
|---|---|
| API framework | `"Express Node.js REST API middleware CORS"` |
| Security | `"API security headers CORS configuration"` |

**Query discipline:** Every search must target a distinct capability domain. Stop when you've covered all domains you identified. Never run a second search for the same domain hoping for better results — if the first search didn't find anything, the catalog doesn't have it.

### Stage 4 — Search

For each domain, run:

```
npx happyskills search "<domain query>" --json --limit 10
```

**What makes a good query:**
- 5-15 words with specific technologies + task
- `"deploy Next.js static export to Cloudflare Workers"` — good (specific)
- `"deployment"` — bad (too vague, returns noise)
- `"best practices for coding"` — bad (generic, no tech specificity)

#### Choosing query form for known skills

When the user names a specific skill ("the deploy-aws skill", "remotion best practices"), don't write a natural-language query — write a **slug** or **workspace/skill** form so the server routes to a fuzzy mode. Three options:

| User said | Query form | Example | Server routes to |
|---|---|---|---|
| "find the deploy-aws skill" / "is there a skill called deploy-aws" | bare slug | `npx happyskills search deploy-aws --json --limit 5` | `fuzzy_slug` (typo-tolerant on `name` / `display_name`) |
| "find letta-ai/remotion" / "the remotion skill in letta-ai" | `workspace/skill` | `npx happyskills search letta-ai/remotion-best-practices --json --limit 5` | `fuzzy_scoped` (typo-tolerant on **both** halves) |
| "find the exact slug `deploy-aws`, no fuzzy" (rare) | `--exact` | `npx happyskills search "deploy-aws" --exact --json --limit 5` | legacy keyword-only FTS |

Use `--limit 5` (not 10) for name lookups — you want the named match plus a couple of close-name alternatives, not a long list.

`fuzzy_scoped` is the path that closes the principal aha **"I didn't know my team already had a skill for this"** — when the user remembers the workspace ("we have one in `acme/...` somewhere") and approximates the skill name. Tolerate typos in *both* halves.

**Team-aware search:** If the user is authenticated, also search their workspace(s) first:
```
npx happyskills search "<query>" --json --workspace <slug> --limit 10
```
Present workspace results separately: "Your team already has these skills:" — this addresses the irritant of teams unknowingly duplicating effort.

#### Workspace Scope Flags

When the user wants results scoped to their own skills, choose the right flag:

| User says | Flag | Covers |
|---|---|---|
| "show my skills", "list my published skills", "what have I published", "across my workspaces", "in my workspaces" | `--mine` | Personal workspace + every org the user is in (one call) |
| "ONLY in my personal workspace", "just my personal account skills" (explicitly excluding orgs) | `--personal` | Personal workspace only |
| "find X in acme", "search for X in <workspace>" (query + workspace) | `--workspace <slug>` (with query) | The named workspace |
| "skills in <workspace>", "browse <workspace>" (no query) | `--workspace <slug>` (browse mode, `--limit 50`) | The named workspace |

**Default to `--mine`** for any "my workspace(s)" / "my skills" / mixed personal+org phrasing — it covers personal AND every org in a single call. Use `--personal` only when the user explicitly excludes orgs ("only personal", "not my orgs"). Never run `--personal` and per-org `--workspace` calls separately when `--mine` would do it in one.

When scope-filtered results look inconsistent (e.g., `--personal` returning other users' skills, `--workspace acme` returning non-acme skills), report plainly as a possible bug — do NOT fabricate a justification.

### Stage 5 — Synthesize

After all searches complete:

1. **Merge results** across all domain searches into a single list
2. **Deduplicate** — same skill appearing in multiple searches is a strong signal; keep it, don't list it twice
3. **Filter already-installed** — compare against the `list --all-scopes --json` output from Stage 2 (match on `name`; this excludes both locally- and globally-installed skills)
4. **Evaluate fit** — for each remaining skill, ask: "Does this actually help with THIS user's specific situation?" A skill might rank high in search but not fit the user's exact context.
5. **Rank** — order by your assessment of value to the user, not raw relevance score

**Note on near-duplicate clusters.** The API already collapses near-duplicates server-side (semantic mode only — fuzzy modes don't cluster). A result with `similar_count > 0` represents that result plus N visually similar variants (forks, light edits, re-publishes) hidden under it; the variants are inlined in `similar_repos[]`. Treat the top-level entry as canonical — don't re-search to surface the variants, and don't recommend two near-identical skills back-to-back. Mention "+N similar variants exist" only if the user explicitly asks for alternatives.

#### Reading the `mode` field — and the honest-failure path

Every response includes a top-level `mode` field telling you which strategy ran. Use it for three things:

1. **Sanity-check the routing.** If you sent `deploy-aws` expecting `fuzzy_slug` but got `mode: "semantic"`, the query wasn't slug-shaped (maybe it had a space or capital you didn't notice). Re-think the query, don't just re-rank.
2. **Interpret `match_quality` correctly.** In `semantic`, the label is from cosine similarity (`strong ≥ 0.5`). In `fuzzy_slug` / `fuzzy_scoped`, it's from a trigram tier (`strong ≥ 0.85`). Same labels, different signals — both meaningful, just don't compare scores across modes.
3. **Detect the workspace-not-found honest failure** (`fuzzy_scoped` only). If the response is:
   ```json
   {
     "data": {
       "mode": "fuzzy_scoped",
       "query": "acme/helo",
       "formulated_query": "acme/helo",
       "results": [],
       "count": 0,
       "workspace_match": null,
       "match_notice": "No workspace matched \"helo\"."
     }
   }
   ```
   the server is telling you it could not match the workspace half of `workspace/skill` — it did **not** silently search globally. **Surface this specifically.** Don't say "no skills found"; say "I couldn't find a workspace called `helo` — did you mean a different workspace, or should I search globally without the prefix?" This is the "transparency over magic" path: the user named a workspace, we honor that, and we ask before second-guessing them.

When `match_notice` is non-null on a `semantic` response (no result reached `strong`/`good`), surface it verbatim — it's the server's honest "results may not match your intent" warning. Don't recompute it on your end.

### Stage 6 — Present

**For each recommended skill, include:**
- Skill name (`owner/name`)
- 1-2 sentence explanation of **WHY** this skill helps with their specific situation (not just what the skill does — why it matters for THEM)
- Quality tier and star count
- Whether it's from their workspace or the public catalog

**Group by domain** when presenting results from broad discovery:

```
Based on your Next.js + Supabase + Stripe project, here's what I found:

**Deployment:**
1. acme/vercel-deploy — Handles Next.js deployments to Vercel with preview URLs...

**Database:**
2. toolbox/supabase-patterns — Supabase query patterns and auth integration...

**Payments:**
3. stripe/checkout-kit — Stripe Checkout, subscriptions, and webhook handling...

Want me to install any of these?
```

**End with an offer to install.** Always. When the user accepts multiple skills, install them all in a single command: `npx happyskills install owner/a owner/b owner/c -y --json`. Never run separate install commands for each skill.

## When to Ask for Clarification

The clarification decision lives in SKILL.md Section 2 Step C — read it there for the full rule. The short version, restated here because this file is the authoritative reference on search reasoning:

**Ask exactly when the Section 1 rule says to ask** — i.e., when you would otherwise fan out into 2+ parallel searches and you cannot name a distinct, project-grounded reason for each one. That fan-out instinct, in the absence of distinct reasons, IS the clarification trigger. There is no separate "is this query vague?" heuristic; the fan-out check covers the vague case automatically (a truly vague query has no domain anchor, so any search strategy would be hedging across guesses).

**Do not ask when:**

- You're about to run a single focused search and you can name the domain in one sentence.
- The user named a specific skill (slug-shaped query) or a workspace/skill form — go straight to `fuzzy_slug` / `fuzzy_scoped`, no clarification.
- You've already asked one or more clarifying questions in this discovery thread and the user has answered them. The state flag in SKILL.md Section 2 Step C says "search permitted" once an answer is in; do not re-litigate.
- The clarification budget for this thread is at 2/2. Search no matter what.

**How to ask:**

- ONE question, via AskUserQuestion. Not a form. Not a sequence.
- Offer concrete options on the highest-leverage axis of branching. "Are you deploying the frontend (Vercel) or the backend (AWS Lambda)?" — good. "What are your goals?" — bad.
- Always include "Just search anyway" as the last option. If the user picks it, proceed with your best-guess decomposition and state it explicitly in SKILL.md Section 2 Step D.

**Never ask:**

- About a technology you can read from the project files (`package.json`, `requirements.txt`, etc.).
- About something the user has already told you earlier in the session — re-read your own context first.
- A minor detail that won't change the search results.

**The deeper "why":** the default for *directive* queries (where the user named a target) is still "just search" — clarification on a clear query is friction with no payoff. The hedging rule is what makes that default safe: it engages clarification only when the agent's own intent to fan out signals genuine framing ambiguity. There is no contradiction between "prefer searching over asking on a clear query" and "ask on a hedging fan-out" — they apply to different cases, identified by the agent's own internal state.

## Narrating Your Work

Tell the user what you're doing at each stage. Don't ask permission — just narrate briefly.

```
"Let me look at your project... I see a Node.js API with PostgreSQL, deployed to
AWS Lambda via Pulumi. You have 4 skills installed — none for database migrations
or deployment automation. Let me search for those..."
```

This builds trust (transparency over magic) and teaches the user what HappySkills can do.

## Handling Sparse or No Results

**No results for a domain:**
Be honest and move on: "The catalog doesn't have skills for [X] yet. I can help you with that directly." Don't run extra queries chasing results that don't exist.

**Low quality results only (all below 40):**
Present them with a caveat: "I found a few skills for [X], but their quality is limited. Here's what's available — use with caution." Then offer to help directly.

**Only one result, low quality:**
Still recommend it. A low-quality skill is better than no skill if it's the only match. The user can decide.

**Do NOT:**
- Run extra queries hoping to find something better when results are sparse
- Hide results because of low quality — quality ranks, it doesn't filter
- Apologize excessively — be matter-of-fact

## Quality Tiers

| Score | Tier | Meaning |
|---|---|---|
| 80-100 | High quality | Well-structured, rich content, strong documentation |
| 60-79 | Good | Solid skill with decent documentation |
| 40-59 | Fair | Functional but documentation could be better |
| 20-39 | Low quality | Minimal documentation or structure |
| < 20 | _(no label)_ | Very poor — still show if it's the only match |

Quality tiers are **informational**. All matching skills are shown regardless of quality.

## JSON Response Shape

```json
{
  "data": {
    "query": "...",
    "formulated_query": "...",
    "mode": "semantic",
    "match_notice": null,
    "workspace_match": null,
    "results": [
      {
        "skill": "owner/name",
        "type": "skill",
        "description": "...",
        "version": "1.0.0",
        "visibility": "public",
        "workspace_slug": "owner",
        "stars": 42,
        "quality_score": 82,
        "quality_tier": "high",
        "relevance_score": 0.0326,
        "match_quality": "strong",
        "tags": ["aws", "deployment"],
        "download_count": 1200,
        "created_at": "...",
        "updated_at": "...",
        "similar_count": 3,
        "similar_repos": [
          {
            "skill": "jdoe/owner-name-fork",
            "similarity": 0.97,
            "...": "(same fields as the top-level result)"
          }
        ]
      }
    ],
    "count": 3
  }
}
```

`similar_count: 0` and `similar_repos: []` are the common case — most results aren't representatives of a cluster (and only `semantic` mode clusters at all).

**Field-level reference:**

| Field | Type / Values | Notes |
|---|---|---|
| `query` | string \| `null` | Search term, or `null` in `list` mode (no query, only filters) |
| `formulated_query` | string | The query echoed back for display — surface it in your preamble (`data.formulated_query`). |
| `mode` | `"semantic"` \| `"fuzzy_slug"` \| `"fuzzy_scoped"` \| `"list"` | Which strategy the dispatcher picked. Always set. See "How the server picks a strategy" above. |
| `match_notice` | string \| `null` | Server-authored honest-failure message. Emitted by `semantic` (when no result hits `strong`/`good`) or `fuzzy_scoped` (when no workspace matched). `null` for `fuzzy_slug` / `list`. **Display verbatim — do not recompute on the client.** |
| `workspace_match` | object \| `null` | `fuzzy_scoped` only. The strongest matched workspace `{ slug, similarity }`, or `null` when the workspace half of `workspace/skill` didn't fuzzy-match anything (honest-failure path; `data.results` is also `[]`). Always `null` for other modes. |
| `results[].skill` | string | Fully qualified `owner/name` |
| `results[].type` | `"skill"` \| `"kit"` | Use `--type kit` to filter to kits only |
| `results[].description` | string | skill.json description (registry-search optimized) |
| `results[].version` | string | Latest published version (API derives from `default_ref`) |
| `results[].visibility` | `"public"` \| `"workspace"` \| `"private"` | Public = catalog-listed; workspace = org-only; private = owner-only |
| `results[].workspace_slug` | string | The workspace that owns the skill |
| `results[].stars` | integer | Star count |
| `results[].quality_score` | 0-100 \| `null` | Quality ranking score |
| `results[].quality_tier` | `"high"` \| `"good"` \| `"fair"` \| `"low"` \| `null` | Tier label corresponding to score |
| `results[].relevance_score` | float | Composite ranking score. Different scales per mode — only meaningful for ordering within one response, not for comparison across modes. |
| `results[].match_quality` | `"strong"` \| `"good"` \| `"partial"` \| `"weak"` \| `null` | Confidence label. Source signal differs by mode: cosine similarity in `semantic` (`strong ≥ 0.5`), trigram tier in `fuzzy_slug` / `fuzzy_scoped` (`strong ≥ 0.85`), always `null` in `list`. The labels are comparable across modes; the underlying scores are not. |
| `results[].tags` | string[] | Skill tags |
| `results[].download_count` | integer | Total downloads |
| `results[].created_at`, `updated_at` | ISO 8601 string | Timestamps |
| `results[].similar_count` | integer (≥0) | Number of near-duplicate variants the API collapsed under this representative. Non-zero only in `semantic` mode (other modes don't cluster). `0` means this result is its own cluster — the common case. |
| `results[].similar_repos` | array (max 5) | Inlined near-duplicate variants (`semantic` only). Same field shape as a top-level result, plus `similarity` (float in `[0, 1]`, where higher = more similar). Empty array when `similar_count` is `0`. The cap is 5 even when `similar_count` is larger. |
| `count` | integer | Total result count |

## Constraints

- **Never proactive** — only search when the user explicitly asks. Exception: a one-line nudge during `init` is acceptable.
- **Always use `--json`** for all search requests through the skill. The dispatcher's response includes `mode` — read it to confirm which strategy ran (especially when a slug-shaped query unexpectedly routes to `semantic`, or vice versa).
- **Always show quality caveats** for low-quality matches (score < 40).
- **Do not hide results** because of low quality.
- **Never silently rewrite the user's query** when the workspace half of `workspace/skill` doesn't match. Surface the honest failure (`workspace_match: null`) verbatim and ask the user what they meant.
