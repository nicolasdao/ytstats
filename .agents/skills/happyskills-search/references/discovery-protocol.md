# Discovery Protocol — Envelope-Driven Flow

This document is the contract for the `next_step` envelope that `npx happyskills search` and `npx happyskills postlex` emit during the discovery protocol. Read this when you see `next_step` in a CLI response — the CLI is telling you what to do next.

## The contract in one sentence

Every CLI command in the discovery flow returns the canonical six-key envelope `{ ok, data, error, next_step, warnings, meta }`. **If `next_step` is non-empty, do what `next_step.instructions` says. Otherwise the flow is done — render `data`.**

## Defaults

- Always include `--with-rerank --limit 50` on initial search inside this agentic session — you are the LLM that powers the rerank step, so it costs nothing.
- `--with-rerank` is silently ignored on non-semantic dispatches (slug-shape queries, `workspace/skill` form, `--exact` mode). The protocol applies only when the server routes to `mode: semantic`.
- The clarification budget is a hard cap of 2 turns per session. The CLI tracks it; you carry it forward in `--clarification-turns-used`. Never exceed.
- Always include the formulated query in user-visible output — `data.formulated_query` is provided for this.

## Action values you will see

### `rank_digests_inline`

The CLI fetched candidates and asks you to rank them with your own judgment.

- `data.rerank_digests` — prose summaries you rank on, one entry per candidate. Each has `{ candidate_id, slug, lex_tier, digest }`.
- `data.rerank_system_prompt` — use as your system instructions for the ranking subtask. Treat it as ephemeral guidance, not your main role.
- `data.rerank_response_schema` — emit JSON matching this OpenAI strict schema exactly.
- Aim for **10–30 items** in your `ranking[]`. Default ~20. Emit fewer when remaining candidates aren't clearly differentiated. Rationales should describe **effect, not implementation** — "Best match because it specifically targets Fastify hot-reloading," not "highest cosine similarity."
- After emitting the ranking JSON, **pipe it to `happyskills postlex`** as instructed. Pass through the values from `next_step.context` (the original query and the clarification budget).

### `clarify_query`

The CLI determined the query needs clarification before it can return strong results.

- `next_step.context.suggested_questions` — array of `{ question, options }`. Pick **one** question.
- `next_step.context.max_turns_remaining` — clarifications you have left. The CLI enforces the cap; if you're at 0, the action will not be `clarify_query`.
- Use your agent's native question mechanism (AskUserQuestion in Claude Code). Present one question with its options.
- **The last option in `options` is always "Just search anyway"** — honor it by re-running the search with the original query and the same `--clarification-turns-used` value (do not increment).
- When the user picks a real option, reformulate the query incorporating their answer, then re-run `npx happyskills search "<refined>" --with-rerank --json --limit 50 --clarification-turns-used <max - max_turns_remaining + 1>`. The instructions field tells you the exact next command.
- Style: rationales and clarifying questions describe effect, not jargon. The user doesn't care about cosine similarity, RRF, MMR, or "match_quality" — they care about whether the skill solves their problem.

### `retry_rank`

Your previous ranking didn't pass schema validation.

- Re-emit a ranking matching the `rerank_response_schema` from the original search response, then re-pipe to `happyskills postlex`.
- **Maximum one retry.** If the second attempt also fails, render the search results without rerank — the API's `relevance_score` order is the fallback baseline and never produces a worse result than what the user would have seen pre-rerank.

### `present_to_user`

The flow is complete. Render the results.

- For `postlex` output, the field is `data.final_ordering` — already-reranked rows in display order, each with `slug`, `name`, `description`, `match_quality`, `star_count`, and `rationale`.
- For `search` output without rerank, the field is `data.results` (the standard semantic-mode shape).
- Follow Section 8 of SKILL.md for the rendering rules. Include `data.formulated_query` in the preamble.
- If the instructions field notes that the clarification budget is spent and no top result is a strong match, surface that honestly in the user-facing copy — don't pretend you have a confident match when you don't.

## Fallback rules

- LLM output fails to parse → CLI returns `retry_rank`. Retry once. Still fails → render baseline `data.results` without rerank.
- `postlex` exits non-zero → render baseline `data.results` and tell the user the rerank step failed; do not block on it.
- Server returned no `rerank_digests` (e.g., feature disabled, non-semantic mode) → no envelope; render `data.results` as-is. Normal path, no error.
- Network failure on telemetry (silent) → never affects user-facing flow. Telemetry is best-effort observability.
