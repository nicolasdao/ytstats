---
name: ytstats
description: ytstats CLI — pull YouTube channel analytics and manage sign-in. Use when asked for views, retention, CTR, demographics, login, or switching channel. Not for releasing the package (release-cli).
argument-hint: "[what you want, e.g. pull last 30 days]"
allowed-tools: Bash, AskUserQuestion
---

# ytstats

Operate the `ytstats` CLI on the user's behalf. They describe what they want in plain English; you pick the command, run it, and answer the question they actually asked.

**Request:** `$ARGUMENTS`

## Resolving the binary

Try in order, first that works:

```bash
node bin/ytstats.js --version    # inside a ytstats checkout — tests local changes
ytstats --version                # installed globally
npx --yes ytstats --version      # anywhere else
```

Prefer a local checkout when the working directory is one, since that is the build the user is editing. Otherwise `npx`. Below, `ytstats` means whichever resolved.

## Reading the output

**stdout is exactly one JSON document on every code path** — success, failure, bad flag, unknown command, crash. stderr is human progress and is safe to discard, so always capture with `2>/dev/null`.

```bash
ytstats daily -d 30 2>/dev/null | jq '.data.rows[-7:]'
```

Branch on `.ok`. On failure, `data` is `null` — never partial — and `.errors[0]` carries a stable `code`, plus `recoverable`, `retryable`, and `nextSteps`. Use `jq` to pull out what you need rather than dumping whole documents into the conversation.

Never parse the prose. `code` is the public contract; the wording is not.

### `.data` has four shapes — check which one you are holding

| Command | `.data` is | Get rows with |
|---|---|---|
| `daily`, `traffic`, `demographics`, `devices`, `content-types`, `search-terms`, `geography`, `playback-locations`, `video-analytics` | `{period, rows}` | `.data.rows` |
| `videos` | a bare array | `.data` |
| `channel` | the channel object | `.data.subscriberCount` |
| `fetch` | `{period, warnings, notes, data}` | `.data.data.<dataset>` |

`fetch` nests one level deeper than the rest, and its datasets are **bare arrays** — `.data.data.daily` is the row list, with no `.rows` under it. Its per-step failures are at `.data.warnings`, and are also copied to the envelope's top-level `.warnings`.

Getting this wrong yields `null` rather than an error, which reads as "no data" when the data is right there.

## On Windows

The examples here are POSIX shell, which is what the agent's own shell provides on every platform — so commands **you** run work as written on Windows too.

The difference is in what you hand to the *user* to run themselves, because their shell is probably PowerShell:

| POSIX | PowerShell |
|---|---|
| `2>/dev/null` | `2>$null` |
| `export VAR=value` | `$env:VAR = "value"` |
| `~/.ytstats/acme` | `$HOME\.ytstats\acme` |

One trap worth naming when you tell a Windows user to save a snapshot: in **Windows PowerShell 5.1**, `>` writes UTF-16LE, which `jq` cannot parse. PowerShell 7 and later default to UTF-8 and are fine. If they are on 5.1, have them use the CLI's own redirection-free form and pipe through `Out-File -Encoding utf8`, or simply use PowerShell 7.

The config directory is handled by the CLI itself — `%APPDATA%\ytstats\` on Windows — so nothing needs adjusting there.

## Routing — intent to command

| What they ask | Run |
|---|---|
| "pull everything", "full snapshot", "all my stats" | `fetch` — see below, it goes to a file |
| "how many subscribers", "channel info" | `channel` |
| "list my videos", "top videos", "my Shorts" | `videos [-s viewCount] [-t SHORTS]` |
| "how did last month go", "views over time", "daily numbers" | `daily -d 30` |
| "where do my views come from" | `traffic` |
| "who watches me", "age", "gender" | `demographics` |
| "mobile or desktop" | `devices` |
| "Shorts vs long-form" | `content-types` |
| "what do people search to find me" | `search-terms` |
| "which countries" | `geography` |
| "where do people watch" | `playback-locations` |
| "best performing videos this period" | `video-analytics` |
| "where do viewers drop off", "retention" | `retention <videoId>` |
| "CTR", "thumbnail performance", "impressions" | `reach` — read the async caveat first |
| something no command covers | `query -m <metrics> --dimensions <dims>` |
| "am I logged in", "which channel", "who am I" | `status` |
| "something is broken", "why doesn't this work" | `doctor` |
| "log in", "connect my account" | `login` |
| "log out", "disconnect" | `logout` — **confirm first** |
| "switch channel", "use my other channel" | `use <channelId or @handle>` |

Full flag reference: [references/commands.md](references/commands.md).

When the request names a video without an id, run `videos` first to resolve the title to an id rather than asking the user for it.

## Time windows

Default is 90 days. Translate plain language rather than asking:

| They say | Flag |
|---|---|
| "last week", "past 7 days" | `-d 7` |
| "last month", "past 30 days" | `-d 30` |
| "last quarter", no period given | `-d 90` |
| "this year", "last year" | `--start 2026-01-01` |
| "since March" | `--start 2026-03-01` |
| a named range | `--start YYYY-MM-DD --end YYYY-MM-DD` |

Dates are `YYYY-MM-DD` only and windows are UTC. `channel` and `videos` take no date flags — they are current-state, not period.

## Pulling everything

`fetch` returns every dataset in one document and is routinely megabytes. Redirect it, then summarize:

```bash
ytstats fetch --days 90 > snapshot.json 2>/dev/null
jq '{views: [.data.data.daily[].views] | add,
     subs: .data.data.channel.subscriberCount,
     videos: .data.data.videos | length,
     degraded: [.data.warnings[].step]}' snapshot.json
```

Report the headline numbers, where the file is, and anything in `data.warnings[]`. Do not print the document into the conversation — the file is queryable with `jq` for whatever they ask next.

Two flags cost real quota: `--reach` adds Reporting API calls, and retention costs **one API call per video** (default limit 50, newest first). For a quick or repeated pull, `--no-retention` is the cheap option. Say so when a request would be expensive.

## Confirm before logging out

`logout` revokes the refresh token with Google and deletes it locally. Getting back in needs the browser flow again.

Always confirm with AskUserQuestion before running it, including which account and whether `--all` or `--forget-credentials` is intended. This is the only command that requires a confirmation — `login`, `use`, and `status` run directly.

## When something fails

Read `.errors[0].code` and act on it. The catalog, with what each code means and whether retrying can possibly help, is in [references/troubleshooting.md](references/troubleshooting.md).

The two flags that prevent pointless loops: `recoverable: false` means stop and tell the user, `retryable: false` means change something before trying again. `nextSteps[0]` is a runnable command.

If the failure is unclear, run `doctor` — it checks four prerequisites independently and always exits 0, with the verdict in `data.healthy`.

## Reading results correctly

Several values are correct but look wrong, and misreporting them is the most likely way to give a confidently false answer. Read [references/interpreting-results.md](references/interpreting-results.md) before summarizing any result set.

The three that bite hardest:

- **`impressionsCtr` is a fraction.** `0.0561` is **5.61%**. Multiply by 100.
- **Retention ratios above 1.0 are correct** — viewers looped that moment. Never clamp, never call it a bug.
- **Empty is not failed.** `rows: []` with `ok: true` and a `DATA_EMPTY` warning means the channel genuinely had no activity. In a `fetch`, an empty dataset named in `data.warnings[]` means that step failed, which is different again.

## Constraints

- **NEVER** run `logout` without an explicit confirmation.
- **NEVER** report `impressionsCtr` without converting the fraction to a percentage.
- **NEVER** retry a command whose diagnostic says `retryable: false`, or continue at all when `recoverable: false`.
- **NEVER** fall back to another channel when `--account` fails with `AUTH_ACCOUNT_UNKNOWN` — show the user the channels in `context.allowed`.
- **NEVER** print a full `fetch` document into the conversation. Redirect to a file and query it.
- **NEVER** branch on diagnostic prose. Branch on `code`.
- **ALWAYS** capture with `2>/dev/null` — stderr is progress noise, stdout is the data.
- **ALWAYS** check `data.warnings[]` in a `fetch` result before calling a dataset empty or a run clean.
- **ALWAYS** say which definition you used when Shorts classification could be ambiguous, since duration-based and YouTube's own classification disagree.

## Setting up a new user

The CLI ships **no** Google client id by design — each user brings their own Google Cloud OAuth client, so the quota is theirs, no verification is needed, and no data leaves the machine. The cost is a one-time setup, and guiding someone through it is your job.

**Start with `doctor`, never with the full walkthrough.** It runs seven checks covering the whole setup and tells you exactly which steps are outstanding, so you present the three things they still need rather than reciting seven at someone who has done four.

```bash
ytstats doctor 2>/dev/null | jq '.data.checks'
```

It always exits 0 — a failing check is information, not an error to stop on. The verdict is `data.healthy`, and `data.blocking` holds the diagnostics in order.

### Map each failing check to what they must do

Walk `data.checks` in order and stop at the first `status: "fail"` — the checks are dependency-ordered, so later failures are usually consequences of earlier ones.

| Failing check | What to tell them |
|---|---|
| `config_writable` | The config directory is not writable. Set `YTSTATS_CONFIG_DIR` somewhere that is |
| `credentials` | No OAuth client yet. This is the full Google Cloud setup — walk `blocking[0].remediation.steps` verbatim |
| `signed_in` | Client exists, nobody has authorized. Run `login`, approve in the browser |
| `api_reachable` | Data API v3 not enabled, or the token is bad. The diagnostic distinguishes them |
| `api_analytics` | Analytics API v2 not enabled — everything with a date window will fail until it is |
| `api_reporting` | Reporting API v1 not enabled — `reach` and CTR will fail until it is |

Each `API_NOT_ENABLED` diagnostic carries the exact console URL for **that** API in `remediation.docs`. Give them that link, not a general one.

### Read the steps out, do not improvise them

When `credentials` fails, `blocking[0].remediation.steps` is the complete seven-step walkthrough with live console URLs — create the project, enable three APIs, configure the consent screen, create the OAuth client, download the JSON, run `login`. Present those, in order. Reconstructing them from memory is how people end up creating the wrong credential type.

**A service account can never work.** It owns no YouTube channel and there is no workaround — not with domain-wide delegation, not with any configuration. They need an **OAuth client ID, Application type: Desktop app**. If they supply a service account key the CLI fails with `AUTH_SERVICE_ACCOUNT`, `recoverable: false` — stop and tell them to create the right credential type.

### The step you must raise yourself

`consent_screen` reports `status: "unknown"` on a fresh setup, because no Google API exposes it. It is the only step whose failure is **delayed**: in Testing mode Google expires refresh tokens after 7 days, so everything works perfectly for a week and then breaks with `invalid_grant` looking like a brand-new problem.

Whenever that check is `unknown`, say so explicitly and give them the link:

> One step I cannot verify: your OAuth consent screen must be published to **Production**. In Testing, Google expires your login after 7 days. Check it reads "In production" at <https://console.cloud.google.com/apis/credentials/consent>

Do not let it pass silently just because `healthy` is `true`. It flips to `pass` on its own once a working token is older than 7 days.
