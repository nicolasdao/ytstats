---
description: How ytstats is put together — module layout, design principles, request flow, and the programmatic API surface.
tags: [architecture, design, modules, orchestration]
source:
  - bin/ytstats.js
  - src/index.js
  - src/cli.js
  - src/fetch-all.js
---

# Architecture

Contributor-facing notes on how `ytstats` is built and why. For the command surface see [cli.md](cli.md); for how to change it see [contributing.md](contributing.md).

## Shape

```
bin/ytstats.js          thin shim; last-resort guard against stdout pollution
  └─ src/cli.js         command definitions, validation ordering, error capture
       ├─ src/auth/     credentials, OAuth, token store, session
       ├─ src/api/      Data v3, Analytics v2, Reporting v1, pure transforms
       ├─ src/fetch-all.js   one-document orchestrator with per-step degradation
       ├─ src/output.js      the envelope; stdout/stderr discipline
       ├─ src/diagnostics.js the failure catalog
       ├─ src/errors.js      YtStatsError, Google error classification, redaction
       ├─ src/dates.js       reporting window resolution and validation
       └─ src/config/   per-user config dir, atomic 0600 store
```

`src/index.js` is a separate entry point — the library surface — and imports the same modules the CLI does.

## Design principles

**Everything I/O is injected.** API clients, the OAuth2 constructor, the loopback server, the browser opener, the identity lookup, the output sinks, and even `now()` are parameters with real defaults. This is why 341 tests run without a network connection and without opening a browser.

**Pure logic is separated from effects.** `api/transforms.js`, `dates.js`, `config/paths.js` and `diagnostics.js` are pure and directly tested. Everything awkward to test is pushed to the edges.

**No native dependencies.** `npx ytstats` must start instantly, which rules out anything requiring a prebuild download or a node-gyp compile. Runtime dependencies are `commander`, `googleapis`, and `open` — all pure JS. Think hard before adding a fourth.

**Read-only by design.** Only three read-only scopes are ever requested (`SCOPES` in `src/auth/oauth.js`). `ytstats` has no code path that modifies a channel.

**The consumer is assumed to be a program.** stdout carries exactly one JSON document on every code path; diagnostics are structured, coded, and carry runnable remediation. See [output-contract.md](output-contract.md).

## Module responsibilities

| Module | Responsibility |
|---|---|
| `config/paths.js` | Per-OS config dir. Pure — platform, env, and home are injected, so Windows and Linux behaviour is asserted from any machine. |
| `config/store.js` | Atomic `0600` JSON read/write, traversal-safe filenames. |
| `auth/credentials.js` | BYO credential resolution and validation. Rejects service accounts and malformed client IDs before they cost a browser round trip. |
| `auth/oauth.js` | PKCE pair, CSRF state, loopback callback server, auth URL builder, scope list. |
| `auth/tokens.js` | Multi-account token store keyed by channel; records which OAuth client issued each account's token; legacy import. |
| `auth/session.js` | Ties the above together: `login`, `logout`, `getAuthenticatedClient` with refresh persistence. |
| `api/client.js` | Builds the three API surfaces plus an authenticated CSV downloader; wraps calls in error mapping. |
| `api/transforms.js` | Pure shaping: duration parsing, content classification, CSV, date normalization, row zipping. |
| `api/data.js` | Data API v3 fetchers — channel, video ids, video resources. |
| `api/analytics.js` | Analytics API v2 fetchers, with the undocumented limits encoded as constants. |
| `api/reporting.js` | Reporting API v1 job lifecycle and reach download. |
| `fetch-all.js` | Orchestrates every dataset into one document, degrading per step. |
| `dates.js` | Reporting window resolution and validation. |
| `output.js` | The envelope and the stdout/stderr split. |
| `diagnostics.js` | The failure catalog and exit-code derivation. |
| `errors.js` | `YtStatsError`, Google error classification, secret redaction. |
| `cli.js` | Commander wiring, validation-before-auth ordering, Commander error capture. |

## Request flow

A data command travels the same path every time:

1. **`bin/ytstats.js`** calls `main(process.argv)`, with a final `catch` that guarantees no stack trace ever reaches stdout.
2. **`main()`** builds the program and calls `parseAsync`. Commander errors are thrown rather than exited (`exitOverride()`) and converted by `diagnoseCommanderError()`.
3. **The `run()` wrapper** executes the command's `validate` callback first, collecting *every* input problem into one envelope before any network call. See [validation ordering](gotchas/cli-output.md#input-is-validated-before-authentication).
4. **`withApis()`** calls `getAuthenticatedClient()` — which resolves credentials, loads the stored account, and registers a `tokens` listener so refreshed tokens are written back — then `createApis()` bundles the three API surfaces.
5. **The command body** calls one or more fetchers, passing the `apis` bundle as the first argument.
6. **`reporter.succeed()` / `reporter.fail()`** renders the single JSON envelope to stdout and returns the exit code.

Progress messages go to stderr throughout via `reporter.progress()` and are safe to discard.

## fetch-all orchestration

`fetchAll()` is the one place that runs every dataset in a single pass. Three properties matter:

**Channel identity is the only hard requirement.** It is fetched outside `step()`, and a missing channel throws `NO_YOUTUBE_CHANNEL` — everything downstream keys off `channel.uploadsPlaylistId`.

**Individual steps degrade rather than abort.** Each dataset runs inside `step(name, fn, fallback)`, which catches, records `{ step, code, message }` in `warnings`, and returns the fallback. YouTube rejects certain metric/dimension combinations for certain channels, and losing demographics should not cost you the other twelve datasets.

**Auth and quota failures are fatal anyway.** `FATAL_CODES` — `NOT_AUTHENTICATED`, `MISSING_CREDENTIALS`, `INVALID_CREDENTIALS`, `NO_YOUTUBE_CHANNEL`, `QUOTA_EXCEEDED` — rethrow instead of degrading, because continuing past them yields a document that is empty for reasons the caller cannot act on step by step.

Independent steps run concurrently in two `Promise.all` batches (daily + cards, then the eight analytics datasets). Traffic-source details are then fetched only for the source types the channel actually has, and retention runs sequentially because it costs one API call per video.

The return value is `{ period, warnings, notes, data }`. `notes` carries non-diagnostic information such as "retention fetched for 50 of 120 videos".

## Programmatic API

`src/index.js` re-exports the module surface so a Node caller can skip the process spawn and the JSON round-trip:

```js
import { getAuthenticatedClient, createApis, fetchAll, resolveDateRange } from 'ytstats';

const { client } = getAuthenticatedClient();
const result = await fetchAll(createApis(client), { range: resolveDateRange({ days: 90 }) });
```

The exported surface, grouped:

| Group | Exports |
|---|---|
| Session | `getAuthenticatedClient`, `login`, `logout`, `identifyLegacyTokens` |
| Credentials | `resolveCredentials`, `saveCredentials`, `clearCredentials`, `loadStoredCredentials`, `discoverClientSecretFile`, `parseClientSecret` |
| Accounts | `loadAccount`, `listAccounts`, `saveAccount`, `removeAccount`, `setDefaultAccount`, `clearAllAccounts`, `migrateLegacyTokens` |
| APIs | `createApis`, `data`, `analytics`, `reporting` (namespace exports), plus everything in `api/transforms.js` |
| Orchestration | `fetchAll` |
| Dates | `resolveDateRange`, `daysBetween`, `toIsoDate` |
| Output | `renderEnvelope`, `createReporter` |
| Errors | `YtStatsError`, `ERROR_CODES`, `EXIT_CODES`, `mapGoogleError`, `diagnoseGoogleError`, `fail`, `redact` |
| Diagnostics | `DIAGNOSTICS`, `diagnose`, `isDiagnostic`, `SEVERITY`, `EXIT` |
| CLI | `buildProgram`, `main`, `SCOPES`, `configDir` |

Library callers get no envelope: `fetchAll` returns its result object directly and fetchers throw `YtStatsError`. Use `renderEnvelope()` if you want the CLI's output shape.

## Two error vocabularies

`ytstats` carries two code sets, and the distinction matters when reading the source:

- **`DIAGNOSTICS` codes** (`src/diagnostics.js`) — the fine-grained public catalog surfaced in the envelope: `AUTH_TOKEN_EXPIRED`, `API_QUOTA_EXCEEDED`, `INPUT_INVALID_DATE`, and so on. This is what consumers branch on.
- **`ERROR_CODES`** (`src/errors.js`) — the coarser internal vocabulary carried on `YtStatsError.code`: `NOT_AUTHENTICATED`, `QUOTA_EXCEEDED`, `INVALID_INPUT`. Used for control flow such as `FATAL_CODES` in `fetch-all.js`.

`legacyCodeFor()` bridges the first onto the second when `mapGoogleError()` builds an error. Both are documented in [output-contract.md](output-contract.md).
