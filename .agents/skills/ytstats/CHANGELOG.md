# Changelog

## [0.3.0] - 2026-07-29

### Added
- Document credential resolution — the five sources in precedence order, and the `YTSTATS_CREDENTIALS_FILE`, `YTSTATS_CLIENT_ID`, `YTSTATS_CLIENT_SECRET`, `XDG_CONFIG_HOME` and `HTTPS_PROXY` variables. None of these were mentioned before, so a request like "use the client secret in ~/secrets/acme.json" had no guidance to work from.
- Warn that switching OAuth clients via `YTSTATS_CREDENTIALS_FILE` alone pairs one client's id with another's tokens, which is what `AUTH_CLIENT_MISMATCH` reports. `YTSTATS_CONFIG_DIR` moves both halves together.
- Cover `AUTH_CREDENTIALS_NOT_FOUND` (noting `context.flag` names which source was wrong), `AUTH_CREDENTIALS_MALFORMED`, and `CONFIG_UNWRITABLE`.

## [0.2.0] - 2026-07-29

### Changed
- Require `ytstats` 0.2.1 or newer. Versions before that read the wrong CSV columns from the reach report and returned every impression field as `null` while still reporting `ok: true`, so a skill declaring `>=0.2.0` would confidently answer "no impressions data" to someone whose CTR data existed.

### Added
- Distinguish an outdated CLI from a genuinely empty channel when reading `reach`. Rows present with every `impressions` and `impressionsCtr` null is the pre-0.2.1 bug, not an absence of data — a real report never returns hundreds of rows in which every impression field is null.
- Explain that `UNEXPECTED` usually means an outdated CLI rather than a genuine internal fault. Before 0.2.1 it leaked on two ordinary paths — an expired `import-legacy` refresh token and a transient Google 5xx during a reach download — which now classify as `AUTH_TOKEN_EXPIRED` and `API_UNAVAILABLE`.

## [0.1.0] - 2026-07-28

Initial version.

### Added
- Plain-English routing for all 22 `ytstats` commands — data retrieval, account management, and diagnosis — so a human or agentic client can ask for channel stats without knowing the command surface.
- The four shapes of the response envelope's `data` field, which differ per command family. `fetch` nests its datasets one level deeper at `.data.data` and returns bare arrays rather than `{period, rows}`, so a path written for the dataset commands silently yields `null` against a snapshot.
- Result-interpretation guidance for values that are correct but read as wrong — `impressionsCtr` is a fraction rather than a percentage, retention ratios above 1.0 mean rewatching, and an empty dataset named in `data.warnings` means the step degraded rather than the channel having no activity.
- Diagnostic-code handling built on `recoverable` and `retryable`, so a failure is never retried when retrying cannot help.
- Large `fetch` output is redirected to a file and summarized rather than printed, keeping multi-megabyte snapshots out of the conversation while staying queryable with `jq`.
- `logout` requires explicit confirmation, since it revokes the refresh token with Google. No other command does.
- Windows notes covering the PowerShell equivalents of the POSIX idioms shown to users, and the Windows PowerShell 5.1 UTF-16 redirection trap that makes a saved snapshot unparseable by `jq`.
