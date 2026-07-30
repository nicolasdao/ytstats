# Command Reference

Every `ytstats` command, its flags, and what it returns. Global flags may be given **before or after** the command name — both resolve identically from 0.5.0 onward.

## Global flags

| Flag | Default | Effect |
|---|---|---|
| `-a, --account <channel>` | the default account | Channel id, `@handle`, or channel title. Never falls back silently on a miss — an unrecognised value is `AUTH_ACCOUNT_UNKNOWN`. **Requires 0.5.0+**, see below |
| `--compact` | off | Single-line JSON |
| `-q, --quiet` | off | Suppress stderr progress. stdout is unaffected |
| `-V, --version` | — | Print version, exit 0 |

## Date window flags

Accepted by every analytics command. Not by `channel` or `videos`, which have no period.

| Flag | Default | Notes |
|---|---|---|
| `-d, --days <n>` | `90` | Days ending today UTC. Max 3650 |
| `--start <date>` | — | `YYYY-MM-DD`, overrides `--days` |
| `--end <date>` | today UTC | `YYYY-MM-DD` |

Dates must be exactly `YYYY-MM-DD` and must exist on the calendar — `2026-02-31` is rejected rather than rolled into March. Every input problem is reported together in one envelope, before authentication.

## Credentials and environment

`ytstats` ships no Google client id — each user brings their own OAuth client. It is resolved from five sources, first complete pair wins:

| Order | Source |
|---|---|
| 1 | `--client-secret <file>` on `login` or `import-legacy` |
| 2 | `YTSTATS_CLIENT_ID` **and** `YTSTATS_CLIENT_SECRET` (both required, or the pair is ignored) |
| 3 | `YTSTATS_CREDENTIALS_FILE` — a path to the JSON Google issued |
| 4 | `credentials.json` stored by a previous `login` |
| 5 | `client_secret*.json` auto-discovered in the working directory |

`ytstats status` reports which one won as `credentialSource` (a path, `environment`, or `stored`) and the resolved `clientId`.

**`--account` did nothing before 0.5.0.** The CLI dropped the selector before it reached the code that validates it, so every command answered with the **default** channel while reporting success — wrong numbers presented as correct, and `logout --account <other>` revoked the default channel's token. If a user reports figures that look like the wrong channel, check `ytstats --version` before anything else. On 0.5.0+ an unrecognised selector raises `AUTH_ACCOUNT_UNKNOWN` listing the valid channels, and both flag positions work.

| Variable | Effect |
|---|---|
| `YTSTATS_CREDENTIALS_FILE` | Point at a client secret file for this shell, without repeating `--client-secret`. Best when the file already exists on disk — no extracting two fields |
| `YTSTATS_CLIENT_ID` / `YTSTATS_CLIENT_SECRET` | The pair form. Both must be set; one alone falls through to the next source |
| `YTSTATS_CONFIG_DIR` | Move the whole config directory — credentials **and** tokens together |
| `XDG_CONFIG_HOME` | Linux config base. Ignored when relative, per the XDG spec |
| `HTTPS_PROXY` | Standard proxy variable, named in the `NETWORK_UNREACHABLE` remediation |

**To use a different OAuth client, prefer `YTSTATS_CONFIG_DIR` over `YTSTATS_CREDENTIALS_FILE` alone.** One config directory holds one client but many channels, so pointing only at a different credentials file pairs that client's id with the previous client's tokens — which is exactly the state `AUTH_CLIENT_MISMATCH` reports. Setting the config dir moves both halves together and makes the mismatch impossible.

## Account and diagnosis

| Command | Purpose |
|---|---|
| `status` | Who is signed in, where config lives, which client resolved. No auth needed |
| `doctor` | Nine independent readiness checks covering the whole setup. Always exits 0 — the verdict is `data.healthy` |
| `login [-c <path>] [--no-browser] [--timeout <s>]` | Loopback OAuth. `--no-browser` prints a URL and reads the pasted redirect |
| `logout [--all] [--forget-credentials]` | Revoke with Google, delete locally. **Confirm before running** |
| `use <channelId or @handle>` | Set the default channel. Fails if not signed in |
| `import-legacy <tokensFile> [-c <path>]` | One-time import of a pre-ytstats token file |

`status` returns `{ authenticated, configDir, credentialSource, clientId, project, accounts[], setupGuide? }`. `project` is `{ id, number, consoleUrl }` — which Google Cloud project the credentials belong to, with a console URL already pinned via `?project=`. Prefer it over composing console links yourself. Each account carries `channelId`, `channelTitle`, `customUrl`, `clientId`, `authorizedAt`, `savedAt`, `isDefault` — never token material. `authorizedAt` is when that account's refresh token was issued; `savedAt` is merely the last write and moves on every token refresh.

`doctor` checks, in dependency order: `config_writable`, `credentials`, `signed_in`, then one probe per API — `api_reachable` (Data v3), `api_analytics` (Analytics v2), `api_reporting` (Reporting v1) — then `reporting_jobs`, `reports_archived`, and finally `consent_screen`. The API probes are skipped when earlier checks failed.

`reporting_jobs` (0.6.0+) is unlike the rest: every other check reports something **blocked**, this one reports something **already lost**. It fails when report types have no reporting job, which means YouTube is generating no data for them and only the last 30 days is ever recoverable. Never let it pass unmentioned because the rest of the run succeeded.

Each check carries `status` (`pass` / `fail` / `unknown`) alongside boolean `ok`. The three APIs are enabled independently in Google Cloud, so a pass on one says nothing about the others.

`consent_screen` is normally `unknown` — no API exposes it, and an `unknown` never counts against `healthy`. Raise it with the user anyway; see the setup flow in `SKILL.md`.

## The everything command

```bash
ytstats fetch [--days 90] [--start <date>] [--end <date>]
              [--no-retention] [--retention-limit <n>] [--reach]
```

| Flag | Default | Effect |
|---|---|---|
| `--no-retention` | retention on | Skip retention curves, one API call per video |
| `--retention-limit <n>` | `50` | How many recent videos to pull retention for |
| `--reach` | off | Also fetch thumbnail impressions and CTR |

The envelope's `.data` is `{period, warnings, notes, data}` — the datasets sit one level deeper, at `.data.data`, and each is a **bare array** with no `.rows` wrapper. `.data.data` carries `channel`, `videos`, `daily`, `videoAnalytics`, `trafficSources`, `trafficSourceDetails`, `demographics`, `deviceTypes`, `contentTypes`, `searchTerms`, `geography`, `playbackLocations`, `audienceRetention`, and `reach` when requested.

`.data.warnings` holds per-step failures as `{step, code, message}`, `.data.notes` holds informational messages, `.data.period` the resolved window. Warnings are also copied to the envelope's top-level `.warnings`.

Individual steps degrade rather than abort — a rejected demographics query costs you demographics, not the other twelve datasets.

## Dataset commands

The date-windowed ones return `{ period, rows }` at `.data`. Two are exceptions: `channel` puts the channel object directly at `.data`, and `videos` puts a bare array there. Zero rows raises a `DATA_EMPTY` **warning**, so "worked and found nothing" is distinguishable from "failed".

| Command | Returns | Extra flags |
|---|---|---|
| `channel` | Channel metadata and lifetime stats. No period | — |
| `videos` | Every video with metadata and current counts. No period | see below |
| `daily` | Day-by-day views, watch time, likes, comments, subscribers | — |
| `traffic` | Views by traffic source type | — |
| `demographics` | Viewer age and gender split | — |
| `devices` | Views by device type | — |
| `content-types` | Shorts vs long-form vs live, using YouTube's own classification | — |
| `search-terms` | What people search to find the channel | `-n, --limit` (default 25, capped at 25) |
| `geography` | Viewers by country | `-n, --limit` (default 50) |
| `playback-locations` | Shorts feed, watch page, embedded | — |
| `video-analytics` | Per-video metrics, top 200 by views | — |

`channel` returns the channel resource directly, not `{period, rows}`: `id`, `title`, `description`, `customUrl`, `publishedAt`, `country`, `subscriberCount`, `viewCount`, `videoCount`, `uploadsPlaylistId`, `thumbnailUrl`.

### videos

```bash
ytstats videos [-n <n>] [-s <field>] [--order asc|desc] [-t <type>]
```

`-s` accepts `publishedAt` (default), `viewCount`, `likeCount`, `commentCount`, `durationSeconds`. `-t` accepts `SHORTS`, `VIDEO_ON_DEMAND`, `LIVE_STREAM`. Filtering and sorting happen locally after every video is fetched, so `-n` reduces output size but not API cost.

### retention

```bash
ytstats retention <videoId> [date flags]
```

Returns `{ videoId, period, curve }` with roughly 100 points:

| Field | Meaning |
|---|---|
| `position` | Elapsed fraction of the video, `0`–`1` |
| `ratio` | `audienceWatchRatio` — how many viewers remain here. Above `1.0` means looping, never clamp |
| `stoppedWatching` | How often viewers **left** during this segment — the literal drop-off |
| `startedWatching` | How often viewers **joined** here, i.e. skipped ahead to it |
| `totalSegmentImpressions` | The denominator, for turning ratios back into counts |
| `relativeRetentionPerformance` | This curve versus similar YouTube videos, not versus itself |

**Use the last four to say *why*, not just *where*.** A trough with high `stoppedWatching` is content losing people — cut or tighten it. The same trough with high `startedWatching` just before it is viewers skipping an intro — move the payload earlier. `ratio` alone cannot tell those apart, and they call for opposite edits.

Any of the four may be `null`, meaning **this channel cannot serve that metric** — never that the value is zero. `relativeRetentionPerformance` needs a peer set and is the one most often missing. When something was dropped the command emits an `ANALYTICS_METRICS_UNSUPPORTED` warning naming exactly which. Requires ytstats 0.6.0+; earlier versions return only `position` and `ratio`.

### reach and reach-jobs

```bash
ytstats reach
ytstats reach-jobs
```

The only source of thumbnail impressions and CTR. Returns `{ job, reportCount, pending, rows[] }`, plus `message` when pending. Rows carry `date`, `channelId`, `videoId`, `impressions`, `impressionsCtr`. Re-running is harmless and creates no duplicate job.

### reports and reports-enable

```bash
ytstats reports
ytstats reports-enable --all
ytstats reports-enable --type channel_combined_a3 --type channel_end_screens_a2
```

**The Reporting API generates a report only once a job exists for it.** A report type with no job produces nothing at all, and creating a job later backfills only 30 days — so uncovered types are losing history permanently while every command still reports success.

`reports` returns `{ available, active, missing, jobs, coverage }`:

| Field | Meaning |
|---|---|
| `available` | Report types this channel may schedule, discovered live |
| `active` | Those with a job — collecting now |
| `missing` | Those with no job — **collecting nothing** |
| `coverage` | `active / available` as a fraction |

A non-empty `missing` raises `REPORTING_JOBS_MISSING`.

`reports-enable` returns `{ created, skipped, failed, requested, note }` and needs `--all` or at least one `--type` — omitting both is `INPUT_MISSING_REQUIRED`, raised before authentication. A type this channel cannot schedule lands in `failed` without stopping the others.

After enabling: first reports arrive in **24–48 hours** with a 30-day backfill, so an immediate re-run returning nothing is expected. Reports then **expire 60 days after generation** (30 for backfill), so tell the user to pull on a schedule and keep the files — creating jobs starts collection but preserves nothing.

Requires ytstats 0.6.0+.

### sync and archive

```bash
ytstats sync
ytstats archive
```

**Jobs make YouTube generate reports; `sync` is what stops them disappearing.** Reports expire 60 days after generation (30 for backfill), so job coverage plus an infrequent pull still loses history silently.

`sync` downloads everything not yet archived into a local append-only store. Idempotent by report id — safe to run on a schedule, and an already-archived report costs no download. Returns `{ jobs, downloaded, skipped, rows, byType, failed, dataDir, note }`. A failed download is **not** marked ingested, so the next run retries it.

`archive` needs no auth and returns `{ dataDir, reportTypes[], totalRows, ingestedReports }` with `rows`, `firstDate`, `lastDate`, `bytes` per type.

**Use `archive.reportTypes[].firstDate` to answer "how far back does my data go".** It is usually more recent than the user expects, because anything older than the expiry window was deleted by Google before it was ever downloaded. Do not answer that question from the channel's creation date.

Storage is NDJSON under `<config dir>/data/reports/` or `YTSTATS_DATA_DIR`. Tell users to back that directory up — it is the only copy of anything older than 60 days.

Requires ytstats 0.6.0+.

### query

```bash
ytstats query -m <metrics> [--dimensions <list>] [--filters <expr>]
              [--sort <field>] [-n <max>] [date flags]
```

Escape hatch for an arbitrary YouTube Analytics API query. `-m` is required. `--sort` takes a `-` prefix for descending. Returns `{ columns, rows }` where `columns` is `[{name, type}]`.

The Analytics API rejects many documented combinations and which ones varies by channel — a rejection is `API_QUERY_NOT_SUPPORTED`, not a bug in the request.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Success. Warnings never change this |
| `1` | General or unexpected |
| `2` | Authentication |
| `3` | Bad input |
| `4` | API error |

Also at `meta.exitCode`, so a consumer reading only stdout still knows.

## Quota

The Data API allows 10,000 units/day per Google Cloud project. A full `fetch` for a 100-video channel costs roughly 5 units, because the uploads playlist (1 unit per 50 videos) is used instead of `search.list` (100 units per call). Retention costs one call per video. The Analytics and Reporting APIs have separate quotas.
