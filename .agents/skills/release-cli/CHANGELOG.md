# Changelog

All notable changes to this skill are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this skill adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
