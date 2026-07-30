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
| `AUTH_SCOPE_MISSING` | Signed in without caption access, and `transcript` needs it. Run `ytstats login --with-captions` — see below. **Not retryable**: the same command cannot help until the user re-authorizes |
| `AUTH_CONSENT_DECLINED` | Consent dismissed or a scope refused. **Retryable** — offer to run `login` again |
| `AUTH_TIMEOUT` | The callback never arrived. Usually Google showed "Access blocked" in the browser, which a retry cannot fix. Check the OAuth client, not the network |
| `AUTH_CLIENT_ID_INVALID` | Client ID does not end in `.apps.googleusercontent.com`. Also consider the client being **gone** — see below |
| `AUTH_SERVICE_ACCOUNT` | **Not recoverable.** Service accounts own no YouTube channel and there is no workaround. The user needs an OAuth client ID, Desktop app type |
| `AUTH_CREDENTIALS_NOT_FOUND` | The supplied credential path could not be opened. `context.flag` names which source — `--client-secret` or `YTSTATS_CREDENTIALS_FILE` — so say which one is wrong rather than guessing |
| `AUTH_CREDENTIALS_MALFORMED` | The file opened but is not the JSON Google produces for an OAuth client. Usually the wrong file entirely, or a truncated download |
| `AUTH_NO_CHANNEL` | The Google account authorized successfully but owns no YouTube channel |
| `AUTH_STATE_MISMATCH` | CSRF check failed — stale browser tab or another process on the port. **Retryable** |

### AUTH_SCOPE_MISSING specifically

Only `transcript` raises this. The fix is one command:

```bash
ytstats login --with-captions
```

Three things to tell the user, because the consent screen is alarming if unexplained:

1. **It re-opens the browser.** This is a real sign-in, not a background step.
2. **Google will say "Manage your YouTube account".** That wording is unavoidable — `youtube.force-ssl` is the *only* scope that can read captions, and Google offers no read-only variant. `ytstats` never writes to a channel.
3. **Nothing already granted is lost.** Permissions are added incrementally, not replaced.

Ask before running it. It is not destructive like `logout`, but it takes over the user's browser and asks them to approve a permission that sounds broader than it is — so they should be expecting it.

**Never infer this from a `null`.** `ytstats status` reports `scopes` per account, and `null` means the grant was never recorded (an older sign-in), not that permission is absent. The CLI itself only raises `AUTH_SCOPE_MISSING` when the recorded list is present and genuinely lacks the scope; for a `null` it attempts the call. Do not tell a user to re-authorize on the strength of a `null` — let the command decide.

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
| `API_QUERY_NOT_SUPPORTED` | YouTube rejected this metric or dimension combination. Which combinations work varies by channel. Not a bug — try a different query or use a purpose-built command. Also what a refused `--segment` looks like: `video-analytics --segment` and `traffic --segment youtubeProduct` are commonly refused. **Not retryable** — drop the segment rather than re-running |
| `API_FORBIDDEN` | Authenticated but not permitted to read this resource |
| `API_NOT_FOUND` | 404 for the requested id — check the video id |
| `API_UNAVAILABLE` | Google 5xx. Nothing wrong with the request. **Retryable** |
| `NETWORK_UNREACHABLE` | Failed before any response — DNS, TLS, proxy, or no connectivity. Check `HTTPS_PROXY` |

## Input — exit 3

`INPUT_INVALID_DATE`, `INPUT_INVALID_RANGE`, `INPUT_INVALID_CHOICE`, `INPUT_INVALID_VALUE`, `INPUT_MISSING_REQUIRED`, `INPUT_UNKNOWN_COMMAND`, `INPUT_UNKNOWN_OPTION`.

All are the caller's fault and all are fixable without touching the user's account. `context.allowed` carries the valid set where one exists. Input is validated **before** authentication and **every** problem is reported at once, so one correction pass fixes everything rather than discovering a second problem after fixing the first.

`INPUT_INVALID_CHOICE` on `--segment` has two distinct causes worth telling apart: an unrecognised dimension, where `context.allowed` lists the accepted set, and `search-terms`, which cannot be segmented at all — there `context.allowed` is empty and `detail` explains that the underlying dimension tolerates only the `views` metric. Neither is worth retrying.

## A setup that worked before and now does not

Two Google policies delete or hide things behind the user's back, and both present as a setup that mysteriously stopped working rather than as anything naming the cause:

- **OAuth clients unused for six months are deleted automatically** (policy from October 2025), with a warning email 30 days ahead to the project contact address — often one nobody reads. A personal analytics CLI is exactly the usage pattern that goes six months untouched. The symptom is `AUTH_CLIENT_ID_INVALID`, or a browser "Access blocked" that ends in `AUTH_TIMEOUT`. Deleted clients are restorable for 30 days.
- **The client secret cannot be re-downloaded.** Since June 2025 it is shown only when the client is created; afterwards the console displays just its last four characters. Never tell a user to re-download an existing client's JSON — it is not possible. They add a new secret to the client, or create a new client, and download at that moment.

When a previously working setup fails at the credential layer, raise the six-month deletion explicitly. The user will otherwise assume they broke something.

## Config — exit 1

`CONFIG_UNWRITABLE` means the per-user config directory exists but cannot be written, so authentication has nowhere to persist. Point `YTSTATS_CONFIG_DIR` somewhere writable — common on CI runners and in containers where `$HOME` is read-only:

```bash
export YTSTATS_CONFIG_DIR=$PWD/.ytstats
```

`doctor` surfaces it as the `config_writable` check, which runs first because everything else depends on it.

## Warnings — never fatal

`AUTH_CLIENT_ID_SUSPICIOUS`, `DATA_PARTIAL`, `DATA_EMPTY`, `REACH_PENDING`, `REPORTING_JOBS_MISSING`, `REPORTS_EXPIRING`, `ANALYTICS_METRICS_UNSUPPORTED` are warnings. They never make `ok` false and never change the exit code. Report them as context, not as failure.

### REPORTING_JOBS_MISSING is the exception to "warnings are minor"

Severity `warning` here reflects that the *command* succeeded, not that the situation is small. It means report types have no reporting job, so YouTube is generating **no data at all** for them, and creating a job later recovers only the trailing 30 days.

`recoverable: true`, `retryable: false` — re-running the command changes nothing; the jobs must be created.

Raise it explicitly every time, even inside an otherwise clean run. Give the count, the report ids from `context`, `ytstats reports-enable --all` as the fix, and the 24–48 hour wait before data appears. Then mention that reports expire 60 days after generation, so the user needs a recurring pull to actually accumulate history. Full wording is in SKILL.md under "Data YouTube is not collecting".

### REPORTS_EXPIRING is a deadline, not a status

Reports YouTube has generated but nobody downloaded expire in 60 days (30 for backfill). This warning means some are within 14 days of that. After it, those periods have no record anywhere.

`recoverable: true`, `retryable: false` — the fix is `ytstats sync`, not re-running whatever produced the warning.

**Run `sync` yourself when you see this**, and say you are doing it. It is a read plus a local write, it is idempotent, and waiting for the user to come back could cost the data. Then confirm with `archive` and tell them to schedule `sync` and back the directory up.

### ANALYTICS_METRICS_UNSUPPORTED means fields are absent, not zero

The query succeeded with a reduced metric set because this channel cannot serve one of the newer metrics — most often `relativeRetentionPerformance`, sometimes `engagedViews`. `context.dropped` names them.

Every analytics command raises this when it drops something — the dataset commands, `retention`, and `fetch` (where it appears in `data.notes`). So a null column always has a stated reason, and "no warning" genuinely means nothing was dropped.

The rows are correct; they carry fewer fields. **Report the dropped fields as unknown.** Saying "your relative retention is 0" when the metric was never returned is a confidently false answer, and it is the failure this diagnostic exists to prevent. Nothing needs fixing.

## When you do not know what is wrong

```bash
ytstats doctor
```

Nine independent checks — config writable, credentials present, signed in, then one probe per API (Data v3, Analytics v2, Reporting v1), then reporting jobs scheduled, reports archived, and finally the consent screen — reported together rather than stopping at the first failure. It **always exits 0**; the verdict is `data.healthy` and the blocking diagnostics are in `data.blocking`. Treating a non-zero exit as the signal here is a mistake; there isn't one.

The last two are the ones a clean-looking run still hides: `reporting_jobs` means YouTube is generating no data for some report types, and `reports_archived` means generated data is about to be deleted undownloaded. Neither blocks a command from succeeding.

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
