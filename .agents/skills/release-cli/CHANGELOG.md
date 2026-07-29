# Changelog

All notable changes to this skill are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this skill adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-07-29

### Added

- Step 4b checks that the `ytstats` agent skill still covers the CLI's surface,
  backed by `scripts/skill-sync-check.sh`. The skill is a second consumer of the
  same contracts as `docs/`, but `doc-manifest.json`'s `--affects` map covers
  `README.md` and `docs/**` only — so a release could update every doc correctly
  and still ship a skill describing behaviour that no longer existed. The check
  reports commands, diagnostic codes, and environment variables the CLI has and
  the skill never mentions. It warns and never blocks, since only the user knows
  whether a change is observable to a caller or purely internal.
- Guidance that a bug fix restoring already-documented behaviour still requires
  raising `systemDependencies.ytstats.version` in the skill. That case looks like
  "nothing to do" and is the one most often missed.

## [0.1.0] - 2026-07-28

Initial version.

### Added

- Release workflow for the `ytstats` npm CLI — bump `package.json`, stamp `CHANGELOG.md`,
  commit, and create an annotated `v<version>` tag.
- Three release modes: hot (uses session context), cold (reconstructs from git and asks
  what the commits miss), and an `unreleased` ledger mode for recording changes between
  releases without bumping.
- `scripts/preflight.sh` — three hard gates for full releases: clean working directory,
  passing `npm test`, and a non-empty `[Unreleased]` section. Ledger mode relaxes the
  clean-tree gate but still guards against a conflicting `CHANGELOG.md` edit.
- `references/breaking-changes.md` — scan for ytstats-specific major-bump triggers
  (removed or repurposed diagnostic codes, envelope shape changes, dropped commands,
  remapped exit codes, dropped library exports), sourced from `docs/contributing.md`.
  Warns and asks rather than forcing a major bump.
- `references/changelog-format.md` — Keep a Changelog categories, writing rules, and the
  link-reference update procedure, including the wrinkle that `v0.1.0` was never tagged.
