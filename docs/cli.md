---
description: Complete ytstats command reference — every command, flag, default, and exit code.
tags: [cli, commands, flags, reference]
source:
  - src/cli.js
  - src/dates.js
---

# CLI Reference

Every command, every flag. For the shape of what comes back, see [output-contract.md](output-contract.md). For what the underlying API calls cost, see [youtube-apis.md](youtube-apis.md).

## Invocation

```bash
ytstats [global flags] <command> [command flags]
```

Installed globally, or run without installing via `npx ytstats <command>`.

Everything below can also be driven in plain English by the `nicolasdao/ytstats` agent skill, which covers all 27 commands and auto-invokes — see [Drive it from an AI agent](../README.md#drive-it-from-an-ai-agent).

## Global flags

Global flags go **before** the command name.

| Flag | Default | Effect |
|---|---|---|
| `-a, --account <channel>` | the default account | Channel id or `@handle` to use when several are signed in |
| `--compact` | off | Single-line JSON instead of pretty-printed |
| `-q, --quiet` | off | Suppress progress and warnings on stderr; stdout is unaffected |
| `-V, --version` | — | Print the package version and exit 0 |
| `-h, --help` | — | Print usage and exit 0 |

```bash
ytstats --account UC1234567890 --compact daily --days 7
```

`--account` accepts a channel id, a custom URL/handle, or a channel title — `loadAccount()` matches the id first, then falls back to a case-insensitive comparison against `customUrl` and `channelTitle`. An unrecognised selector fails with `AUTH_ACCOUNT_UNKNOWN`; it never silently falls back to the default.

## Date window flags

Every analytics command accepts the same three flags:

| Flag | Default | Notes |
|---|---|---|
| `-d, --days <number>` | `90` | Days of history ending today (UTC) |
| `--start <date>` | — | `YYYY-MM-DD`; overrides `--days` |
| `--end <date>` | today (UTC) | `YYYY-MM-DD` |

Rules enforced before any network call:

- Dates must match `YYYY-MM-DD` exactly. A locale format such as `01/01/2026` fails with `INPUT_INVALID_DATE`.
- The date must exist on the calendar. `2026-02-31` is rejected — `Date` would otherwise roll it silently into March.
- `--days` must be a positive number, and at most **3650** (enforced in `src/dates.js`).
- `--start` must be on or before `--end`, checked only once both parse cleanly.

All input problems are reported **together**, in one envelope, before authentication:

```bash
$ ytstats daily --start 01/01/2026 --end yesterday --days -3
# → 3 errors in one envelope: two INPUT_INVALID_DATE, one INPUT_INVALID_RANGE
```

## Authentication commands

### login

```bash
ytstats login [-c|--client-secret <path>] [--no-browser] [--with-captions] [--timeout <seconds>]
```

Runs the loopback OAuth flow: opens the browser, captures the callback on `127.0.0.1`, exchanges the code, fetches the channel identity, and stores both the OAuth client and the tokens.

| Flag | Default | Effect |
|---|---|---|
| `-c, --client-secret <path>` | resolution order below | Path to the `client_secret` JSON downloaded from Google Cloud |
| `--no-browser` | off | Print the URL and read the pasted redirect back — for SSH and headless machines |
| `--with-captions` | off | Also request caption access, which `ytstats transcript` needs. Write-capable — see below |
| `--timeout <seconds>` | `300` | How long to wait for the browser callback, so an automated caller is never blocked indefinitely |

Credentials are resolved in this order: `--client-secret` → `YTSTATS_CLIENT_ID`/`YTSTATS_CLIENT_SECRET` → `YTSTATS_CREDENTIALS_FILE` → stored `credentials.json` → `client_secret*.json` in the working directory. See [configuration.md](configuration.md).

Returns `{ channelId, channelTitle, customUrl, configDir }`.

```bash
ytstats login --client-secret ~/Downloads/client_secret_1234.json
ytstats login --no-browser          # headless
ytstats login --with-captions       # adds caption access, for `ytstats transcript`
```

**About `--with-captions`.** The default grant is three read-only scopes. Captions have no read-only scope — `captions.list` and `captions.download` both require `youtube.force-ssl`, which Google's consent screen calls *"Manage your YouTube account"* — so the only way to read a transcript is to hold a write-capable scope. `ytstats` still never writes.

It is opt-in for that reason: nobody acquires write capability without asking for it. Adding it later is safe and additive, because incremental authorization is enabled — the scopes you already granted are kept rather than replaced. Running `transcript` without it fails with [`AUTH_SCOPE_MISSING`](output-contract.md#diagnostic-catalog) and names the command to fix it.

### logout

```bash
ytstats logout [--all] [--forget-credentials]
```

Revokes the token with Google (best effort) and deletes it locally.

| Flag | Default | Effect |
|---|---|---|
| `--all` | off | Log out of every channel on this machine |
| `--forget-credentials` | off | Also delete the stored OAuth client id and secret |

Local removal happens even when revocation fails — being offline should not leave credentials on disk. Returns `{ loggedOut, revoked, accounts }`.

### status

```bash
ytstats status
```

Reports who is signed in and where configuration lives. Takes no flags and needs no authentication. This is the "who am I" command.

Returns `{ authenticated, configDir, credentialSource, clientId, project, accounts[], setupGuide? }`. Each account carries `channelId`, `channelTitle`, `customUrl`, `clientId`, `savedAt`, and `isDefault` — never token material. `setupGuide` appears only when no account is signed in.

`credentialSource` says *where* the OAuth client came from (a path, `environment`, or `stored`); `clientId` says *which* client that turned out to be. Both are `null` when no credentials resolve. Client IDs are public by OAuth design — only the secret is sensitive — so neither field is redacted.

`project` is `{ id, number, consoleUrl }` — which Google Cloud project these credentials belong to. `number` is the leading segment of the client ID and is always available; `id` is the human-readable project id, present only when the original `client_secret.json` carried it. `consoleUrl` is pre-pinned with `?project=`, because a bare console link opens whichever project the browser last used — very often the wrong one for anyone signed into several accounts.

Comparing the top-level `clientId` against an account's `clientId` tells you whether that channel's stored token was issued by the client currently resolving. A disagreement is what [`AUTH_CLIENT_MISMATCH`](output-contract.md#diagnostic-catalog) reports on the next authenticated command.

```bash
ytstats status 2>/dev/null | jq '{clientId, credentialSource}'
ytstats status 2>/dev/null | jq -r '.data.accounts[] | select(.isDefault) | .channelTitle'
```

### doctor

```bash
ytstats doctor
```

Runs nine independent readiness checks, cheapest first, and reports all of them rather than stopping at the first failure. Together they cover the whole setup walkthrough, so `doctor` is the one call that answers "what is still missing".

| Check id | What it proves |
|---|---|
| `config_writable` | The config directory exists and accepts a write (probe file is written then removed) |
| `credentials` | An OAuth client resolved from some source |
| `signed_in` | At least one channel has stored tokens |
| `api_reachable` | A live `channels.list` succeeds — the **Data API v3** is enabled |
| `api_analytics` | A one-day `reports.query` succeeds — the **Analytics API v2** is enabled |
| `api_reporting` | `jobs.list` succeeds — the **Reporting API v1** is enabled |
| `reporting_jobs` | Every schedulable report type has a job — see below, this is the one that reports a *loss* |
| `reports_archived` | No generated report is within 14 days of expiring un-downloaded |
| `consent_screen` | Published to Production — see below, this one is usually `unknown` |

The three APIs are enabled **independently** in Google Cloud, so each gets its own probe. Reaching only the Data API and reporting healthy would be worse than not checking: setup looks complete, then the first `daily` or `reach` fails with `API_NOT_ENABLED` and nothing points at the missing API. All three are skipped when earlier checks failed, since they cannot succeed.

Every check carries a `status` of `pass`, `fail`, or `unknown` alongside its boolean `ok`.

**`reporting_jobs` and `reports_archived` are two halves of one problem.** A job makes YouTube *generate* a report; it does nothing to stop that report expiring 60 days later. A channel can have perfect job coverage and still lose everything because nothing ever downloaded it. `reports_archived` fails when an un-downloaded report is within 14 days of expiry — fix with `ytstats sync`.

**`reporting_jobs` is the only check that reports something already lost.** The other seven report a blockage — something is not working and can be fixed. This one reports that data was never collected. The Reporting API generates nothing for a report type until a job exists, and creating one later backfills only 30 days, so a channel can look completely healthy while months of history quietly fail to exist. It fails rather than warns for that reason: a warning that costs a month of data per month ignored is mis-graded. Fix it with `ytstats reports-enable --all`.

**`consent_screen` is the honest gap.** No Google API exposes whether the consent screen is published, and it is the one setup step whose failure is *delayed* — in Testing, Google expires refresh tokens after 7 days. It is reported as `status: "unknown"` with the console URL rather than omitted, so `healthy: true` never implies a prerequisite nobody looked at. An `unknown` never counts against `healthy`: "we could not look" is not "we found a problem".

It flips to `pass` on its own once a working token is more than 7 days old — Testing mode would already have expired it, so age is proof.

`doctor` itself always succeeds — `ok: true`, exit 0. The verdict is `data.healthy`, and the blocking diagnostics are in `data.blocking`. Failures are also attached as envelope warnings. This is deliberate: a health check that exits non-zero when it finds a problem is reporting its own success incorrectly.

### use

```bash
ytstats use <channelId|@handle>
```

Sets the default channel for subsequent commands. Fails if that channel is not signed in.

### import-legacy

```bash
ytstats import-legacy <tokensFile> [-c|--client-secret <path>]
```

Imports tokens from a pre-`ytstats` project-local `tokens.json`. The legacy file holds no channel identity, so the tokens are exchanged for one before anything is stored. Never overwrites an account that already exists — it returns `{ migrated: false, reason }` instead, where `reason` is one of `no-refresh-token`, `unknown-channel`, or `already-logged-in`.

An expired legacy refresh token fails with `AUTH_TOKEN_EXPIRED` and a `ytstats login` next step — the ordinary outcome when the old setup went stale. An unreadable path fails earlier with `INPUT_INVALID_VALUE`, which is why the CLI never returns the `no-legacy-file` reason that `migrateLegacyTokens()` still reports to library callers.

## fetch

```bash
ytstats fetch [--days 90] [--start <date>] [--end <date>]
              [--no-retention] [--retention-limit <n>] [--reach]
```

Every dimension in a single JSON document — the command to pipe into a script.

| Flag | Default | Effect |
|---|---|---|
| `--no-retention` | retention on | Skip retention curves, which cost one API call per video |
| `--retention-limit <number>` | `50` | How many recent videos to pull retention for, newest first |
| `--reach` | off | Also include thumbnail impressions and CTR from the Reporting API |

`data` contains `channel`, `videos`, `daily`, `videoAnalytics`, `trafficSources`, `trafficSourceDetails`, `demographics`, `deviceTypes`, `contentTypes`, `searchTerms`, `geography`, `playbackLocations`, `audienceRetention`, and `reach` when `--reach` is passed.

Alongside it: `period` (`{ startDate, endDate, days }`), `warnings` (per-step failures, each `{ step, code, message }`), and `notes` (informational, such as a truncated retention run).

Individual analytics steps degrade rather than abort — see [architecture.md](architecture.md#fetch-all-orchestration).

```bash
ytstats fetch --days 90 > snapshot.json
ytstats fetch --no-retention --days 30      # cheapest full fetch
ytstats fetch --reach                       # includes CTR, if reports exist yet
```

## Dataset commands

All of these accept the date window flags above and return `{ period, rows }`. An empty `rows` array raises a `DATA_EMPTY` warning so "the query worked and found nothing" is distinguishable from "the query failed".

They also raise `ANALYTICS_METRICS_UNSUPPORTED` when a metric this channel cannot serve was dropped from the query — `context.dropped` names it. Without that warning a null column is indistinguishable from a genuine zero, which is the failure mode [the reach CSV regression](gotchas/youtube-api.md#the-reach-csv-columns-are-not-called-impressions) took two months to notice. **An absent field means unknown, never zero.**

| Command | Returns | Extra flags |
|---|---|---|
| `channel` | Channel metadata and lifetime stats *(no period; no date flags)* | — |
| `videos` | Every video with metadata and current counts *(no period; no date flags)* | see below |
| `daily` | Day-by-day views, watch time, likes, comments, subscribers | — |
| `traffic` | Views by traffic source type | — |
| `demographics` | Viewer age and gender split | — |
| `devices` | Views by device type | — |
| `content-types` | Shorts vs long-form vs live, using YouTube's own `creatorContentType` | — |
| `search-terms` | What people search on YouTube to find the channel | `-n, --limit` (default `25`, capped at 25) |
| `geography` | Viewer breakdown by country | `-n, --limit` (default `50`) |
| `playback-locations` | Where viewers watch — Shorts feed, watch page, embedded | — |
| `video-analytics` | Per-video metrics, top 200 by views | — |

### channel

```bash
ytstats channel
```

Returns the channel resource directly, not `{ period, rows }`: `id`, `title`, `description`, `customUrl`, `publishedAt`, `country`, `subscriberCount`, `viewCount`, `videoCount`, `uploadsPlaylistId`, `thumbnailUrl`.

### videos

```bash
ytstats videos [-n <number>] [-s <field>] [--order asc|desc] [-t <type>]
```

| Flag | Default | Choices |
|---|---|---|
| `-n, --limit <number>` | all | — |
| `-s, --sort <field>` | `publishedAt` | `publishedAt`, `viewCount`, `likeCount`, `commentCount`, `durationSeconds` |
| `--order <dir>` | `desc` | `asc`, `desc` |
| `-t, --type <type>` | all | `SHORTS`, `VIDEO_ON_DEMAND`, `LIVE_STREAM` |

Filtering and sorting happen locally after every video is fetched, so `-n` reduces output size but not API cost. `contentType` is duration-based and can disagree with YouTube's own classification — see [the gotcha](gotchas/youtube-api.md#two-content-type-vocabularies-disagree).

```bash
ytstats videos --type SHORTS --sort viewCount | jq '.data[0:5]'
```

### retention

```bash
ytstats retention <videoId> [--days 90] [--start <date>] [--end <date>]
```

Audience retention curve for one video — roughly 100 points at 1% intervals. Returns `{ videoId, period, curve }`, where each point is:

| Field | Meaning |
|---|---|
| `position` | Elapsed fraction of the video, `0`–`1` |
| `ratio` | `audienceWatchRatio` — how many viewers are still watching here |
| `stoppedWatching` | How often viewers **left** during this segment |
| `startedWatching` | How often viewers **joined** here, i.e. skipped ahead to it |
| `totalSegmentImpressions` | The denominator, for turning ratios back into counts |
| `relativeRetentionPerformance` | How this curve compares to similar YouTube videos |

Ratios above `1.0` are correct and never clamped: a Short showing `1.54` means viewers looped it.

The last four are the ones that explain a dip. A trough with high `stoppedWatching` is content losing people; the same trough preceded by high `startedWatching` is viewers skipping an intro. Those need opposite edits, and `ratio` alone cannot distinguish them.

Any of the four may be `null` if this channel cannot serve it — `relativeRetentionPerformance` needs a peer set and is the most often missing. When that happens the command emits an `ANALYTICS_METRICS_UNSUPPORTED` warning naming exactly what was dropped. **A `null` here means unknown, never zero.**

### transcript

```bash
ytstats transcript <videoId>
```

The caption transcript for one video, with cue timings — the other half of a retention analysis. `retention` says *where* viewers left; this says *what was being said* there.

Requires the opt-in captions scope: run `ytstats login --with-captions` first. Without it the command fails with `AUTH_SCOPE_MISSING` rather than an opaque Google 403. It takes no date flags — a transcript is not a time series.

Returns `{ videoId, trackId, language, trackKind, lastUpdated, cachedAt, cues }`. Each cue is exactly:

| Field | Meaning |
|---|---|
| `start` | Cue start, in **seconds as a number** — not a timestamp string |
| `end` | Cue end, same units |
| `text` | What was said, with multi-line cues joined and markup stripped. Rolling auto-caption repetition is removed, so a sentence appears once, at the moment it was said |

Seconds because retention's x-axis is `elapsedVideoTimeRatio`, a fraction of the video: aligning the two needs numbers and the video's duration (from `ytstats videos`). The join is deliberately left to the consumer — `ytstats` emits the two primitives rather than a correlation it would have to guess the shape of.

**`trackKind` matters when reading the text.** `ASR` means YouTube's speech recognition wrote it, and it mishears names, jargon and anything over music. Anything else was written by the channel owner. `ytstats` prefers an author-written track, falls back to ASR, skips drafts entirely, and always reports which one it used — the choice is never silent.

Transcripts are cached under `<data dir>/transcripts/<videoId>.json` and keyed on the track's `lastUpdated`, so a second run for an unchanged track lists the tracks (cheap) and skips the download (not cheap). Editing the captions on YouTube invalidates the cache automatically.

A video with no usable caption track returns `cues: []` with a `DATA_EMPTY` warning and `ok: true` — captions being off is not a failure. `captions.download` needs edit permission on the video, so this only works for channels you own.

```bash
ytstats transcript dQw4w9WgXcQ 2>/dev/null | jq '.data.cues[0]'
ytstats transcript dQw4w9WgXcQ 2>/dev/null | jq -r '.data.cues[] | "\(.start)  \(.text)"'
```

## reach

```bash
ytstats reach
ytstats reach-jobs
```

`reach` is the only source of thumbnail impressions and CTR. It works unlike every other command because the data comes from the asynchronous Reporting API: the first run only *creates* the job, and reports appear 24-48 hours later with a 30-day backfill.

Returns `{ job, reportCount, pending, rows[] }`, plus `message` when pending. A pending result is a `REACH_PENDING` **warning**, not an error — the command succeeded, the data does not exist yet. Re-running is harmless and creates no duplicate job.

Rows carry `date`, `channelId`, `videoId`, `impressions`, and `impressionsCtr`. **`impressionsCtr` is a decimal fraction, not a percentage**: `0.0561` means 5.61%.

`reach-jobs` lists the Reporting API jobs on the channel.

## reports

```bash
ytstats reports
ytstats reports-enable --all
ytstats reports-enable --type channel_combined_a3 --type channel_end_screens_a2
```

The Reporting API generates a report only once a job exists for it. A report type with no job produces **nothing**, silently — and creating a job later backfills 30 days and no more. These two commands make that gap visible and closable.

`reports` returns the audit:

| Field | Meaning |
|---|---|
| `available` | Report types this channel may schedule, from a live `reportTypes.list` |
| `active` | Those with a job — currently collecting |
| `missing` | Those with no job — **collecting nothing right now** |
| `jobs` | The raw job list: `id`, `reportTypeId`, `name`, `createTime` |
| `coverage` | `active / available`, as a fraction |

A non-empty `missing` raises a `REPORTING_JOBS_MISSING` warning.

`reports-enable` creates the jobs and returns `{ created, skipped, failed, requested, note }`. It requires `--all` or at least one `--type`, validated before authentication. One report type this channel cannot schedule does not stop the others — it lands in `failed` with its reason while the rest are created.

Two things to know after running it:

- First reports arrive **24-48 hours** later, with a 30-day backfill. An immediate re-run showing nothing is expected.
- Reports **expire**: 60 days after generation, 30 days for backfill reports. Creating jobs starts collection; it does not preserve anything on its own. Pull on a cadence shorter than 60 days and keep the output.

```bash
ytstats reports 2>/dev/null | jq -r '.data.missing[].id'
ytstats reports-enable --all 2>/dev/null | jq '.data.created | length'
```

## sync and archive

```bash
ytstats sync
ytstats archive
```

**Creating jobs starts collection; `sync` is what preserves it.** Reports expire off Google's servers 60 days after generation (30 days for backfill reports), so the Reporting API is a delivery mechanism with expiring artifacts rather than an archive. `sync` downloads every report not yet stored into a local append-only archive.

Idempotent by report id — running it on a schedule is safe and cheap, and an already-archived report is skipped without a download. Run it **more often than every 60 days**; monthly is comfortable, weekly is safer.

`sync` returns `{ jobs, downloaded, skipped, rows, byType, failed, dataDir, note }`. A report that fails to download is **not** marked ingested, so the next run retries it rather than leaving a permanent hole. Progress is persisted even when a run aborts partway.

`archive` needs no authentication — it reads local files — and returns `{ dataDir, reportTypes[], totalRows, ingestedReports }`, with `rows`, `firstDate`, `lastDate` and `bytes` per report type.

Storage is NDJSON, one file per report type, under `<config dir>/data/reports/` or `YTSTATS_DATA_DIR`. Rows carry `_reportId`, `_jobId` and `_createTime` provenance. Reads dedupe last-wins by the row's dimension columns, resolving by `_createTime` rather than file order — overlapping reports carry corrected figures for days already reported, and file order is not guaranteed to match report order.

```bash
ytstats sync 2>/dev/null | jq '{downloaded: .data.downloaded, rows: .data.rows}'
ytstats archive 2>/dev/null | jq -r '.data.reportTypes[] | "\(.reportTypeId): \(.rows) rows \(.firstDate)..\(.lastDate)"'
```

**The archive is the only copy of anything older than 60 days.** Back it up.

## query

```bash
ytstats query -m <metrics> [--dimensions <list>] [--filters <expr>]
              [--sort <field>] [-n <max>] [date flags]
```

Escape hatch for an arbitrary YouTube Analytics API query.

| Flag | Required | Notes |
|---|---|---|
| `-m, --metrics <list>` | yes | Comma-separated, e.g. `views,likes` |
| `--dimensions <list>` | no | Comma-separated, e.g. `day` |
| `--filters <filters>` | no | e.g. `video==VIDEO_ID` |
| `--sort <field>` | no | Prefix with `-` for descending |
| `-n, --max <number>` | no | Maximum rows |

Returns `{ columns, rows }`, where `columns` is `[{ name, type }]` taken from the response's `columnHeaders`.

The Analytics API rejects many documented combinations, and which ones vary by channel — a rejection surfaces as `API_QUERY_NOT_SUPPORTED`. Notably `videoThumbnailImpressions` never works; use `reach` instead.

```bash
ytstats query -m views,likes --dimensions day --start 2026-01-01
```

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. Warnings do not change this. |
| `1` | General or unexpected failure |
| `2` | Authentication |
| `3` | Bad input |
| `4` | API error |

The code is also available as `meta.exitCode` in the envelope, so a consumer that can only read stdout still knows.

```bash
ytstats fetch --days 30 2>/dev/null | jq '.data.channel.subscriberCount'
ytstats fetch 2>/dev/null | jq -r 'if .ok then "fine" else .nextSteps[0] end'
```
