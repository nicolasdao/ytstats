# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **`ytstats transcript` returned zero cues for every video on 0.7.0.** The
  command was unusable as shipped. Three defects, all invisible to unit tests
  because the fixtures were hand-written rather than captured from the API —
  the same lesson as the reach CSV regression, relearned:
  - `captions.download` hands its body back as a **Blob**, not a string.
    `String(blob)` is the literal `"[object Blob]"`, which parses to no cues
    while every other signal still reads as success: `ok: true`, a track chosen
    and reported, a cache file written, and a `DATA_EMPTY` warning saying the
    track "contained no cues" — indistinguishable from a video whose captions
    really are empty. `readBody()` now handles string, `Buffer`, `.text()` and
    `.arrayBuffer()` explicitly.
  - `trackKind` arrives **lowercase** (`"asr"`), though Google documents it
    capitalised. `t.trackKind !== 'ASR'` therefore classified every
    auto-generated track as author-written, silently inverting the manual-over-ASR
    preference that `selectCaptionTrack()` exists to express. The value is now
    normalized to upper case, so a consumer's `=== 'ASR'` branch works.
  - YouTube's auto-captions **roll**: each cue repeats the previous cue's text
    before adding new words, interleaved with 10 ms cues that restate the line.
    Emitting them verbatim put the same sentence at two or three timestamps,
    which corrupts the one question this feature answers — *what was said at the
    moment viewers left*. Carry-over lines are dropped and a cue with nothing new
    is skipped. A real 15-second Short goes from 12 duplicated cues to 7 clean
    ones. Two related quirks fixed with it: a whitespace-only line inside a cue
    no longer terminates it (that dropped the opening line of every ASR track),
    and inline word timings are stripped before lines are compared.
- Cue times are rounded to millisecond precision, so `3.2800000000000002` no
  longer reaches the JSON a consumer reads.

### Changed

- `trackKind` is now always upper case (`ASR`, `STANDARD`, `FORCED`) regardless
  of what the API returns.

## [0.7.0] - 2026-07-30

### Added

- `ytstats transcript <videoId>` — the caption transcript for a video you own,
  with cue timings. This is the other half of a retention analysis: `retention`
  says *where* viewers left, `transcript` says *what was being said* there. Cues
  are `{ start, end, text }` with times as **seconds as numbers**, because
  retention's x-axis is `elapsedVideoTimeRatio` and aligning the two needs
  numbers. The join is left to the consumer rather than guessed at here.
- `ytstats login --with-captions` — opt-in caption access. Captions have **no
  read-only scope**: `captions.list` and `captions.download` both require
  `youtube.force-ssl`, which Google presents as "Manage your YouTube account".
  The default grant is therefore unchanged at three read-only scopes, and
  nobody acquires write capability without asking. `ytstats` still never writes.
  Adding the scope later is additive — incremental authorization was already
  enabled, so previously granted scopes are preserved.
- `scopes` on each account in `ytstats status`, recording what Google actually
  granted. An absent value means **unknown**, not "nothing granted": accounts
  saved before this field existed have `null` and keep working. The value is
  never synthesized from the requested scope list, because a fabricated grant
  record is worse than none — the scope check trusts what it reads.
- `AUTH_SCOPE_MISSING` — raised before the request when the stored grant is
  known to lack caption access, so the user gets `ytstats login --with-captions`
  instead of an opaque Google 403. `retryable: false`: re-running the same
  command cannot help.
- Library exports: the `captions` namespace, `CAPTIONS_SCOPE`, `parseCues`,
  `readTranscript` and `writeTranscript`.

### Notes

- Transcripts are cached under `<data dir>/transcripts/<videoId>.json`, keyed on
  the caption track's `lastUpdated` so an edited track invalidates the cache on
  its own. The cache is load-bearing rather than an optimisation:
  `captions.download` costs **200 quota units** against a 10,000/day budget —
  the most expensive call `ytstats` makes, roughly 50 transcripts a day. Listing
  tracks to check staleness costs 50. `transcript` is deliberately one video at
  a time, with no bulk mode.
- The transcript cache uses its own path validator rather than the report-type
  one, which rejects hyphens — and most YouTube video ids contain one.

## [0.6.1] - 2026-07-30

### Fixed

- Report a dropped metric on every dataset command, not only `retention`. The
  tiered metric fallback landed in 0.6.0 wired into `retention` and `fetch` but
  **not** into the `simple()` helper, so `daily`, `traffic`, `devices`,
  `content-types`, `geography`, `playback-locations` and `video-analytics` could
  return `engagedViews: null` on every row with no warning at all. That is the
  same silent-null shape as the reach CSV regression — `ok: true`, correct row
  count, a column of nulls, and nothing anywhere saying why. All seven now emit
  `ANALYTICS_METRICS_UNSUPPORTED` with the dropped metric in `context.dropped`.
  An absent field means unknown, never zero.

### Added

- `buildProgram({ makeApis })` — an injection seam defaulting to `createApis`.
  Without it `withApis()` constructed the API bundle itself, so no test could
  drive a command body past authentication; the whole post-auth half of the CLI,
  including which warnings a command emits, was unreachable from the suite. That
  is precisely why the missing warning above went unnoticed. `period` is still
  returned as the clean range, never the object carrying the callback.

### Documented

- The archive is keyed by report type, not by channel. One config directory holds
  many channels but one file per report type, so syncing two channels from the
  same directory interleaves them. Rows stay distinguishable by `channel_id` and
  never overwrite each other, but `archive` totals and `readRows()` cover both.
  `sync` honours `--account`, so each command behaves correctly and only the
  store mixes — which is what makes it easy to miss. Give each channel its own
  `YTSTATS_CONFIG_DIR`.

## [0.6.0] - 2026-07-30

### Added

- `ytstats reports` and `ytstats reports-enable` — audit and close the Reporting
  API job gap. The API generates a report **only once a job exists for it**, so a
  report type with no job produces nothing at all, silently, while every command
  keeps returning `ok: true`. Creating a job later backfills 30 days and no more,
  which makes this the one failure in `ytstats` whose cost is unbounded and
  unrecoverable. Until now exactly one job was ever created
  (`channel_reach_basic_a1`), and only when `reach` was first run — every other
  report type had been collecting nothing since the tool was written.
- `doctor` gained a `reporting_jobs` check that **fails** rather than warns when
  report types are uncovered. It is the only check that reports something already
  lost rather than something blocked; a warning that costs a month of history per
  month ignored is mis-graded.
- Report types are discovered live via `reportTypes.list` rather than hardcoded.
  Google version-bumps report ids in place (`channel_basic_a2` → `a3`) and its own
  two listing pages currently disagree about the set, so a constant would rot
  silently. Uses `yt-analytics.readonly`, already requested — no new consent.
- Audience retention now returns `stoppedWatching`, `startedWatching`,
  `totalSegmentImpressions` and `relativeRetentionPerformance` alongside `ratio`.
  `audienceWatchRatio` alone cannot distinguish viewers *leaving* at a point from
  viewers *skipping ahead* to it — those call for opposite edits.
- `engagedViews` is requested alongside `views` on the seven fetchers that allow
  it. YouTube redefined `views` on 2025-04-30 (a Shorts view is now every play or
  replay, no minimum watch time); `engagedViews` preserves the prior definition,
  so comparisons spanning that date no longer silently overstate Shorts.
- `ytstats sync` and `ytstats archive` — a durable local store for Reporting API
  output. Creating jobs makes YouTube *generate* reports; it does nothing to stop
  them expiring **60 days after generation** (30 days for backfill reports). Full
  job coverage plus an infrequent pull therefore still loses history, silently.
  Confirmed live during development: the first sync of a long-running reach job
  returned rows starting exactly ~60 days back — everything earlier had already
  been deleted by Google. Storage is append-only NDJSON per report type under
  `<config dir>/data` or `YTSTATS_DATA_DIR`, deduped last-wins on replay.
- `doctor` gained a `reports_archived` check, failing when a generated report is
  within 14 days of expiring un-downloaded. `reporting_jobs` and this are two
  halves of one problem: the first catches data never generated, the second data
  generated and never collected.
- `REPORTING_JOBS_MISSING`, `REPORTS_EXPIRING` and `ANALYTICS_METRICS_UNSUPPORTED`
  diagnostics.
- `YTSTATS_DATA_DIR` to relocate the archive. It defaults under the config
  directory so `YTSTATS_CONFIG_DIR` still moves everything for a channel together.

### Changed

- Analytics queries degrade per-metric instead of failing outright. The API
  rejects the *whole query* when a channel cannot serve one requested metric, so
  adding any newer metric unconditionally would turn a working dataset into no
  dataset. Each addition is now a tier that falls back to the set already known to
  work; only `API_QUERY_NOT_SUPPORTED` triggers a retry, so a 403 is never quietly
  downgraded into "degraded data". Dropped metrics are reported in `notes` (from
  `fetch`) or as an `ANALYTICS_METRICS_UNSUPPORTED` warning (from `retention`) —
  an absent field means unknown, never zero.
- `reach-jobs` now pages `jobs.list` rather than reading only the first page.
- A `sync` marks a report ingested only after the append succeeds, so a failed
  download is retried on the next run rather than skipped forever — the report is
  gone in 60 days and a retry is the only chance to get it. Progress is persisted
  even when a run aborts partway.
- **Upgrade impact:** `doctor` now reports `data.healthy: false` on installs where
  it previously reported `true`, because the two new checks surface a condition
  that was always present and never visible. `data.checks` also grew from 7 to 9
  entries — consumers reading it by position rather than by `id` will shift. No
  envelope key, diagnostic code, command, or exit code changed.

## [0.5.0] - 2026-07-29

### Fixed

- Make `--account` work. `run()` passed Commander's Command instance to every
  command body as `globalOpts` and dropped `program.opts()` entirely, so
  `globalOpts.account` was always `undefined` and the selector was silently
  inert — **in both positions, on every command, since the first release**. A
  read command answered with the default channel's data while the caller
  believed they had selected another, and `logout --account <other>` revoked the
  default channel's token. `AUTH_ACCOUNT_UNKNOWN` could never fire from the CLI,
  because the selector never reached the code that raises it.
- Accept `--account` after the command name as well as before it. Commander does
  not fold a post-command global option back into the program's options, so the
  documented "global flags go before the command" rule was load-bearing in a way
  nothing enforced. Both positions now resolve identically.

### Added

- Record `authorizedAt` on each account — when its refresh token was issued, set
  at login and preserved across refreshes. `savedAt` is rewritten on every token
  refresh, so any check on token age read it as "just now" for an actively used
  install; `doctor`'s `consent_screen` heuristic could therefore never fire.

## [0.4.0] - 2026-07-29

### Fixed

- Point at the Google console pages that exist. Google moved OAuth configuration
  into a "Google Auth Platform" section in April 2025: the consent screen is now
  `/auth/audience` and the OAuth client is `/auth/clients`. Every diagnostic, the
  setup walkthrough, and the README used the retired `/apis/credentials/consent`
  and `/apis/credentials` paths, so a new user following the instructions was
  being sent to pages Google no longer documents.
- Stop advising users to re-download an existing client's JSON. Since June 2025
  the client secret is shown only at creation and the console afterwards displays
  just its last four characters, so that remediation could not be followed. It now
  says to add a new secret or create a new client.

### Added

- Report which Google Cloud project the credentials belong to. `ytstats status`
  gains `project` — `{ id, number, consoleUrl }` — with a console URL already
  pinned via `?project=`, and `doctor`'s consent-screen link is pinned the same
  way. A bare console URL opens whichever project the browser last used, so
  anyone signed into several accounts could confidently check the wrong project's
  consent screen and conclude they were fine. `projectId` is now kept from the
  `project_id` Google includes in the downloaded client file.
- Warn in the setup walkthrough that the client JSON must be downloaded at the
  moment of creation.

## [0.3.0] - 2026-07-29

### Added

- Probe all three YouTube APIs in `doctor` instead of only the Data API. They are
  enabled independently in Google Cloud, so reaching one said nothing about the
  others — setup could look complete, `healthy` report `true`, and the first
  `daily` or `reach` then fail with `API_NOT_ENABLED` and nothing pointing at the
  missing API. `api_analytics` and `api_reporting` join `api_reachable`, each
  carrying that API's own console URL in its remediation.
- Add a `consent_screen` check reporting `status: "unknown"`. No Google API
  exposes whether the consent screen is published to Production, and it is the one
  setup step whose failure is delayed — in Testing, Google expires refresh tokens
  after 7 days, so everything works for a week and then breaks looking like a new
  problem. Reporting it as unverifiable keeps a real prerequisite visible rather
  than letting `healthy: true` imply a step nobody looked at. It flips to `pass`
  once a working token is older than 7 days, which Testing mode would have expired.
- Add `status` (`pass` / `fail` / `unknown`) to every `doctor` check, alongside the
  existing boolean `ok`. An `unknown` never counts against `healthy` — "we could
  not look" is not "we found a problem".

## [0.2.1] - 2026-07-28

### Fixed

- Report an expired legacy refresh token during `import-legacy` as
  `AUTH_TOKEN_EXPIRED` rather than `UNEXPECTED`. The identity lookup was the one
  Google call not wrapped in `mapGoogleError`, so a stale token — the most
  predictable outcome of a migration, since people migrate precisely because the
  old setup went stale — surfaced as an internal error telling the user to report
  a bug, with `recoverable: false` halting any agent that respects it. It now
  carries `recoverable: true` and a `ytstats login` next step, and exits 2 rather
  than 1.
- Report an unreadable or malformed legacy token file as `INPUT_INVALID_VALUE`
  rather than `UNEXPECTED`. A mistyped path is ordinary during a migration.
- Read the correct columns from the reach report. `channel_reach_basic_a1` emits
  `video_thumbnail_impressions` and `video_thumbnail_impressions_ctr`, but
  `fetchReach` read `impressions` and `impressions_ctr`, so every row resolved to
  `null` while the command still reported `ok: true` with no warning — a silent
  failure indistinguishable from a channel with no impressions. `ytstats reach`
  and `fetch --reach` returned empty CTR data for every user affected.
- Classify a failed reach report download by its HTTP status. `downloadCsv` folded
  the status into a message string and the call skipped `call()`, so a transient
  Google 5xx surfaced as `UNEXPECTED` with `recoverable: false` — halting a caller
  permanently on a hiccup that `API_UNAVAILABLE` would have marked retryable.

### Added

- Export `identifyLegacyTokens` from `src/index.js`, exchanging a legacy token
  file's tokens for the channel identity that owns them.

## [0.2.0] - 2026-07-28

### Added

- Add `YTSTATS_CREDENTIALS_FILE` — supply the OAuth client as a path to the JSON Google
  issued, rather than as two extracted environment variables. Resolved after the
  `YTSTATS_CLIENT_ID`/`YTSTATS_CLIENT_SECRET` pair and before stored credentials, so
  existing setups are unaffected. Intended for CI, where secrets already arrive as
  mounted files, and for per-directory configuration with direnv.
- Add `AUTH_CLIENT_MISMATCH`, raised when a channel's stored token was issued by a
  different OAuth client than the one currently resolving. Previously this reached
  Google as `invalid_grant` and surfaced as `AUTH_TOKEN_EXPIRED`, which blames the
  consent screen and sends the caller to fix the wrong thing.
- Add a `clientId` field to `ytstats status` and to each account it lists, recording
  which OAuth client resolved and which one authorized each channel. A client ID is
  public by OAuth design, so neither is redacted.
- Add a `clientId` field to `tokens.json` account records, binding each refresh token
  to the client that issued it. Accounts written before this field existed read as
  `null` and are treated as unknown rather than mismatched, so upgrading logs nobody
  out.
- Add documentation for running several OAuth clients side by side, one
  `YTSTATS_CONFIG_DIR` per client, which moves credentials and tokens together.

## [0.1.0] - 2026-07-28

Initial release.

### Added

- `login` / `logout` / `status` / `use` — bring-your-own-credentials OAuth. No shared
  client ID: each user supplies their own Google Cloud OAuth client, so quota and
  verification are their own.
- Loopback OAuth flow with PKCE (S256) and a constant-time CSRF state check, bound to
  `127.0.0.1` on an ephemeral port. `--no-browser` fallback for headless machines.
- Multi-account token storage in a per-user config directory (macOS, Windows, Linux),
  written atomically at `0600` inside a `0700` directory.
- `fetch` — every dimension in one JSON document: channel, videos, daily metrics,
  per-video analytics, traffic sources and details, demographics, devices, content
  types, search terms, geography, playback locations, retention curves, optional reach.
- Individual dataset commands: `channel`, `videos`, `daily`, `traffic`, `demographics`,
  `devices`, `content-types`, `search-terms`, `geography`, `playback-locations`,
  `video-analytics`, `retention`, `reach`, `reach-jobs`, `query`.
- `doctor` — checks config writability, credentials, sign-in state and live API
  reachability independently, and reports the exact blocking diagnostics.
- `import-legacy` — import tokens from a pre-ytstats project-local `tokens.json`.
- Agent-first output contract: stdout is always exactly one shape-invariant envelope
  (`ok`, `command`, `fetchedAt`, `data`, `errors`, `warnings`, `nextSteps`, `meta`),
  including for unknown commands and invalid flags. Every diagnostic carries a stable
  code, cause, `recoverable`/`retryable` flags, and runnable remediation commands.
- Input validation runs before authentication and reports every problem at once.
- Client ID pre-flight validation, so a malformed OAuth client fails immediately
  instead of hanging until the browser callback times out.

[Unreleased]: https://github.com/nicolasdao/ytstats/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/nicolasdao/ytstats/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/nicolasdao/ytstats/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/nicolasdao/ytstats/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/nicolasdao/ytstats/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/nicolasdao/ytstats/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/nicolasdao/ytstats/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/nicolasdao/ytstats/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/nicolasdao/ytstats/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nicolasdao/ytstats/releases/tag/v0.1.0
