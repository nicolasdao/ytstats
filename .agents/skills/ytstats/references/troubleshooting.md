# Troubleshooting

Every anticipated failure carries its own `code`, so never guess from prose. Read `.errors[0].code`, check `recoverable` and `retryable`, and run `.nextSteps[0]`.

## The anti-loop contract

Two flags, two different questions:

- **`recoverable`** — can this be fixed at all? `AUTH_SERVICE_ACCOUNT` is `false`: no configuration will ever make a service account work with YouTube. Stop and tell the user.
- **`retryable`** — would re-running the *identical* command help? `API_RATE_LIMITED` is `true`. `AUTH_TIMEOUT` is `false` even though it sounds transient, because the usual cause is a browser-side rejection a retry cannot change.

Respect both and you never loop pointlessly. `recoverable: false` means stop. `retryable: false` means change something before trying again.

## Authentication — exit 2

| Code | What to do |
|---|---|
| `AUTH_NO_CREDENTIALS` | No OAuth client anywhere. The user must do the one-time Google Cloud setup — walk them through `remediation.steps`, which contains the full console walkthrough |
| `AUTH_NO_TOKENS` | Client exists, nobody signed in. Run `login` |
| `AUTH_TOKEN_EXPIRED` | Refresh token rejected. Usually the consent screen is still in **Testing**, where Google expires refresh tokens every 7 days. Re-login fixes it now, publishing the consent screen to Production fixes it permanently |
| `AUTH_TOKEN_REVOKED` | Access revoked in Google account settings or by a logout elsewhere. Re-login |
| `AUTH_ACCOUNT_UNKNOWN` | The `--account` selector matched nothing. `context.allowed` lists the valid channel ids. Never retry with a guess — show the user the list |
| `AUTH_CLIENT_MISMATCH` | This channel's token was issued by a different OAuth client than the one now resolving. See below |
| `AUTH_CONSENT_DECLINED` | Consent dismissed or a scope refused. **Retryable** — offer to run `login` again |
| `AUTH_TIMEOUT` | The callback never arrived. Usually Google showed "Access blocked" in the browser, which a retry cannot fix. Check the OAuth client, not the network |
| `AUTH_CLIENT_ID_INVALID` | Client ID does not end in `.apps.googleusercontent.com` |
| `AUTH_SERVICE_ACCOUNT` | **Not recoverable.** Service accounts own no YouTube channel and there is no workaround. The user needs an OAuth client ID, Desktop app type |
| `AUTH_NO_CHANNEL` | The Google account authorized successfully but owns no YouTube channel |
| `AUTH_STATE_MISMATCH` | CSRF check failed — stale browser tab or another process on the port. **Retryable** |

### AUTH_CLIENT_MISMATCH specifically

One config directory holds **one** OAuth client but many channels. Signing in a second channel with a different `client_secret` overwrites the stored client, and Google binds refresh tokens to the client that issued them.

`context.expected` is the client the channel was authorized with, `context.value` is the one resolving now. Two fixes:

- Give each client its own directory, which moves credentials and tokens together. POSIX shells use `export YTSTATS_CONFIG_DIR=~/.ytstats/<name>`, PowerShell uses `$env:YTSTATS_CONFIG_DIR = "$HOME\.ytstats\<name>"`
- Or re-run `login` to re-authorize this channel with the client that is now resolving

Do not "fix" this by re-running the same command. It is not retryable.

## Google APIs — exit 4

| Code | What to do |
|---|---|
| `API_NOT_ENABLED` | One of the three YouTube APIs is off in the Google Cloud project. `remediation.docs` links straight to the enable page. **Retryable** once enabled |
| `API_QUOTA_EXCEEDED` | Daily quota spent. Resets at midnight Pacific. Do not retry in a loop — tell the user when it resets |
| `API_RATE_LIMITED` | Transient, unlike a daily quota. **Retryable** after a short backoff |
| `API_QUERY_NOT_SUPPORTED` | YouTube rejected this metric or dimension combination. Which combinations work varies by channel. Not a bug — try a different query or use a purpose-built command |
| `API_FORBIDDEN` | Authenticated but not permitted to read this resource |
| `API_NOT_FOUND` | 404 for the requested id — check the video id |
| `API_UNAVAILABLE` | Google 5xx. Nothing wrong with the request. **Retryable** |
| `NETWORK_UNREACHABLE` | Failed before any response — DNS, TLS, proxy, or no connectivity. Check `HTTPS_PROXY` |

## Input — exit 3

`INPUT_INVALID_DATE`, `INPUT_INVALID_RANGE`, `INPUT_INVALID_CHOICE`, `INPUT_INVALID_VALUE`, `INPUT_MISSING_REQUIRED`, `INPUT_UNKNOWN_COMMAND`, `INPUT_UNKNOWN_OPTION`.

All are the caller's fault and all are fixable without touching the user's account. `context.allowed` carries the valid set where one exists. Input is validated **before** authentication and **every** problem is reported at once, so one correction pass fixes everything rather than discovering a second problem after fixing the first.

## Warnings — never fatal

`AUTH_CLIENT_ID_SUSPICIOUS`, `DATA_PARTIAL`, `DATA_EMPTY`, `REACH_PENDING` are warnings. They never make `ok` false and never change the exit code. Report them as context, not as failure.

## When you do not know what is wrong

```bash
ytstats doctor
```

Four independent checks — config writable, credentials present, signed in, API reachable — reported together rather than stopping at the first failure. It **always exits 0**; the verdict is `data.healthy` and the blocking diagnostics are in `data.blocking`. Treating a non-zero exit as the signal here is a mistake; there isn't one.

Use it whenever the failure is unclear, or before a long unattended run.

## UNEXPECTED usually means an outdated CLI

`UNEXPECTED` is `recoverable: false`, so it stops you — correctly, since it means the CLI hit a condition it could not classify. But before reporting it as a bug, check the version.

Versions before 0.2.1 leaked unclassified errors on two paths that are entirely ordinary:

| Situation | Pre-0.2.1 | 0.2.1 and newer |
|---|---|---|
| `import-legacy` with an expired refresh token | `UNEXPECTED` | `AUTH_TOKEN_EXPIRED`, run `login` |
| `import-legacy` with an unreadable path | `UNEXPECTED` | `INPUT_INVALID_VALUE` |
| `reach` hitting a transient Google 5xx | `UNEXPECTED` | `API_UNAVAILABLE`, retryable |

An expired token during a migration is the *expected* outcome — people migrate because the old setup went stale — so `UNEXPECTED` there is the CLI misreporting, not a genuine internal fault. On a current CLI, treat `UNEXPECTED` as it is documented: stop, and surface the diagnostic for reporting.

## Unknown codes

`code` values are public API and new ones are added freely without a major version bump. An unrecognized code is not an error in your handling — fall back to `recoverable`, `retryable`, and `nextSteps[0]`, which are present on every diagnostic.
