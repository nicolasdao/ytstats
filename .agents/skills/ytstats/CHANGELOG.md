# Changelog

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
