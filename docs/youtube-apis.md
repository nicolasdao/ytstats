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

### Captions

Two fetchers in `src/api/captions.js`, plus `fetchTranscript()` which chains them. These are the only calls in `ytstats` that need a scope outside the read-only default — see [the gotcha](gotchas/youtube-api.md#captions-have-no-read-only-scope-and-only-work-on-videos-you-own).

```js
youtube.captions.list({ part: 'snippet', videoId })
youtube.captions.download({ id: trackId, tfmt: 'vtt' })
```

`captions.list` returns the tracks with `{ id, language, trackKind, isAutoSynced, isDraft, lastUpdated }`. `lastUpdated` is load-bearing rather than informational: it is what the transcript cache keys on, because captions can be edited after upload and listing is far cheaper than downloading.

Two shapes differ from the documentation and are normalized here: `trackKind` arrives **lowercase** (`"asr"`, not `"ASR"`) and is uppercased, and `captions.download` returns a **Blob** rather than a string. Both are covered in [the gotchas](gotchas/youtube-api.md#captionsdownload-returns-a-blob-and-string-on-it-yields-object-blob).

`selectCaptionTrack()` prefers an author-written track over `ASR`, skips drafts, and the chosen track is reported in the output rather than applied silently. `captions.download` requires edit permission on the video, so this only works for videos you own.

`parseCues()` also de-duplicates YouTube's rolling auto-captions, where each cue restates the previous cue's text before adding new words — emitting them verbatim would put the same sentence at several timestamps.

Tests assert the exact parameters (`part`, `videoId`, `id`, `tfmt`), as with every other fetcher.

### Quota costs

| Operation | Cost |
|---|---|
| `channels.list` | 1 |
| `playlistItems.list` | 1 per page of 50 |
| `videos.list` | 1 per batch of 50 |
| `captions.list` | 50 |
| `captions.download` | 200 |
| `search.list` | **100** — never used |

`captions.download` at 200 units is the most expensive single call `ytstats` makes — roughly 50 transcripts against the 10,000/day Data API budget, and 250× a `videos.list` batch. That is why `transcript` is one video at a time with no bulk mode, and why its cache is load-bearing rather than an optimisation: a re-run that skips the download saves 200 units and costs 50.

The two figures come from different pages, which is easy to trip over: `captions.list` is in the [quota calculator](https://developers.google.com/youtube/v3/determine_quota_cost), but `captions.download` is **not** listed there at all — its cost is stated only on [its own reference page](https://developers.google.com/youtube/v3/docs/captions/download) ("A call to this method has a quota cost of 200 units"). Both verified 2026-07-30.

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
| `fetchDailyAnalytics` | `views`, `engagedViews`†, `estimatedMinutesWatched`, `averageViewDuration`, `likes`, `dislikes`, `comments`, `shares`, `subscribersGained`, `subscribersLost` | `day` | `day` | — |
| `fetchCardMetrics` | `cardImpressions`, `cardClicks`, `cardClickRate`, `cardTeaserImpressions`, `cardTeaserClicks`, `cardTeaserClickRate`, `annotationImpressions`, `annotationClickableImpressions`, `annotationClicks`, `annotationClickThroughRate`, `annotationCloseRate` | `day` | `day` | — |
| `fetchVideoAnalytics` | `views`, `engagedViews`†, `estimatedMinutesWatched`, `averageViewDuration`, `averageViewPercentage`, `likes`, `comments`, `shares`, `subscribersGained`, `subscribersLost` | `video` | `-views` | ≤ 200 |
| `fetchTrafficSources` | `views`, `engagedViews`†, `estimatedMinutesWatched` | `insightTrafficSourceType` | `-views` | — |
| `fetchDemographics` | `viewerPercentage` | `ageGroup,gender` | — | — |
| `fetchDeviceTypes` | `views`, `engagedViews`†, `estimatedMinutesWatched` | `deviceType` | `-views` | — |
| `fetchContentTypes` | `views`, `engagedViews`†, `estimatedMinutesWatched`, `likes`, `shares`, `subscribersGained`, `subscribersLost` | `creatorContentType` | `-views` | — |
| `fetchSearchTerms` | `views` | `insightTrafficSourceDetail` | `-views` | ≤ 25 |
| `fetchGeography` | `views`, `engagedViews`†, `estimatedMinutesWatched`, `subscribersGained`, `subscribersLost` | `country` | `-views` | 50 |
| `fetchPlaybackLocations` | `views`, `engagedViews`†, `estimatedMinutesWatched` | `insightPlaybackLocationType` | `-views` | — |
| `fetchTrafficSourceDetails` | `views` | `insightTrafficSourceDetail` | `-views` | ≤ 25 |
| `fetchAudienceRetention` | `audienceWatchRatio`, `relativeRetentionPerformance`†, `startedWatching`†, `stoppedWatching`†, `totalSegmentImpressions`† | `elapsedVideoTimeRatio` | — | — |
| `fetchSubGeography` | `views`, `engagedViews`†, `estimatedMinutesWatched` | `city` \| `province` \| `dma` | `-views` | 25 |
| `fetchOperatingSystems` | `views`, `engagedViews`†, `estimatedMinutesWatched` | `operatingSystem` | `-views` | — |
| `fetchSharingServices` | `shares` **only** | `sharingService` | `-shares` | — |
| `fetchPlaylists` | `views`, `estimatedMinutesWatched`, `playlistStarts`†, `viewsPerPlaylistStart`† | `playlist` | `-views` | 50 |
| `fetchRevenue` | `estimatedRevenue`, `estimatedAdRevenue`, `estimatedRedPartnerRevenue`†, `grossRevenue`, `cpm`, `playbackBasedCpm`†, `adImpressions`, `monetizedPlaybacks` | `day` | `day` | — |
| `runCustomReport` | caller-supplied | caller-supplied | caller-supplied | caller-supplied |

† Requested in the first tier and dropped if this channel rejects it — see [Metric tiers](#metric-tiers).

`fetchSearchTerms` filters with `insightTrafficSourceType==YT_SEARCH`; `fetchTrafficSourceDetails` filters on whichever source type it is given. `fetchAudienceRetention` filters `video==<videoId>`. `fetchSubGeography` adds `country==XX` when given one — **required** for `province`, optional for `city` and `dma`.

Three preconditions in that table are load-bearing rather than stylistic, and each fails opaquely without them: `province` needs the country filter, `sharingService` tolerates only `shares`, and the revenue query returns **zero rows with no error** unless `sort` is set. See [the gotcha](gotchas/youtube-api.md#three-more-dimensions-with-hard-preconditions).

The `views`-only metric lists on the two detail fetchers are not an oversight: adding `estimatedMinutesWatched` to `insightTrafficSourceDetail` triggers an internal server error.

Tests assert the **exact query parameters** each fetcher sends. That is what pins these limits rather than merely documenting them.

### Segmentation

Every fetcher above except the two `insightTrafficSourceDetail` ones takes an
optional `segment`, which appends a second dimension — `subscribedStatus` or
`youtubeProduct` — to its own and surfaces the value as a column on each row.
Surfaced as `--segment` on the dataset commands.

`withSegment()` does two things, and the second is the one that is easy to miss:

1. Appends the dimension: `day` becomes `day,subscribedStatus`.
2. **Narrows every metric tier to what that segment accepts.** A segment restricts
   the metric list of the report it partitions, and an unsupported metric fails the
   whole query — so requesting the unsegmented metric list alongside a segment
   returns no data at all.

| Segment | Metrics it accepts |
|---|---|
| `subscribedStatus` | `views`, `engagedViews`, `estimatedMinutesWatched`, `averageViewDuration`, `averageViewPercentage`, `likes`, `dislikes`, `shares` |
| `youtubeProduct` | the first five only — it rejects every engagement metric |

Both lists were captured by requesting each metric individually against a live
channel on 2026-07-30. Whatever the narrowing costs is reported through the same
`onDegraded` callback a tier drop uses, so it reaches the caller as an
`ANALYTICS_METRICS_UNSUPPORTED` warning naming each dropped metric.

Narrowing and tiering are independent: a segmented query still falls back from
`engagedViews` if this channel rejects it.

An unrecognised segment passes through untouched, leaving the API — not the table
above — to judge a dimension it has not been taught about. `fetchDemographics`
needs no narrowing, because `viewerPercentage` is the one metric no segment
restricts.

Which combinations a channel actually serves varies by report; the verified matrix
is in [cli.md](cli.md#--segment). A rejection surfaces as `API_QUERY_NOT_SUPPORTED`.

### Metric tiers

The Analytics API rejects the **whole query** when a channel cannot serve one requested metric — it does not return a null column. Requesting a newer metric unconditionally would therefore turn a working dataset into no dataset for anyone whose channel lacks it.

`queryTiered()` requests the richest metric set, and retries with the next tier down when a tier is refused. The last tier is the historical metric list; its failure propagates untouched. A 403 must never be quietly downgraded into "degraded data", so only a refusal triggers a retry.

**A refusal has two forms, and the silent one is the dangerous one.** Usually it is `API_QUERY_NOT_SUPPORTED`. But some combinations come back as **HTTP 200 with an empty `rows` array** — a success by every mechanical signal. A tier that returns zero rows is therefore treated as refused and the descent continues; if a thinner tier returns rows, those are used and the difference is reported through `onDegraded`. When *every* tier is empty the dataset is genuinely empty: the richest response is returned and nothing is reported as dropped. See [the gotcha](gotchas/youtube-api.md#a-refused-metric-combination-can-arrive-as-http-200-with-zero-rows) for the outage that proved it necessary.

Retention has four tiers, so a channel losing one capability does not forfeit the others:

```
audienceWatchRatio,relativeRetentionPerformance,startedWatching,stoppedWatching,totalSegmentImpressions
audienceWatchRatio,startedWatching,stoppedWatching,totalSegmentImpressions
audienceWatchRatio,relativeRetentionPerformance,totalSegmentImpressions
audienceWatchRatio
```

The second tier covers a channel with no peer set; the third covers the reverse — a channel that serves `relativeRetentionPerformance` but refuses the drop-off counts, which without that tier would fall all the way to bare `audienceWatchRatio` and lose the peer comparison for no reason.

Whatever was dropped is reported: `notes` in `fetchAll`, an `ANALYTICS_METRICS_UNSUPPORTED` warning on `ytstats retention`. Absent fields mean **unknown**, never zero.

### Reading retention

`audienceWatchRatio` says how many viewers remain at a point. It cannot say *why* a dip happened — the four added metrics can:

| Metric | Answers |
|---|---|
| `stoppedWatching` | How often viewers left during this segment — the literal drop-off |
| `startedWatching` | How often viewers joined here, i.e. skipped ahead to it |
| `totalSegmentImpressions` | The denominator, so the ratios can be turned back into counts |
| `relativeRetentionPerformance` | How this curve compares to similar YouTube videos, not to itself |

A dip with high `stoppedWatching` is content losing people; the same dip with high `startedWatching` upstream is viewers skipping an intro. Those call for opposite edits, and `audienceWatchRatio` alone cannot tell them apart.

### Notable omission

`videoThumbnailImpressions` and `videoThumbnailImpressionsClickRate` appear nowhere in this file. They are documented by Google but never work; a test asserts their absence. Impressions and CTR come from the Reporting API instead.

### fetchCardMetrics degrades silently

It is the one fetcher with its own `try`/`catch` returning `[]`, because some channels never have card data and the query fails outright. Unlike every other step, a failure here produces **no warning** — treat empty card fields as unknown rather than zero.

### runCustomReport

The escape hatch behind `ytstats query`. Returns `{ columns, rows }`, where `columns` is derived from the response's `columnHeaders` as `[{ name, type }]`.

## Reporting API v1

The only source of thumbnail impressions and CTR, and asynchronous by design.

**This API only generates a report once a job exists for it.** No job means no data — not withheld data, ungenerated data — and creating a job later backfills 30 days and nothing more. Reports then expire 60 days after generation (30 for backfill reports), so a job nobody downloads from also loses history. Both halves matter; see [the gotcha](gotchas/youtube-api.md#a-reporting-api-report-type-with-no-job-collects-nothing-forever).

### Job coverage

| Function | Purpose |
|---|---|
| `listReportTypes(apis)` | What this channel may schedule, from `reportTypes.list`. Discovered live — ids are version-bumped in place and Google's own doc pages disagree, so a constant would rot. Needs only `yt-analytics.readonly`, already requested. |
| `listJobs(apis)` | Every scheduled job, paged. Exported as `listReachJobs` too, which is the published name. |
| `auditReportingJobs(apis)` | `{ available, active, missing, coverage, jobs, jobCount }` — the comparison that makes the gap visible |
| `ensureJobs(apis, ids)` | Creates jobs for ids with none. One rejected type does not abort the rest: `{ created, skipped, failed }` |

Deprecated (`deprecateTime`) and `systemManaged` types are excluded from `available` — `jobs.create` rejects both.

Surfaced as `ytstats reports` / `ytstats reports-enable`, and as the `reporting_jobs` check in `doctor`, which **fails** rather than warns because the loss compounds every day it goes unnoticed.

### The reach lifecycle

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
4. **Thirteen analytics fetchers** — concurrent: video analytics, traffic sources, demographics, device types, content types, search terms, geography, playback locations, cities, operating systems, sharing services, playlists, revenue. `fetchAll` requests only the `city` level of sub-national geography, since `province` needs a country filter it cannot guess; `regions --level province` covers that.
5. **Traffic source details** — one call per source type the channel actually returned, concurrent.
6. **Retention** — sequential, one API call per video, capped at `retentionLimit` (default 50) with the newest videos first.
7. **Reach** — only with `reach: true`.

Every step after the channel runs inside `step(name, fn, fallback)`, which catches, records a warning, and returns the fallback — except for `FATAL_CODES` (`NOT_AUTHENTICATED`, `MISSING_CREDENTIALS`, `INVALID_CREDENTIALS`, `NO_YOUTUBE_CHANNEL`, `QUOTA_EXCEEDED`), which rethrow.

Returns `{ period: { startDate, endDate, days }, warnings, notes, data }`. When retention is truncated, `notes` says so explicitly.
