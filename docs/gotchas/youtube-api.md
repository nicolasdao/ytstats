---
description: Non-obvious behaviour of the three YouTube APIs — metrics that never work, undocumented limits, and lag that cannot be removed.
tags: [youtube-api, analytics, reporting, quota, gotchas]
source:
  - src/api/**
  - src/sync.js
  - src/archive.js
---

# YouTube API Gotchas

What breaks in the YouTube Data, Analytics, and Reporting APIs, why, and where `ytstats` handles it. Each entry names the handling site so a future change does not silently undo a workaround.

Related: [auth gotchas](auth.md) for credential and token traps, [youtube-apis.md](../youtube-apis.md) for the full request reference.

## CTR and impressions do not work on the Analytics API

The Analytics API documents `videoThumbnailImpressions` and `videoThumbnailImpressionsClickRate` as valid channel-report metrics. They do not work — every combination returns `The query is not supported.`

This is a [known Google issue](https://issuetracker.google.com/issues/254665034) affecting all channels regardless of size. The only working source is the Reporting API's `channel_reach_basic_a1` report, which is why `ytstats reach` exists at all and why it behaves unlike every other command.

**Where handled:** `src/api/reporting.js`. Never add these metrics to `src/api/analytics.js` — a test asserts they are absent.

## Captions have no read-only scope, and only work on videos you own

Both `captions.list` and `captions.download` require `https://www.googleapis.com/auth/youtube.force-ssl` (or `youtubepartner`). There is **no** read-only variant — `youtube.readonly` is not accepted for either. Google presents `force-ssl` to the user as *"Manage your YouTube account"*: full read/write.

That single fact is why `ytstats` cannot simply add captions to its default grant. Three read-only scopes is a promise every existing user consented to, and a new scope also invalidates existing consent — so widening the default would both break the promise and force every user to re-authorize. Hence `login --with-captions`, which is the only thing that ever requests it.

`captions.download` additionally requires permission to **edit** the video, so it works only for videos on a channel the signed-in user owns. There is no path to another creator's transcript, by design of the API rather than by choice here.

Two consequences worth keeping straight:

- A 403 on `captions.download` for your own video usually means the scope, not the ownership.
- A stored account whose `scopes` array lacks `force-ssl` is refused **before** the call, as `AUTH_SCOPE_MISSING`, so the user gets `ytstats login --with-captions` instead of an opaque Google 403.

**Where handled:** `CAPTIONS_SCOPE` and `captionsScopeMissing()` in `src/auth/oauth.js`; the fetchers in `src/api/captions.js`; the pre-flight check in the `transcript` command (`src/cli.js`). `SCOPES` stays at exactly three entries and a test asserts it.

## captions.download returns a Blob, and String() on it yields "[object Blob]"

The googleapis client hands this endpoint back as a **Blob**, not a string — unlike every other call in the codebase. `String(res.data)` therefore produces the literal `"[object Blob]"`, which parses to **zero cues**.

The failure shape is the dangerous part, and it is the reach-CSV regression exactly: `ok: true`, a track selected and reported, a cache file written, a `DATA_EMPTY` warning saying the track "contained no cues". Indistinguishable from a video whose captions really are empty. It shipped in 0.7.0 and was caught only by running the command against a real video — every unit test passed, because the fixtures were hand-written strings.

`readBody()` now handles string, `Buffer`, and anything exposing `.text()` or `.arrayBuffer()`, in that order.

**Where handled:** `readBody()` in `src/api/captions.js`, pinned by a test whose fake returns `{ text: async () => … }` rather than a string.

## trackKind comes back lowercase, so a === 'ASR' test never fires

Google's [captions resource docs](https://developers.google.com/youtube/v3/docs/captions) give `trackKind` as `ASR`, `forced`, `standard` — capitalised. The API returns `"asr"`.

So `t.trackKind !== 'ASR'` classified **every** auto-generated track as author-written, silently inverting the one preference `selectCaptionTrack()` exists to express: on a video with both an ASR and a manual track, it would have picked ASR. Nothing fails; you just get the worse transcript and a `trackKind` that no consumer's `=== 'ASR'` branch matches.

`listCaptionTracks()` now uppercases the value so consumers get one stable spelling, and the internal comparison is case-insensitive regardless.

**Where handled:** the `toUpperCase()` normalization in `listCaptionTracks()` and the `isAsr()` helper in `selectCaptionTrack()`, `src/api/captions.js`.

## Auto-captions roll, so a naive parse repeats every sentence

YouTube's ASR VTT is a *rolling* transcript: each cue repeats the previous cue's text and appends the new words, interleaved with 10-millisecond "settle" cues that restate the line on its own.

```
00:00:03.280 --> 00:00:07.190 align:start position:0%
Here are three warning signs that AI            <- carry-over from the previous cue
might<00:00:03.679><c> be</c><00:00:03.919><c> burning</c>...   <- the new words
```

Emitting every cue verbatim gives the same sentence at two or three different timestamps. For this feature that is worse than verbose: the whole point is answering *what was said at the moment viewers left*, so duplicated text at the wrong timestamps corrupts the answer rather than padding it.

Two further quirks in the same payload, both of which silently lost content:

- A **whitespace-only line** appears *inside* a cue. Trimming before the blank-line check treated it as a cue terminator and dropped the opening line of every ASR track.
- Word timings are **inline markup** (`Here<00:00:00.400><c> are</c>`), so markup stripping has to run before any line comparison.

`parseCues()` drops the leading lines a cue carries over from its predecessor and skips a cue left with nothing new. A real 15-second Short goes from 12 duplicated cues to 7 clean ones.

**Where handled:** `parseCues()` in `src/api/transforms.js`, pinned by `REAL_ASR_VTT` in `test/api/captions.test.js` — a verbatim capture of live output. Do not replace that fixture with a tidier hand-written one; its awkwardness is the test.

## An auto-generated caption track is a different claim from an author-written one

`captions.list` returns both kinds, distinguished by `trackKind` — `ASR` is speech recognition, anything else was written or uploaded by the author. ASR mishears names, jargon and anything said over music.

Since the reason to pull a transcript here is finding out *what was said* at a retention drop-off, a mistranscribed line leads to the wrong editing decision. `ytstats` prefers a manual track and falls back to ASR, but **reports which one it used** (`trackKind` in the output) rather than choosing silently. Draft tracks are skipped entirely: an unpublished track is not what viewers saw.

**Where handled:** `selectCaptionTrack()` in `src/api/captions.js`, pinned by tests.

## Reporting API data is always 1-2 days behind

Reports cover midnight-to-midnight Pacific Time and are generated 1-2 days after the period closes, so `ytstats reach` never returns data for today or yesterday.

This is not a `ytstats` limitation. YouTube Studio shows the same lag, because real-time impression data does not exist anywhere.

## The first reach run returns nothing for 24-48 hours

The first `ytstats reach` only *creates* the reporting job. Google then generates reports within 24-48 hours, including a 30-day backfill. Until then there is genuinely nothing to download.

This surfaces as the `REACH_PENDING` **warning**, not an error — the command succeeded, the data does not exist yet. Re-running is harmless and does not create a duplicate job, because `ensureReachJob()` looks for an existing job with the same `reportTypeId` before creating one.

**Where handled:** `fetchReach()` and `ensureReachJob()` in `src/api/reporting.js`.

## A Reporting API report type with no job collects nothing, forever

The single most expensive thing to learn late. Google's wording:

> "YouTube does not begin to generate your report until you create a reporting job for that report."

Not "does not serve" — **does not generate**. A report type with no job produces no data at all, and the API says nothing about it: `jobs.list` succeeds, `reach` succeeds, every query returns `ok: true`. The absence is indistinguishable from a channel that had no activity.

Creating a job later backfills **30 days and no more**. Everything older never existed and cannot be bought back at any price, by any API, by contacting Google, or by upgrading. This is the only failure in `ytstats` where the cost of noticing late is unbounded and unrecoverable.

Creating the job is also only half of it. Reports **expire off Google's servers**: 60 days after generation for normal reports, 30 days for the backfill ones. A job created and then never collected from still loses data — it just loses it more slowly. A durable local sink and a pull cadence under 60 days is the only configuration that actually retains history.

`ytstats` created exactly one job (`channel_reach_basic_a1`) until 0.6.0, and only when `reach` was first run. Every other report type had been collecting nothing since the tool was written.

**Where handled:** `auditReportingJobs()` and `ensureJobs()` in `src/api/reporting.js`; the `reporting_jobs` check in `doctor` (`src/cli.js`), which **fails** rather than warns precisely because the loss compounds daily; the `REPORTING_JOBS_MISSING` diagnostic.

## Reports expire, so a job nobody collects from still loses data

The second half of the trap above, and the one that looks solved when it is not. Creating a job makes YouTube *generate* reports. It does nothing to keep them:

| Report kind | Available for |
|---|---|
| Normal | **60 days** from generation |
| Historical / backfill | **30 days** from generation |

So full job coverage plus an infrequent pull still loses history, in silence. A channel synced twice a year keeps two 60-day windows and nothing else, and no API call reports the hole — the rows simply are not there.

This was confirmed live while building the feature: a first `sync` of a reach job running since the tool was written returned rows starting **2026-05-29**, exactly ~60 days before the sync date. Everything earlier had already been deleted by Google and is unrecoverable.

The Analytics API needs no equivalent handling. It is a *query* API over YouTube's own long-lived store — any range, any time. Only the Reporting API is ephemeral, which is why only its output is archived.

**Where handled:** `src/archive.js` (append-only NDJSON, last-wins replay), `src/sync.js` (`syncReports`, `findExpiringReports`), the `reports_archived` check in `doctor`, and the `REPORTS_EXPIRING` diagnostic. Never make `sync` mark a report ingested before the append succeeds — the report is gone in 60 days and a retry is the only chance to get it.

## The archive is keyed by report type, not by channel

One config directory holds **many** channels, but the archive under it is one NDJSON file per report type — not per channel per report type. Sync two channels from the same config directory and both land in `channel_reach_basic_a1.ndjson`.

Nothing corrupts: `channel_id` is a column in every report and `keyColumns()` treats it as a dimension, so rows from different channels never collide or overwrite each other. But `archive` reports combined `rows` / `firstDate` / `lastDate` totals across channels, and `readRows()` returns both channels interleaved. A consumer asking "my reach data" gets everyone's.

`sync` itself honours `--account` and pulls only that channel's jobs — so the mixing happens in the *store*, not the fetch. That makes it easy to miss: each individual command behaves correctly.

The fix if you run several channels is the same one that separates their credentials: a config directory each, since `YTSTATS_DATA_DIR` defaults to `<config dir>/data` and therefore moves with it.

```bash
alias yt-acme='YTSTATS_CONFIG_DIR=~/.ytstats/acme ytstats'
```

**Where handled:** nowhere in code — this is a documented limitation, not a defence. `channel_id` in `KNOWN_DIMENSIONS` (`src/archive.js`) is what keeps it merely confusing rather than lossy.

## Last-wins in the archive must resolve by createTime, not file order

Overlapping reports carry corrected figures for days already reported, so the archive dedupes on the row's dimension columns and keeps the newest. The tempting implementation — "later line in the file wins" — is wrong: a re-ingest, a restored backup, or two processes appending can all put an older report's rows after a newer report's, silently overwriting a correction with the figure it corrected.

Every archived row therefore carries `_createTime`, and replay ranks on that, falling back to file order only to break ties.

The related trap is knowing what "the same row" *is*. The CSV header does not say which columns are dimensions and which are metrics, and merging on too few columns collapses distinct rows into one — the same silent loss this module exists to prevent. `keyColumns()` treats a column as a dimension if it is a known dimension name, ends in `_id`, or holds any non-numeric value anywhere in the file. `date` has to be in the known list explicitly: it arrives as `20260328.0`, which every numeric heuristic reads as a metric.

**Where handled:** `keyColumns()` and `readRows()` in `src/archive.js`, both pinned by tests.

## Report type ids are version-bumped in place, so never hardcode them

Google revises report types by incrementing a suffix — `channel_basic_a2` became `channel_basic_a3`, `channel_cards_a1` became `channel_cards_a2` — and retires the old id. Worse, Google's own two listing pages currently disagree about the set: [full_report_list](https://developers.google.com/youtube/reporting/v1/reports/full_report_list) omits `channel_province_a3` and `channel_sharing_service_a2`, which [channel_reports](https://developers.google.com/youtube/reporting/v1/reports/channel_reports) lists.

A hardcoded array therefore rots silently and starts creating jobs for ids that no longer exist. `reportTypes.list` returns exactly what *this* channel may schedule, and it needs only `yt-analytics.readonly` — a scope `ytstats` already requests, so live discovery costs no extra consent.

Filter out `deprecateTime` and `systemManaged` entries: `jobs.create` rejects both.

**Where handled:** `listReportTypes()` in `src/api/reporting.js`. Do not replace it with a constant.

## Reach reports overlap, so rows must be deduped

Successive report files cover overlapping periods, and later files carry corrected figures for days already reported. Concatenating rows produces duplicates and stale numbers.

`fetchReach()` keys rows on `` `${date}|${videoId}` `` in a `Map` and lets the last write win, so corrections from later reports replace earlier figures.

**Where handled:** the `deduped` map in `fetchReach()`, `src/api/reporting.js`.

## Per-video analytics rejects maxResults above 200

Queries with `dimensions=video` fail if `maxResults` exceeds 200. Channels with more than 200 videos get only the top 200 by the sort field (`-views`).

**Where handled:** `MAX_VIDEO_ROWS` in `src/api/analytics.js`, applied with `Math.min` so a caller cannot exceed it. A test asserts the clamp.

## Traffic source detail queries are fragile in three separate ways

The `insightTrafficSourceDetail` dimension has three distinct traps:

1. It **requires** both `sort` and `maxResults`. Without `maxResults` the query returns `The query is not supported.`
2. With `maxResults` too high (50+) it returns `Internal error encountered.` The safe ceiling is **25**.
3. Combining it with `estimatedMinutesWatched` also triggers an internal error. Only `views` is reliable.

A fourth follows from the third: adding a **second dimension** breaks it too, which is why `search-terms` refuses `--segment` locally rather than letting YouTube answer with an error naming neither the flag nor the reason. Neither detail fetcher accepts a `segment` argument at all, and a test asserts that a caller passing one cannot change their `dimensions`.

**Where handled:** `MAX_DETAIL_ROWS` and the hard-coded `metrics: 'views'` in `fetchSearchTerms()` and `fetchTrafficSourceDetails()`, `src/api/analytics.js`; the `segmentable: false` rejection in `simple()`, `src/cli.js`. Tests assert all four.

## A segment dimension silently restricts which metrics a report may request

Adding `subscribedStatus` or `youtubeProduct` to a report looks like it only splits
the rows. It also shrinks the metric list that report is allowed to ask for — and
because [an unsupported metric fails the whole query](#an-unsupported-metric-fails-the-whole-query-not-just-its-column),
requesting the unsegmented metric list alongside a segment returns **nothing at
all**, not a partial answer.

`day` with the ten daily metrics works. `day,subscribedStatus` with the same ten
returns `The query is not supported.` Drop `comments`, `subscribersGained` and
`subscribersLost` and it returns rows. Probed metric by metric against a live
channel on 2026-07-30:

| Segment | Rejects |
|---|---|
| `subscribedStatus` | `comments`, `subscribersGained`, `subscribersLost` |
| `youtubeProduct` | those three plus `likes`, `dislikes`, `shares` — every engagement metric |

The trap is that the existing tiered fallback does **not** rescue this. Both daily
tiers differ only by `engagedViews`, so both contain `comments` and both fail; the
command errors out entirely rather than degrading. Tiering answers "which metrics
does this *channel* serve" — it cannot answer "which metrics does this *dimension*
allow", because the whole tier list sits above the ceiling.

`withSegment()` therefore narrows every tier up front and reports the difference
through `onDegraded`, so the loss arrives as an `ANALYTICS_METRICS_UNSUPPORTED`
warning naming each metric rather than as three silent nulls.

Dimension support varies independently of metric support, and per channel:
`video` refuses both segments outright, and `youtubeProduct` is refused on
`insightTrafficSourceType`, `insightPlaybackLocationType` and `ageGroup,gender`.
Those surface as `API_QUERY_NOT_SUPPORTED` rather than an empty dataset — the
verified matrix is in [cli.md](../cli.md#--segment). Do not convert it into a
hardcoded per-command allow-list: it was measured on one channel, and this project
has repeatedly found per-channel variation.

**Where handled:** `SEGMENT_METRICS` and `withSegment()` in `src/api/analytics.js`,
pinned by tests using captured segmented payloads; the `--segment` option and the
`search-terms` rejection in `simple()`, `src/cli.js`.

## `views` changed meaning on 30 April 2025

YouTube redefined the metric rather than adding a new one. A Shorts view is now **every play or replay, with no minimum watch time**; it previously required a watch-time threshold. `engagedViews` was introduced to carry the old definition forward.

The trap is that nothing fails. A channel's `views` series has a step change in April 2025 that no content decision caused, and long-form is unaffected — so any Shorts-vs-long-form comparison spanning that date overstates Shorts. Reading `views` alone, you would conclude a format change worked.

`ytstats` requests both wherever the API allows, so a consumer can compare like with like across the boundary. Neither metric alone is sufficient: `views` is what YouTube reports today, `engagedViews` is what makes today comparable to last year.

**Where handled:** the metric tiers in `src/api/analytics.js`. `engagedViews` is deliberately **absent** from `fetchSearchTerms` and `fetchTrafficSourceDetails` — `insightTrafficSourceDetail` tolerates only `views`, per the trap above. A test asserts both the presence and that absence.

## An unsupported metric fails the whole query, not just its column

The Analytics API does not return a null column for a metric a channel cannot serve — it rejects the entire request with `The query is not supported.` So adding any newer metric (`engagedViews`, `relativeRetentionPerformance`) unconditionally converts a working dataset into **no** dataset for every channel that lacks it.

Which metrics a channel supports genuinely varies, so this cannot be settled by testing one channel. Every metric addition is therefore a *tier*: request the richest set, and on `API_QUERY_NOT_SUPPORTED` retry with the set already known to work. The last tier is the historical metric list, and its failure is a real error that propagates untouched.

Two things this must not do, both of which a naive retry gets wrong:

1. **Retry on any error.** A 403 or a network failure would be silently downgraded into "degraded data" when it is actually an auth problem. Only `API_QUERY_NOT_SUPPORTED` triggers a fallback.
2. **Fall straight to the minimum.** Retention drops `relativeRetentionPerformance` (the metric needing a peer set, most often unavailable) *before* it drops the drop-off counts, so one missing benchmark does not cost `stoppedWatching` too.

Degradation is reported — `notes` in `fetch`, an `ANALYTICS_METRICS_UNSUPPORTED` warning on `retention`. A null column with no explanation is the failure shape this project has already paid for once.

**Where handled:** `queryTiered()` and `isUnsupported()` in `src/api/analytics.js`; the `degraded` map in `src/fetch-all.js`.

## Retention ratios legitimately exceed 1.0

`audienceWatchRatio` returns values above 1.0 for Shorts that viewers loop. A 25-second Short showing `1.54` at position 0 means 54% more viewing than the number of initial viewers.

This is a strong engagement signal, not a data error. `ytstats` never clamps it, and a test pins that behaviour so nobody "fixes" it later.

**Where handled:** `fetchAudienceRetention()` in `src/api/analytics.js` — note the deliberate absence of clamping.

## Two content-type vocabularies disagree

| Source | Values |
|---|---|
| `classifyContent()`, duration-based | `SHORTS`, `VIDEO_ON_DEMAND`, `LIVE_STREAM` |
| YouTube's `creatorContentType` dimension | `shorts`, `videoOnDemand`, `creatorContentTypeUnspecified` |

Different casing *and* different semantics. The `ytstats` classifier uses duration alone (`<= 60s` is a Short), so a 62-second video intended as a Short reads as `VIDEO_ON_DEMAND`. YouTube uses additional signals and may disagree.

Consumers wanting YouTube's own opinion should read the `contentTypes` dataset rather than the `contentType` field on a video.

**Where handled:** `classifyContent()` in `src/api/transforms.js` (duration-based) versus `fetchContentTypes()` in `src/api/analytics.js` (YouTube's own).

## Subscriber counts are rounded

Above 1,000 subscribers the Data API returns counts rounded to 3 significant figures — expect `1,020` or `10,400`, never exact values. Below 1,000 the count is exact. Week-over-week deltas smaller than the rounding step are invisible.

**Where handled:** nothing to handle, but `normalizeChannel()` in `src/api/transforms.js` carries a comment so the rounding is not mistaken for a bug.

## The reach CSV columns are not called impressions

`channel_reach_basic_a1` emits these headers:

```
date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr
```

Not `impressions` / `impressions_ctr`, which is what the obvious reading of the row object suggests. `fetchReach` originally read the short names, so `row.impressions` was `undefined` on every row and `?? null` turned the whole result into nulls.

That failure mode is the dangerous part. The job existed, the download succeeded, the CSV parsed, the row count was right, and `ok` stayed `true` with **no warning** — a response indistinguishable from a channel that genuinely has no impressions. It is invisible to every signal a caller has: no error code, no `recoverable: false`, nothing to retry. A live channel returned 373 null rows for two months while real data sat behind the wrong key.

Prefer asserting a **value** over a shape when a transform maps external column names. A test that only checks `rows.length` passes against a fully-null result.

**Where handled:** the `video_thumbnail_impressions` reads in `fetchReach()`, `src/api/reporting.js`, pinned by tests using the real header in `test/api/fetchers.test.js`.

## A hand-rolled Error loses the HTTP status

`downloadCsv` is a bare `fetch`, not a googleapis client call, so a non-OK response has to be turned into an error by hand. Writing `throw new Error(\`Failed to download report (${res.status})\`)` folds the status into prose and discards it as structure — and `diagnoseGoogleError()` reads `err.response?.status ?? err.status`, so it has nothing to classify on. A transient Google 5xx then became `UNEXPECTED` with `recoverable: false`, permanently halting a caller on a hiccup that `API_UNAVAILABLE` marks retryable.

Two things were needed, and either alone is insufficient: the throw must carry `status` (and `response.status`), **and** the call site must go through `call()` like every other request in `src/api/reporting.js`. The call site had been missed.

The general rule: **every path that can fail with a Google error must reach `mapGoogleError`.** A bare `await` on a request, or a hand-built `Error`, is a latent `UNEXPECTED`.

**Where handled:** the status-preserving throw in `downloadCsv()` (`src/api/client.js`) and the `call()` wrapper around it in `fetchReach()` (`src/api/reporting.js`).

## Reporting API CSVs need a real CSV parser

Report bodies contain video titles and search terms, which routinely include commas and quotes. Splitting on `,` silently corrupts rows, and the corruption is quiet — it produces plausible-looking wrong data rather than an error.

**Where handled:** `parseCsv()` in `src/api/transforms.js` implements the RFC 4180 subset that matters: quoted fields, embedded commas and newlines, and `""` escapes.

## Reporting API dates arrive in a different format

Report dates arrive as `20260328.0` while every other surface uses ISO `YYYY-MM-DD`. Passing them through unchanged would give consumers two date formats in one document.

`normalizeReportingDate()` unifies them. It passes ISO dates through untouched and returns the original value when it recognises neither form, so an unexpected format is visible rather than silently mangled.

**Where handled:** `normalizeReportingDate()` in `src/api/transforms.js`.

## CSV cells with a leading zero must stay strings

Numeric-looking cells are coerced to numbers, but identifiers such as zero-padded codes would lose their leading zero and become the wrong value.

`coerce()` only converts values matching `/^-?(0|[1-9]\d*)(\.\d+)?$/` — a pattern that admits a bare `0` and `0.5` but rejects `007`, leaving it a string.

**Where handled:** `coerce()` in `src/api/transforms.js`.

## search.list costs 100x what playlistItems.list costs

The Data API allows 10,000 quota units per project per day.

| Operation | Cost |
|---|---|
| `channels.list` | 1 |
| `playlistItems.list` | 1 per page of 50 |
| `videos.list` | 1 per batch of 50 |
| `search.list` | **100** |

`ytstats` enumerates videos through the channel's uploads playlist, never `search.list`. A full fetch for a 100-video channel costs roughly 5 units. A test asserts `search.list` is never called.

The expensive operation is retention: one Analytics call **per video**, which is why `fetch` caps it at 50 videos by default (`--retention-limit`) and offers `--no-retention`.

**Where handled:** `fetchAllVideoIds()` in `src/api/data.js`, and the retention cap in `src/fetch-all.js`.

## Card metrics fail on some channels and are swallowed

`fetchCardMetrics()` is the one fetcher with its own `try`/`catch` returning `[]`. Some channels never have card/annotation data and the query fails outright rather than returning zero rows.

Because it degrades inside the fetcher, a card-metrics failure produces **no warning** in the envelope — unlike every other step, which degrades through `fetch-all.js`'s `step()` and is reported. Treat empty `annotationClickThroughRate` / `cardClicks` / `cardImpressions` fields as "unknown", not "zero".

**Where handled:** `fetchCardMetrics()` in `src/api/analytics.js`.
