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

Everything below can also be driven in plain English by the `nicolasdao/ytstats` agent skill, which covers all 22 commands and auto-invokes — see [Drive it from an AI agent](../README.md#drive-it-from-an-ai-agent).

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
ytstats login [-c|--client-secret <path>] [--no-browser] [--timeout <seconds>]
```

Runs the loopback OAuth flow: opens the browser, captures the callback on `127.0.0.1`, exchanges the code, fetches the channel identity, and stores both the OAuth client and the tokens.

| Flag | Default | Effect |
|---|---|---|
| `-c, --client-secret <path>` | resolution order below | Path to the `client_secret` JSON downloaded from Google Cloud |
| `--no-browser` | off | Print the URL and read the pasted redirect back — for SSH and headless machines |
| `--timeout <seconds>` | `300` | How long to wait for the browser callback, so an automated caller is never blocked indefinitely |

Credentials are resolved in this order: `--client-secret` → `YTSTATS_CLIENT_ID`/`YTSTATS_CLIENT_SECRET` → `YTSTATS_CREDENTIALS_FILE` → stored `credentials.json` → `client_secret*.json` in the working directory. See [configuration.md](configuration.md).

Returns `{ channelId, channelTitle, customUrl, configDir }`.

```bash
ytstats login --client-secret ~/Downloads/client_secret_1234.json
ytstats login --no-browser          # headless
```

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

Returns `{ authenticated, configDir, credentialSource, clientId, accounts[], setupGuide? }`. Each account carries `channelId`, `channelTitle`, `customUrl`, `clientId`, `savedAt`, and `isDefault` — never token material. `setupGuide` appears only when no account is signed in.

`credentialSource` says *where* the OAuth client came from (a path, `environment`, or `stored`); `clientId` says *which* client that turned out to be. Both are `null` when no credentials resolve. Client IDs are public by OAuth design — only the secret is sensitive — so neither field is redacted.

Comparing the top-level `clientId` against an account's `clientId` tells you whether that channel's stored token was issued by the client currently resolving. A disagreement is what [`AUTH_CLIENT_MISMATCH`](output-contract.md#diagnostic-catalog) reports on the next authenticated command.

```bash
ytstats status 2>/dev/null | jq '{clientId, credentialSource}'
ytstats status 2>/dev/null | jq -r '.data.accounts[] | select(.isDefault) | .channelTitle'
```

### doctor

```bash
ytstats doctor
```

Runs four independent readiness checks, cheapest first, and reports all of them rather than stopping at the first failure:

| Check id | What it proves |
|---|---|
| `config_writable` | The config directory exists and accepts a write (probe file is written then removed) |
| `credentials` | An OAuth client resolved from some source |
| `signed_in` | At least one channel has stored tokens |
| `api_reachable` | A live `channels.list` call succeeds with the stored token |

`api_reachable` is skipped when earlier checks failed, since it cannot succeed.

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

Imports tokens from a pre-`ytstats` project-local `tokens.json`. The legacy file holds no channel identity, so the tokens are exchanged for one before anything is stored. Never overwrites an account that already exists — it returns `{ migrated: false, reason }` instead, where `reason` is one of `no-legacy-file`, `no-refresh-token`, `unknown-channel`, or `already-logged-in`.

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

Audience retention curve for one video — roughly 100 points at 1% intervals. Returns `{ videoId, period, curve }`, where each point is `{ position, ratio }`.

Ratios above `1.0` are correct and never clamped: a Short showing `1.54` means viewers looped it.

## reach

```bash
ytstats reach
ytstats reach-jobs
```

`reach` is the only source of thumbnail impressions and CTR. It works unlike every other command because the data comes from the asynchronous Reporting API: the first run only *creates* the job, and reports appear 24-48 hours later with a 30-day backfill.

Returns `{ job, reportCount, pending, rows[] }`, plus `message` when pending. A pending result is a `REACH_PENDING` **warning**, not an error — the command succeeded, the data does not exist yet. Re-running is harmless and creates no duplicate job.

Rows carry `date`, `channelId`, `videoId`, `impressions`, and `impressionsCtr`. **`impressionsCtr` is a decimal fraction, not a percentage**: `0.0561` means 5.61%.

`reach-jobs` lists the Reporting API jobs on the channel.

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
