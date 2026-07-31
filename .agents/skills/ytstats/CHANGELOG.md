# Changelog

## [0.10.1] - 2026-07-31

### Fixed
- The segment support matrix omitted every command added in ytstats 0.9.0, and both it and the rejection rule still named `search-terms` as the only command that refuses `--segment`. **Five** do — `search-terms`, `sharing-services`, `playlists`, `revenue` and `cards` — so an agent would have read an `INPUT_INVALID_CHOICE` on four of them as an unexpected failure rather than a flag that does not apply.
- `regions` is the only command whose segment support depends on `--level`, and the matrix now says so: `province` serves both segments, `city` and `dma` serve only `subscribedStatus`. Verified command by command against a live channel, not inferred from the flag list.
- Description trimmed to 196 chars, under the 200 recommended, by dropping two articles from the descriptive tail. Every routing trigger phrase is retained.
- `cards` now carries its explicit field list, and both it and the docs state that those eleven counters are **merged into `fetch`'s daily rows but absent from the standalone `daily` command** — an asymmetry that grew when the card set went from four counters to eleven, and which would read as a field having disappeared when comparing the two outputs.

## [0.10.0] - 2026-07-31

### Added
- Route the six new dataset commands: `regions` (city/province/dma), `operating-systems`, `sharing-services`, `playlists`, `revenue` and `cards`. Added to the routing table, the `.data` shapes table, `references/commands.md`, and the `fetch` dataset list.
- Three interpretation rules, each covering a way to report a confidently wrong answer:
  - **Zero revenue is an answer, not a failure.** An unmonetized channel returns rows of zeros, and "revenue data is unavailable" wrongly implies a fix exists. Check the subscriber count against the 1,000-sub Partner Programme threshold before speculating.
  - **Zeros from `cards` mean no cards, or a swallowed failure — and the output cannot tell you which.** That fetcher catches its own errors and returns empty with no warning anywhere in the envelope, so card figures are unknown rather than zero.
  - **`regions --level province` needs `--country`**, fails locally with `INPUT_MISSING_REQUIRED`, and returns ISO 3166-2 codes; `dma` returns Nielsen market numbers, which must not be presented as city names.

### Changed
- Require `ytstats` 0.9.0 or newer, up from 0.8.1 — the six commands do not exist before it.
- Description now says 33 commands, not 27.

## [0.9.1] - 2026-07-31

### Changed
- Require `ytstats` 0.8.1 or newer, up from 0.8.0. On 0.8.0 and earlier, `retention` returned an **empty curve for every video** on a channel whose drop-off metrics YouTube refuses — `ok: true`, `curve: []`, no warning — because the refusal arrives as HTTP 200 with zero rows and the metric fallback only recognised explicit errors. An agent on 0.8.0 would tell a user their videos have no retention data when they have years of it, and would silently fail the transcript-vs-retention analysis that is this skill's headline use case. Third floor raise for the same reason (0.2.1 CTR, 0.7.1 transcript): the guidance is only true from the version that ships the fix.

### Added
- A rule for reading an empty retention curve, mirroring the existing empty-transcript rule: check `meta.version` first, and on 0.8.1+ trust `curve: []` only when it carries a `DATA_EMPTY` warning.
- The distinction between "no retention data" and "no drop-off attribution". A channel that refuses `startedWatching`/`stoppedWatching` still returns a full, usable curve with `ratio` and `relativeRetentionPerformance`; describing that video as having no retention data is wrong and discards the analysis the user asked for.

## [0.9.0] - 2026-07-30

### Added
- Route segmentation requests to `--segment subscribedStatus` / `--segment youtubeProduct` — "subscribers vs non-subscribers", "which YouTube surface". Added to the routing table and the `.data` shapes table in `SKILL.md`, and documented with the full flag reference in `references/commands.md`.
- A "Segmenting a dataset" section in `SKILL.md` and three rules in `references/interpreting-results.md`, because every way of misreading a segmented result produces a confident wrong number rather than an error:
  - **Segments partition the total, they never add to it.** Summing them reproduces the unsegmented figure, and the same date appears once per segment value — so a naive sum or row count doubles the channel's traffic.
  - **A segment drops metrics, and a dropped metric is unknown, not zero.** A segment restricts which metrics its report may request, so `subscribedStatus` costs `comments`/`subscribersGained`/`subscribersLost` and `youtubeProduct` costs those plus `likes`/`dislikes`/`shares`. They return `null` with an `ANALYTICS_METRICS_UNSUPPORTED` warning naming them. Reporting "subscribers left no comments" from a dropped column is a fabrication.
  - **A refused segment is a rejection, not an empty channel.** Support varies by report and by channel; a refusal is `API_QUERY_NOT_SUPPORTED`, exit 4, `retryable: false`. `search-terms --segment` fails earlier still with `INPUT_INVALID_CHOICE` and cannot be segmented at all.
- The `SUBSCRIBER` traffic source / `UNSUBSCRIBED` viewer combination, which is correct and reads as a contradiction — the source is the feed, the segment is the viewer.
- A per-command support matrix, so an agent picks a combination that works instead of discovering a rejection.

### Changed
- Require `ytstats` 0.8.0 or newer, up from 0.7.1. `--segment` does not exist before it, and on 0.7.x this skill would route a user to a flag the CLI rejects as an unknown option. Same reasoning as every previous floor raise: the guidance only becomes true at the version that ships the behaviour.

## [0.8.1] - 2026-07-30

### Changed
- Require `ytstats` 0.7.1 or newer, up from 0.7.0. On 0.7.0 the `transcript` command this skill routes to returned **zero cues for every video** — `captions.download` returns a Blob and the body was read as a string, so a working transcript looked exactly like a video with no captions (`ok: true`, a track reported, and a `DATA_EMPTY` warning). An agent following this skill on 0.7.0 would tell a user their video has no captions when it has them — the same class of confidently-wrong answer as the 0.2.1 CTR floor raise. 0.7.1 also normalizes `trackKind` to upper case, which this skill's "an ASR track is not a quote" rule branches on.

### Added
- Note that auto-caption repetition is removed by the CLI, so a sentence appears once at the moment it was said. Agents quoting a transcript against a retention dip can trust the timestamp rather than de-duplicating themselves.

## [0.8.0] - 2026-07-30

### Added
- Route transcript requests to the new `transcript <videoId>` command — "what did I say at the drop-off", "what was said", "subtitles". Added to the routing table in `SKILL.md`, the `.data` shapes table, and `references/commands.md` with the full cue shape.
- Explain the opt-in captions permission. `login --with-captions` is now a routing entry of its own, and agents are told to confirm before running it: it takes over the browser and Google labels the permission "Manage your YouTube account", which is alarming without the explanation that it is the only scope captions have and the CLI only reads with it.
- `AUTH_SCOPE_MISSING` in `references/troubleshooting.md`, with its own section. Includes the rule that a `null` in `status.scopes` means **unrecorded, not absent** — an agent must not tell a user to re-authorize on the strength of a null.
- Guidance for pairing a transcript with a retention curve, in `SKILL.md` and `references/interpreting-results.md`. The unit mismatch is the trap: retention positions are fractions of the video, cue times are seconds, so converting needs `durationSeconds` from `videos`. Comparing them directly gives a confident answer about the wrong moment.
- The rule that an `ASR` track is not a quote. Speech recognition mangles names and jargon, and the whole point of the feature is explaining a drop-off — recommending someone cut a line they never said is worse than saying nothing. `trackKind` is reported by the CLI, so agents must state which kind of track they are quoting.
- Quota warning: `captions.download` is 200 units against a 10,000/day budget, so `transcript` is roughly 40-50 a day uncached. Agents are told never to loop it over a whole channel.

### Changed
- Require `ytstats` 0.7.0 or newer, up from 0.6.1. `transcript`, `login --with-captions`, `AUTH_SCOPE_MISSING` and the `scopes` field on accounts all arrive in 0.7.0; on 0.6.x this skill would route a user to a command that does not exist. Same reasoning as the 0.2.1 and 0.6.1 floor raises — the guidance only becomes true at the version that ships the behaviour.
- Description now says 27 commands, not 26.

## [0.7.2] - 2026-07-30

### Fixed
- Warn that the report archive is keyed by report type, **not** by channel. 0.7.1 told agents to answer "how far back does my data go" from `archive.reportTypes[].firstDate` without noting that several channels synced from one config directory share those files — and `archive` accepts no `--account`, since it reads local files. On a multi-channel setup an agent would have quoted combined figures as if they described the one channel asked about. Agents are now told to check the account count via `status` first. Nothing is lost either way: rows carry `channel_id` and never overwrite each other, and `sync` honours `--account` — only the totals combine, which is what makes it easy to miss.

### Changed
- CLI floor unchanged at `>=0.6.1`. This limitation is identical on every version that has an archive, so it is a documentation gap in the skill rather than a behaviour difference between CLI releases.

## [0.7.1] - 2026-07-30

### Changed
- Require `ytstats` 0.6.1 or newer. On 0.6.0 the seven dataset commands (`daily`, `traffic`, `devices`, `content-types`, `geography`, `playback-locations`, `video-analytics`) dropped an unavailable metric **without emitting any warning**, so this skill's rule that a null column always has a stated reason was false there — an agent following it would report a metric YouTube never returned as a zero. Same reasoning as the v0.2.1 floor raise for silently-empty CTR: the guidance only becomes true at the fixed version.
- State the dropped-metric rule generally rather than only under retention, now that every analytics command raises `ANALYTICS_METRICS_UNSUPPORTED`. Added to the dataset-command section of `references/commands.md` and the diagnostic entry in `references/troubleshooting.md`.

### Fixed
- Completed two `.data` shape entries: `reports` also returns `jobCount`, and `sync` also returns `note` (which carries the expiry-cadence advice an agent should relay).

## [0.7.0] - 2026-07-29

### Added
- Instruct agents to raise missing Reporting API jobs **unprompted**, with the exact wording to use. This is the one condition the user cannot discover themselves: YouTube generates a report only once a job exists for it, so uncovered report types produce nothing at all while every command keeps returning `ok: true`, and creating the job later recovers only 30 days. An agent that stayed quiet because the run "succeeded" would be watching history disappear.
- Follow-up guidance that creating jobs is only half the fix — reports expire 60 days after generation (30 for backfill), so a job nobody downloads from still loses data. Agents now close `reports-enable` by telling the user to pull on a recurring schedule and keep the files.
- `reports`, `reports-enable`, `sync` and `archive` in the routing table, the command reference, and the `.data` shapes table.
- Guidance that creating jobs and archiving reports are **two** failures with one symptom. Reports expire 60 days after generation, so agents are told to run `sync` themselves — announcing it — when `doctor` reports `reports_archived` as failing, rather than waiting for a user who may not return before the deadline.
- Answer "how far back does my data go" from `archive.reportTypes[].firstDate`, never from the channel's age. A years-old channel can have a two-month archive, and the earlier history is not retrievable by any API call.
- The `reports_archived` doctor check and the `REPORTS_EXPIRING` diagnostic.
- The `reporting_jobs` doctor check, flagged as the only check that reports something already lost rather than something blocked.
- How to read the four new retention metrics. A dip with high `stoppedWatching` is content losing viewers; the same dip with high `startedWatching` is viewers skipping ahead — opposite advice, and `ratio` alone cannot distinguish them. `relativeRetentionPerformance` answers "is this normal for a video like mine" rather than "where is my worst moment".
- The 30 April 2025 `views` redefinition and when to use `engagedViews` instead. Comparisons spanning that date otherwise overstate Shorts for purely mechanical reasons, and a step change in the daily series around it is the metric change rather than anything the user did.
- `REPORTING_JOBS_MISSING` and `ANALYTICS_METRICS_UNSUPPORTED` to the diagnostic catalog, both with the caveat that a dropped metric means **unknown**, never zero.

### Changed
- Require `ytstats` 0.6.0 or newer. The skill now tells agents to run `reports-enable --all` as the fix for a real and ongoing data loss; on 0.5.0 that command does not exist, so the guidance would name a remedy the user cannot run.
- `doctor` is described as nine checks, not seven — and the "four independent checks" figure in the troubleshooting reference, which had been wrong since the check count grew past four, is corrected and now names each one.

## [0.6.0] - 2026-07-29

### Changed
- Require `ytstats` 0.5.0 or newer. Before it the `--account` selector was silently dropped before reaching the code that validates it, so every command answered with the **default** channel while reporting success. The skill routes "switch channel" and per-invocation selection through that flag, so on any earlier CLI it was confidently steering agents to the wrong channel's data.
- Global flags are no longer position-sensitive — `--account` resolves identically before or after the command name from 0.5.0 onward.

### Added
- Tell agents to check `ytstats --version` first when reported figures look like the wrong channel, since the pre-0.5.0 symptom is plausible-looking data rather than an error.
- Note `authorizedAt` on each account — when its refresh token was issued — and that `savedAt` is only the last write, moving on every refresh.

## [0.5.0] - 2026-07-29

### Added
- Explain the two Google policies that make a previously working setup fail with no obvious cause: OAuth clients unused for six months are deleted automatically (from October 2025), and the client secret has been non-re-downloadable since June 2025. Both present as `AUTH_CLIENT_ID_INVALID` or a browser "Access blocked", naming neither cause, so the user assumes they broke something.
- Never tell a user to re-download an existing client's JSON — it is no longer possible. They add a new secret or create a new client.

### Changed
- Require `ytstats` 0.4.0 or newer. The skill reads setup steps and console URLs out of the CLI's diagnostics, and earlier versions emit console paths Google has retired — so an older CLI would have the skill relaying dead links.

## [0.4.0] - 2026-07-29

### Added
- Guide a brand-new user through setup from `doctor` rather than reciting the whole walkthrough. The seven checks map to exactly which steps are outstanding, so someone who has done four is shown the remaining three, each with the console URL for that specific API.
- Raise the `consent_screen` step explicitly whenever `doctor` reports it `unknown`. No API exposes whether the consent screen is published, and it is the only step whose failure is delayed — everything works for 7 days, then breaks with `invalid_grant` looking like a new problem. Silence here is how that trap keeps catching people.
- Note that the three YouTube APIs are enabled independently, so a pass on one says nothing about the others.

### Changed
- Require `ytstats` 0.3.0 or newer, where `doctor` gained the per-API probes, the `consent_screen` check, and the `status` field the setup flow reads.

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
