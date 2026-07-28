---
description: Traps in the per-user config store — atomic writes, permission windows, path traversal, and platform differences.
tags: [config, storage, permissions, security, gotchas]
source:
  - src/config/**
---

# Config and Storage Gotchas

Everything the config store holds is a secret — the OAuth client secret and refresh tokens. These entries explain why the write path is more careful than a `writeFileSync` would be.

Related: [configuration.md](../configuration.md) for the directory layout and env vars, [auth gotchas](auth.md) for what is stored.

## The temp file is created *at* 0600, not chmod'd afterwards

`writeJson()` passes `{ mode: FILE_MODE }` to `fs.writeFileSync` rather than writing first and fixing permissions after. Between those two operations the secret would be briefly world-readable, and a concurrent reader can hit exactly that window.

```js
fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: FILE_MODE });
```

**Where handled:** `writeJson()` in `src/config/store.js`.

## The write is atomic via rename, so a crash never truncates tokens

Writing in place means a crash mid-write leaves a half-written token file that parses as invalid JSON — and the user is silently logged out. `writeJson()` writes to a unique temp file in the same directory and then `renameSync`s it over the target, which is atomic on POSIX filesystems.

The temp name includes the pid and six random bytes so two concurrent processes cannot collide. On failure the temp file is unlinked best-effort before the error is rethrown.

**Where handled:** `writeJson()` in `src/config/store.js`.

## chmod runs again after the rename

`rename` preserves the temp file's mode, so the final file is already `0600`. The extra `chmodSync(target, FILE_MODE)` afterwards guards the case where the target pre-existed with looser permissions on a filesystem that does not behave as expected. It is belt-and-braces, not redundancy to remove.

Every `chmod` call in this file is wrapped in `try`/`catch` because Windows ignores POSIX modes and would otherwise throw.

**Where handled:** `writeJson()` in `src/config/store.js`.

## The directory mode is asserted, not assumed

`fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE })` does not reliably produce `0700`: the mode is masked by the process umask, and the directory may already exist from an earlier run with different permissions.

`ensureDir()` therefore follows the mkdir with an explicit `chmodSync(dir, DIR_MODE)`.

**Where handled:** `ensureDir()` in `src/config/store.js`.

## Unsafe filenames are rejected, not sanitised

`assertSafeName()` throws for anything that is not a flat basename — path separators, `.`, `..`, absolute paths, and embedded NUL. It does not strip or rewrite them.

Silently sanitising would hide a caller bug: code that passes `../../.ssh/id_rsa` has a defect, and rewriting it into `id_rsa` lets the defect ship. The throw is the point.

**Where handled:** `assertSafeName()` in `src/config/store.js`.

## Windows relies on directory location, not file modes

POSIX modes are meaningless on Windows, so `0600` provides no protection there. The security property comes from the storage location instead: `%APPDATA%` is already per-user and roaming.

Do not "fix" the Windows path to a shared location on the assumption that the file modes are doing the work.

**Where handled:** the comment on `FILE_MODE` / `DIR_MODE` in `src/config/store.js`; the `win32` branch of `resolveConfigDir()` in `src/config/paths.js`.

## readJson returns null for a corrupt file, not an error

Both the read and the `JSON.parse` are wrapped, and either failure yields `null`. A corrupt `tokens.json` therefore reads as "not signed in" rather than crashing the command.

The trade-off is deliberate but worth knowing: a truncated token file is indistinguishable from an absent one, so the user sees `AUTH_NO_TOKENS` and re-runs `login`, which repairs it. Callers must not treat `null` as proof the file does not exist.

**Where handled:** `readJson()` in `src/config/store.js`.

## A relative XDG_CONFIG_HOME is ignored, per spec

The XDG Base Directory specification requires a relative `XDG_CONFIG_HOME` to be treated as unset. `resolveConfigDir()` implements this with `path.isAbsolute(xdg)` and falls back to `~/.config`.

`YTSTATS_CONFIG_DIR` behaves the *opposite* way: a relative value is accepted and resolved to absolute against the current working directory, since it is an explicit override rather than an environment convention.

**Where handled:** `resolveConfigDir()` in `src/config/paths.js`.

## Config path resolution is pure so every OS can be tested from any OS

`resolveConfigDir({ platform, env, home })` takes all three inputs as parameters; only `configDir()` reads `process.platform`, `process.env`, and `os.homedir()`. This is what lets the test suite assert Windows and Linux behaviour while running on macOS.

Reading `process.*` directly inside `resolveConfigDir()` would make two thirds of that coverage impossible.

**Where handled:** `resolveConfigDir()` versus `configDir()` in `src/config/paths.js`.

## listFiles filters in-flight temp files

`listFiles()` excludes names containing `.tmp-` so a concurrent write in progress is not reported as a stored file. Anything enumerating the config directory should apply the same filter rather than reading the raw directory listing.

**Where handled:** `listFiles()` in `src/config/store.js`.

## removeAccount deletes the file when the last account goes

Leaving an empty `{ accounts: {} }` store behind would make `listAccounts()` cheap but leave a stale file implying state that no longer exists. `removeAccount()` unlinks `tokens.json` entirely once the last account is removed, and otherwise promotes an arbitrary remaining account to default.

**Where handled:** `removeAccount()` in `src/auth/tokens.js`.
