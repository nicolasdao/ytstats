# CHANGELOG.md Format

`ytstats` follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The file lives at `CHANGELOG.md` in the project root.

## Categories

| Category | Use for | Default bump signal |
|---|---|---|
| **Added** | New commands, flags, datasets, diagnostics, capabilities | minor |
| **Changed** | Changes to existing behavior, output shape, or defaults | minor or patch |
| **Deprecated** | Marked for future removal, still working | minor |
| **Removed** | Commands, flags, or diagnostic codes taken away | **major** |
| **Fixed** | Bug fixes | patch |
| **Security** | Vulnerability fixes, dependency advisories | patch or minor |

Omit categories with no entries. Never write an empty `### Fixed`.

## Writing rules

- One bullet per **logical change** — squash related commits.
- Start each bullet with an imperative verb: Add, Fix, Remove, Change, Update, Deprecate.
- Be specific and name things: command names, flag names, diagnostic codes, module paths.
- Newest release directly below `## [Unreleased]`.
- `## [Unreleased]` is always present, even when empty after a release.
- Dates are ISO 8601 — `YYYY-MM-DD`.
- Version headings are bracketed — `## [0.2.0] - 2026-08-01`.

Good bullets for this project name the surface they touch:

```markdown
### Added
- Add `--json-lines` flag to `fetch` for streaming large snapshots.
- Add `API_REPORT_STALE` diagnostic for reach data older than 7 days.

### Fixed
- Fix `retention` clamping ratios above 1.0, which discarded valid Shorts loop data.
```

## Current structure

```markdown
# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-27

Initial release.

### Added
- ...

[Unreleased]: https://github.com/nicolasdao/ytstats/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nicolasdao/ytstats/releases/tag/v0.1.0
```

## Stamping a release

1. Move every bullet out of `## [Unreleased]` into a new `## [<version>] - <today>` section placed directly beneath it.
2. Leave `## [Unreleased]` in place, empty.
3. Update the link references at the **bottom** of the file. This is easy to forget and leaves broken compare links.

For a release of `0.2.0` on top of `0.1.0`, the reference block becomes:

```markdown
[Unreleased]: https://github.com/nicolasdao/ytstats/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/nicolasdao/ytstats/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/nicolasdao/ytstats/releases/tag/v0.1.0
```

The pattern: `[Unreleased]` always compares the newest tag to `HEAD`; each version compares the previous tag to itself; the oldest version points at its release tag.

## Known wrinkle — v0.1.0 was never tagged

The repository has no git tags, so the existing `compare/v0.1.0...HEAD` and `releases/tag/v0.1.0` links do not resolve. This is a pre-existing condition and is **not** the release skill's job to repair.

Two consequences to keep in mind:

- The first release run has no baseline tag to diff from — use all history.
- After that release, `v<new-version>` will exist but `v0.1.0` still will not, so the `[0.2.0]` compare link would 404. Prefer pointing the first new entry at the release tag form (`releases/tag/v0.2.0`) rather than a compare against a tag that does not exist, and mention this to the user.

If the user later backfills the `v0.1.0` tag, the compare form becomes correct and can be used from then on.
