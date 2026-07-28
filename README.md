# ytstats

Pull your YouTube channel's stats and analytics as JSON, from the command line.

```bash
npx ytstats login
npx ytstats fetch --days 90 > snapshot.json
```

No install. No server. No shared API key. Your data and your credentials never leave your machine.

## Table of Contents

<!-- BEGIN toc -->
- [Overview](#overview)
  - [Why bring your own credentials](#why-bring-your-own-credentials)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [1. Create a Google Cloud project](#1-create-a-google-cloud-project)
  - [2. Enable the three APIs](#2-enable-the-three-apis)
  - [3. Configure the OAuth consent screen](#3-configure-the-oauth-consent-screen)
  - [4. Create the OAuth client](#4-create-the-oauth-client)
  - [5. Log in](#5-log-in)
  - [Where credentials are stored](#where-credentials-are-stored)
- [Commands](#commands)
  - [Self-diagnosis](#self-diagnosis)
- [Output](#output)
- [Use as a library](#use-as-a-library)
- [Drive it from an AI agent](#drive-it-from-an-ai-agent)
- [Things worth knowing](#things-worth-knowing)
- [Quota](#quota)
- [Project Structure](#project-structure)
- [Documentation](#documentation)
- [Requirements](#requirements)
- [License](#license)
<!-- END toc -->

## Overview

`ytstats` reads a channel you own — metadata, videos, daily metrics, traffic sources, demographics, devices, content types, search terms, geography, playback locations, retention curves, and thumbnail CTR — and prints it as one JSON document.

It is built for programs first. **stdout is exactly one JSON document, always** — success, failure, bad flag, unknown command, crash. Progress goes to stderr and is safe to discard. Every failure carries a stable code, a cause, `recoverable`/`retryable` flags, and runnable next steps, so an agent in a retry loop knows whether to retry, fix something, or stop.

### Why bring your own credentials

`ytstats` has **no built-in Google client ID**, by design. You create a Google Cloud project, generate an OAuth client, and the CLI uses yours. This means:

- **Your quota is yours.** The YouTube Data API gives every project 10,000 units/day. A shared client ID would make everyone compete for one pool.
- **No verification bottleneck.** Apps using YouTube scopes need Google's OAuth verification to serve strangers. You're not a stranger to yourself.
- **Nothing to trust.** There is no backend to send your data to, because there is no backend.

The cost is about five minutes of setup, once.

## Getting Started

### Prerequisites

Node.js 18+. No native dependencies, so `npx` is instant.

### 1. Create a Google Cloud project

<https://console.cloud.google.com/projectcreate>

### 2. Enable the three APIs

| API | Link |
|---|---|
| YouTube Data API v3 | [enable](https://console.cloud.google.com/apis/library/youtube.googleapis.com) |
| YouTube Analytics API | [enable](https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com) |
| YouTube Reporting API | [enable](https://console.cloud.google.com/apis/library/youtubereporting.googleapis.com) |

All three must be enabled in the **same project** that issues your OAuth client.

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

`--no-browser` prints a URL and reads the pasted redirect back, for SSH and headless machines.

### Where credentials are stored

Both the OAuth client and your tokens are written to a per-user directory, `0600`, readable only by you:

| OS | Location |
|---|---|
| macOS | `~/Library/Application Support/ytstats/` |
| Linux | `$XDG_CONFIG_HOME/ytstats/` (default `~/.config/ytstats/`) |
| Windows | `%APPDATA%\ytstats\` |

Override with `YTSTATS_CONFIG_DIR`. For CI, point `YTSTATS_CREDENTIALS_FILE` at the JSON Google issued, or set `YTSTATS_CLIENT_ID` and `YTSTATS_CLIENT_SECRET` where the secret arrives as two variables. These are plaintext files, like `gcloud`, `gh`, and `aws` use. `ytstats logout` revokes the token with Google and deletes them.

One config directory holds one OAuth client and any number of channels. To manage channels that live under *different* Google Cloud projects, give each its own directory — `YTSTATS_CONFIG_DIR` moves credentials and tokens together:

```bash
alias yt-acme='YTSTATS_CONFIG_DIR=~/.ytstats/acme ytstats'
```

## Commands

The one you'll actually use:

```bash
ytstats fetch [--days 90] [--no-retention] [--retention-limit 50] [--reach]
```

Every dimension in a single JSON document. Individual analytics steps degrade rather than abort — YouTube rejects some metric combinations for some channels, and losing demographics shouldn't cost you the other twelve datasets. Anything that failed appears in `warnings`.

Individual datasets and account management:

```bash
ytstats channel                       # metadata and lifetime stats
ytstats videos [-n 10] [-t SHORTS] [-s viewCount]
ytstats daily [-d 30]                 # day-by-day metrics
ytstats traffic                       # where views come from
ytstats demographics                  # age and gender
ytstats devices
ytstats content-types                 # Shorts vs long-form vs live
ytstats search-terms                  # what people search to find you
ytstats geography [-n 50]
ytstats playback-locations
ytstats video-analytics               # per-video, top 200 by views
ytstats retention <videoId>           # where viewers drop off
ytstats reach                         # thumbnail impressions and CTR
ytstats query -m views,likes --dimensions day

ytstats login | logout | status | doctor | use <channel> | import-legacy <file>
```

All analytics commands accept `--days N`, or `--start YYYY-MM-DD --end YYYY-MM-DD`. Global flags: `-a, --account <channel>`, `--compact`, `-q, --quiet`.

Full reference with every flag and default: [docs/cli.md](docs/cli.md).

### Self-diagnosis

When something is wrong and you don't know what:

```bash
ytstats doctor
```

It checks config writability, credentials, sign-in state, and live API reachability independently, and returns a pass/fail list plus the exact blocking diagnostics. `doctor` itself always succeeds (`ok: true`); the verdict is in `data.healthy`.

## Output

Every response is the same shape — every key present, every time, so a consumer never branches on whether a field exists:

```jsonc
{
  "ok": true,
  "command": "channel",
  "fetchedAt": "2026-07-27T10:00:00.000Z",
  "data": { },            // null whenever ok is false — never partial
  "errors": [],           // non-empty iff ok is false
  "warnings": [],         // non-fatal; never affects ok or the exit code
  "nextSteps": [],        // ordered, deduplicated, ready-to-run commands
  "meta": { "version": "0.1.0", "exitCode": 0, "helpCommand": "ytstats --help" }
}
```

Exit codes: `0` success · `2` authentication · `3` bad input · `4` API error · `1` anything else. Also available as `meta.exitCode`, so a consumer that can only see stdout still knows.

```bash
ytstats fetch --days 30 2>/dev/null | jq '.data.channel.subscriberCount'
ytstats fetch 2>/dev/null | jq -r 'if .ok then "fine" else .nextSteps[0] end'
```

Input is validated **before** authentication, and every input problem is reported together — so one loop iteration fixes everything rather than discovering a bad date only after fixing auth.

The envelope, the diagnostic schema, and the full failure-code catalog are in [docs/output-contract.md](docs/output-contract.md).

## Use as a library

```js
import { getAuthenticatedClient, createApis, fetchAll, resolveDateRange } from 'ytstats';

const { client } = getAuthenticatedClient();
const result = await fetchAll(createApis(client), { range: resolveDateRange({ days: 90 }) });
```

Library callers get no envelope: `fetchAll` returns its result object directly and fetchers throw `YtStatsError`. The full export surface is listed in [docs/architecture.md](docs/architecture.md#programmatic-api).

## Drive it from an AI agent

There is a published agent skill that operates **the entire CLI** — all 22 commands — from plain English, so neither you nor an agentic client has to compose flags by hand:

```
nicolasdao/ytstats@0.1.0        install with HappySkills
```

Ask for what you want and it picks the command, runs it, and answers the question:

| You say | It runs |
|---|---|
| "pull all my channel stats" | `fetch --days 90` into a file, then summarizes |
| "how's my CTR" | `reach` — and explains the 24-48h Reporting API lag if the job is new |
| "where do viewers drop off on my last video" | `videos` to resolve the id, then `retention <videoId>` |
| "log in" / "switch channel" | `login` / `use <channel>` |
| "why doesn't this work" | `doctor` |

It auto-invokes, so there is no slash command to remember. It also carries the parts of this README that are easy to get wrong when reading results — that `impressionsCtr` is a fraction rather than a percentage, that retention ratios above 1.0 mean rewatching, and that an empty dataset listed in `data.warnings` means the step degraded rather than the channel having no activity.

Two behaviours are deliberate: it confirms before `logout`, because that revokes the refresh token with Google, and it redirects a large `fetch` to a file rather than printing megabytes of JSON.

Requires `ytstats` **0.2.0 or newer** — it reads the `clientId` field on `status` and the `AUTH_CLIENT_MISMATCH` diagnostic, both added in 0.2.0.

The skill's source lives in this repo at `.agents/skills/ytstats/`, and its own `SKILL.md` and `references/` are its full documentation.

## Things worth knowing

**CTR only comes from `ytstats reach`.** The Analytics API documents `videoThumbnailImpressions` but it has never worked ([issue 254665034](https://issuetracker.google.com/issues/254665034)). CTR is served asynchronously by the Reporting API instead: the first `reach` run only creates a job, and data appears **24-48 hours later** with a 30-day backfill. It's also permanently 1-2 days behind — the same lag YouTube Studio shows.

**Retention ratios above 1.0 are correct.** A Short showing `1.54` means viewers looped it. Not a bug, and never clamped.

**Shorts detection is duration-based.** ≤60s is `SHORTS`. A 62-second video meant as a Short will read `VIDEO_ON_DEMAND`. YouTube's own classification uses extra signals — read `content-types` for its opinion.

**Per-video analytics caps at 200 videos**, sorted by views. An API limit, not ours.

**Subscriber counts are rounded** to 3 significant figures above 1,000. Small week-over-week changes are invisible.

**`fetch --reach` and retention cost extra calls.** Retention is one API call per video, hence `--retention-limit` (default 50, newest first).

The rest, with the handling sites named, is in [docs/gotchas.md](docs/gotchas.md).

## Quota

The Data API allows 10,000 units/day per project. `ytstats` uses the uploads playlist (1 unit per 50 videos) rather than `search.list` (100 units per call), so a full fetch for a 100-video channel costs about 5 units. The Analytics and Reporting APIs have separate quotas.

## Project Structure

```
bin/ytstats.js       thin shim; guards stdout against stack traces
src/
  cli.js             command definitions, validation ordering, error capture
  index.js           the library entry point
  auth/              credentials, OAuth loopback flow, token store, session
  api/               Data v3, Analytics v2, Reporting v1, pure transforms
  config/            per-user config dir, atomic 0600 store
  fetch-all.js       one-document orchestrator with per-step degradation
  output.js          the envelope; stdout/stderr discipline
  diagnostics.js     the failure catalog
  errors.js          YtStatsError, Google error classification, redaction
  dates.js           reporting window resolution and validation
test/                332 tests, none requiring network access
docs/                topic documentation, indexed below
.agents/skills/      agent skills — ytstats drives the CLI, release-cli cuts releases
```

## Documentation

<!-- BEGIN doc-index -->
- [Architecture](docs/architecture.md) — How ytstats is put together — module layout, design principles, request flow, and the programmatic API surface.
- [Authentication](docs/auth.md) — The bring-your-own-credentials OAuth model — credential resolution, the PKCE loopback flow, token storage, and multi-account handling.
- [CLI Reference](docs/cli.md) — Complete ytstats command reference — every command, flag, default, and exit code.
- [Configuration](docs/configuration.md) — Environment variables, the per-user config directory, stored file formats, and CI setup.
- [Contributing](docs/contributing.md) — How to extend ytstats — adding datasets, commands, and diagnostics; the dependency policy; and the release process.
- [Gotchas](docs/gotchas.md)
- [Output Contract](docs/output-contract.md) — The JSON envelope, the diagnostic schema, the full failure-code catalog, and exit-code derivation.
- [Testing](docs/testing.md) — How ytstats is tested — injection seams, temp config dirs, real-HTTP loopback tests, subprocess end-to-end runs, and what coverage numbers actually mean.
- [YouTube APIs](docs/youtube-apis.md) — How ytstats calls the YouTube Data, Analytics, and Reporting APIs — exact queries, encoded limits, quota costs, and transforms.
<!-- END doc-index -->

Also: [CHANGELOG.md](CHANGELOG.md).

## Requirements

Node.js 18+. No native dependencies.

## License

BSD-3-Clause
