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
