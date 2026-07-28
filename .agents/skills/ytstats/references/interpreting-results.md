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

## Retention ratios above 1.0 are correct

A `ratio` of `1.54` at some position means viewers **rewatched that moment** — a loop, common on Shorts. Never clamp it, never call it a bug, never describe it as "over 100% which must be an error." It is the most interesting signal in the curve.

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
