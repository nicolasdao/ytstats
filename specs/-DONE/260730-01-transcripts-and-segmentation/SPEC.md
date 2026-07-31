# SPEC — Video transcripts (opt-in scope) + the segmentation decision

Authored 2026-07-30 against `ytstats` CLI **0.6.1** / agent skill **0.7.2**.
No project spec rules are configured (`skills-config.json` absent), so only the generic authoring rules applied.

---

## §0 How to use this spec (read first)

**What this spec is.** An executable plan for two pieces of work: adding video-transcript support behind an opt-in OAuth scope (Tier 1), and settling how analytics segmentation reaches the CLI (Tier 2).

**Who you are.** A fresh LLM session with no memory of the research that produced this. Everything you need is here or reachable from §10.

### DO

- Read this file end-to-end before editing anything.
- Run `/init-context` first if it is available — it loads `docs/gotchas/`, which contains traps this spec references rather than repeats.
- Treat every `file:line` as an **anchor, not gospel**. Grep the named symbol to confirm the location before editing; lines drift.
- Implement **Tier 1 first**, one fix per commit.
- Run the verification commands in §8 after each fix.
- Update the agent skill in the **same pass** as any observable CLI change (see §7 rule 6).

### DO NOT

- Do not re-explore the codebase or re-research the YouTube API. The findings in §2 and §4 were verified against Google's docs on 2026-07-30.
- Do not refactor adjacent code. A feature is a feature.
- Do not add a runtime dependency. `package.json` dependencies are read-only (see §5).
- Do not create files other than those listed in §4.
- Do not commit or push without confirming with the user first.
- Do not edit anything under `specs/` — including this file. If you find a gap, **surface it to the user**; do not patch the spec mid-implementation.
- Do not drop the `yt-analytics-monetary.readonly` scope. See §2, "the scope that must stay".

### Suggested first 30 minutes

1. Read this spec end-to-end.
2. Read `docs/architecture.md` (design principles) and `docs/gotchas/auth.md` (token traps).
3. Run `npm test` — confirm 422 tests pass before you change anything.
4. Run `node bin/ytstats.js status 2>/dev/null | jq .data` — see the current account shape. Note there is **no** `scopes` field. That absence is §4.1.
5. Start §4.1. It is a prerequisite for everything else in Tier 1.

**No domain glossary is needed** beyond §9 — terminology is standard YouTube API vocabulary, and the four terms that are genuinely non-obvious are defined there.

---

## §1 Goal

Two independent goals, tiered by the user's priority:

1. **Transcripts (Tier 1).** Let a user pull a video's transcript with cue timings, so they can correlate *what was said* against *where viewers dropped off* — using the retention metrics that shipped in 0.6.0 (`stoppedWatching`, `startedWatching`, `totalSegmentImpressions`, `relativeRetentionPerformance`). This was the user's original motivating goal for the whole tool. It requires a new OAuth scope, which must be **opt-in** so the read-only guarantee survives for everyone who does not want it.

2. **Segmentation (Tier 2).** Decide and implement how `subscribedStatus` / `youtubeProduct` reach the CLI as a second axis on existing datasets. This is **not** new datasets — it is a new dimension on the ten already pulled. It is specced because the decision **blocks** six planned new datasets that touch the same fetchers.

---

## §2 Context

`ytstats` currently requests three **read-only** scopes and `docs/architecture.md` states as a design principle: *"Read-only by design. Only three read-only scopes are ever requested. `ytstats` has no code path that modifies a channel."*

Transcripts break that. Verified against Google's docs on 2026-07-30: **both `captions.list` and `captions.download` require `https://www.googleapis.com/auth/youtube.force-ssl`** (or `youtubepartner`). There is **no read-only variant**. `force-ssl` is full read/write — "Manage your YouTube account". `captions.download` additionally requires permission to edit the video, so it only works for videos the user owns.

Adding a scope invalidates existing consent: every current user must log in again. Hence the approved design — **opt-in second scope**, decided by the user before this spec was written.

**The scope that must stay.** A probe on 2026-07-30 requested `estimatedRevenue`, `estimatedAdRevenue`, `grossRevenue`, `cpm`, `adImpressions` and `monetizedPlaybacks` against a channel report. **All six were accepted** (`ok: true`, 0 rows); **none** returned `API_QUERY_NOT_SUPPORTED`. Google's [channel_reports page](https://developers.google.com/youtube/analytics/channel_reports) claims revenue metrics are "not currently supported for channel reports" — that claim is stale or wrong. Zero rows is consistent with an unmonetized channel (the probed channel has 52 subscribers, below the 1,000-subscriber YPP threshold).

**Consequence: do not remove `yt-analytics-monetary.readonly`.** It is likely what makes those queries legal. This makes the transcript work a purely **additive** single scope change, not a consolidation of two. Recorded here so nobody revisits it and deletes the scope.

**Helpful existing fact.** `buildAuthUrl` already sets `include_granted_scopes=true` (`src/auth/oauth.js:47`), so Google's incremental authorization is already enabled. Requesting `force-ssl` later **preserves** previously granted scopes rather than replacing them.

---

## §3 Acceptance criteria

Numeric or observable only.

**Tier 1 — transcripts**

- `npm test` passes with **no fewer than 422 tests**, and every new test is offline (no network, no browser).
- `node bin/ytstats.js status 2>/dev/null | jq '.data.accounts[0].scopes'` returns a JSON array of scope strings after a fresh `login` (currently returns `null`, because the field does not exist).
- `node bin/ytstats.js transcript <ownVideoId> 2>/dev/null | jq '.data.cues | length'` returns a number greater than 0 for a video that has captions.
- Each cue has exactly the keys `start`, `end`, `text` — verify with `jq -r '.data.cues[0] | keys | join(",")'`.
- `start` and `end` are **seconds as numbers**, not timestamp strings — verify `jq '.data.cues[0].start | type'` returns `"number"`.
- With an account whose stored `scopes` array lacks `force-ssl`, `transcript` fails with `.errors[0].code == "AUTH_SCOPE_MISSING"` and `.nextSteps[0]` contains `login --with-captions`.
- `grep -c "youtube.force-ssl" src/auth/oauth.js` returns at least 1, and `SCOPES` (the default list) still contains exactly **3** entries — verify `node -e "import('./src/auth/oauth.js').then(m => console.log(m.SCOPES.length))"` prints `3`.
- A second `transcript` call for the same video and unchanged `lastUpdated` performs **no** `captions.download` request. Assert this in a test by counting calls on the injected API bundle.
- stdout remains exactly one JSON document on every new code path, including the scope-missing failure.

**Tier 2 — segmentation**

- `node bin/ytstats.js daily --days 7 --segment subscribedStatus 2>/dev/null | jq '.data.rows[0] | has("subscribedStatus")'` returns `true`.
- Passing an unsupported value fails with `.errors[0].code == "INPUT_INVALID_CHOICE"` and `.errors[0].context.allowed` listing the accepted dimensions.
- `daily --days 7` with no `--segment` returns rows **without** a segment key — verify the shape is unchanged from 0.6.1.
- `search-terms` and `traffic-source-details` **reject** `--segment` with `INPUT_INVALID_CHOICE` (see §4.7 for why).

**Both tiers**

- `bash .agents/skills/release-cli/scripts/skill-sync-check.sh` reports `PASS` with no `MISSING` lines.
- `npx happyskills validate ytstats --json` reports `"valid": true`.
- `python3 .claude/skills/init-doc/scripts/build-doc-manifest.py --root . --check` exits clean.

---

## §4 The work

### Tier 1 — transcripts

Fixes §4.1–§4.6. **§4.1 is a hard prerequisite** — without it nothing can tell whether a token has the captions scope.

#### §4.1 Persist the granted scopes on each account

**Symptom:** There is no way to know whether a stored token can call the captions API. `ytstats status` shows no scope information, and every account record lacks the field.

**Where it lives:**
- `saveAccount` in `src/auth/tokens.js:38` — the persisted account shape. It stores `channelId`, `channelTitle`, `customUrl`, `clientId`, `authorizedAt`, `tokens`. **No `scopes`.**
- `login` in `src/auth/session.js:121`; the token exchange is `client.getToken(...)` at `src/auth/session.js:150`.

**Why it happens:** The field was never needed — all three scopes were constant, so any stored token had all of them by definition. An opt-in scope makes the grant variable, so it has to be recorded.

**How to fix:**
1. Google's token response includes a space-separated `scope` string. At `src/auth/session.js:150` the result is destructured as `{ tokens }`; read `tokens.scope`.
2. Pass `scopes: tokens.scope ? tokens.scope.split(' ') : null` into `saveAccount`.
3. In `saveAccount`, persist `scopes` using the **same fallback pattern** the neighbouring fields already use: `scopes: scopes ?? existing?.scopes ?? null`. This matters — the refresh write-back path (`client.on('tokens', …)` in `src/auth/session.js`) calls `saveAccount` with a partial payload and no scopes, and must not erase them. This is the identical trap documented as *"An absent client binding is unknown, not a mismatch"* in `docs/gotchas/auth.md`.
4. Surface `scopes` on each account in the `status` command output (`src/cli.js`, the `status` action). It is not token material — scope names are not secrets — so it is safe to print and must **not** be redacted.

**Done when:** After a fresh `login`, `status` shows a `scopes` array on the account. A pre-existing account still shows `null` and no command crashes.

**Stop and ask if:** `tokens.scope` is absent from Google's response in practice. Do not synthesize the value from `SCOPES` — a fabricated grant record is worse than a null one, because §4.3 branches on it.

---

#### §4.2 Add the opt-in captions scope and `login --with-captions`

**Symptom:** No way to request captions access.

**Where it lives:**
- `SCOPES` in `src/auth/oauth.js:8` — must stay exactly three entries.
- `buildAuthUrl` in `src/auth/oauth.js:35` — already takes `scopes = SCOPES` as a parameter, so it needs no change.
- Two call sites already pass the scope list explicitly and are the only places that need changing: `browserFlow` at `src/auth/session.js:191` and `pasteFlow` at `src/auth/session.js:214`, both `scopes: SCOPES`.
- `login` in `src/auth/session.js:121`.

**How to fix:**
1. Export a separate constant beside `SCOPES`, e.g. `export const CAPTIONS_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';`. **Do not add it to `SCOPES`.**
2. Give `login()` a `withCaptions` option. When true, pass `scopes: [...SCOPES, CAPTIONS_SCOPE]` to both `browserFlow` and `pasteFlow`. Both already accept a `scopes` argument path via `buildAuthUrl`.
3. Add `--with-captions` to the `login` command in `src/cli.js`, wired to that option.
4. Update the comment above `SCOPES` (`src/auth/oauth.js:7`) — it currently reads "Read-only scopes only. ytstats never requests write access to a channel." That becomes false when the flag is used. Replace it with a note that the default list is read-only and the captions scope is opt-in only.

**Done when:** `SCOPES.length === 3`. `login --with-captions` produces an auth URL containing `youtube.force-ssl` (assert in a test against the injected `buildAuthUrl` / auth URL string — the existing oauth tests show the pattern).

**Stop and ask if:** you find yourself wanting to make `force-ssl` the default for convenience. It is not — that decision was made deliberately and reversing it silently breaks the read-only guarantee for every existing user.

---

#### §4.3 Add the `AUTH_SCOPE_MISSING` diagnostic

**Symptom:** A user who logged in without `--with-captions` runs `transcript` and gets an opaque Google 403.

**Where it lives:** `DIAGNOSTICS` in `src/diagnostics.js`; the `def()` helper is at `src/diagnostics.js:60`, and `AUTH_NO_TOKENS` at `src/diagnostics.js:84` is a good shape to copy.

**How to fix:**
1. Add `AUTH_SCOPE_MISSING` with `exitCode: EXIT.AUTH`, `recoverable: true`, `retryable: false` (re-running the same command cannot help; the user must re-authorize).
2. Remediation must name the exact command: `ytstats login --with-captions`. Explain that this re-opens the browser and that existing scopes are preserved because incremental authorization is already enabled.
3. Diagnostic `code` values are public API — add, never repurpose. The catalog test will fail unless the entry has a title, detail, cause, and at least one remediation step.
4. **Treat an absent `scopes` field as unknown, not as missing.** For accounts created before §4.1, `scopes` is `null`; in that case attempt the call and let a real Google 403 surface. Only raise `AUTH_SCOPE_MISSING` pre-flight when `scopes` is a **present array that lacks** the captions scope. Same precedent as the client binding in `docs/gotchas/auth.md`.

**Done when:** With a stored account whose `scopes` array omits `force-ssl`, `transcript` exits 2 with `AUTH_SCOPE_MISSING` and `nextSteps[0]` containing `login --with-captions`. With `scopes: null`, the command attempts the API call instead.

---

#### §4.4 Add the captions fetchers

**Symptom:** No code can reach the captions API.

**Where it lives:** New file `src/api/captions.js`. Follow `src/api/reporting.js` for structure. `createApis` is at `src/api/client.js:10` and must expose the `youtube` client already present (captions live on the Data API v3, so no new API surface is needed).

**How to fix:**
1. `listCaptionTracks(apis, videoId)` → `youtube.captions.list({ part: 'snippet', videoId })`. Return `{ id, language, trackKind, isAutoSynced, isDraft, lastUpdated }` per track.
2. `downloadCaptionTrack(apis, trackId, { format = 'vtt' })` → `youtube.captions.download({ id: trackId, tfmt: format })`. **Wrap every call in `call()`** from `src/api/client.js`, like every other request in `src/api/*.js`. The general rule, documented in `docs/gotchas/youtube-api.md`: *every path that can fail with a Google error must reach `mapGoogleError`* — a bare `await` is a latent `UNEXPECTED`.
3. **Track selection** (decided by the user): prefer a manually-written track (`trackKind` is not `ASR`) in the channel's default language; fall back to the auto-generated one. Skip tracks where `isDraft` is true. **Report which track was chosen** in the command output (`trackId`, `language`, `trackKind`) so the choice is never silent.
4. Add a cue parser. `vtt` and `srt` share the shape `HH:MM:SS.mmm --> HH:MM:SS.mmm`; the only difference is that `srt` uses a **comma** before milliseconds. Write **one** parser handling both, in `src/api/transforms.js` beside `parseCsv` (which is the precedent for a hand-rolled parser in this project — no new dependency). Output cues as `{ start, end, text }` with times as **seconds (numbers)**, because retention is expressed as `elapsedVideoTimeRatio` and the consumer needs numbers to align them.
5. Add tests asserting the **exact query parameters** sent (`part`, `videoId`, `id`, `tfmt`) — that is this project's standard for API fetchers, not merely checking the return shape.

**Done when:** Tests pass asserting exact parameters, and the parser test asserts real values — a specific `start`, `end` and `text` from a small real-shaped VTT fixture, **not** just `cues.length`. See §7 rule 5.

**Stop and ask if:** `captions.download` returns a format you cannot parse, or returns binary. Do not add a dependency to handle it.

---

#### §4.5 Add the `transcript` command with archive caching

**Symptom:** No user-facing way to get a transcript.

**Where it lives:**
- `src/cli.js` — add the command near `retention` (`src/cli.js:655`). It takes a `<videoId>` argument like `retention` does, and needs **no** date flags.
- Caching: `src/archive.js` — `dataDir()` at `:39`, `appendRows` at `:147`, `readRows` at `:176`.

**⚠ Trap — the archive path validator rejects YouTube video ids.** `safeType` at `src/archive.js:47` validates against `/^[a-zA-Z0-9_]+$/` — **no hyphen**. YouTube video ids are `[A-Za-z0-9_-]{11}` and routinely contain hyphens, so `appendRows(videoId, …)` **will throw** for a large fraction of videos. Verified 2026-07-30.

**How to fix:**
1. Do **not** loosen `safeType` — it guards the report-type path against traversal and that protection is load-bearing.
2. Add a **separate** transcript store function in `src/archive.js` with its own validator that permits `-` while still rejecting `/`, `\`, `.`, `..`, absolute paths and NUL. Store under a distinct subdirectory, e.g. `<dataDir>/transcripts/<videoId>.json`. Keep files `0600` and directories `0700`, matching the existing constants at `src/archive.js:24-25`.
3. **Cache invalidation:** captions can be edited, so key the cache on the track's `lastUpdated` from `captions.list`. On each run, list tracks (cheap) and only download when the cached `lastUpdated` differs or nothing is cached. Store `lastUpdated` alongside the cues.
4. Return `{ videoId, trackId, language, trackKind, lastUpdated, cachedAt, cues }`.
5. Emit a `DATA_EMPTY` warning when the video has no caption tracks — "worked and found nothing" must stay distinguishable from "failed", per the existing convention in `simple()` at `src/cli.js:586`.

**Done when:** Acceptance criteria in §3 for cue shape and the no-second-download assertion pass. A video id containing a hyphen caches successfully — **add a test using such an id specifically**, since that is the trap.

**Stop and ask if:** you conclude the transcript belongs in the same NDJSON files as report data. It does not — captions do not expire, the record is one document per video rather than an append-only row stream, and mixing them would make `archive` totals meaningless.

---

#### §4.6 Update the docs and the agent skill

**Where it lives:** `docs/cli.md`, `docs/auth.md`, `docs/architecture.md`, `docs/configuration.md`, `docs/output-contract.md`, `docs/gotchas/auth.md`, `docs/gotchas/youtube-api.md`, `CHANGELOG.md`, then `.agents/skills/ytstats/`.

**How to fix:**
1. `docs/architecture.md` — the "Read-only by design" principle is now conditional. Rewrite it to state that the **default** grant is three read-only scopes and that write-capable `force-ssl` is opt-in via `login --with-captions`, requested only when the user asks. Do not delete the principle; qualify it precisely.
2. `docs/auth.md` — document the opt-in flow, the `scopes` field on accounts, and that incremental authorization preserves prior grants.
3. `docs/output-contract.md` — add `AUTH_SCOPE_MISSING` to the diagnostic catalog table.
4. New gotcha in `docs/gotchas/youtube-api.md`: captions require a write-capable scope with no read-only variant, and `captions.download` only works for videos you own.
5. New gotcha in `docs/gotchas/auth.md`: an absent `scopes` field means unknown, not missing — with the reasoning from §4.3 step 4.
6. Update each touched doc's `source` globs if it now documents `src/api/captions.js`. `doc-manifest.json` is **generated** — regenerate it, never hand-edit.
7. **Agent skill**, per `CLAUDE.md`: `transcript` into `references/commands.md` **and** the `SKILL.md` routing table; `AUTH_SCOPE_MISSING` into `references/troubleshooting.md`; the new `data` shape into the `SKILL.md` shapes table; the cue-timing-vs-`elapsedVideoTimeRatio` correlation guidance into `references/interpreting-results.md`; and raise `systemDependencies.ytstats.version` in `skill.json`. Bump the skill version and add a `CHANGELOG.md` entry.

**Done when:** `skill-sync-check.sh` reports PASS, `happyskills validate` is valid, and the manifest `--check` exits clean.

**Stop and ask if:** you are unsure whether the skill needs a version-floor raise. The rule from `CLAUDE.md`: raise it whenever a release changes behaviour the skill's guidance depends on — a new command always does.

---

### Tier 2 — segmentation

Independent of Tier 1; may ship first if preferred. **It unblocks the dataset checklist in §10.**

#### §4.7 Add `--segment <dimension>` to dataset commands

**Symptom:** `subscribedStatus` and `youtubeProduct` are supported by the API on nearly every report but unreachable from the CLI. There is no way to ask "how do subscribers behave differently from non-subscribers".

**Decision (made by the user, 2026-07-30):** a **single generic `--segment <dimension>` flag** on dataset commands. Rejected alternatives: per-command named flags (make `data` shape vary by invocation, so the envelope contract and the skill must describe it per-command) and separate commands per segment (pushes a 26-command surface past 40 and doubles with every future dataset).

**Where it lives:**
- `simple()` at `src/cli.js:586` — the helper that defines the nine date-windowed dataset commands. Adding the flag here reaches all of them at once, exactly as the `onDegraded` wiring does.
- The private `query()` helper at `src/api/analytics.js:17` builds `dimensions`.

**How to fix:**
1. Add `--segment <dimension>` via `simple()`, validated against an enumerated set — `subscribedStatus`, `youtubeProduct` — using `INPUT_INVALID_CHOICE` with `context.allowed`, following the existing `Option().choices()` pattern used by `videos --sort` in `src/cli.js`.
2. Append the segment to the fetcher's `dimensions` string and surface the value as a column on each returned row.
3. **Exclude the fragile fetchers.** `fetchSearchTerms` and `fetchTrafficSourceDetails` use `insightTrafficSourceDetail`, which per `docs/gotchas/youtube-api.md` requires both `sort` and `maxResults`, breaks above ~25 results, and tolerates **only** the `views` metric. Adding a dimension there is very likely to fail. Reject `--segment` on those two commands with `INPUT_INVALID_CHOICE` rather than letting YouTube return an opaque error.
4. Reuse the existing tiered-fallback machinery rather than inventing new degradation. If a segment is rejected for a given report, `queryTiered` at `src/api/analytics.js:45` and the `ANALYTICS_METRICS_UNSUPPORTED` diagnostic already express "we asked for more than this channel serves".
5. Validation runs **before** authentication — that is the established ordering (`run()`'s `validate` callback in `src/cli.js`), so a bad `--segment` value never costs a login round trip.

**Done when:** §3's Tier 2 criteria pass, including the unchanged default shape and the two rejections.

**Stop and ask if:** more than two dimensions look worth supporting (e.g. `audienceType`, which the API allows on retention only). Do not silently widen the enumerated set — each addition changes what the skill must document.

---

#### §4.8 Document segmentation

**How to fix:** `docs/cli.md` (the flag, the enumerated values, the two exclusions and why), `docs/youtube-apis.md` (the dimension being appended), `CHANGELOG.md`, and the agent skill — `references/commands.md`, the `SKILL.md` shapes table (rows gain a segment column when the flag is used), and `references/interpreting-results.md` for how to read a segmented result without double-counting: **segmented rows partition the total, so summing across segments must reproduce the unsegmented figure.** Say that explicitly; it is the obvious way to get a wrong answer.

**Done when:** `skill-sync-check.sh` PASS, manifest `--check` clean.

---

## §5 Non-goals

- Do **not** add `youtube.force-ssl` to the default `SCOPES` list.
- Do **not** remove `yt-analytics-monetary.readonly` — see §2.
- Do **not** implement transcript↔retention correlation inside `ytstats`. The user chose to emit the two primitives separately; the join is the consumer's job, consistent with `docs/youtube-apis.md`: *"Mapping it onto a particular database schema is the consumer's job."*
- Do **not** add a `--with-transcript` flag to `retention`. Same reason.
- Do **not** add the six planned new datasets (city/province/dma, `operatingSystem`, `sharingService`, playlists, the nine unfetched card/annotation metrics). They follow the recipe in `docs/contributing.md` and are deliberately **not** in this spec — but do them only **after** §4.7, or you will rework all six.
- Do **not** add a `revenue` command in this spec, even though §2 shows the queries are accepted. It is a separate, non-breaking addition.
- Do **not** add a runtime dependency. `commander`, `googleapis`, `open` only — all pure JS, which is why `npx ytstats` starts instantly.
- Do **not** loosen `safeType` in `src/archive.js`.
- Do **not** create a git branch or open a PR. `CLAUDE.md`: work directly on `master`.
- Do **not** edit `doc-manifest.json` by hand.
- Do **not** modify anything under `specs/`, including this file.

---

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
|---|---|---|
| 1 | **Quota cost of `captions.download` was not verified.** It is believed to be substantially more expensive than a `videos.list` batch (possibly ~200 units against a 10,000/day budget, which would cap you near 50 transcripts/day), but this was **not** confirmed against Google's quota calculator during research. | Check the [quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost) **before** implementing any bulk path. If it is expensive, the command must stay one-video-at-a-time with no batch mode, and the caching in §4.5 becomes load-bearing rather than an optimization. Do not add a "fetch all transcripts" command in this spec. |
| 2 | Whether `tokens.scope` is reliably present in Google's token response for this flow was reasoned from the OAuth spec, not observed. | §4.1's stop-and-ask clause covers it: if absent, surface to the user rather than synthesizing the value. |
| 3 | Whether `subscribedStatus` is accepted on **every** one of the nine dataset commands is not individually verified — Google documents broad support, but this project has repeatedly found per-channel variation (see the three `insightTrafficSourceDetail` traps). | Rely on the existing tiered fallback (§4.7 step 4) rather than a hardcoded allow-list per command. Let a rejection surface as a diagnostic. |
| 4 | Revenue metrics returned 0 rows on an unmonetized channel; whether a monetized channel returns real figures is unknown. | Irrelevant to this spec's work — recorded in §2 only to prevent the scope being dropped. Do not act on it. |
| 5 | Whether `captions.download` works for auto-generated (ASR) tracks is not stated in Google's docs. | §4.4 prefers manual tracks anyway. If ASR download fails, report it as a diagnostic rather than falling back silently, and surface the finding to the user. |

---

## §7 Anti-hallucination guardrails

1. No new files except `src/api/captions.js` and its test file, plus any new test file for §4.7. Everything else is an edit to a listed existing file.
2. `package.json` dependencies are read-only. No new runtime dependency, for any reason.
3. No "while I'm here" cleanups. A feature is a feature.
4. Do not invent new abstractions. Minimum diff. Follow the existing patterns named in §4 (`call()`, `simple()`, `queryTiered`, `def()`, `parseCsv`).
5. **Assert a value, not just a shape**, on anything that maps external field names. A test checking `cues.length` passes against a result where every `text` is `undefined` — that is exactly how the reach-CSV column mismatch survived two months (`docs/gotchas/youtube-api.md`). Pin the cue parser with a real-shaped fixture and assert an actual timestamp and string.
6. The agent skill must be updated in the same pass as the CLI change. Nothing detects skill drift automatically — `doc-manifest.json`'s `--affects` map covers `README.md` and `docs/**` only. Run `bash .agents/skills/release-cli/scripts/skill-sync-check.sh`; it warns and never blocks, so a PASS is necessary but not sufficient — also re-read what the skill *says* about anything you changed.
7. One fix per commit, single-line conventional format (`feat(scope): …`, `fix(scope): …`). Stage files individually **by name**; never `git add -A` or `git add .` — there is untracked tooling under `.agents/skills/` that must not be swept in.
8. Never use `--no-verify`.
9. Do not commit or push without the user confirming. Do not run `npm publish`.
10. Do not re-run the research this spec already did. Trust §2 and §4; grep the anchors to confirm locations.
11. Tests must stay **offline**. Every effect is injected — `buildProgram({ makeApis })` exists precisely so authenticated command paths can be driven without network. Use it.

---

## §8 Verification commands

```bash
# Baseline before touching anything — expect 422 passing
npm test

# Current account shape: note there is no `scopes` field yet (that is §4.1)
node bin/ytstats.js status 2>/dev/null | jq '.data.accounts[0]'
```

**Network note for this machine.** Every command that reaches Google needs the IPv6 workaround, or it fails as a misleading `NETWORK_UNREACHABLE`:

```bash
export NODE_OPTIONS=--no-network-family-autoselection
```

```bash
# Tier 1 — after §4.2, confirm the default scope list is still exactly 3
node -e "import('./src/auth/oauth.js').then(m => console.log(m.SCOPES.length, m.SCOPES))"

# Tier 1 — resolve a video id you own, then pull its transcript
node bin/ytstats.js videos -n 5 2>/dev/null | jq -r '.[]? // .data[] | "\(.id)  \(.title)"'
node bin/ytstats.js transcript <videoId> 2>/dev/null | jq '{trackId: .data.trackId, trackKind: .data.trackKind, cues: (.data.cues|length), first: .data.cues[0]}'

# Cue times must be numbers in seconds, not strings
node bin/ytstats.js transcript <videoId> 2>/dev/null | jq '.data.cues[0].start | type'

# Second run must not re-download — check stderr progress and the cache file
ls -la "$(node bin/ytstats.js archive 2>/dev/null | jq -r .data.dataDir)/transcripts/"

# Tier 2 — segmentation
node bin/ytstats.js daily --days 7 --segment subscribedStatus 2>/dev/null | jq '.data.rows[0]'
node bin/ytstats.js daily --days 7 --segment nonsense 2>/dev/null | jq '.errors[0] | {code, context}'
node bin/ytstats.js search-terms --days 7 --segment subscribedStatus 2>/dev/null | jq '.errors[0].code'

# Both tiers — the three sync checks
bash .agents/skills/release-cli/scripts/skill-sync-check.sh
npx happyskills validate ytstats --json | jq '.data.valid'
python3 .claude/skills/init-doc/scripts/build-doc-manifest.py --root . --check
```

**Credentials.** A working login already exists on this machine. If `status` shows no account, **ask the user** — do not attempt to create Google Cloud credentials yourself. Re-authorizing with `--with-captions` opens a real browser and requires the user's consent; ask before running it.

---

## §9 Domain glossary

| Term | Meaning |
|---|---|
| `elapsedVideoTimeRatio` | Retention's x-axis: elapsed fraction of the video, `0`–`1`. Caption cues are in **seconds**, so aligning the two requires the video's duration. |
| `trackKind` | Caption track type from `captions.list`. `ASR` means auto-generated by speech recognition; anything else is manually written or uploaded. |
| Cue | One timed caption entry: a start time, an end time, and its text. |
| Segment (this spec) | A second dimension applied to an existing report — `subscribedStatus` or `youtubeProduct` — partitioning rows rather than adding a new dataset. |
| ASR | Automatic Speech Recognition — YouTube's auto-captioning. |

---

## §10 References

**Project docs (read these, do not re-derive them)**
- `docs/architecture.md` — design principles, the injection seams, module map
- `docs/auth.md` + `docs/gotchas/auth.md` — the OAuth model and its traps
- `docs/gotchas/youtube-api.md` — API traps, including the three `insightTrafficSourceDetail` failures and the reach-CSV lesson behind §7 rule 5
- `docs/cli.md` — the current 26-command surface
- `docs/output-contract.md` — envelope invariants and the 38-code diagnostic catalog
- `docs/contributing.md` — the 6-step "Adding a new dataset" recipe (used by the deferred checklist below)
- `CLAUDE.md` — branching, committing, and the skill-sync requirement

**External (verified 2026-07-30)**
- [captions.list](https://developers.google.com/youtube/v3/docs/captions/list) / [captions.download](https://developers.google.com/youtube/v3/docs/captions/download) — scopes, formats, ownership requirement
- [Analytics dimensions](https://developers.google.com/youtube/analytics/dimensions) — `subscribedStatus`, `youtubeProduct`, `audienceType`
- [Analytics channel reports](https://developers.google.com/youtube/analytics/channel_reports) — note its revenue claim is contradicted by §2
- [Quota costs](https://developers.google.com/youtube/v3/determine_quota_cost) — needed for §6 uncertainty 1

**Deferred work — not in this spec**
- Six new datasets: city/province/dma geography, `operatingSystem`, `sharingService`, playlist reports, the nine unfetched card/annotation metrics. Follow `docs/contributing.md`. **Do these after §4.7.**
- A `revenue` command — the scope is already granted and the queries already accepted (§2).

**Code anchors**

```
SCOPES                        src/auth/oauth.js:8
buildAuthUrl                  src/auth/oauth.js:35
include_granted_scopes        src/auth/oauth.js:47
login                         src/auth/session.js:121
client.getToken               src/auth/session.js:150
browserFlow scopes            src/auth/session.js:191
pasteFlow scopes              src/auth/session.js:214
getAuthenticatedClient        src/auth/session.js:52
saveAccount                   src/auth/tokens.js:38
def (diagnostic helper)       src/diagnostics.js:60
AUTH_NO_TOKENS (shape to copy) src/diagnostics.js:84
createApis                    src/api/client.js:10
query (private)               src/api/analytics.js:17
queryTiered                   src/api/analytics.js:45
fetchAudienceRetention        src/api/analytics.js:316
buildProgram (deps/makeApis)  src/cli.js:37
withApis                      src/cli.js:127
simple                        src/cli.js:586
retention command             src/cli.js:655
safeType (rejects hyphens)    src/archive.js:47
dataDir                       src/archive.js:39
appendRows                    src/archive.js:147
readRows                      src/archive.js:176
```
