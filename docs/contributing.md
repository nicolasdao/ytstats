---
description: How to extend ytstats — adding datasets, commands, and diagnostics; the dependency policy; and the release process.
tags: [contributing, workflow, dependencies, release, versioning]
source:
  - package.json
  - CHANGELOG.md
  - vitest.config.js
---

# Contributing

How to change `ytstats` without breaking the contracts it makes. Read [architecture.md](architecture.md) first for how the pieces fit together.

## Adding a new dataset

1. **Add the fetcher** to the relevant `src/api/*.js`, taking `apis` as its first argument so it stays injectable.
2. **Add a test asserting the exact query parameters**, not just the return shape. That is what protects the undocumented API limits — a test that only checks returned rows lets someone raise `maxResults` and reintroduce an opaque failure.
3. **Wire it into `fetch-all.js` behind `step()`** so a failure degrades to a warning rather than aborting the whole run.
4. **Add a dedicated command in `cli.js`** if it is independently useful. Most analytics datasets can use the `simple()` helper, which supplies the date flags, the range validation, and the `DATA_EMPTY` warning.
5. **Add a diagnostic to `diagnostics.js`** if it introduces a new failure mode. The catalog test fails unless the entry has a title, detail, cause, and at least one remediation step.
6. **Update [cli.md](cli.md), [youtube-apis.md](youtube-apis.md), and `CHANGELOG.md`.**

If YouTube rejects a metric or dimension combination in a way that is not obvious, add it to [gotchas/youtube-api.md](gotchas/youtube-api.md) naming the handling site — so the next person does not undo the workaround.

## Adding a command

Commands live in `src/cli.js`, grouped by section. Three helpers exist:

- **`run(name, body, { validate })`** wraps a command body: diagnostics in, one envelope plus exit code out. The `validate` callback runs **before** authentication and returns an array of diagnostics rather than throwing, so every input problem is reported at once.
- **`simple(name, description, fn)`** defines a date-windowed analytics command with the standard flags, range validation, and empty-result warning. Returns the command so extra options can be chained.
- **`dateOptions(cmd)`** adds `--days`, `--start`, and `--end` to a command built by hand.

Use `withApis(globalOpts)` to authenticate and get the API bundle. Never write to stdout directly — go through `reporter.succeed()` or `reporter.fail()`, or you break the one-JSON-document guarantee.

Commander's negated options read inverted: `--no-retention` surfaces as `cmdOpts.retention`, defaulting to `true`.

## Adding a diagnostic

Entries in `DIAGNOSTICS` (`src/diagnostics.js`) are built with the `def()` helper, which defaults `severity` to `error` and `exitCode` to `EXIT.GENERAL`. A complete entry needs:

```js
MY_NEW_CODE: def({
  code: 'MY_NEW_CODE',
  exitCode: EXIT.API,
  recoverable: true,      // can this be fixed at all?
  retryable: false,       // would re-running the SAME command help?
  title: '…',
  detail: '…',
  cause: '…',
  remediation: { summary: '…', steps: ['…'], commands: [DOCTOR_CMD], docs: ['…'] },
})
```

Get `recoverable` and `retryable` right — they are the anti-loop signals an agent depends on. Marking something `retryable: true` when a retry cannot help sends a caller into an infinite loop.

Use `defaults: { … }` for context values that must appear even when a call site forgets to pass them, as `INPUT_INVALID_DATE` does with `expected`.

Throw it with `fail(DIAGNOSTICS.MY_NEW_CODE, { … })` rather than constructing a `YtStatsError` by hand.

## The stability contract

**`code` values are public API.** Scripts and agents consuming `ytstats` JSON branch on them. Add new codes freely; never repurpose an existing one, and never delete one without a major version bump.

The same applies to the envelope's shape invariance — every key present on every response — and to the rule that `data` is `null` whenever `ok` is false. See [output-contract.md](output-contract.md).

## Dependency policy

**No native dependencies.** `npx ytstats` must start instantly, which rules out anything requiring a prebuild download or a node-gyp compile. Runtime dependencies are `commander`, `googleapis`, and `open` — all pure JS. Think hard before adding a fourth.

Node 18 or newer is required (`engines.node`).

### The gaxios override

`package.json` pins `gaxios` above its transitive default:

```jsonc
"overrides": { "gaxios": "^7.1.4" }
```

`package.json` carries the rationale inline under `overridesRationale`: `googleapis-common` pins gaxios 7.1.3, which drags in `rimraf > glob > minimatch > brace-expansion` and a high-severity DoS advisory (GHSA-mh99-v99m-4gvg). gaxios 7.1.4+ dropped that chain. Same major version, so this is a patch-level floor rather than a compatibility risk.

**Remove the override once `googleapis-common` raises its own floor.** Keeping a stale override silently pins a dependency the upstream has moved past.

## Testing requirements

Every change needs tests, and the suite must stay offline. See [testing.md](testing.md) for the injection seams available.

The two rules that catch the most regressions:

- Assert **exact query parameters** on API fetchers, since that is what pins the undocumented limits.
- Use `useTempConfigDir()` for anything touching the config store, so tests never read real credentials.

## Release process

The package is published to npm. `files` in `package.json` limits the tarball to `bin/`, `src/`, `docs/`, `README.md`, `CHANGELOG.md`, and `LICENSE` — tests and config are not shipped.

A release has two halves, and the split is deliberate:

| Half | Steps | Automated? |
|---|---|---|
| **Cut the release** | Version bump, changelog, commit, tag | Yes — the `release-cli` skill |
| **Ship to production** | `git push`, `npm publish` | No — always manual |

Nothing publishes to npm without a human running `npm publish`. That boundary is the point, not an unfinished feature.

### Cutting a release manually

These steps are the contract. The skill below automates them; it does not replace them.

1. Make sure `npm test` passes. `prepublishOnly` runs it again and blocks publication on failure.
2. Update `CHANGELOG.md`. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/): move entries out of `## [Unreleased]` into a new version heading with its date, and update the link references at the bottom.
3. Bump the version in `package.json` following [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Removing or repurposing a diagnostic `code`, changing the envelope shape, or dropping a command is a **major** bump — see [The stability contract](#the-stability-contract).
4. Commit `package.json` and `CHANGELOG.md` only, as `chore(release): ytstats v<version>`.
5. Tag it: `git tag -a v<version> -m "Release v<version>"`.

`meta.version` in the envelope is read from `package.json` at runtime, so it tracks the bump automatically.

### Cutting a release with the release-cli skill

`release-cli` is an AI-agent skill that performs steps 1-5 above. It is **optional tooling, not a project dependency** — it lives in `.agents/skills/release-cli/` and is excluded from the npm tarball, so a clone or an npm install does not necessarily have it. Install it with [HappySkills](https://happyskills.ai) if it is absent.

```bash
/release-cli                              # analyze changes and propose a bump
/release-cli minor "Added --json-lines"   # force the bump level, supply a note
/release-cli unreleased                   # record changes only, no bump or tag
```

**Three gates must pass before it will cut a release**, and none can be overridden:

1. The working directory is clean. A release commits only `package.json` and `CHANGELOG.md`, so uncommitted code would produce a tag whose commit does not contain the changes it ships.
2. `npm test` passes.
3. `## [Unreleased]` is non-empty — it refuses to stamp an empty version.

**It warns on breaking changes rather than deciding for you.** The skill scans the diff for this project's documented major-bump triggers — a removed or repurposed diagnostic `code`, an envelope key that changed or became conditional, a dropped command, a remapped exit code, a dropped `src/index.js` export — and asks you to confirm the bump when it finds one. It is a `grep`-and-diff heuristic: it cannot see a code whose *meaning* changed while its string stayed the same, so it is a safety net, not a substitute for knowing what you changed.

**The `unreleased` ledger mode** records changes into `## [Unreleased]` without bumping or tagging. It appends rather than replaces, so several sessions working the same branch can each record their own work and the next release promotes the whole section — instead of one session reconstructing everyone's scope from `git log` at release time.

### Shipping to production

After the tag exists, deployment is two manual commands:

```bash
git push && git push --tags
npm publish
```

`prepublishOnly` re-runs the full test suite as the last gate before the tarball is built.

`origin` points at <https://github.com/nicolasdao/ytstats.git>, and every release from `v0.1.0` onward is tagged, so the `compare/` links in `CHANGELOG.md` resolve and each release has a baseline to diff against.

## Documentation

Documentation lives in `docs/`, indexed from [README.md](../README.md). Each file carries frontmatter declaring the `source` globs it documents, and `doc-manifest.json` at the project root is the derived retrieval index — regenerated, never hand-edited.

When a change touches code covered by a doc's `source` globs, update that doc in the same commit.
