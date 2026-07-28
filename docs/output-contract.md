---
description: The JSON envelope, the diagnostic schema, the full failure-code catalog, and exit-code derivation.
tags: [output, envelope, diagnostics, error-codes, agents]
source:
  - src/output.js
  - src/diagnostics.js
  - src/errors.js
---

# Output Contract

`ytstats` is designed for a program — often an LLM in a retry loop — rather than a human at a terminal. Everything here follows from that. For why the implementation looks the way it does, see [gotchas/cli-output.md](gotchas/cli-output.md).

## The two rules

**1. stdout is exactly one JSON document, always.** Every code path: success, failure, bad flag, unknown command, crash. There is no path that writes nothing.

**2. stderr is everything a human reads**, and is safe to discard entirely.

```bash
ytstats fetch --days 30 2>/dev/null | jq '.data.channel.subscriberCount'
```

Commander's default behaviour violates rule 1 — it prints prose to stderr and calls `process.exit`, leaving stdout empty. `exitOverride()` and `configureOutput()` exist precisely to prevent that.

## The envelope

Shape-invariant: **every key is present on every response**, so a consumer never branches on whether a field exists.

```jsonc
{
  "ok": true,
  "command": "channel",
  "fetchedAt": "2026-07-27T10:00:00.000Z",
  "data": { },            // null whenever ok is false — never partial
  "errors": [],           // non-empty iff ok is false
  "warnings": [],         // non-fatal; never affects ok or the exit code
  "nextSteps": [],        // ordered, deduplicated, ready-to-run commands
  "meta": {
    "version": "0.1.0",
    "exitCode": 0,
    "helpCommand": "ytstats --help",
    "docs": "https://www.npmjs.com/package/ytstats"
  }
}
```

| Field | Type | Contract |
|---|---|---|
| `ok` | boolean | True iff `errors` is empty |
| `command` | string \| null | The command that ran; best-effort from argv when parsing failed early |
| `fetchedAt` | ISO 8601 string | When the envelope was rendered |
| `data` | object \| array \| null | The payload. **`null` whenever `ok` is false** — never partial |
| `errors` | array | Error-severity diagnostics. Non-empty exactly when `ok` is false |
| `warnings` | array | Warning-severity diagnostics. Never affect `ok` or the exit code |
| `nextSteps` | string[] | Flattened remediation, errors before warnings, deduplicated |
| `meta.version` | string | The `ytstats` version, read from `package.json` |
| `meta.exitCode` | number | The process exit code, duplicated for stdout-only consumers |
| `meta.helpCommand` | string | Always `ytstats --help` |
| `meta.docs` | string | Package documentation URL |

`data` being `null` on failure is load-bearing: a consumer that reads `data` without checking `ok` would otherwise act on half a dataset and never know.

`--compact` emits the same document on a single line.

## Diagnostics

Each entry in `errors` and `warnings` answers four questions — what happened, why, can it be fixed, and what to run next:

```jsonc
{
  "code": "AUTH_TOKEN_EXPIRED",        // stable API — branch on this, never on prose
  "severity": "error",                 // "error" | "warning"
  "title": "Stored refresh token is no longer valid",
  "detail": "Google rejected the stored refresh token (invalid_grant)…",
  "cause": "Most commonly the OAuth consent screen is still in Testing mode…",
  "recoverable": true,                 // can this be fixed and retried at all?
  "retryable": false,                  // would re-running the SAME command help?
  "remediation": {
    "summary": "Sign in again, then publish your consent screen to Production.",
    "steps": ["Run: ytstats login", "…"],
    "commands": [{ "run": "ytstats login", "description": "Re-authorize this machine" }],
    "docs": ["https://console.cloud.google.com/apis/credentials/consent"]
  },
  "context": { "flag": "--start", "value": "01/01/2026", "expected": "YYYY-MM-DD" }
}
```

### recoverable vs retryable

These are the anti-loop signals, and they are not the same question:

- **`recoverable`** — can this be fixed at all? `AUTH_SERVICE_ACCOUNT` is `recoverable: false`: no configuration will ever make a service account work with YouTube APIs.
- **`retryable`** — would re-running the *identical* command help? `AUTH_TIMEOUT` is `retryable: false` because the usual cause is a browser-side rejection that a retry cannot change. `API_RATE_LIMITED` is `retryable: true`.

An agent that respects both never loops pointlessly.

### context

Whatever the call site supplied: `flag`, `value`, `expected`, `allowed`, `step`, `account`, `detail`. `diagnose()` also folds these into the `detail` prose (`Option: --start. Received: "01/01/2026". Expected: YYYY-MM-DD.`) so a consumer reading only `detail` still learns what was wrong. Stack-like lines are stripped — diagnostics are prose, never traces.

### nextSteps

Every diagnostic's `remediation.commands` flattened into one ordered, deduplicated list of `"<command>  # <description>"` strings, errors before warnings. A diagnostic with no commands contributes its `remediation.summary` instead.

```bash
ytstats fetch 2>/dev/null | jq -r 'if .ok then "fine" else .nextSteps[0] end'
```

## Diagnostic catalog

`code` values are **public API**. New ones may be added freely; existing ones are never repurposed or deleted without a major version bump.

### Authentication — exit 2

| Code | Recoverable | Retryable | Meaning |
|---|---|---|---|
| `AUTH_NO_CREDENTIALS` | yes | no | No OAuth client found in any of the four sources |
| `AUTH_NO_TOKENS` | yes | no | Client exists, but no channel has been authorized here |
| `AUTH_TOKEN_EXPIRED` | yes | no | Refresh token rejected (`invalid_grant`) — usually the 7-day Testing trap |
| `AUTH_TOKEN_REVOKED` | yes | no | Access explicitly revoked, by logout elsewhere or in Google account settings |
| `AUTH_ACCOUNT_UNKNOWN` | yes | no | `--account` matched no signed-in channel |
| `AUTH_CONSENT_DECLINED` | yes | **yes** | Google returned `access_denied` — consent dismissed or a scope refused |
| `AUTH_TIMEOUT` | yes | no | Callback never arrived; usually "Access blocked" in the browser |
| `AUTH_CLIENT_ID_INVALID` | yes | no | Client ID does not end in `.apps.googleusercontent.com` |
| `AUTH_STATE_MISMATCH` | yes | **yes** | OAuth state check failed — stale tab or another process on the port |
| `AUTH_SERVICE_ACCOUNT` | **no** | no | Service account key supplied. No workaround exists |
| `AUTH_NO_CHANNEL` | yes | no | Authorization succeeded but the account owns no YouTube channel |
| `AUTH_CREDENTIALS_MALFORMED` | yes | no | File is not the JSON Google produces for an OAuth client |
| `AUTH_CREDENTIALS_NOT_FOUND` | yes | no | `--client-secret` path could not be opened |

### Google APIs — exit 4

| Code | Recoverable | Retryable | Meaning |
|---|---|---|---|
| `API_NOT_ENABLED` | yes | yes | One of the three YouTube APIs is not enabled in the project |
| `API_QUOTA_EXCEEDED` | yes | yes | Daily quota spent; resets at midnight Pacific |
| `API_RATE_LIMITED` | yes | yes | Transient rate limit, unlike a daily quota exhaustion |
| `API_QUERY_NOT_SUPPORTED` | yes | no | YouTube rejected this metric/dimension combination |
| `API_FORBIDDEN` | yes | no | Authenticated but not permitted to read this resource |
| `API_NOT_FOUND` | yes | no | 404 for the requested id |
| `API_UNAVAILABLE` | yes | yes | Google 5xx; nothing wrong with the request |
| `NETWORK_UNREACHABLE` | yes | yes | Request failed before a response — DNS, TLS, proxy, or no connectivity |

### Input — exit 3

| Code | Recoverable | Retryable | Meaning |
|---|---|---|---|
| `INPUT_UNKNOWN_COMMAND` | yes | no | No such command; `context.allowed` lists the valid set |
| `INPUT_UNKNOWN_OPTION` | yes | no | Flag not recognised by this command |
| `INPUT_MISSING_REQUIRED` | yes | no | A mandatory option was not supplied |
| `INPUT_INVALID_CHOICE` | yes | no | Value outside the enumerated set; see `context.allowed` |
| `INPUT_INVALID_DATE` | yes | no | Not `YYYY-MM-DD`, or not a real calendar date |
| `INPUT_INVALID_RANGE` | yes | no | Inverted range, or a non-positive `--days` |
| `INPUT_INVALID_VALUE` | yes | no | Value could not be interpreted for this flag |

### Data and config

| Code | Severity | Exit | Meaning |
|---|---|---|---|
| `AUTH_CLIENT_ID_SUSPICIOUS` | warning | 0 | Client ID has the right suffix but an unusual shape; proceeding |
| `DATA_PARTIAL` | warning | 0 | Some datasets failed while others succeeded — empty means "not fetched", not "zero" |
| `DATA_EMPTY` | warning | 0 | Query succeeded and returned zero rows — genuinely no data |
| `REACH_PENDING` | warning | 0 | Reporting job created; YouTube has not generated reports yet |
| `CONFIG_UNWRITABLE` | error | 1 | Config directory not writable, so authentication cannot persist |
| `UNEXPECTED` | error | 1 | Unrecognised condition. A bug worth reporting |

## Exit codes

| Code | Class |
|---|---|
| `0` | Success |
| `1` | General or unexpected |
| `2` | Authentication |
| `3` | Bad input |
| `4` | API error |

`exitCodeFor()` returns the **worst** exit code across all error-severity diagnostics, and `EXIT.OK` when there are none — which is why warnings never change it. The result is duplicated at `meta.exitCode`.

`EXIT` in `src/diagnostics.js` also defines `PARTIAL: 5`, which no diagnostic currently uses; partial results are reported as warnings on a successful run instead.

## Two code vocabularies

Reading the source, you will meet two sets of codes:

- **`DIAGNOSTICS` codes** (`src/diagnostics.js`) — the fine-grained catalog above. This is the public contract, surfaced in the envelope.
- **`ERROR_CODES`** (`src/errors.js`) — a coarser internal vocabulary on `YtStatsError.code`: `MISSING_CREDENTIALS`, `INVALID_CREDENTIALS`, `NOT_AUTHENTICATED`, `AUTH_FAILED`, `AUTH_TIMEOUT`, `ACCESS_DENIED`, `API_NOT_ENABLED`, `NO_YOUTUBE_CHANNEL`, `QUOTA_EXCEEDED`, `QUERY_NOT_SUPPORTED`, `NOT_FOUND`, `INVALID_INPUT`, `API_ERROR`, `UNKNOWN`. Used for internal control flow, such as `FATAL_CODES` in `fetch-all.js`.

`legacyCodeFor()` maps the first onto the second when `mapGoogleError()` constructs an error. Consumers should read the envelope's `code`, which is always the `DIAGNOSTICS` vocabulary.

## Error classification

`diagnoseGoogleError()` turns a Google API failure into a precise diagnostic by checking, **in this order**: network-level error codes, then reason strings (`accessNotConfigured`, `NoLinkedYouTubeAccount`, `quotaExceeded`, `rateLimitExceeded`), then message fingerprints (`query is not supported`, `invalid_grant`, revocation phrasing), and only then generic HTTP statuses.

The order matters: a bare 403 can mean four unrelated things, so reordering silently degrades precise diagnostics into `API_FORBIDDEN`.

## Redaction

`redact()` strips anything resembling a secret from text bound for stdout or stderr:

- Google client secrets (`GOCSPX-…`)
- Access tokens (`ya29.…`), refresh tokens (`1//…`), authorization codes (`4/…`)
- JSON fields named `client_secret`, `clientSecret`, `refresh_token`, `access_token`, `code_verifier`, `codeVerifier`, `authorization_code`
- Query parameters `code`, `code_verifier`, `client_secret`

It runs on the **serialized** JSON, after `JSON.stringify`, so a secret embedded in prose is caught too. It deliberately does *not* match a bare `"code"` field, because every diagnostic carries `"code": "AUTH_NO_TOKENS"` — public API that must survive redaction.

Redaction is belt-and-braces: these values are never deliberately logged in the first place.

## Failures are differentiated

There is no single "not authenticated" bucket. A generic error would force the caller to guess between six unrelated problems, each with a different fix. The design assumption is an agent that reads `code`, checks `recoverable`/`retryable`, and runs `nextSteps[0]` — so every anticipated failure earns its own code and its own recovery path.

Input problems are additionally reported **all at once, before authentication**, so one loop iteration fixes everything rather than discovering a bad date only after fixing auth.
