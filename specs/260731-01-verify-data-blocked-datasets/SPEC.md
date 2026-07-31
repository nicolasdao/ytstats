# SPEC — Verify the four datasets that had no data to test against

Authored 2026-07-31 against `ytstats` CLI **0.9.0** / agent skill **0.10.1**.
No project spec rules are configured (`skills-config.json` → `nicolasdao/init-spec.rulesFile` is empty), so only the generic authoring rules applied.

**This spec is dormant until the channel produces data.** It is not work to start today. See §2 for how to tell when it is ready.

---

## §0 How to use this spec (read first)

**What this spec is.** A verification pass over four `ytstats` features whose code paths have never had a real value flow through them, because the channel they were built against had no such data. This is *not* a feature spec — nothing new gets built. You confirm that already-shipped code returns correct values, and fix it if it does not.

**Who you are.** A fresh LLM session with no memory of the work that shipped these commands. Everything you need is here or reachable from §10.

### DO

- Read this file end-to-end before running anything.
- Run `/init-context` first if available — it loads `docs/gotchas/`, which contains the traps this spec references rather than repeats.
- **Run §4.0 (the preflight) first.** It tells you which of the four items have data. Skip the ones that do not, and say so in your final report.
- Treat every `file:line` as an **anchor, not gospel**. Grep the named symbol to confirm before editing; lines drift.
- Fix what you find broken, and pin each fix with a test built from a **captured** payload (see §7 rule 3).
- One fix per commit, single-line conventional format.

### DO NOT

- Do not re-explore the codebase or re-research the YouTube API. §2 and §4 were verified live on 2026-07-31.
- Do not add features. The six commands and their flags are settled; this is verification only.
- Do not add a runtime dependency. `package.json` dependencies are read-only.
- Do not create files other than those listed in §4.
- Do not commit or push without confirming with the user first.
- **Do not cut a release, run `npm publish`, or publish the agent skill.** Commit, then stop and ask (decided by the user, 2026-07-31).
- Do not edit anything under `specs/` — including this file. If you find a gap, **surface it to the user**; do not patch the spec mid-implementation.
- Do not "fix" a zero that is genuinely zero. §4 tells you how to tell the difference for each item.

### Suggested first 30 minutes

1. Read this spec end-to-end.
2. `npm test` — confirm **528 tests** pass before touching anything.
3. Run the §4.0 preflight. Write down which of the four items are testable today.
4. Start with whichever of §4.1–§4.4 the preflight cleared. They are independent; any order is fine.

**No domain glossary is needed** beyond §9 — the terminology is standard YouTube Analytics vocabulary, and the four non-obvious terms are defined there.

---

## §1 Goal

Confirm that four shipped features return **correct values**, not merely well-shaped ones, now that the channel has data they never had before:

1. `ytstats playlists` — per-playlist rows
2. `ytstats revenue` — non-zero earnings figures
3. `ytstats cards` — non-zero card/end-screen engagement
4. `ytstats retention` — the drop-off metrics `startedWatching` and `stoppedWatching`

Each was shipped with its **request** verified against the live API and its **response mapping unverified**, because the channel returned nothing or all-zeros. That is the exact condition that produced two shipped-broken releases in this project's history (§2).

---

## §2 Context

Three of these commands shipped in `ytstats` 0.9.0 (2026-07-31) and one predates it. All four were exercised against a channel that could not prove them:

| Item | Why it could not be verified | What *was* verified |
|---|---|---|
| `playlists` | The channel had no playlist traffic — the `playlist` dimension returned **0 rows** | The request is accepted; `isCurated==1` is refused by the API and is not sent |
| `revenue` | The channel is unmonetized (52 subscribers, below the 1,000-subscriber YouTube Partner Programme threshold) — every metric returned **0** | All eight metrics are accepted; the query returns 363 rows **only when `sort` is set** |
| `cards` | The channel uses no cards or end screens — all eleven counters returned **0** | All eleven metrics are accepted |
| retention drop-off | The channel **refuses** `startedWatching`/`stoppedWatching`; requesting either alone returns `An internal error has occurred.` | The four-tier fallback correctly degrades and warns |

**Why this matters more than it looks.** This project has shipped broken twice for precisely this reason, both times with every test green:

- **The reach CSV regression** — `fetchReach` read `impressions` when the CSV header is `video_thumbnail_impressions`. Every row was `null` for two months with `ok: true` and no warning.
- **`transcript` on 0.7.0** — returned zero cues for every video, because `captions.download` hands back a Blob and the fixtures were hand-written strings.

Both survived because the tests asserted *shape* against *invented* fixtures. `docs/testing.md` now carries the rule that came out of it: **"Use a captured payload, not one you wrote."** A test built on a fixture you authored verifies your belief against itself.

The three 0.9.0 commands are in that state today. Their tests assert the request parameters exactly — which is real protection — but their row mappings (`r.playlist` → `playlistId`, `r.estimatedRevenue` → `estimatedRevenue`, and so on) have never been confirmed against a payload containing a non-zero value.

**How to tell this spec is ready to run.** Any one of these makes at least part of it actionable:

- The channel crosses **1,000 subscribers** and is accepted into the YouTube Partner Programme → §4.2 becomes testable.
- The channel gains a **playlist that accumulates views** → §4.1.
- The creator adds **cards or end screens** to a video and it accrues impressions → §4.3.
- Retention drop-off metrics start being served — re-check with §4.0; per-channel support varies and can change → §4.4.

---

## §3 Acceptance criteria

Numeric or observable only. Each applies **only to items the §4.0 preflight cleared**; items without data are reported as still-unverified rather than failed.

- `npm test` passes with **no fewer than 528 tests**, and every new test is offline (no network).
- For each cleared item, a test exists whose fixture is a **verbatim captured payload** containing at least one **non-zero** value, and which asserts that specific value — not `rows.length`.
- `node bin/ytstats.js playlists --days 365 2>/dev/null | jq '.data.rows[0] | {playlistId, views, playlistStarts}'` returns a real playlist id and a views count greater than 0.
- `node bin/ytstats.js revenue --days 90 2>/dev/null | jq '[.data.rows[] | select(.estimatedRevenue > 0)] | length'` returns a number greater than 0.
- `node bin/ytstats.js cards --days 90 2>/dev/null | jq '[.data.rows[] | select(.cardImpressions > 0)] | length'` returns a number greater than 0.
- `node bin/ytstats.js retention <videoId> --days 3650 2>/dev/null | jq '.data.curve[0].stoppedWatching'` returns a number rather than `null`, **and** the envelope carries no `ANALYTICS_METRICS_UNSUPPORTED` warning naming those metrics.
- Every value the CLI reports matches the same field in a raw API call for the same window (the §8 comparison script). A mismatch is the defect this spec exists to catch.
- `bash .agents/skills/release-cli/scripts/skill-sync-check.sh` reports `PASS` with no `MISSING` lines.
- `npx happyskills validate ytstats --json` reports `"valid": true` with `checks_warned: 0`.
- `python3 .claude/skills/init-doc/scripts/build-doc-manifest.py --root . --check` exits clean.

---

## §4 The work

Fixes are independent — do the ones the preflight clears, in any order.

### §4.0 Preflight — decide what is testable today

**Do this first.** It costs four API calls and determines the whole session's scope.

```bash
export NODE_OPTIONS=--no-network-family-autoselection   # see §8, this machine needs it

node bin/ytstats.js channel 2>/dev/null | jq '{subs: .data.subscriberCount, videos: .data.videoCount}'
node bin/ytstats.js playlists --days 365 2>/dev/null | jq '{rows: (.data.rows|length)}'
node bin/ytstats.js revenue  --days 365 2>/dev/null | jq '{nonZero: ([.data.rows[] | select(.estimatedRevenue > 0)] | length)}'
node bin/ytstats.js cards    --days 365 2>/dev/null | jq '{nonZero: ([.data.rows[] | select(.cardImpressions > 0)] | length)}'
```

For retention, pick any video id from `node bin/ytstats.js videos -n 5 2>/dev/null | jq -r '.data[].id'` and run:

```bash
node bin/ytstats.js retention <videoId> --days 3650 2>/dev/null \
  | jq '{stopped: .data.curve[0].stoppedWatching, warnings: [.warnings[].code]}'
```

**Read it like this:**

| Result | Meaning | Action |
|---|---|---|
| rows/non-zero count is 0 | Still no data | **Skip that item.** Report it as still unverified. Not a failure |
| rows/non-zero count > 0 | Data has arrived | Run the matching §4.N |
| `stoppedWatching` is a number | The channel now serves drop-off metrics | Run §4.4 |
| `stoppedWatching` is `null` + `ANALYTICS_METRICS_UNSUPPORTED` | Still refused | **Skip §4.4.** Correct, documented behaviour |

**Done when:** you have a written list of which of §4.1–§4.4 are in scope for this session.

**Stop and ask if:** every item is still empty. There is nothing to do; tell the user and stop rather than manufacturing work.

---

### §4.1 Verify `playlists` returns real per-playlist rows

**Symptom to look for:** rows arrive with the right keys but `playlistId` is `undefined`/`null`, or `playlistStarts` and `viewsPerPlaylistStart` are null on every row while views are populated.

**Where it lives:**
- `fetchPlaylists` in `src/api/analytics.js:234`
- The command: `simple('playlists', …)` in `src/cli.js:736`
- In the one-document run: `step('playlists', …)` in `src/fetch-all.js:135`
- Existing test: *"playlists never request the isCurated filter, which the API refuses"* in `test/api/fetchers.test.js:560`

**Why it needs checking:** the mapping reads `r.playlist` for the id. That is the column name the `playlist` dimension is believed to return, but no response containing one has ever been observed. If the real column is named differently, `playlistId` is `undefined` on every row and `?? null` turns the whole result into nulls — the reach-CSV failure exactly.

**Verification step BEFORE editing:**

```bash
node -e "
import('./src/index.js').then(async m => {
  const { client } = m.getAuthenticatedClient();
  const apis = m.createApis(client);
  const r = await apis.analytics.reports.query({
    ids:'channel==MINE', startDate:'2026-01-01', endDate:'2026-12-31',
    metrics:'views,estimatedMinutesWatched,playlistStarts,viewsPerPlaylistStart',
    dimensions:'playlist', sort:'-views', maxResults:50 });
  console.log(JSON.stringify(r.data, null, 1));
});
"
```

Compare `columnHeaders[].name` against what the mapping reads. That comparison **is** the test.

**How to fix (only if it disagrees):**
1. Correct the field reads in `fetchPlaylists`. Minimum diff — do not restructure the fetcher.
2. Paste the captured payload verbatim into `test/api/fetchers.test.js` as a `REAL_*` constant with a comment saying when it was captured, following `REAL_ASR_VTT` in `test/api/captions.test.js` as the pattern.
3. Assert an actual playlist id and an actual view count, not `rows.length`.

**Done when:** the §3 `playlists` criterion passes and a test asserts a real captured value.

**Stop and ask if:** the dimension returns rows but `playlistStarts` is rejected as a metric. That is a metric-support question, not a mapping bug — surface it rather than silently dropping the metric.

---

### §4.2 Verify `revenue` returns real earnings

**Symptom to look for:** `estimatedRevenue` populated but `cpm`, `playbackBasedCpm` or `monetizedPlaybacks` null on every row; or currency arriving in a unit you did not expect.

**Where it lives:**
- `fetchRevenue` in `src/api/analytics.js:261`
- The command: `simple('revenue', …)` in `src/cli.js:741`
- `step('revenue', …)` in `src/fetch-all.js:136`
- Existing tests at `test/api/fetchers.test.js:521` and `:534`

**Why it needs checking:** all eight metric names were accepted by the API, but every value returned was `0` on an unmonetized channel. Zeros cannot distinguish a correct mapping from a wrong one — both produce `0` when the source column is missing and the row is zero-filled.

**Two things to check that only real data can settle:**

1. **Currency and scale.** Confirm whether `estimatedRevenue` is in whole currency units or a sub-unit, and which currency. Cross-check one day's figure against YouTube Studio for the same date. If the CLI and Studio disagree by a factor of 100, or by a currency, that is a real defect and it must be documented in `docs/cli.md`.
2. **The three-tier fallback.** `fetchRevenue` requests eight metrics, falls back to six, then to `estimatedRevenue` alone. On the probed channel the richest tier succeeded, so tiers two and three have never run. If a monetized channel refuses `estimatedRedPartnerRevenue` or `playbackBasedCpm`, the fallback fires for the first time — confirm the `ANALYTICS_METRICS_UNSUPPORTED` warning names exactly what was dropped.

**Verification step BEFORE editing:** run the §8 comparison script for `revenue`, then open YouTube Studio → Analytics → Revenue for the same window and compare one day.

**How to fix (only if it disagrees):** correct the field reads; capture the payload; assert a specific non-zero figure. If the discrepancy is currency or scale rather than a wrong field, **do not silently convert** — surface it to the user first, because the right answer may be documentation rather than code.

**Done when:** the §3 `revenue` criterion passes, and one day's `estimatedRevenue` matches YouTube Studio for the same date.

**Stop and ask if:** the CLI and Studio disagree and you cannot tell whether the cause is a mapping error, a currency unit, or Studio's own reporting lag. Do not guess at a multiplier.

---

### §4.3 Verify `cards` returns real engagement

**Symptom to look for:** the six card counters populated but the five annotation counters null, or a rate field (`cardClickRate`) arriving as a percentage when a fraction was assumed.

**Where it lives:**
- `CARD_METRICS` in `src/api/analytics.js:195`, `fetchCardMetrics` in `src/api/analytics.js:202`
- The command: `simple('cards', …)` in `src/cli.js:744`
- Merged into daily in the one-document run: `step('cardMetrics', …)` in `src/fetch-all.js:114`
- Existing tests at `test/api/fetchers.test.js:546` and `:551`

**Why it needs checking, and why it is the riskiest of the four:** `fetchCardMetrics` is the **one fetcher with its own `try`/`catch` returning `[]`**. A failure inside it produces **no warning anywhere in the envelope** — see *"Card metrics fail on some channels and are swallowed"* in `docs/gotchas/youtube-api.md`. So a broken mapping here is invisible by construction: you cannot tell "this channel uses no cards" from "the query failed" from the output alone.

**Also verify the rate fields specifically.** `impressionsCtr` elsewhere in this project is a **fraction** (`0.0561` = 5.61%), and that convention caught someone out badly enough to earn its own section in the agent skill. Confirm whether `cardClickRate`, `cardTeaserClickRate`, `annotationClickThroughRate` and `annotationCloseRate` are fractions or percentages, and make sure `docs/cli.md` and the skill's `references/interpreting-results.md` say which.

**One more thing to confirm:** the eleven counters are merged into `fetch`'s daily rows but absent from the standalone `daily` command. Check that asymmetry still holds and still matches what `docs/cli.md` claims.

**Done when:** the §3 `cards` criterion passes, a test asserts a real non-zero counter, and the fraction-vs-percentage question is settled in writing in both `docs/cli.md` and the agent skill.

**Stop and ask if:** the rate fields are percentages. That contradicts this project's established convention and the fix might be to normalize *or* to document — the user decides which.

---

### §4.4 Verify the retention drop-off metrics

**Symptom to look for:** `stoppedWatching` and `startedWatching` now return numbers, but the four-tier fallback still drops them, or the values look implausible against the curve.

**Where it lives:**
- `RETENTION_TIERS` in `src/api/analytics.js:593`, `fetchAudienceRetention` in `src/api/analytics.js:600`
- `queryTiered` in `src/api/analytics.js:108` — the tiering and zero-row handling
- The command and its empty-curve warning: `src/cli.js:749` and `src/cli.js:774`
- Existing test: *"treats a zero-row tier as a refusal and keeps descending"* in `test/api/fetchers.test.js:334`

**Why it needs checking:** on 2026-07-31 this channel refused these two metrics in a way that returned **HTTP 200 with an empty `rows` array** rather than an error, which silently emptied every retention curve until 0.8.1 fixed it. If the channel now serves them, the **first tier** succeeds for the first time — a path that has never run against real data.

**What to confirm:**
1. The first tier is accepted: `calls[0].metrics` includes all five metrics and returns rows.
2. No `ANALYTICS_METRICS_UNSUPPORTED` warning is emitted when nothing was actually dropped.
3. `stoppedWatching` and `startedWatching` are plausible: they are **counts**, not ratios, so they should be integers and `totalSegmentImpressions` should be of comparable magnitude.

**Then do the thing the whole feature exists for.** Re-run the transcript × retention analysis and confirm a drop-off can now be attributed — a dip with high `stoppedWatching` (viewers left) reads differently from one preceded by high `startedWatching` (viewers skipped ahead). Those call for opposite edits and `ratio` alone cannot separate them. The §8 script does the join.

**Done when:** the §3 retention criterion passes and the analysis distinguishes leaving from skipping on at least one real video.

**Stop and ask if:** the metrics return but the values look wrong — for example `stoppedWatching` exceeding `totalSegmentImpressions`. Surface it; do not clamp or normalize. Ratios above 1.0 elsewhere in retention are legitimate and were nearly "fixed" once before.

---

### §4.5 Update the docs and the agent skill for whatever you learned

Only for items the preflight cleared and that you actually verified.

**Where it lives:** `docs/cli.md`, `docs/youtube-apis.md`, `docs/gotchas/youtube-api.md`, `CHANGELOG.md`, then `.agents/skills/ytstats/`.

**How to fix:**
1. **Remove the "unverified" hedges** for any item you have now proven. `docs/cli.md` currently says of `playlists` that "the request shape is verified against the live API while the row mapping is not" — that sentence must go once it *is* verified, and similar wording exists for `revenue` and `cards`. A stale hedge is its own kind of wrong.
2. Record anything newly learned as a gotcha if it was non-obvious — currency units, a rate that is a percentage, a metric a monetized channel refuses.
3. **Agent skill**, per `CLAUDE.md`: `references/interpreting-results.md` currently tells an agent that zero revenue means an unmonetized channel and that card zeros are unknowable. Both statements need revisiting once real values exist. Bump the skill version, add a `CHANGELOG.md` entry, and raise `systemDependencies.ytstats.version` **only if** the CLI behaviour changed.
4. Regenerate `doc-manifest.json` — it is generated, never hand-edited.

**Done when:** `skill-sync-check.sh` reports PASS, `happyskills validate` is valid with zero warnings, and the manifest `--check` exits clean.

---

## §5 Non-goals

- Do **not** add new commands, flags or datasets. The surface is settled at 33 commands.
- Do **not** refactor `queryTiered`, `withSegment` or `simple()`. They are load-bearing and were fixed carefully; a verification pass is not the place to restructure them.
- Do **not** remove `yt-analytics-monetary.readonly` from the default scopes — it is what makes `revenue` legal.
- Do **not** loosen the zero-row-is-a-refusal rule in `queryTiered` because it costs an extra API call on a genuinely empty dataset. That call is what distinguishes "no data" from "refused".
- Do **not** turn a swallowed card-metrics failure into a thrown error without asking. The `try`/`catch` is deliberate; changing it changes `fetch`'s degradation behaviour.
- Do **not** cut a release, `npm publish`, or publish the agent skill. Commit and stop.
- Do **not** create a git branch or open a PR. `CLAUDE.md`: work directly on `master`.
- Do **not** edit `doc-manifest.json` by hand.
- Do **not** modify anything under `specs/`, including this file.

---

## §6 Known uncertainties

| # | Uncertainty | Safe behavior |
|---|---|---|
| 1 | **Whether the `playlist` dimension's column is actually named `playlist`.** The mapping assumes it; no response containing a row has ever been seen. | Run the §4.1 raw query and read `columnHeaders[].name` before editing anything. |
| 2 | **Revenue currency and scale are unknown.** Whether `estimatedRevenue` is whole units or a sub-unit, and in which currency, was never observable on a channel earning zero. | Cross-check one day against YouTube Studio (§4.2). If they disagree, surface it — do not apply a multiplier. |
| 3 | **Whether the card rate fields are fractions or percentages.** Assumed to follow the `impressionsCtr` fraction convention; never observed non-zero. | §4.3. Settle it in writing before reporting any CTR figure to a user. |
| 4 | **Whether this channel will ever serve `startedWatching`/`stoppedWatching`.** Refused on 2026-07-31 in a way that returned zero rows rather than an error. Support varies per channel and may simply never arrive. | §4.0 decides. A continued refusal is correct documented behaviour, not a bug — report it and skip §4.4. |
| 5 | **Revenue tiers two and three have never executed.** The richest tier succeeded (returning zeros), so the fallback path is unexercised against real data. | Watch for `ANALYTICS_METRICS_UNSUPPORTED` on a monetized channel and confirm it names exactly what was dropped. |
| 6 | **The segment support matrix in `docs/cli.md` was measured on one channel on 2026-07-31.** It may not hold as the channel grows. | Out of scope by decision (2026-07-31). If you happen to observe a contradiction, note it for the user rather than rewriting the matrix. |

---

## §7 Anti-hallucination guardrails

1. No new files except test fixtures added to existing test files, plus any new gotcha entry in `docs/gotchas/youtube-api.md`. Everything else is an edit to a file listed in §4.
2. `package.json` dependencies are read-only. No new runtime dependency, for any reason.
3. **Build every fixture from a CAPTURED payload, never an invented one.** Paste it verbatim, mark it with the capture date, and do not tidy it. This project has shipped broken twice by ignoring this — see §2 and `docs/testing.md` § "Use a captured payload".
4. **Assert a value, not a shape.** A test checking `rows.length` passes against a result where every field is `null`. Assert a specific playlist id, a specific revenue figure, a specific card count.
5. No "while I'm here" cleanups. A verification pass is a verification pass.
6. Do not invent new abstractions. Follow the existing patterns: `call()`, `simple()`, `queryTiered`, `def()`, `parseCsv`.
7. Tests must stay **offline**. Every effect is injected — `buildProgram({ makeApis })` exists so authenticated command paths run without network. Use it.
8. One fix per commit, single-line conventional format (`fix(scope): …`). Stage files individually **by name**; never `git add -A` or `git add .` — there is untracked tooling under `.agents/skills/` that must not be swept in.
9. Never use `--no-verify`.
10. Do not commit or push without the user confirming. Do not run `npm publish` or publish the agent skill.
11. Do not re-run the research this spec already did. Trust §2 and §4; grep the anchors to confirm locations.
12. If an item has no data, **say so plainly in your report**. Do not present an unverified item as verified, and do not invent a way to make it look tested.

---

## §8 Verification commands

**Network note for this machine.** Every command that reaches Google needs the IPv6 workaround, or it fails as a misleading `NETWORK_UNREACHABLE`:

```bash
export NODE_OPTIONS=--no-network-family-autoselection
```

**Credentials.** A working login already exists on this machine. If `node bin/ytstats.js status` shows no account, **ask the user** — do not attempt to create Google Cloud credentials yourself.

```bash
# Baseline before touching anything — expect 528 passing
npm test

# Who is signed in, and does the account still hold the captions scope
node bin/ytstats.js status 2>/dev/null | jq '.data.accounts[0] | {channelTitle, scopes}'
```

**Compare the CLI against the raw API.** This is the core check — the CLI's mapping is correct only if its output matches the raw columns.

```bash
node -e "
import('./src/index.js').then(async m => {
  const { client } = m.getAuthenticatedClient();
  const apis = m.createApis(client);
  const r = await apis.analytics.reports.query({
    ids:'channel==MINE', startDate:'2026-01-01', endDate:'2026-12-31',
    metrics:'<metrics>', dimensions:'<dimension>', sort:'<sort>' });
  console.log(JSON.stringify({ cols: r.data.columnHeaders.map(h=>h.name), rows: (r.data.rows||[]).slice(0,3) }, null, 1));
});
"
```

Substitute per item:

| Item | `<dimension>` | `<metrics>` | `<sort>` |
|---|---|---|---|
| playlists | `playlist` | `views,estimatedMinutesWatched,playlistStarts,viewsPerPlaylistStart` | `-views` |
| revenue | `day` | `estimatedRevenue,estimatedAdRevenue,grossRevenue,cpm,adImpressions,monetizedPlaybacks` | `day` (**required** — unsorted returns zero rows) |
| cards | `day` | `cardImpressions,cardClicks,cardClickRate,cardTeaserImpressions,cardTeaserClicks` | `day` |
| retention | `elapsedVideoTimeRatio` | `audienceWatchRatio,relativeRetentionPerformance,startedWatching,stoppedWatching,totalSegmentImpressions` | *(none; add `filters:'video==<videoId>'`)* |

**The retention × transcript analysis** (§4.4), using published commands only:

```bash
V=<videoId>
DUR=$(node bin/ytstats.js videos 2>/dev/null | jq -r --arg v "$V" '.data[]|select(.id==$v)|.durationSeconds')
node bin/ytstats.js retention  "$V" --days 3650 2>/dev/null | jq '.data.curve'  > /tmp/curve.json
node bin/ytstats.js transcript "$V"             2>/dev/null | jq '.data.cues'   > /tmp/cues.json
# A cue at t seconds sits at position t / DUR. Rank points by the drop in `ratio`,
# then read `stoppedWatching` vs `startedWatching` to say whether viewers LEFT or SKIPPED.
```

**The three sync checks, before finishing:**

```bash
bash .agents/skills/release-cli/scripts/skill-sync-check.sh
npx happyskills validate ytstats --json | jq '{valid: .data.valid, warned: .data.checks_warned}'
python3 .claude/skills/init-doc/scripts/build-doc-manifest.py --root . --check
```

---

## §9 Domain glossary

| Term | Meaning |
|---|---|
| YPP | YouTube Partner Programme. Monetization requires 1,000 subscribers plus a watch-hours threshold; below it, revenue metrics return zeros rather than errors. |
| `stoppedWatching` / `startedWatching` | Counts, not ratios: how often viewers **left** during a segment, and how often they **joined** it by skipping ahead. A dip means opposite things depending on which moved. |
| `elapsedVideoTimeRatio` | Retention's x-axis: elapsed fraction of the video, `0`–`1`. Transcript cues are in **seconds**, so aligning them needs the video's duration. |
| Card / teaser | A card is the in-video interactive panel; the teaser is the small preview that precedes it. They have separate impression and click counters. |

---

## §10 References

**Project docs (read these, do not re-derive them)**
- `docs/testing.md` § "Use a captured payload" — the rule this whole spec enforces
- `docs/gotchas/youtube-api.md` — especially "A refused metric combination can arrive as HTTP 200 with zero rows", "Card metrics fail on some channels and are swallowed", and "Three more dimensions with hard preconditions"
- `docs/cli.md` — the command reference, including the hedges §4.5 must remove
- `docs/youtube-apis.md` — the fetcher/metric/dimension table
- `CLAUDE.md` — branching, committing, and the skill-sync requirement

**Related spec**
- `specs/-DONE/260730-01-transcripts-and-segmentation/SPEC.md` — the work that shipped these commands. Its §10 deferred list is what became `ytstats` 0.9.0.

**External**
- [Analytics dimensions](https://developers.google.com/youtube/analytics/dimensions) — `playlist`, `sharingService`, `operatingSystem`
- [Channel reports](https://developers.google.com/youtube/analytics/channel_reports) — note its claim that revenue metrics are unsupported for channel reports is **contradicted** by observation; all eight were accepted on 2026-07-31
- [YPP eligibility](https://support.google.com/youtube/answer/72851) — the threshold that gates §4.2

**Code anchors**

```
queryTiered                    src/api/analytics.js:108
CARD_METRICS                   src/api/analytics.js:195
fetchCardMetrics               src/api/analytics.js:202
fetchPlaylists                 src/api/analytics.js:234
fetchRevenue                   src/api/analytics.js:261
RETENTION_TIERS                src/api/analytics.js:593
fetchAudienceRetention         src/api/analytics.js:600
simple('playlists')            src/cli.js:736
simple('revenue')              src/cli.js:741
simple('cards')                src/cli.js:744
retention command              src/cli.js:749
retention DATA_EMPTY branch    src/cli.js:774
step('cardMetrics')            src/fetch-all.js:114
step('playlists')              src/fetch-all.js:135
step('revenue')                src/fetch-all.js:136
playlists isCurated test       test/api/fetchers.test.js:560
revenue sort test              test/api/fetchers.test.js:521
card metrics tests             test/api/fetchers.test.js:546,551
zero-row refusal test          test/api/fetchers.test.js:334
```
