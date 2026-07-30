# Interpreting Results

Things that are correct but look wrong, and things that look fine but are not. Every entry here is a way to report a number accurately when the naive reading would be wrong.

## CTR is a fraction, not a percentage

`impressionsCtr: 0.0561` means **5.61%**. Multiply by 100 before showing it to anyone.

Reporting `0.0561` as "0.06% click-through" understates the channel by two orders of magnitude and reads as catastrophic when the real figure is healthy. This is the single easiest number in the whole surface to misreport.

## CTR only comes from `reach`, and it lags

The Analytics API documents `videoThumbnailImpressions` but it has **never worked** — do not reach for `query -m videoThumbnailImpressions`, it will fail or return nothing. CTR is served asynchronously by the Reporting API through `ytstats reach`.

That command behaves unlike every other one:

- The **first run only creates the job**. It returns `pending: true` with a `REACH_PENDING` warning and no rows. That is success, not failure — `ok` is `true`.
- Reports appear **24 to 48 hours later**, with a 30-day backfill.
- The data is permanently **1 to 2 days behind**, the same lag YouTube Studio shows.

So "what's my CTR" on a channel that has never run `reach` is answered by starting the job and telling the user to come back tomorrow. Do not treat the empty first result as an error, and do not re-run it repeatedly hoping for data — re-running is harmless but changes nothing.

**Rows present but every `impressions` null means an outdated CLI, not an empty channel.** Distinguish the two cases before answering:

| `rows` | `pending` | Means |
|---|---|---|
| empty | `true` | Job just created. Real — come back in 24-48h |
| populated, values present | `false` | Real data |
| **populated, every `impressions` and `impressionsCtr` null** | `false` | **`ytstats` older than 0.2.1** |

Versions before 0.2.1 read the wrong CSV columns, so every row resolved to `null` while the command still reported `ok: true` with no warning. Nothing distinguishes it from a genuine absence except the shape: a real report never returns hundreds of rows in which *every* impression field is null.

If you see that, check `ytstats --version` and say the CLI needs upgrading. Do **not** report "no impressions data" — the data exists and is being dropped in transit.

## Retention ratios above 1.0 are correct

A `ratio` of `1.54` at some position means viewers **rewatched that moment** — a loop, common on Shorts. Never clamp it, never call it a bug, never describe it as "over 100% which must be an error." It is the most interesting signal in the curve.

## "How far back does my data go" is answered by the archive, not the channel

For anything from `reach` or the Reporting API, the honest answer comes from `ytstats archive` → `reportTypes[].firstDate`, never from when the channel was created or when jobs were enabled.

Reports expire 60 days after YouTube generates them, so data that was never downloaded inside that window does not exist anywhere anymore. A channel running for years can have an archive starting two months ago, and that is not a bug — it is the expiry window.

Say this plainly rather than implying the earlier history is retrievable. It is not, by any API call.

## A retention dip has two opposite explanations

`ratio` tells you **where** viewers thinned out. It cannot tell you **why**, and the two causes need opposite advice:

| Signal | Meaning | What to advise |
|---|---|---|
| High `stoppedWatching` in the segment | Viewers **left** here | The content lost them — cut, tighten, or reorder |
| High `startedWatching` just after a low-`ratio` stretch | Viewers **skipped** that stretch | They found it skippable — move the payload earlier |

Reporting a dip without checking which one moved is guessing. Say which it was.

`relativeRetentionPerformance` compares the curve to **similar YouTube videos**, so it answers "is this normal for a video like mine" rather than "where is my worst moment". A curve that looks poor in isolation can be above average for its length and category — and that changes the recommendation entirely.

`totalSegmentImpressions` is the denominator when someone wants counts rather than ratios.

Any of these four can be `null`, which means **the channel cannot serve that metric** — never that it is zero. A dropped metric comes with an `ANALYTICS_METRICS_UNSUPPORTED` warning naming it. Requires ytstats 0.6.0+; older versions return only `position` and `ratio`.

## `views` changed meaning on 30 April 2025

YouTube redefined the metric rather than adding a new one: a **Shorts** view is now every play or replay, with no minimum watch time. Long-form was unaffected. `engagedViews` carries the previous definition.

This matters whenever a question spans that date:

- **"Are my Shorts doing better than last year?"** — on `views` alone the answer is yes for mechanical reasons. Compare `engagedViews` instead.
- **"Shorts vs long-form"** — `views` overstates Shorts after April 2025 because only one side changed counting method.
- **A step change in the daily series around 2025-04-30** is the redefinition, not something the user did.

Both fields are present on `daily`, `video-analytics`, `traffic`, `devices`, `content-types`, `geography`, and `playback-locations` (0.6.0+). Use `views` for "what YouTube reports today", `engagedViews` for anything comparative across that boundary — and say which you used.

If `engagedViews` is `null`, this channel cannot serve it; do not substitute `views` silently.

## Shorts detection is duration-based and disagrees with YouTube

`ytstats videos` classifies by duration: `≤60s` is `SHORTS`. A 62-second video intended as a Short reads as `VIDEO_ON_DEMAND`.

YouTube's own classification uses extra signals. When the question is "how are my Shorts doing", `content-types` carries YouTube's opinion via `creatorContentType` and is the better source. Use `videos -t SHORTS` for a duration cut, `content-types` for YouTube's.

Say which definition you used when the two could disagree.

## Subscriber counts are rounded

Above 1,000, YouTube rounds to **3 significant figures**. `1,230` may be anything from 1,225 to 1,234. Small week-over-week changes are invisible, so do not report a delta of "+3 subscribers" derived from two rounded figures — the precision is not there.

## Per-video analytics caps at 200

`video-analytics` returns the top 200 videos by views. That is an API limit, not a ytstats choice. On a channel with more than 200 videos the tail is simply absent — say so rather than presenting the set as complete.

## Empty is not the same as failed, and not the same as absent

Three distinct states, easy to conflate:

| State | Signal | Meaning |
|---|---|---|
| Genuinely zero | `ok: true`, `rows: []`, `DATA_EMPTY` warning | The query worked, the channel had no activity |
| Not fetched | `fetch` only — dataset empty **and** named in `data.warnings[]` | That step failed and degraded; the data exists but was not retrieved |
| Failed | `ok: false`, `data: null` | Nothing was retrieved. `data` is never partial |

In a `fetch` result, always check `data.warnings[]` before describing any dataset as empty. An empty `demographics` with a warning naming `demographics` means "YouTube rejected this query for this channel", not "your channel has no viewers".

## Warnings never mean failure

`warnings` never affects `ok` and never affects the exit code. A run with twelve warnings and `ok: true` succeeded. `doctor` in particular always exits 0 even when it finds problems — its verdict is `data.healthy`, and the blocking items are in `data.blocking`.

## The reporting window is UTC

`--days 30` means 30 days ending today **in UTC**, not local time. Near midnight in a distant timezone the boundary can differ from what the user expects by a day.

## Fetch degrades, so check the manifest

`fetch` runs every dataset independently. `data.warnings[]` lists what failed as `{step, code, message}`, and `data.notes[]` carries non-failures worth knowing — for example "retention fetched for 50 of 120 videos" when `--retention-limit` truncated the run.

Read both before summarizing a snapshot. Reporting "14 datasets pulled" when three degraded is a false clean bill of health.
