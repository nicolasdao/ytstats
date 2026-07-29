---
description: Credential and OAuth traps — service accounts, weekly token expiry, silent browser failures, and refresh-token preservation.
tags: [auth, oauth, credentials, tokens, gotchas]
source:
  - src/auth/**
---

# Authentication Gotchas

Traps in the bring-your-own-credentials OAuth model, and where `ytstats` defends against them.

Related: [auth.md](../auth.md) for the full flow, [config-storage.md](config-storage.md) for how the resulting tokens are written.

## Service accounts can never be used

A platform limitation with no workaround. A service account owns no YouTube channel and there is no way to link one, so Google rejects the flow with `NoLinkedYouTubeAccount`. Domain-wide delegation does not help — it is itself a service-account mechanism.

> "the YouTube Reporting API and YouTube Analytics API do not support this flow.
> Since there is no way to link a Service Account to a YouTube account, attempts to
> authorize requests with this flow will generate an error."
> — [Google's authorization guide](https://developers.google.com/youtube/reporting/guides/authorization)

The only service-account-based YouTube API is the Content ID API, which is partner-only and does not cover single-channel analytics.

**Where handled:** `parseClientSecret()` in `src/auth/credentials.js` detects `type: 'service_account'` and fails with `AUTH_SERVICE_ACCOUNT`, marked `recoverable: false` so an agent stops instead of retrying forever.

## An unused OAuth client is deleted after six months

Since 27 October 2025, Google automatically deletes OAuth clients that have been inactive for **six months**, with an email warning 30 days beforehand. Deleted clients are restorable for 30 days after that.

This is a sharper hazard for `ytstats` than for a typical app, because the usage pattern invites it: a personal analytics CLI you reach for occasionally can easily go six months untouched, and the warning email goes to the project contact address — often one nobody reads. The symptom is a client that simply stops existing, which surfaces as `AUTH_CLIENT_ID_INVALID` or a browser "Access blocked" rather than anything naming deletion.

There is no defence in code. The mitigation is knowing it exists: run `ytstats doctor` occasionally, and keep the Google Cloud project's contact email one you actually read.

**Where handled:** nowhere — this is a Google-side policy. Documented here so the failure is recognisable.

## The client secret is shown once and never again

Since June 2025 the client secret is visible and downloadable **only at the moment the OAuth client is created**. Afterwards the console displays just its last four characters.

So "re-download the client JSON" — which used to be the standard recovery for a corrupt or mislaid credential file — is no longer possible. The recovery is to add a *new* secret to the existing client, or create a new client, and download at that moment.

Any remediation text that tells a user to re-download an existing client's JSON is now wrong, and the setup walkthrough has to say "download it now" rather than "download the JSON" as though it could be fetched later.

**Where handled:** the `AUTH_CLIENT_ID_SUSPICIOUS` remediation steps and `SETUP_STEPS` in `src/diagnostics.js`.

## Testing-mode consent screens expire tokens weekly

While an OAuth consent screen is in **Testing** status, Google expires refresh tokens after **7 days**. The symptom is re-authenticating every week, surfacing as `invalid_grant`.

Publishing the consent screen to Production removes the expiry. Verification is not required for personal use — the user clicks past a one-time "unverified app" warning.

**Where handled:** `invalid_grant` maps to `AUTH_TOKEN_EXPIRED` in `diagnoseGoogleError()` (`src/errors.js`), whose `cause` names Testing mode as the likely root cause rather than saying "log in again".

## A bad client ID fails in the browser, not the API

An invalid or malformed client ID produces **no API error**. Google renders "Access blocked: Authorization Error" in the browser and never redirects, so the loopback listener waits until it times out. The resulting `AUTH_TIMEOUT` is misleading: retrying can never help.

**Where handled:** `validateClientId()` in `src/auth/credentials.js` runs before any browser opens, turning a five-minute hang into an instant `AUTH_CLIENT_ID_INVALID`. `AUTH_TIMEOUT` also names "Access blocked" as the leading cause and is marked `retryable: false`.

## A merely unusual client ID must not lock anyone out

`validateClientId()` has two tiers, deliberately. An ID that does not end in `.apps.googleusercontent.com` **throws** — it cannot possibly work. An ID with the right suffix but not the canonical `<project-number>-<hash>` shape only **returns a warning diagnostic** (`AUTH_CLIENT_ID_SUSPICIOUS`), because legacy clients occasionally deviate and a false positive here would block a working setup.

Do not tighten the regex into a hard failure without evidence that the deviant shape is genuinely unusable.

**Where handled:** `CANONICAL_CLIENT_ID` and the two-tier return in `src/auth/credentials.js`.

## Google omits refresh_token on refresh, so saving must merge

A refresh response contains a new `access_token` but **no** `refresh_token`. Writing the response over the stored tokens would therefore destroy the long-lived credential and force a re-login on the next run.

`saveAccount()` merges instead of replacing: `tokens: { ...(existing?.tokens ?? {}), ...tokens }`. The `tokens` event handler registered in `getAuthenticatedClient()` relies on this, since it fires with exactly those partial refresh payloads.

**Where handled:** `saveAccount()` in `src/auth/tokens.js`; the `client.on('tokens', …)` handler in `src/auth/session.js`.

## The client secret must be stored, not discarded after login

Google's token endpoint requires the client secret on **every** refresh, not just the initial code exchange. Treating it as single-use — a reasonable instinct for a secret — breaks every subsequent command.

**Where handled:** `login()` calls `saveCredentials()` alongside `saveAccount()` in `src/auth/session.js`, and `getAuthenticatedClient()` resolves credentials before loading tokens.

## Channel identity is fetched before anything is persisted

If the identity lookup were done after saving, a failed lookup would leave a half-written account with tokens but no channel id — and `saveAccount()` throws on a missing channel id, so the failure mode is a corrupt store rather than a clean error.

`login()` exchanges the code, fetches identity, and only then calls `saveCredentials()` + `saveAccount()`. Keep that ordering.

**Where handled:** `login()` in `src/auth/session.js`.

## Credentials are diagnosed before tokens

`getAuthenticatedClient()` resolves credentials *first*, then loads the account. The ordering is deliberate: telling someone who has not yet created a Google Cloud project to "run `ytstats login`" sends them down a path that cannot succeed. They need `AUTH_NO_CREDENTIALS`, not `AUTH_NO_TOKENS`.

**Where handled:** `getAuthenticatedClient()` in `src/auth/session.js`.

## An unknown --account never falls back to the default

`loadAccount(selector)` returns `null` for an unrecognised selector rather than quietly returning the default account. A silent fallback would answer a question about channel A with channel B's data — wrong numbers presented as correct ones.

The caller turns that `null` into `AUTH_ACCOUNT_UNKNOWN`, listing the channels that *are* signed in.

**Where handled:** `loadAccount()` in `src/auth/tokens.js`; the `AUTH_ACCOUNT_UNKNOWN` branch in `getAuthenticatedClient()`.

## One config directory holds one OAuth client, but many channels

`tokens.json` is keyed by channel and holds as many as you log into. `credentials.json` is a **single** record for the whole directory. The two structures disagree, and a second `ytstats login` with a different `client_secret` file silently overwrites the stored client while the first channel's tokens stay put.

Google binds a refresh token to the client that issued it, so the next command for that first channel refreshes with the wrong client and Google answers `invalid_grant`. That maps to `AUTH_TOKEN_EXPIRED`, whose cause names a Testing-mode consent screen — so the user publishes their consent screen, which changes nothing, and is now further from the answer than when they started. A misdiagnosis is more expensive than an error.

Only reachable with two Google Cloud projects; the ordinary case of several channels under one project is consistent. The fix for the multi-project case is a config directory per client, since `YTSTATS_CONFIG_DIR` moves credentials and tokens together.

**Where handled:** `saveAccount()` in `src/auth/tokens.js` records `clientId` at login; the comparison in `getAuthenticatedClient()` (`src/auth/session.js`) throws `AUTH_CLIENT_MISMATCH` before the refresh can happen.

## An absent client binding is unknown, not a mismatch

The mismatch check runs only when `account.clientId` is set. Accounts written before that field existed have none, and treating absent as "does not match" would reject every pre-existing account on upgrade — logging out every user to protect against a problem most of them do not have.

The same reasoning applies to the refresh write-back path: `client.on('tokens', …)` calls `saveAccount()` with a partial payload and no `clientId`, so `saveAccount()` falls back to the existing value rather than nulling it. Dropping it there would disarm the check after the first refresh, which is precisely when it is still needed.

**Where handled:** the `account.clientId &&` guard in `getAuthenticatedClient()`; the `clientId ?? existing?.clientId ?? null` fallback in `saveAccount()`.

## The account selector is checked before the client binding

`getAuthenticatedClient()` resolves credentials, then the account, then the binding. An unknown `--account` is the more specific complaint, and reporting a client mismatch for a channel that is not signed in at all would misdirect exactly the way the ordering elsewhere in this file exists to prevent.

**Where handled:** the order of the `loadAccount()` / `AUTH_ACCOUNT_UNKNOWN` block and the `AUTH_CLIENT_MISMATCH` block in `src/auth/session.js`.

## An expired legacy token is the expected outcome of a migration

`import-legacy` exchanges the old tokens for a channel identity before storing anything. That call must be wrapped in `mapGoogleError`, and originally was not — it was the one Google call in the codebase that escaped the mapping, because it built its own `googleapis` client inline instead of going through `createApis()`.

The consequence was backwards. A stale refresh token is not an edge case during a migration; it is the *reason* people migrate. But the raw error reached `run()`'s catch unrecognised and surfaced as `UNEXPECTED` — "a bug worth reporting", `recoverable: false`, exit 1 — telling the user to file an issue against a tool that was working correctly. Worse, `recoverable: false` is the signal that stops an agent entirely, so an automated caller halted where it should have run `ytstats login`.

It now maps to `AUTH_TOKEN_EXPIRED`, `recoverable: true`, exit 2, with `ytstats login` as `nextSteps[0]`. The same applies to an unreadable token file, which is now `INPUT_INVALID_VALUE` rather than `UNEXPECTED` — a mistyped path is equally ordinary.

The general rule this encodes: **any call that can fail with a Google error must go through `mapGoogleError`.** A bare `await` on a googleapis promise anywhere in the codebase is a latent `UNEXPECTED`.

**Where handled:** `identifyLegacyTokens()` in `src/auth/session.js`, called by the `import-legacy` action in `src/cli.js`.

## The loopback server binds 127.0.0.1, never 0.0.0.0

Binding `0.0.0.0` would expose the callback listener — and therefore the authorization code — to anything on the local network. The server binds `127.0.0.1` on an ephemeral port (`server.listen(0, '127.0.0.1')`).

The state comparison is constant-time (`crypto.timingSafeEqual`) so the value cannot be probed byte by byte, and the success page deliberately contains no code or token material. A test asserts the success page never contains the authorization code.

**Where handled:** `startLoopbackServer()` in `src/auth/oauth.js`.

## The favicon request is not the callback

Browsers request `/favicon.ico` unprompted when the callback page loads. Treating any request as the callback would settle the promise on the wrong one.

The handler 404s `/favicon.ico` and anything that is not `/` or `/callback` before inspecting query parameters. A test covers this.

**Where handled:** the pathname guards in `startLoopbackServer()`, `src/auth/oauth.js`.

## --no-browser uses a deliberately dead redirect URI

The paste flow sets `redirectUri` to `http://127.0.0.1:1` and starts **no** listener. Port 1 is chosen so the browser's redirect fails immediately and visibly, leaving the URL — including `?code=…` — in the address bar for the user to copy.

The same `redirect_uri` must then be sent to the token exchange, since Google validates that it matches the one used in the authorization request.

**Where handled:** `pasteFlow()` in `src/auth/session.js`.

## Logout removes local tokens even when revocation fails

Revoking with Google is best-effort: it is wrapped in `try`/`catch` and the loop continues. If the machine is offline or the token is already invalid, revocation fails but the local removal still happens — otherwise `logout` would leave credentials on disk while reporting an error, which is the worst of both outcomes.

Resolving credentials for the revocation call is likewise optional; without them `ytstats` cannot revoke, but it can still forget.

**Where handled:** `logout()` in `src/auth/session.js`.

## A read-only config dir must not break a working command

The `tokens` event handler that persists refreshed tokens swallows its errors. If the config directory has become unwritable, the in-memory client still holds a valid access token and the command can complete — failing the whole run over a cache write would be a worse outcome than losing the refreshed token.

**Where handled:** the empty `catch` in the `client.on('tokens', …)` handler, `src/auth/session.js`.
