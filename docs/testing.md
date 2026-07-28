---
description: How ytstats is tested — injection seams, temp config dirs, real-HTTP loopback tests, subprocess end-to-end runs, and what coverage numbers actually mean.
tags: [testing, vitest, coverage, injection]
source:
  - test/**
  - vitest.config.js
---

# Testing

341 tests across 13 files. **None of them requires network access**, and none opens a browser.

## Running

```bash
npm test          # vitest run
npm run test:watch
npm run coverage  # vitest run --coverage
```

`vitest.config.js` sets a Node environment, matches `test/**/*.test.js`, and allows a 15-second timeout — long enough for the end-to-end tests, which spawn real subprocesses.

`prepublishOnly` runs `npm test`, so a failing suite blocks publication.

## Injection is the strategy

The suite runs offline because every effect is a parameter with a real default. `buildProgram()` takes `stdout`, `stderr`, `exit`, `session`, and `now`; `login()` takes `OAuth2`, `startLoopbackServer`, `openBrowser`, `fetchIdentity`, `promptForRedirectUrl`, and `log`; `fetchAll()` takes a `fetchers` bundle; every API fetcher takes `apis` as its first argument.

Nothing is mocked at the module level. Tests hand in plain objects, which means a test breaks when a *contract* changes rather than when an implementation detail moves.

## Test files

| File | Tests | Covers |
|---|---|---|
| `test/envelope.test.js` | 98 | Envelope shape, the diagnostic catalog, severity routing, `nextSteps`, redaction |
| `test/api/transforms.test.js` | 33 | Duration parsing, content classification, CSV, date normalization, row zipping |
| `test/cli.e2e.test.js` | 31 | The real binary, spawned as a subprocess |
| `test/api/fetchers.test.js` | 31 | Exact query parameters sent by every Data, Analytics, and Reporting fetcher |
| `test/auth/credentials.test.js` | 25 | Resolution precedence across all five sources, file shapes, service-account rejection, discovery |
| `test/auth/tokens.test.js` | 23 | Multi-account store, merging, the client binding, default promotion, legacy import |
| `test/auth/session.test.js` | 26 | `login`, `logout`, `getAuthenticatedClient`, refresh persistence, client-mismatch detection |
| `test/auth/oauth.test.js` | 18 | PKCE, auth URL construction, and the loopback server over real HTTP |
| `test/config/store.test.js` | 14 | Atomic writes, permissions, traversal rejection |
| `test/fetch-all.test.js` | 13 | Orchestration, per-step degradation, fatal codes, retention capping |
| `test/dates.test.js` | 11 | Window resolution, calendar validation, bounds |
| `test/client-id.test.js` | 10 | Client ID pre-flight validation, both tiers |
| `test/config/paths.test.js` | 8 | Per-OS directory resolution, including Windows and Linux from any host |

`envelope.test.js` dominates the count because it parameterizes with `it.each` over the entire `DIAGNOSTICS` catalog — every code is asserted to be fully specified, and every recoverable one to carry remediation. Adding a diagnostic adds tests automatically.

## Isolation

`test/helpers/tmp.js` provides `useTempConfigDir()`, which creates a fresh temp directory, points `YTSTATS_CONFIG_DIR` at it, and returns a `cleanup()` that restores the previous value and removes the directory.

Every test touching the config store uses it, so there is no shared global state and no risk of a test reading the developer's real credentials.

The helper also exports `mode(path)` — an octal permission string for asserting `0600`/`0700` — and `isWindows`, used to skip POSIX-mode assertions where they are meaningless.

## What each layer proves

**Pure functions are tested directly.** `transforms.js`, `dates.js`, `config/paths.js`, and `diagnostics.js` have no effects to arrange.

**Fetchers assert the exact query parameters**, not merely the return shape. This is the mechanism that pins the undocumented API limits — `MAX_VIDEO_ROWS` at 200, `MAX_DETAIL_ROWS` at 25, the `views`-only metric list on `insightTrafficSourceDetail`, and the absence of `videoThumbnailImpressions`. A test that only checked the returned rows would let someone raise a limit and reintroduce an opaque failure.

There is also a test asserting `search.list` is never called, protecting the 100× quota difference against a plausible-looking refactor.

**The session layer injects `OAuth2`, the loopback server, the browser opener, and the identity lookup**, so `login` and `logout` are covered end to end without Google.

**The loopback server is tested over real HTTP** on `127.0.0.1` — the test makes actual `fetch` calls against a listening server. It covers state mismatch, user denial, timeout, favicon noise, and the guarantee that the success page never contains the authorization code.

**The CLI is tested by spawning the actual binary.** `test/cli.e2e.test.js` runs `node bin/ytstats.js …` with `execFile`, a temp `YTSTATS_CONFIG_DIR`, and `NO_COLOR=1`, and never throws on a non-zero exit — the exit code is part of what it asserts. This is what proves the output contract holds on paths that are hard to reach in-process: unknown commands, invalid flags, `--help`, `--version`.

## Coverage numbers

`npm run coverage` currently reports about 71% overall, and two figures need explaining:

**`src/cli.js` reports 0%.** Its 31 end-to-end tests run the file as a **subprocess**, which v8 coverage cannot instrument from the parent process. The file is well covered; the number is a measurement artifact, not a gap. Do not chase it by converting the e2e tests to in-process calls — running the real binary is the point.

**`src/api/client.js` reports about 33%.** The uncovered lines are `createApis()` and `downloadCsv()`, which construct live googleapis clients and perform real HTTP. Fetchers take the resulting bundle as a parameter, so the tests hand in plain objects and never execute the constructor.

## What is not covered

**No test performs a live call against Google.** Request shapes are asserted against the documented contract, not the live service. If YouTube changes a limit or starts rejecting a combination that works today, the suite will not notice — that class of failure surfaces as a `API_QUERY_NOT_SUPPORTED` diagnostic at runtime, which is why per-step degradation exists.

The browser is never opened, and no real OAuth consent is exercised.

## Adding tests

For a new fetcher, assert the exact parameters passed to the injected API bundle — see [contributing.md](contributing.md#adding-a-new-dataset).

For a new diagnostic, the catalog test fails unless the entry has a title, detail, cause, and at least one remediation step.

For anything touching the config store, use `useTempConfigDir()` rather than writing to the real directory.

**Assert a value, not just a shape, whenever a transform maps external column or field names.** A test checking `rows.length` passes against a result where every field is `null` — which is exactly how the reach CSV column mismatch survived: correct row count, correct keys, no error, and nothing but nulls behind them. Pin such transforms with a fragment of the real payload and assert an actual number came through.
