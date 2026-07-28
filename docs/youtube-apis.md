---
description: How ytstats calls the YouTube Data, Analytics, and Reporting APIs — exact queries, encoded limits, quota costs, and transforms.
tags: [youtube-api, analytics, reporting, quota, fetchers]
source:
  - src/api/**
  - src/fetch-all.js
---

# YouTube APIs

`ytstats` reads from three separate Google APIs. This is the request-level reference; for the traps each one hides, see [gotchas/youtube-api.md](gotchas/youtube-api.md).

## The three surfaces

`createApis(authClient)` bundles them, plus a CSV downloader:

```js
{
  youtube:   google.youtube({ version: 'v3', auth }),           // Data API v3
  analytics: google.youtubeAnalytics({ version: 'v2', auth }),  // Analytics API v2
  reporting: google.youtubereporting({ version: 'v1', auth }),  // Reporting API v1
  downloadCsv(url),                                             // OAuth-authenticated fetch
}
```

Every fetcher takes this bundle as its first argument. That is the injection seam: tests hand in plain objects and never touch the network. All three APIs must be enabled in the same Google Cloud project that issued the OAuth client, or requests fail with `API_NOT_ENABLED`.

`call(fn)` wraps each request and converts Google's error shapes into typed `YtStatsError`s via `mapGoogleError()`.

## Data API v3

Three fetchers in `src/api/data.js`.

### fetchChannel

```js
youtube.channels.list({
  part: 'snippet,contentDetails,statistics,status,topicDetails',
  mine: true,
})
```

Returns the normalized channel, or `null` when the account owns none. `uploadsPlaylistId` comes from `contentDetails.relatedPlaylists.uploads` and is what every video enumeration keys off.

### fetchAllVideoIds

Pages `playlistItems.list` over the uploads playlist at `maxResults: 50`, following `nextPageToken` until exhausted.

**This must not be swapped for `search.list`.** `playlistItems.list` costs 1 quota unit per page of 50; `search.list` costs 100 per call — a 100× difference. A test asserts `search.list` is never called.

### fetchVideos

Batches ids 50 at a time into `videos.list`:

```js
youtube.videos.list({
  part: 'snippet,contentDetails,statistics,status,liveStreamingDetails,topicDetails',
  id: batch.join(','),
})
```

1 quota unit per batch. `liveStreamingDetails` is requested because `classifyContent()` uses its presence to identify live streams.

### Quota costs

| Operation | Cost |
|---|---|
| `channels.list` | 1 |
| `playlistItems.list` | 1 per page of 50 |
| `videos.list` | 1 per batch of 50 |
| `search.list` | **100** — never used |

The Data API grants 10,000 units/day per project. A full fetch for a 100-video channel costs roughly 5 units. The Analytics and Reporting APIs have separate quotas.

## Analytics API v2

Every fetcher in `src/api/analytics.js` funnels through one private `query()` helper that always sets `ids: 'channel==MINE'` and includes `dimensions`, `filters`, `sort`, and `maxResults` only when supplied.

Two undocumented limits are encoded as constants rather than left to callers, because exceeding either produces an opaque failure:

```js
const MAX_VIDEO_ROWS = 200;   // dimensions=video rejects maxResults above this
const MAX_DETAIL_ROWS = 25;   // insightTrafficSourceDetail errors above ~25
```

Both are applied with `Math.min`, so a caller cannot exceed them.

### Fetchers

| Fetcher | Metrics | Dimensions | Sort | maxResults |
|---|---|---|---|---|
| `fetchDailyAnalytics` | `views`, `estimatedMinutesWatched`, `averageViewDuration`, `likes`, `dislikes`, `comments`, `shares`, `subscribersGained`, `subscribersLost` | `day` | `day` | — |
| `fetchCardMetrics` | `views`, `annotationClickThroughRate`, `cardClicks`, `cardImpressions` | `day` | `day` | — |
| `fetchVideoAnalytics` | `views`, `estimatedMinutesWatched`, `averageViewDuration`, `averageViewPercentage`, `likes`, `comments`, `shares`, `subscribersGained`, `subscribersLost` | `video` | `-views` | ≤ 200 |
| `fetchTrafficSources` | `views`, `estimatedMinutesWatched` | `insightTrafficSourceType` | `-views` | — |
| `fetchDemographics` | `viewerPercentage` | `ageGroup,gender` | — | — |
| `fetchDeviceTypes` | `views`, `estimatedMinutesWatched` | `deviceType` | `-views` | — |
| `fetchContentTypes` | `views`, `estimatedMinutesWatched`, `likes`, `shares`, `subscribersGained`, `subscribersLost` | `creatorContentType` | `-views` | — |
| `fetchSearchTerms` | `views` | `insightTrafficSourceDetail` | `-views` | ≤ 25 |
| `fetchGeography` | `views`, `estimatedMinutesWatched`, `subscribersGained`, `subscribersLost` | `country` | `-views` | 50 |
| `fetchPlaybackLocations` | `views`, `estimatedMinutesWatched` | `insightPlaybackLocationType` | `-views` | — |
| `fetchTrafficSourceDetails` | `views` | `insightTrafficSourceDetail` | `-views` | ≤ 25 |
| `fetchAudienceRetention` | `audienceWatchRatio` | `elapsedVideoTimeRatio` | — | — |
| `runCustomReport` | caller-supplied | caller-supplied | caller-supplied | caller-supplied |

`fetchSearchTerms` filters with `insightTrafficSourceType==YT_SEARCH`; `fetchTrafficSourceDetails` filters on whichever source type it is given. `fetchAudienceRetention` filters `video==<videoId>`.

The `views`-only metric lists on the two detail fetchers are not an oversight: adding `estimatedMinutesWatched` to `insightTrafficSourceDetail` triggers an internal server error.

Tests assert the **exact query parameters** each fetcher sends. That is what pins these limits rather than merely documenting them.

### Notable omission

`videoThumbnailImpressions` and `videoThumbnailImpressionsClickRate` appear nowhere in this file. They are documented by Google but never work; a test asserts their absence. Impressions and CTR come from the Reporting API instead.

### fetchCardMetrics degrades silently

It is the one fetcher with its own `try`/`catch` returning `[]`, because some channels never have card data and the query fails outright. Unlike every other step, a failure here produces **no warning** — treat empty card fields as unknown rather than zero.

### runCustomReport

The escape hatch behind `ytstats query`. Returns `{ columns, rows }`, where `columns` is derived from the response's `columnHeaders` as `[{ name, type }]`.

## Reporting API v1

The only source of thumbnail impressions and CTR, and asynchronous by design. `src/api/reporting.js` uses one report type:

```js
export const REACH_REPORT_TYPE = 'channel_reach_basic_a1';
```

The lifecycle:

1. **`ensureReachJob()`** lists jobs and returns the existing one with a matching `reportTypeId`, creating it only if absent. Safe to call on every run — it never creates a duplicate.
2. **`listReports()`** pages `jobs.reports.list` for that job.
3. **Zero reports** → return `pending: true` with an explanatory `message`. The CLI surfaces this as the `REACH_PENDING` warning. Google generates the first reports within 24-48 hours, including a 30-day backfill.
4. **Download and merge.** Each report's `downloadUrl` is fetched through `apis.downloadCsv`, parsed, and folded into a `Map` keyed `` `${date}|${videoId}` ``. Reports overlap, so last write wins — later reports carry corrected figures for the same day.
5. **Sort** by date, then video id.

The CSV headers are **not** what the output field names suggest:

```
date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr
```

`fetchReach` reads `video_thumbnail_impressions` and `video_thumbnail_impressions_ctr`, falling back to the short `impressions` / `impressions_ctr` names should the schema ever change. Reading only the short names yields `null` for every row while the command still reports success — see [the gotcha](gotchas/youtube-api.md#the-reach-csv-columns-are-not-called-impressions).

A failed download is thrown with its HTTP status preserved as structure and wrapped in `call()`, so a Google 5xx classifies as `API_UNAVAILABLE` (retryable) rather than `UNEXPECTED`.

Rows are `{ date, channelId, videoId, impressions, impressionsCtr }`, with numbers coerced by `parseCsv`. **`impressionsCtr` is a decimal fraction, not a percentage**: `0.0561` means 5.61%.

Report data is permanently 1-2 days behind — the same lag YouTube Studio shows — because it covers midnight-to-midnight Pacific periods generated after the period closes.

### downloadCsv

Report bodies are plain CSV behind an OAuth-protected URL that the googleapis client does not handle, so `createApis` provides a `fetch` wrapper that attaches `Authorization: Bearer <token>` from `authClient.getAccessToken()` and requests gzip. A non-2xx response throws.

## Transforms

`src/api/transforms.js` is pure — no network, no auth, deterministic, directly tested.

| Function | Purpose |
|---|---|
| `parseDuration(iso)` | ISO 8601 duration (`PT15M33S`, `P1DT2H`) to whole seconds; `0` when absent or unparseable |
| `classifyContent(video)` | `LIVE_STREAM` if `liveStreamingDetails` is present, `SHORTS` if duration is 1-60s, else `VIDEO_ON_DEMAND` |
| `parseCsv(text)` | RFC 4180 subset: quoted fields, embedded commas and newlines, `""` escapes |
| `normalizeReportingDate(v)` | `20260328.0` → `2026-03-28`; ISO passes through; unrecognised values are returned unchanged |
| `rowsFromAnalytics(data)` | Zips `columnHeaders` + positional `rows` into objects |
| `normalizeChannel(ch)` | Flattens the channel resource into camelCase |
| `normalizeVideo(v)` | Flattens the video resource, adding `durationSeconds` and `contentType` |

Output is idiomatic camelCase JSON. Mapping it onto a particular database schema is the consumer's job.

A naive `split(',')` would corrupt report rows silently, because video titles and search terms routinely contain commas — hence the real parser. Its `coerce()` helper converts numeric-looking cells to numbers but leaves anything with a leading zero as a string, so zero-padded identifiers survive.

## Orchestration

`fetchAll()` in `src/fetch-all.js` runs every dataset in one pass. Order and concurrency:

1. **`fetchChannel`** — outside `step()`. A missing channel throws `NO_YOUTUBE_CHANNEL`; everything downstream needs `uploadsPlaylistId`.
2. **`fetchAllVideoIds`** then **`fetchVideos`** — sequential, the second needs the first.
3. **`fetchDailyAnalytics` + `fetchCardMetrics`** — concurrent; the results are merged by date.
4. **Eight analytics fetchers** — concurrent: video analytics, traffic sources, demographics, device types, content types, search terms, geography, playback locations.
5. **Traffic source details** — one call per source type the channel actually returned, concurrent.
6. **Retention** — sequential, one API call per video, capped at `retentionLimit` (default 50) with the newest videos first.
7. **Reach** — only with `reach: true`.

Every step after the channel runs inside `step(name, fn, fallback)`, which catches, records a warning, and returns the fallback — except for `FATAL_CODES` (`NOT_AUTHENTICATED`, `MISSING_CREDENTIALS`, `INVALID_CREDENTIALS`, `NO_YOUTUBE_CHANNEL`, `QUOTA_EXCEEDED`), which rethrow.

Returns `{ period: { startDate, endDate, days }, warnings, notes, data }`. When retention is truncated, `notes` says so explicitly.
