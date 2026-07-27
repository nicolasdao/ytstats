# YouTube API Gotchas

Non-obvious behaviour of the three YouTube APIs, learned the hard way. Each entry
explains what breaks, why, and where `ytstats` handles it — so a future change does
not silently undo a workaround.

## Table of Contents

- [CTR and Impressions Do Not Work on the Analytics API](#ctr-and-impressions-do-not-work-on-the-analytics-api)
- [Reporting API Data Is Always 1-2 Days Behind](#reporting-api-data-is-always-1-2-days-behind)
- [The First Reach Run Returns Nothing for 24-48 Hours](#the-first-reach-run-returns-nothing-for-24-48-hours)
- [Per-Video Analytics Rejects maxResults Above 200](#per-video-analytics-rejects-maxresults-above-200)
- [Traffic Source Detail Queries Are Fragile](#traffic-source-detail-queries-are-fragile)
- [Retention Ratios Legitimately Exceed 1.0](#retention-ratios-legitimately-exceed-10)
- [Two Content Type Vocabularies Disagree](#two-content-type-vocabularies-disagree)
- [Subscriber Counts Are Rounded](#subscriber-counts-are-rounded)
- [Service Accounts Can Never Be Used](#service-accounts-can-never-be-used)
- [Testing-Mode Consent Screens Expire Tokens Weekly](#testing-mode-consent-screens-expire-tokens-weekly)
- [A Bad Client ID Fails in the Browser, Not the API](#a-bad-client-id-fails-in-the-browser-not-the-api)
- [Reporting API CSVs Need a Real CSV Parser](#reporting-api-csvs-need-a-real-csv-parser)
- [search.list Costs 100x What playlistItems.list Costs](#searchlist-costs-100x-what-playlistitemslist-costs)

## CTR and Impressions Do Not Work on the Analytics API

The Analytics API documents `videoThumbnailImpressions` and
`videoThumbnailImpressionsClickRate` as valid channel-report metrics. **They do not
work.** Every combination returns `The query is not supported.`

This is a [known Google issue](https://issuetracker.google.com/issues/254665034)
affecting all channels regardless of size. The only working source is the Reporting
API's `channel_reach_basic_a1` report — which is why `ytstats reach` exists at all
and why it works so differently from every other command.

**Where handled:** `src/api/reporting.js`. Never add these metrics to
`src/api/analytics.js`; a test asserts they are absent.

## Reporting API Data Is Always 1-2 Days Behind

Reports cover midnight-to-midnight Pacific Time and are generated 1-2 days after the
period closes. `ytstats reach` will never return data for today or yesterday.

This is not a limitation of `ytstats` — YouTube Studio shows the same lag, because
real-time impression data does not exist anywhere.

## The First Reach Run Returns Nothing for 24-48 Hours

The first `ytstats reach` only *creates* the reporting job. Google then generates
reports within 24-48 hours, including a 30-day backfill. Until then there is
genuinely nothing to download.

This is reported as the `REACH_PENDING` **warning**, not an error — the command
succeeded, the data simply does not exist yet. Re-running is harmless and does not
create a duplicate job.

**Where handled:** `fetchReach()` in `src/api/reporting.js`.

## Per-Video Analytics Rejects maxResults Above 200

Queries with `dimensions=video` fail if `maxResults` exceeds 200. Channels with more
than 200 videos get only the top 200 by the sort field.

**Where handled:** `MAX_VIDEO_ROWS` in `src/api/analytics.js`, clamped with
`Math.min` so a caller cannot exceed it. A test asserts the clamp.

## Traffic Source Detail Queries Are Fragile

The `insightTrafficSourceDetail` dimension has three separate traps:

1. It **requires** both `sort` and `maxResults`. Without `maxResults` the query
   returns `The query is not supported.`
2. With `maxResults` too high (50+) it returns `Internal error encountered.` The
   safe ceiling is **25**.
3. Combining it with `estimatedMinutesWatched` also triggers an internal error.
   Only `views` is reliable.

**Where handled:** `MAX_DETAIL_ROWS` and the `metrics: 'views'` literal in
`src/api/analytics.js`. Tests assert all three.

## Retention Ratios Legitimately Exceed 1.0

`audienceWatchRatio` returns values above 1.0 for Shorts that viewers loop. A
25-second Short showing `1.54` at position 0 means 54% more viewing than the number
of initial viewers.

This is a strong engagement signal, **not** a data error. `ytstats` never clamps it,
and a test pins that behaviour so nobody "fixes" it later.

## Two Content Type Vocabularies Disagree

| Source | Values |
|---|---|
| `classifyContent()`, duration-based | `SHORTS`, `VIDEO_ON_DEMAND`, `LIVE_STREAM` |
| YouTube's `creatorContentType` dimension | `shorts`, `videoOnDemand`, `creatorContentTypeUnspecified` |

Different casing *and* different semantics. Our classifier uses duration alone
(`<= 60s` is a Short), so a 62-second video intended as a Short reads as
`VIDEO_ON_DEMAND`. YouTube uses additional signals and may disagree.

Consumers wanting YouTube's own opinion should read the `contentTypes` dataset
rather than the `contentType` field on a video.

## Subscriber Counts Are Rounded

Above 1,000 subscribers, the Data API returns counts rounded to 3 significant
figures — expect `1,020` or `10,400`, never exact values. Below 1,000 the count is
exact. Week-over-week deltas smaller than the rounding step are invisible.

## Service Accounts Can Never Be Used

A platform limitation with no workaround. A service account owns no YouTube channel
and there is no way to link one, so Google rejects the flow with
`NoLinkedYouTubeAccount`. Domain-wide delegation does not help — it is itself a
service-account mechanism.

> "the YouTube Reporting API and YouTube Analytics API do not support this flow.
> Since there is no way to link a Service Account to a YouTube account, attempts to
> authorize requests with this flow will generate an error."
> — [Google's authorization guide](https://developers.google.com/youtube/reporting/guides/authorization)

The only service-account-based YouTube API is the Content ID API, which is
partner-only and does not cover single-channel analytics.

**Where handled:** `parseClientSecret()` detects a service account key and fails
with `AUTH_SERVICE_ACCOUNT`, marked `recoverable: false` so an agent stops instead
of retrying forever.

## Testing-Mode Consent Screens Expire Tokens Weekly

While an OAuth consent screen is in **Testing** status, Google expires refresh
tokens after **7 days**. The symptom is re-authenticating every week, surfacing as
`invalid_grant`.

Publishing the consent screen to Production removes the expiry. Verification is not
required for personal use — the user clicks past a one-time "unverified app"
warning.

**Where handled:** `invalid_grant` maps to `AUTH_TOKEN_EXPIRED`, whose remediation
names this as the likely root cause rather than just saying "log in again".

## A Bad Client ID Fails in the Browser, Not the API

An invalid or malformed client ID produces **no API error**. Google renders
"Access blocked: Authorization Error" in the browser and never redirects, so the
loopback listener waits until it times out. The resulting `AUTH_TIMEOUT` is
misleading: retrying can never help.

**Where handled:** `validateClientId()` in `src/auth/credentials.js` runs before any
browser opens, turning a five-minute hang into an instant `AUTH_CLIENT_ID_INVALID`.
`AUTH_TIMEOUT` also names "Access blocked" as the leading cause and is marked
`retryable: false`.

## Reporting API CSVs Need a Real CSV Parser

Report bodies contain video titles and search terms, which routinely include commas
and quotes. Splitting on `,` silently corrupts rows — and the corruption is quiet,
producing plausible-looking wrong data.

**Where handled:** `parseCsv()` in `src/api/transforms.js` implements the RFC 4180
subset that matters: quoted fields, embedded commas and newlines, `""` escapes.

Separately, report dates arrive as `20260328.0` while every other surface uses ISO.
`normalizeReportingDate()` unifies them so consumers never see two date formats.

## search.list Costs 100x What playlistItems.list Costs

The Data API allows 10,000 quota units per project per day.

| Operation | Cost |
|---|---|
| `channels.list` | 1 |
| `playlistItems.list` | 1 per page of 50 |
| `videos.list` | 1 per batch of 50 |
| `search.list` | **100** |

`ytstats` enumerates videos through the channel's uploads playlist, never
`search.list`. A full fetch for a 100-video channel costs roughly 5 units. A test
asserts `search.list` is never called.

The expensive operation is retention: one Analytics call **per video**, which is why
`fetch` caps it at 50 videos by default (`--retention-limit`) and offers
`--no-retention`.
