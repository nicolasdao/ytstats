# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/nicolasdao/ytstats/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/nicolasdao/ytstats/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nicolasdao/ytstats/releases/tag/v0.1.0
