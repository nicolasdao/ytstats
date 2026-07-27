# ytstats

Pull your YouTube channel's stats and analytics as JSON, from the command line.

```bash
npx ytstats login
npx ytstats fetch --days 90 > snapshot.json
```

No install. No server. No shared API key. Your data and your credentials never leave your machine.

## Why bring your own credentials

`ytstats` has **no built-in Google client ID**, by design. You create a Google Cloud project, generate an OAuth client, and the CLI uses yours. This means:

- **Your quota is yours.** The YouTube Data API gives every project 10,000 units/day. A shared client ID would make everyone compete for one pool.
- **No verification bottleneck.** Apps using YouTube scopes need Google's OAuth verification to serve strangers. You're not a stranger to yourself.
- **Nothing to trust.** There is no backend to send your data to, because there is no backend.

The cost is about five minutes of setup, once.

## Setup

### 1. Create a Google Cloud project

<https://console.cloud.google.com/projectcreate>

### 2. Enable the three APIs

| API | Link |
|---|---|
| YouTube Data API v3 | [enable](https://console.cloud.google.com/apis/library/youtube.googleapis.com) |
| YouTube Analytics API | [enable](https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com) |
| YouTube Reporting API | [enable](https://console.cloud.google.com/apis/library/youtubereporting.googleapis.com) |

### 3. Configure the OAuth consent screen

<https://console.cloud.google.com/apis/credentials/consent> — choose **External**, fill in the app name and your email, and add your own Google account as a **test user**.

> **Publish it to Production when you're done.** While the consent screen is in *Testing*, Google expires refresh tokens after **7 days** and you'll be logging in every week. Publishing (you'll click past an "unverified app" warning once) stops that.

### 4. Create the OAuth client

<https://console.cloud.google.com/apis/credentials> → **Create credentials → OAuth client ID → Application type: Desktop app**. Download the JSON.

> A **service account will not work** — not with any amount of configuration. Service accounts have no YouTube channel, so Google rejects them with `NoLinkedYouTubeAccount`. This is [documented](https://developers.google.com/youtube/v3/guides/authentication) and there is no workaround. You need an OAuth client ID.

### 5. Log in

```bash
npx ytstats login --client-secret ~/Downloads/client_secret_1234.json
```

Your browser opens, you approve, and you're done. Every later command needs no flags:

```bash
npx ytstats channel
```

## Where credentials are stored

Both the OAuth client and your tokens are written to a per-user directory, `0600`, readable only by you:

| OS | Location |
|---|---|
| macOS | `~/Library/Application Support/ytstats/` |
| Linux | `$XDG_CONFIG_HOME/ytstats/` (default `~/.config/ytstats/`) |
| Windows | `%APPDATA%\ytstats\` |

Override with `YTSTATS_CONFIG_DIR`. For CI, set `YTSTATS_CLIENT_ID` and `YTSTATS_CLIENT_SECRET` instead of a file.

These are plaintext files, like `gcloud`, `gh`, and `aws` use. `ytstats logout` revokes the token with Google and deletes them.

## Commands

### Authentication

```bash
ytstats login [--client-secret <path>] [--no-browser]
ytstats logout [--all] [--forget-credentials]
ytstats status                    # who's logged in, where config lives
ytstats doctor                    # check every prerequisite, report what's missing
ytstats use <channelId|@handle>   # switch default channel
ytstats import-legacy <file>      # import tokens from a pre-ytstats install
```

`login` accepts `--timeout <seconds>` (default 300) so an automated caller is never blocked indefinitely waiting on a browser.

`--no-browser` prints a URL and reads the pasted redirect back — for SSH and headless machines.

### The one you'll actually use

```bash
ytstats fetch [--days 90] [--no-retention] [--retention-limit 50] [--reach]
```

Every dimension in a single JSON document: channel, videos, daily metrics, per-video analytics, traffic sources and their details, demographics, devices, content types, search terms, geography, playback locations, and retention curves.

Individual analytics steps degrade rather than abort — YouTube rejects some metric combinations for some channels, and losing demographics shouldn't cost you the other twelve datasets. Anything that failed appears in `warnings`.

### Individual datasets

```bash
ytstats channel                       # metadata and lifetime stats
ytstats videos [-n 10] [-t SHORTS] [-s viewCount] [--order asc]
ytstats daily [-d 30]                 # day-by-day metrics
ytstats traffic                       # where views come from
ytstats demographics                  # age and gender
ytstats devices
ytstats content-types                 # Shorts vs long-form vs live
ytstats search-terms                  # what people search to find you
ytstats geography [-n 50]
ytstats playback-locations            # Shorts feed vs watch page vs embedded
ytstats video-analytics               # per-video, top 200 by views
ytstats retention <videoId>           # where viewers drop off
ytstats reach                         # thumbnail impressions and CTR
ytstats reach-jobs
ytstats query -m views,likes --dimensions day   # arbitrary Analytics API query
```

All accept `--days N`, or `--start YYYY-MM-DD --end YYYY-MM-DD`.

### Global flags

| Flag | Effect |
|---|---|
| `-a, --account <channel>` | pick a channel when several are logged in |
| `--compact` | single-line JSON |
| `-q, --quiet` | silence stderr progress |

## Output contract

Designed for agents, not just humans. **stdout is exactly one JSON document, always** — success, failure, bad flag, unknown command, crash. There is no code path that writes nothing. Progress goes to stderr and is safe to discard.

The envelope is **shape-invariant**: every key is present on every response, so a consumer never branches on whether a field exists.

```jsonc
{
  "ok": true,
  "command": "channel",
  "fetchedAt": "2026-07-27T10:00:00.000Z",
  "data": { … },          // null whenever ok is false — never partial
  "errors": [],           // non-empty iff ok is false
  "warnings": [],         // non-fatal; never affects ok or the exit code
  "nextSteps": [],        // ordered, deduplicated, ready-to-run commands
  "meta": { "version": "0.1.0", "exitCode": 0, "helpCommand": "ytstats --help" }
}
```

### Diagnostics

Each entry in `errors` / `warnings` answers four questions:

```jsonc
{
  "code": "AUTH_TOKEN_EXPIRED",        // stable API — branch on this, never on prose
  "severity": "error",
  "title": "Stored refresh token is no longer valid",
  "detail": "Google rejected the stored refresh token (invalid_grant)…",
  "cause": "Most commonly the OAuth consent screen is still in Testing mode…",
  "recoverable": true,                 // can this be fixed and retried at all?
  "retryable": false,                  // would re-running the SAME command help?
  "remediation": {
    "summary": "Sign in again, then publish your consent screen to Production.",
    "steps": ["Run: ytstats login", "…"],
    "commands": [{ "run": "ytstats login", "description": "Re-authorize this machine" }],
    "docs": ["https://console.cloud.google.com/apis/credentials/consent"]
  },
  "context": { "flag": "--start", "value": "01/01/2026", "expected": "YYYY-MM-DD" }
}
```

`recoverable` and `retryable` exist to stop an agent looping pointlessly. `AUTH_SERVICE_ACCOUNT` is `recoverable: false` — no amount of retrying will ever make a service account work.

### Failures are differentiated

There is no single "not authenticated" bucket. Every distinct cause has its own code and its own fix:

| Situation | Code |
|---|---|
| No Google Cloud OAuth client anywhere | `AUTH_NO_CREDENTIALS` |
| Client exists, never logged in | `AUTH_NO_TOKENS` |
| Refresh token rejected (usually the 7-day Testing trap) | `AUTH_TOKEN_EXPIRED` |
| Access revoked | `AUTH_TOKEN_REVOKED` |
| `--account` names an unknown channel | `AUTH_ACCOUNT_UNKNOWN` |
| Consent screen dismissed | `AUTH_CONSENT_DECLINED` |
| Service account key supplied | `AUTH_SERVICE_ACCOUNT` |
| Client ID malformed | `AUTH_CLIENT_ID_INVALID` |
| Google account owns no channel | `AUTH_NO_CHANNEL` |

Plus `API_NOT_ENABLED`, `API_QUOTA_EXCEEDED`, `API_RATE_LIMITED`, `API_QUERY_NOT_SUPPORTED`, `API_FORBIDDEN`, `API_NOT_FOUND`, `API_UNAVAILABLE`, `NETWORK_UNREACHABLE`, `INPUT_UNKNOWN_COMMAND`, `INPUT_UNKNOWN_OPTION`, `INPUT_MISSING_REQUIRED`, `INPUT_INVALID_CHOICE`, `INPUT_INVALID_DATE`, `INPUT_INVALID_RANGE`, `INPUT_INVALID_VALUE`, `DATA_PARTIAL`, `DATA_EMPTY`, `REACH_PENDING`, `CONFIG_UNWRITABLE`, `UNEXPECTED`.

### Input is validated before authentication

All input problems are reported **together**, before any network call — so one loop iteration fixes everything rather than discovering a bad date only after fixing auth:

```bash
$ ytstats daily --start 01/01/2026 --end yesterday --days -3
# → 3 errors in one envelope: two INPUT_INVALID_DATE, one INPUT_INVALID_RANGE
```

### Self-diagnosis

When something is wrong and you don't know what, ask:

```bash
ytstats doctor
```

It checks config writability, credentials, sign-in state and live API reachability independently, and returns a pass/fail list plus the exact blocking diagnostics. `doctor` itself always succeeds (`ok: true`); the verdict is in `data.healthy`.

### Exit codes

`0` success · `2` authentication · `3` bad input · `4` API error · `1` anything else. Also available as `meta.exitCode`, so a consumer that can only see stdout still knows.

```bash
ytstats fetch --days 30 2>/dev/null | jq '.data.channel.subscriberCount'
ytstats fetch 2>/dev/null | jq -r 'if .ok then "fine" else .nextSteps[0] end'
```

## Use as a library

```js
import { getAuthenticatedClient, createApis, fetchAll, resolveDateRange } from 'ytstats';

const { client } = getAuthenticatedClient();
const result = await fetchAll(createApis(client), { range: resolveDateRange({ days: 90 }) });
```

## Things worth knowing

**CTR only comes from `ytstats reach`.** The Analytics API documents `videoThumbnailImpressions` but it has never worked ([issue 254665034](https://issuetracker.google.com/issues/254665034)). CTR is served asynchronously by the Reporting API instead: the first `reach` run only creates a job, and data appears **24-48 hours later** with a 30-day backfill. It's also permanently 1-2 days behind — the same lag YouTube Studio shows.

**Retention ratios above 1.0 are correct.** A Short showing `1.54` means viewers looped it. Not a bug, and never clamped.

**Shorts detection is duration-based.** ≤60s is `SHORTS`. A 62-second video meant as a Short will read `VIDEO_ON_DEMAND`. YouTube's own classification uses extra signals — read `content-types` for its opinion.

**Per-video analytics caps at 200 videos**, sorted by views. An API limit, not ours.

**Subscriber counts are rounded** to 3 significant figures above 1,000. Small week-over-week changes are invisible.

**`fetch --reach` and retention cost extra calls.** Retention is one API call per video, hence `--retention-limit` (default 50, newest first).

## Quota

The Data API allows 10,000 units/day per project. `ytstats` uses the uploads playlist (1 unit per 50 videos) rather than `search.list` (100 units per call), so a full fetch for a 100-video channel costs about 5 units. The Analytics and Reporting APIs have separate quotas.

## Documentation

- [docs/api-gotchas.md](docs/api-gotchas.md) — non-obvious YouTube API behaviour, what breaks and where it is handled
- [docs/architecture.md](docs/architecture.md) — module layout, design principles, testing strategy, how to add a dataset
- [CHANGELOG.md](CHANGELOG.md)

## Requirements

Node.js 18+. No native dependencies, so `npx` is instant.

## License

MIT
