# Architecture

Contributor-facing notes: how `ytstats` is put together and why. For usage, see the
[README](../README.md). For YouTube's quirks, see [api-gotchas.md](api-gotchas.md).

## Table of Contents

- [Shape](#shape)
- [Design Principles](#design-principles)
- [Module Responsibilities](#module-responsibilities)
- [Authentication](#authentication)
- [The Output Contract](#the-output-contract)
- [Diagnostics](#diagnostics)
- [Testing Strategy](#testing-strategy)
- [Adding a New Dataset](#adding-a-new-dataset)

## Shape

```
bin/ytstats.js          thin shim
  └─ src/cli.js         command definitions, validation ordering, error capture
       ├─ src/auth/     credentials, OAuth, token store, session
       ├─ src/api/      Data v3, Analytics v2, Reporting v1, pure transforms
       ├─ src/fetch-all.js   one-document orchestrator with per-step degradation
       ├─ src/output.js      the envelope; stdout/stderr discipline
       ├─ src/diagnostics.js the failure catalog
       └─ src/config/   per-user config dir, atomic 0600 store
```

## Design Principles

**Everything I/O is injected.** API clients, the OAuth2 constructor, the loopback
server, the browser opener, the identity lookup, the output sinks, and even `now()`
are parameters with real defaults. This is why 316 tests run without a network
connection and without opening a browser.

**Pure logic is separated from effects.** `transforms.js`, `dates.js`,
`config/paths.js` and `diagnostics.js` are pure and directly tested. Everything
awkward to test is pushed to the edges.

**No native dependencies.** `npx ytstats` must start instantly. That rules out
anything requiring a prebuild download or a node-gyp compile. Runtime deps are
`commander`, `googleapis`, `open` — all pure JS. Think hard before adding a fourth.

**Read-only by design.** Only three read-only scopes are ever requested. `ytstats`
has no code path that modifies a channel.

## Module Responsibilities

| Module | Responsibility |
|---|---|
| `config/paths.js` | Per-OS config dir. Pure — platform/env/home injected, so Windows and Linux behaviour is asserted from any machine. |
| `config/store.js` | Atomic `0600` JSON read/write, traversal-safe filenames. |
| `auth/credentials.js` | BYO credential resolution and validation. Rejects service accounts and malformed client IDs before they cost a browser round trip. |
| `auth/oauth.js` | PKCE pair, CSRF state, loopback callback server, auth URL builder. |
| `auth/tokens.js` | Multi-account token store keyed by channel; legacy import. |
| `auth/session.js` | Ties the above together: `login`, `logout`, `getAuthenticatedClient` with refresh persistence. |
| `api/client.js` | Builds the three API surfaces plus an authenticated CSV downloader. |
| `api/transforms.js` | Pure shaping: duration parsing, content classification, CSV, date normalization. |
| `api/data.js` | Data API v3 fetchers. |
| `api/analytics.js` | Analytics API v2 fetchers, with the documented limits encoded as constants. |
| `api/reporting.js` | Reporting API v1 job lifecycle and reach download. |
| `fetch-all.js` | Orchestrates every dataset into one document, degrading per step. |
| `dates.js` | Reporting window resolution and validation. |
| `output.js` | The envelope and the stdout/stderr split. |
| `diagnostics.js` | The failure catalog. |
| `errors.js` | `YtStatsError`, Google error classification, secret redaction. |
| `cli.js` | Commander wiring, validation-before-auth ordering, Commander error capture. |

## Authentication

Bring-your-own-credentials: there is **no** built-in client ID. Resolution order is
`--client-secret` → `YTSTATS_CLIENT_ID`/`YTSTATS_CLIENT_SECRET` → stored
`credentials.json` → `client_secret*.json` in the working directory.

`login` runs the loopback flow Google recommends for desktop apps:

1. Generate a PKCE pair (S256) and an unguessable `state`.
2. Bind an HTTP server to `127.0.0.1` on an ephemeral port — never `0.0.0.0`.
3. Open the browser at Google with `access_type=offline&prompt=consent`.
4. Capture the callback, compare `state` in constant time, reject on mismatch.
5. Exchange the code with the PKCE verifier. The success page contains no token
   material and never echoes the authorization code.
6. Fetch the channel identity, *then* persist — so a failed lookup cannot leave a
   half-written account behind.

The client secret must be **stored, not discarded**: Google's token endpoint
requires it on every refresh, not just the initial exchange.

Storage is a per-user directory (`~/Library/Application Support/ytstats`,
`%APPDATA%\ytstats`, `$XDG_CONFIG_HOME/ytstats`), written atomically — temp file
created *at* `0600`, then renamed — so a crash never leaves a partial token file and
a secret is never briefly world-readable.

## The Output Contract

Two rules, both load-bearing:

1. **stdout is exactly one JSON document, always.** Every code path, including
   unknown commands and invalid flags. Commander's default behaviour — prose to
   stderr, `process.exit`, empty stdout — is overridden via `exitOverride()` and
   `configureOutput()` precisely because it violates this.
2. **stderr is everything a human reads** and is safe to discard entirely.

The envelope is shape-invariant: `ok`, `command`, `fetchedAt`, `data`, `errors`,
`warnings`, `nextSteps`, `meta` are present on every response. `data` is `null`
whenever `ok` is false — never partial, because a consumer that reads `data` without
checking `ok` would otherwise act on half a dataset.

## Diagnostics

The consumer is assumed to be an LLM in a retry loop, not a human at a terminal.
So every anticipated failure gets its own code and its own recovery path — a single
generic "not authenticated" would force the caller to guess between six unrelated
problems.

Each diagnostic answers four questions: what happened (`title`/`detail`), why
(`cause`), can it be fixed (`recoverable`/`retryable`), and what to run next
(`remediation.commands`).

`recoverable` and `retryable` are the anti-loop signals. `AUTH_SERVICE_ACCOUNT` is
`recoverable: false` because no amount of retrying will ever make it work;
`AUTH_TIMEOUT` is `retryable: false` because the usual cause is a browser-side
rejection that a plain retry cannot fix.

Two ordering rules matter:

- **Input is validated before authentication.** Checking auth first would hide a
  malformed date behind a login error, costing an agent an extra round trip.
- **Credentials are diagnosed before tokens.** Telling someone with no Google Cloud
  project to "run login" sends them down a path that cannot succeed.

`code` values are public API. Add freely; never repurpose or delete without a major
version bump.

## Testing Strategy

316 tests, none requiring network access.

- **Pure functions** tested directly.
- **Fetchers** take an injected API bundle, so tests assert the exact query
  parameters sent. This is how the `maxResults` limits are pinned rather than merely
  documented.
- **The session layer** injects `OAuth2`, the loopback server, the browser opener
  and identity lookup, so `login`/`logout` are covered without Google.
- **The loopback server** is tested for real over HTTP on `127.0.0.1`: state
  mismatch, user denial, timeout, favicon noise, and the guarantee that the success
  page never contains the authorization code.
- **The CLI** is tested end to end by spawning the actual binary and asserting exit
  codes and stdout parseability.

Note on coverage: `src/cli.js` reports 0% because its 23 end-to-end tests run it as
a **subprocess**, which v8 coverage cannot instrument from the parent process. It is
well covered; the number is a measurement artifact.

**Not covered:** no test performs a live call against Google. Request shapes are
asserted against the documented contract, not the live service.

## Adding a New Dataset

1. Add the fetcher to the relevant `src/api/*.js`, taking `apis` as its first
   argument so it stays injectable.
2. Add a test asserting the **exact query parameters**, not just the return shape —
   that is what protects the API limits.
3. Wire it into `fetch-all.js` behind `step()` so a failure degrades to a warning
   rather than aborting the run.
4. Add a dedicated command in `cli.js` if it is independently useful.
5. If it introduces a new failure mode, add a diagnostic to `diagnostics.js`. The
   catalog test will fail unless it has a title, detail, cause, and at least one
   remediation step.
6. Update the README command list and `CHANGELOG.md`.
