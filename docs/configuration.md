---
description: Environment variables, the per-user config directory, stored file formats, and CI setup.
tags: [configuration, environment, config-directory, ci]
source:
  - src/config/**
  - src/auth/credentials.js
  - src/archive.js
---

# Configuration

`ytstats` has no config file of its own. Everything is either an environment variable or state written by `login`. For the traps in the storage layer, see [gotchas/config-storage.md](gotchas/config-storage.md).

## Environment variables

| Variable | Read by | Effect |
|---|---|---|
| `YTSTATS_CONFIG_DIR` | `resolveConfigDir()` | Overrides the config directory entirely. Relative values are resolved to absolute against the working directory |
| `YTSTATS_DATA_DIR` | `resolveDataDir()` | Overrides where the report archive is stored. Defaults to `<config dir>/data`, so `YTSTATS_CONFIG_DIR` moves credentials, tokens **and** archive together. Relative values are resolved to absolute |
| `YTSTATS_CLIENT_ID` | `resolveCredentials()` | OAuth client id. **Both** this and the secret must be set for the pair to be used |
| `YTSTATS_CLIENT_SECRET` | `resolveCredentials()` | OAuth client secret |
| `YTSTATS_CREDENTIALS_FILE` | `resolveCredentials()` | Path to the `client_secret` JSON Google issued. Same effect as `--client-secret`, without repeating the flag |
| `XDG_CONFIG_HOME` | `resolveConfigDir()` | Linux/BSD config base. **Ignored when relative**, per the XDG spec |
| `APPDATA` | `resolveConfigDir()` | Windows config base; falls back to `%USERPROFILE%\AppData\Roaming` |
| `HTTPS_PROXY` | `googleapis` / Node | Standard proxy variable, named in the `NETWORK_UNREACHABLE` remediation |

Note the deliberate asymmetry: a relative `XDG_CONFIG_HOME` is ignored because the spec says so, while a relative `YTSTATS_CONFIG_DIR` is accepted and resolved — it is an explicit override, not an environment convention.

**One archive holds one channel's data cleanly; several channels share it.** The archive is one file per report type, not per channel, so syncing two channels from the same config directory interleaves them. Rows stay distinguishable by `channel_id` and never overwrite each other, but `archive` totals and `readRows()` cover both — give each channel its own `YTSTATS_CONFIG_DIR`, which carries the archive with it. See [the gotcha](gotchas/youtube-api.md#the-archive-is-keyed-by-report-type-not-by-channel).

**Point `YTSTATS_DATA_DIR` somewhere you back up.** The archive under it is the only copy of any Reporting API data older than 60 days — Google deletes reports 60 days after generating them (30 days for backfill reports). Everything else `ytstats` stores can be recreated by logging in again; this cannot be recreated at all.

## The config directory

`resolveConfigDir({ platform, env, home })` picks the location, checking `YTSTATS_CONFIG_DIR` first and otherwise following platform convention:

| OS | Location |
|---|---|
| macOS | `~/Library/Application Support/ytstats/` |
| Linux / BSD | `$XDG_CONFIG_HOME/ytstats/`, default `~/.config/ytstats/` |
| Windows | `%APPDATA%\ytstats\` |

The function is pure — platform, environment, and home directory are all parameters. Only `configDir()` reads `process.platform`, `process.env`, and `os.homedir()`. That is what lets the test suite assert Windows and Linux behaviour while running on macOS.

`ytstats status` and `ytstats doctor` both report the resolved path.

## Stored files

Two files, both written by `login`.

### credentials.json

The BYO OAuth client, saved so later commands need no flags — and because Google's token endpoint requires the client secret on **every** refresh, not just the initial exchange.

```jsonc
{
  "version": 1,
  "clientId": "123456789012-abc.apps.googleusercontent.com",
  "clientSecret": "GOCSPX-…",
  "projectId": "youtube-analytics-491713",
  "source": "/Users/you/Downloads/client_secret_1234.json",
  "savedAt": "2026-07-27T10:00:00.000Z"
}
```

`source` records where the credentials originally came from, for display only. `projectId` is copied from the `project_id` Google includes in the downloaded file, so console links can be pinned to the right project. It is `null` for credentials saved before the field existed and for the env-var pair; the project *number* still falls out of the client ID in both cases.

### tokens.json

The multi-account token store, keyed by channel id:

```jsonc
{
  "version": 1,
  "default": "UC…",
  "accounts": {
    "UC…": {
      "channelId": "UC…",
      "channelTitle": "…",
      "customUrl": "@…",
      "clientId": "123456789012-abc.apps.googleusercontent.com",
      "tokens": { "access_token": "…", "refresh_token": "…", "expiry_date": 0 },
      "savedAt": "2026-07-27T10:00:00.000Z"
    }
  }
}
```

`clientId` records which OAuth client issued this account's refresh token. It is not a secret and is never used to authenticate — it exists so a later run can tell whether the credentials it resolved are the ones the token belongs to. Accounts written before the field existed have `null` and are treated as unknown, not as a mismatch.

Deleted entirely when the last account is removed. See [auth.md](auth.md#token-storage) for how it is read and merged.

## Permissions and write discipline

Everything the store holds is a secret, so:

- The directory is created at `0700` and the mode is re-asserted with `chmod`, since `mkdir`'s mode is masked by umask and the directory may predate the run.
- Files are written at `0600`. The temp file is created **at** that mode rather than chmod'd afterwards, so the secret is never briefly world-readable.
- Writes are atomic: a uniquely-named temp file in the same directory, then `rename`. A crash never leaves a half-written token file, and a concurrent reader never sees one.
- File names must be flat basenames. Separators, `..`, absolute paths, and NUL are **rejected**, not sanitised.

On Windows POSIX modes are meaningless; the protection there is the per-user `%APPDATA%` location.

These are plaintext files, the same approach `gcloud`, `gh`, and `aws` take. `ytstats logout` revokes the token with Google and deletes them.

## CI and headless machines

Point at a mounted secret file:

```bash
export YTSTATS_CREDENTIALS_FILE=/run/secrets/ytstats-client.json
export YTSTATS_CONFIG_DIR=$PWD/.ytstats     # if $HOME is not writable
ytstats login --no-browser
```

This is usually the cleanest option in CI, where the runner already mounts secrets as files: it takes the JSON Google issued as-is, with no step that extracts two fields out of it, and a path in the environment leaks less than a secret in the environment.

The pair still works where the secret arrives as two variables:

```bash
export YTSTATS_CLIENT_ID=123456789012-abc.apps.googleusercontent.com
export YTSTATS_CLIENT_SECRET=GOCSPX-…
```

Both must be set — one alone is ignored and resolution falls through to the next source.

`--no-browser` prints the authorization URL and reads the pasted redirect back, so a machine with no browser can still complete the flow. The refresh token it produces is then reusable, provided the consent screen is published to Production — in Testing mode Google expires it after 7 days.

If the config directory is not writable, `doctor` reports `CONFIG_UNWRITABLE` and its remediation points at `YTSTATS_CONFIG_DIR`.

## Credential resolution order

Ordered in `resolveCredentials()`; the first complete pair wins:

1. `--client-secret <file>`
2. `YTSTATS_CLIENT_ID` + `YTSTATS_CLIENT_SECRET` (both required)
3. `YTSTATS_CREDENTIALS_FILE`
4. Stored `credentials.json`
5. `client_secret*.json` auto-discovered in the working directory

The env pair is checked before the env path so that the path form changes nothing for anyone already exporting the pair. If both are set, the pair wins and `ytstats status` reports `credentialSource: environment` — which is how you catch a stale `YTSTATS_CLIENT_ID` shadowing the file you meant to use.

Auto-discovery prefers an exact `client_secret.json`, otherwise takes the alphabetically first match so the same directory always resolves the same way. Full detail in [auth.md](auth.md#credential-resolution).

## Running several OAuth clients side by side

One config directory holds **one** OAuth client — `credentials.json` is a single record, not one per channel. `tokens.json` holds many channels, so the two only stay consistent if every channel in a directory was authorized with the same client.

That is fine for the common case (one Google Cloud project, several of your own channels). It breaks when channels live under *different* projects — managing a client's channel with a client-issued OAuth client, for instance. Give each client its own directory:

```bash
alias yt-acme='YTSTATS_CONFIG_DIR=~/.ytstats/acme YTSTATS_CREDENTIALS_FILE=~/secrets/acme.json ytstats'
alias yt-mine='YTSTATS_CONFIG_DIR=~/.ytstats/mine ytstats'
```

`YTSTATS_CONFIG_DIR` is what does the real work: it moves the credentials *and* the tokens together, so the two halves cannot drift apart. Setting only `YTSTATS_CREDENTIALS_FILE` while leaving the config directory shared pairs one client's id with another's tokens, which is exactly the state [`AUTH_CLIENT_MISMATCH`](output-contract.md#diagnostic-catalog) exists to catch.

Per-directory rather than per-shell, with [direnv](https://direnv.net/):

```bash
# .envrc
export YTSTATS_CONFIG_DIR="$PWD/.ytstats"
export YTSTATS_CREDENTIALS_FILE="$HOME/secrets/acme.json"
```

## Not committing credentials

The repository's `.gitignore` excludes `client_secret*.json`, `credentials.json`, `tokens.json`, and `.env` — because a downloaded client secret can easily land in the working directory during testing, and auto-discovery means it will be picked up from there.

The stored copies live in the per-user config directory, outside any repository.
