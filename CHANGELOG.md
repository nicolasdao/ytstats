# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/nicolasdao/ytstats/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/nicolasdao/ytstats/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/nicolasdao/ytstats/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/nicolasdao/ytstats/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/nicolasdao/ytstats/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/nicolasdao/ytstats/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nicolasdao/ytstats/releases/tag/v0.1.0
