---
description: Non-obvious behaviour of the three YouTube APIs — metrics that never work, undocumented limits, and lag that cannot be removed.
tags: [youtube-api, analytics, reporting, quota, gotchas]
source:
  - src/api/**
---

# YouTube API Gotchas

What breaks in the YouTube Data, Analytics, and Reporting APIs, why, and where `ytstats` handles it. Each entry names the handling site so a future change does not silently undo a workaround.

Related: [auth gotchas](auth.md) for credential and token traps, [youtube-apis.md](../youtube-apis.md) for the full request reference.

## CTR and impressions do not work on the Analytics API

The Analytics API documents `videoThumbnailImpressions` and `videoThumbnailImpressionsClickRate` as valid channel-report metrics. They do not work — every combination returns `The query is not supported.`

This is a [known Google issue](https://issuetracker.google.com/issues/254665034) affecting all channels regardless of size. The only working source is the Reporting API's `channel_reach_basic_a1` report, which is why `ytstats reach` exists at all and why it behaves unlike every other command.

**Where handled:** `src/api/reporting.js`. Never add these metrics to `src/api/analytics.js` — a test asserts they are absent.

## Reporting API data is always 1-2 days behind

Reports cover midnight-to-midnight Pacific Time and are generated 1-2 days after the period closes, so `ytstats reach` never returns data for today or yesterday.

This is not a `ytstats` limitation. YouTube Studio shows the same lag, because real-time impression data does not exist anywhere.

## The first reach run returns nothing for 24-48 hours

The first `ytstats reach` only *creates* the reporting job. Google then generates reports within 24-48 hours, including a 30-day backfill. Until then there is genuinely nothing to download.

This surfaces as the `REACH_PENDING` **warning**, not an error — the command succeeded, the data does not exist yet. Re-running is harmless and does not create a duplicate job, because `ensureReachJob()` looks for an existing job with the same `reportTypeId` before creating one.

**Where handled:** `fetchReach()` and `ensureReachJob()` in `src/api/reporting.js`.

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

**Where handled:** `MAX_DETAIL_ROWS` and the hard-coded `metrics: 'views'` in `fetchSearchTerms()` and `fetchTrafficSourceDetails()`, `src/api/analytics.js`. Tests assert all three.

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
