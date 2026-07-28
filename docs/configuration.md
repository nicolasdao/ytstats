---
description: Environment variables, the per-user config directory, stored file formats, and CI setup.
tags: [configuration, environment, config-directory, ci]
source:
  - src/config/**
  - src/auth/credentials.js
---

# Configuration

`ytstats` has no config file of its own. Everything is either an environment variable or state written by `login`. For the traps in the storage layer, see [gotchas/config-storage.md](gotchas/config-storage.md).

## Environment variables

| Variable | Read by | Effect |
|---|---|---|
| `YTSTATS_CONFIG_DIR` | `resolveConfigDir()` | Overrides the config directory entirely. Relative values are resolved to absolute against the working directory |
| `YTSTATS_CLIENT_ID` | `resolveCredentials()` | OAuth client id. **Both** this and the secret must be set for the pair to be used |
| `YTSTATS_CLIENT_SECRET` | `resolveCredentials()` | OAuth client secret |
| `XDG_CONFIG_HOME` | `resolveConfigDir()` | Linux/BSD config base. **Ignored when relative**, per the XDG spec |
| `APPDATA` | `resolveConfigDir()` | Windows config base; falls back to `%USERPROFILE%\AppData\Roaming` |
| `HTTPS_PROXY` | `googleapis` / Node | Standard proxy variable, named in the `NETWORK_UNREACHABLE` remediation |

Note the deliberate asymmetry: a relative `XDG_CONFIG_HOME` is ignored because the spec says so, while a relative `YTSTATS_CONFIG_DIR` is accepted and resolved — it is an explicit override, not an environment convention.

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
  "source": "/Users/you/Downloads/client_secret_1234.json",
  "savedAt": "2026-07-27T10:00:00.000Z"
}
```

`source` records where the credentials originally came from, for display only.

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
      "tokens": { "access_token": "…", "refresh_token": "…", "expiry_date": 0 },
      "savedAt": "2026-07-27T10:00:00.000Z"
    }
  }
}
```

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

Supply the OAuth client through the environment instead of a file:

```bash
export YTSTATS_CLIENT_ID=123456789012-abc.apps.googleusercontent.com
export YTSTATS_CLIENT_SECRET=GOCSPX-…
export YTSTATS_CONFIG_DIR=$PWD/.ytstats     # if $HOME is not writable
ytstats login --no-browser
```

Both `YTSTATS_CLIENT_ID` and `YTSTATS_CLIENT_SECRET` must be set — one alone is ignored and resolution falls through to the next source.

`--no-browser` prints the authorization URL and reads the pasted redirect back, so a machine with no browser can still complete the flow. The refresh token it produces is then reusable, provided the consent screen is published to Production — in Testing mode Google expires it after 7 days.

If the config directory is not writable, `doctor` reports `CONFIG_UNWRITABLE` and its remediation points at `YTSTATS_CONFIG_DIR`.

## Credential resolution order

Ordered in `resolveCredentials()`; the first complete pair wins:

1. `--client-secret <file>`
2. `YTSTATS_CLIENT_ID` + `YTSTATS_CLIENT_SECRET` (both required)
3. Stored `credentials.json`
4. `client_secret*.json` auto-discovered in the working directory

Auto-discovery prefers an exact `client_secret.json`, otherwise takes the alphabetically first match so the same directory always resolves the same way. Full detail in [auth.md](auth.md#credential-resolution).

## Not committing credentials

The repository's `.gitignore` excludes `client_secret*.json`, `credentials.json`, `tokens.json`, and `.env` — because a downloaded client secret can easily land in the working directory during testing, and auto-discovery means it will be picked up from there.

The stored copies live in the per-user config directory, outside any repository.
