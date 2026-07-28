---
description: The bring-your-own-credentials OAuth model — credential resolution, the PKCE loopback flow, token storage, and multi-account handling.
tags: [auth, oauth, pkce, credentials, tokens, security]
source:
  - src/auth/**
---

# Authentication

`ytstats` has **no built-in Google client ID**. Each user supplies their own Google Cloud OAuth client, and the CLI uses it. This document covers how that works internally; for the traps, see [gotchas/auth.md](gotchas/auth.md).

## Why bring your own credentials

Three consequences follow from having no shared client:

- **Quota is per-project.** The YouTube Data API grants every Google Cloud project 10,000 units/day. A shared client ID would make every user compete for one pool.
- **No verification bottleneck.** Apps requesting YouTube scopes need Google's OAuth verification to serve strangers. You are not a stranger to yourself, so the unverified-app warning is a one-time click rather than a blocker.
- **Nothing to trust.** There is no backend to send data to, because there is no backend.

The cost is roughly five minutes of one-time Google Cloud setup, walked through in the [README](../README.md#getting-started) and reproduced in the `SETUP_GUIDE` constant (`src/errors.js`) that ships inside diagnostics.

## Scopes

Three, all read-only, frozen in `src/auth/oauth.js`:

```js
export const SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
]);
```

There is no code path that writes to a channel.

## Credential resolution

`resolveCredentials()` returns `{ clientId, clientSecret, source }`, checking four sources in order and taking the first that yields a complete pair:

| Order | Source | `source` value |
|---|---|---|
| 1 | `--client-secret <file>` | the path given |
| 2 | `YTSTATS_CLIENT_ID` **and** `YTSTATS_CLIENT_SECRET` (both required) | `environment` |
| 3 | `credentials.json` saved by a previous `ytstats login` | `stored` |
| 4 | `client_secret*.json` auto-discovered in the working directory | the discovered path |

If none match, it throws `AUTH_NO_CREDENTIALS` with a `detail` naming everything it searched.

`source` is for display only and never contains the secret — it is what `ytstats status` reports as `credentialSource` and what `login` prints to stderr.

### File shapes accepted

`parseClientSecret()` normalises the shapes Google hands out. It reads `raw.installed` (Desktop app), `raw.web`, or an already-flat object, and accepts both `client_id`/`client_secret` and `clientId`/`clientSecret` casings.

It rejects two things outright:

- `type: 'service_account'` → `AUTH_SERVICE_ACCOUNT`, marked `recoverable: false`. Service accounts can never work with YouTube APIs; see [the gotcha](gotchas/auth.md#service-accounts-can-never-be-used).
- A missing `client_id` or `client_secret` → `AUTH_CREDENTIALS_MALFORMED`.

### Auto-discovery

`discoverClientSecretFile(dir)` scans a directory for files starting with `client_secret` and ending in `.json` — the shape of Google's downloads, `client_secret_<numbers>-<hash>.apps.googleusercontent.com.json`. An exact `client_secret.json` wins; otherwise candidates are sorted for determinism so the same directory always yields the same file.

### Client ID pre-flight validation

`validateClientId()` runs before a browser is ever opened, because Google does not reject a bad client ID through the API — it renders "Access blocked" in the browser and never redirects, so the CLI would hang until its timeout.

Two tiers:

- Does not end in `.apps.googleusercontent.com` → **throws** `AUTH_CLIENT_ID_INVALID`.
- Right suffix, but not the canonical `<project-number>-<hash>` shape → **returns a warning diagnostic**, `AUTH_CLIENT_ID_SUSPICIOUS`, and the flow proceeds. Legacy clients occasionally deviate, and being wrong here must not lock anyone out.

`login` surfaces the warning in the envelope as well as on stderr, since it is the leading cause of a subsequent timeout.

## The login flow

`login()` in `src/auth/session.js` runs the loopback flow Google recommends for desktop apps:

1. **Resolve and validate credentials** — as above, before anything else happens.
2. **Generate a PKCE pair (S256) and an unguessable `state`.** The verifier is 64 random bytes base64url-encoded (86 characters, within RFC 7636's 43-128 range — the `slice(0, 128)` is a ceiling that never triggers at this size); the challenge is its base64url SHA-256 digest, 43 characters. The state is 24 random bytes, 32 characters. PKCE protects the authorization code against interception by another local process racing on the loopback port.
3. **Bind an HTTP server to `127.0.0.1` on an ephemeral port** — `server.listen(0, '127.0.0.1')`, never `0.0.0.0`.
4. **Open the browser** at Google's authorization endpoint with `access_type=offline&prompt=consent` (what makes Google return a refresh token) and `include_granted_scopes=true`.
5. **Capture the callback.** The handler 404s `/favicon.ico` and any path other than `/` or `/callback`, then compares the returned `state` in constant time via `crypto.timingSafeEqual`. A mismatch, a Google `error` parameter, or a missing code each rejects with its own diagnostic.
6. **Exchange the code** with the PKCE verifier and the same `redirect_uri` used in the authorization request.
7. **Fetch the channel identity** via `channels.list({ part: 'snippet,contentDetails', mine: true })` — *before* persisting, so a failed lookup cannot leave a half-written account behind.
8. **Persist** the credentials and the account.

The success page served to the browser contains no token material and never echoes the authorization code. A test asserts this.

### Timeout

The loopback server takes a `timeoutMs` (default 300 seconds, set via `login --timeout`). On expiry it rejects with `AUTH_TIMEOUT`, which is marked `retryable: false` — the usual cause is Google refusing the request in the browser and never redirecting at all, which a plain retry cannot fix.

### The --no-browser flow

`pasteFlow()` starts **no** listener. It sets `redirectUri` to `http://127.0.0.1:1` so the browser's redirect fails immediately and visibly, leaving the full URL — including `?code=…` — in the address bar. The user pastes it back, and `extractCode()` pulls the `code` parameter out (or accepts a bare code if that is what was pasted).

The same dead `redirect_uri` must be sent to the token exchange, because Google validates that it matches the authorization request.

## Token storage

Tokens live in `tokens.json` inside the per-user config directory (see [configuration.md](configuration.md)):

```jsonc
{
  "version": 1,
  "default": "UC...",
  "accounts": {
    "UC...": {
      "channelId": "UC...",
      "channelTitle": "…",
      "customUrl": "@…",
      "tokens": { "access_token": "…", "refresh_token": "…", "expiry_date": 0 },
      "savedAt": "2026-07-27T10:00:00.000Z"
    }
  }
}
```

Keyed by channel, so one machine can hold several. The first account logged in wins `default`; `ytstats use` changes it.

**Saving merges rather than replaces.** A refresh response from Google contains a new `access_token` but no `refresh_token`, so `saveAccount()` spreads the existing tokens under the new ones. Overwriting would destroy the long-lived credential.

### Refresh persistence

`getAuthenticatedClient()` registers a `tokens` listener on the OAuth2 client:

```js
client.on('tokens', tokens => {
  try { saveAccount({ …account, tokens }); } catch { /* read-only dir must not break the command */ }
});
```

Any token the googleapis client rotates during the process lifetime is written back to disk. The error is swallowed deliberately: if the config directory has become unwritable, the in-memory access token is still valid and the command can complete.

The client secret is required on every refresh, not only the initial exchange — which is why `saveCredentials()` runs at login and `getAuthenticatedClient()` resolves credentials before loading tokens.

### Account selection

`loadAccount(selector)` resolves in this order:

1. No selector → the `default` account, or `null` if none.
2. Exact match on the `accounts` key (the channel id).
3. Case-insensitive match against `customUrl` or `channelTitle`.

An unrecognised selector returns `null` — never a silent fallback to the default, which would answer a question about one channel with another channel's data. The caller turns that into `AUTH_ACCOUNT_UNKNOWN`, listing the channels that are available.

`listAccounts()` returns summaries without token material, safe to print.

## Failure diagnosis order

`getAuthenticatedClient()` resolves credentials **before** loading tokens. There is no single "not authenticated" bucket, because each cause needs a different fix:

| Situation | Diagnostic |
|---|---|
| No OAuth client anywhere | `AUTH_NO_CREDENTIALS` |
| Client exists, never logged in | `AUTH_NO_TOKENS` |
| `--account` names an unknown channel | `AUTH_ACCOUNT_UNKNOWN` |
| Refresh token rejected (`invalid_grant`) | `AUTH_TOKEN_EXPIRED` |
| Access explicitly revoked | `AUTH_TOKEN_REVOKED` |
| Consent screen dismissed | `AUTH_CONSENT_DECLINED` |
| Callback never arrived | `AUTH_TIMEOUT` |
| State check failed | `AUTH_STATE_MISMATCH` |
| Service account key supplied | `AUTH_SERVICE_ACCOUNT` |
| Client ID malformed | `AUTH_CLIENT_ID_INVALID` |
| Google account owns no channel | `AUTH_NO_CHANNEL` |

Telling someone who has not yet created a Google Cloud project to "run login" sends them down a path that cannot succeed — hence the ordering. Full catalog in [output-contract.md](output-contract.md#diagnostic-catalog).

## Logout

`logout()` revokes with Google and forgets locally:

1. Collect the target accounts — all of them with `--all`, otherwise the selected or default one.
2. Resolve credentials if possible. Without them revocation is impossible, but local removal still proceeds.
3. For each account, call `client.revokeToken()` on the refresh token (falling back to the access token), wrapped in `try`/`catch`.
4. Remove the account locally regardless of whether revocation succeeded.
5. With `--forget-credentials`, delete `credentials.json` too.

Returns `{ loggedOut, revoked, accounts }`. `revoked` is false when the machine was offline or the token was already invalid — the local state is still clean.

## Legacy import

`migrateLegacyTokens()` performs a one-time import of a pre-`ytstats` per-project token file. It never overwrites an existing account, returning `{ migrated: false, reason }` for `no-legacy-file`, `no-refresh-token`, `unknown-channel`, or `already-logged-in`.

Because the legacy file carries no channel identity, `import-legacy` in `src/cli.js` exchanges the tokens for one via `channels.list` before calling it.
