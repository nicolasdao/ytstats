# Gotchas

Lessons learned the hard way so we don't repeat them.

Each domain file explains what breaks, why, and where `ytstats` handles it — so a future change does not silently undo a workaround.

- [YouTube API](gotchas/youtube-api.md) — metrics that never work, undocumented `maxResults` ceilings, reporting lag, quota traps, and vocabulary mismatches across the three APIs.
- [Authentication](gotchas/auth.md) — service accounts, weekly token expiry in Testing mode, client IDs that fail silently in the browser, and refresh-token preservation.
- [CLI and output](gotchas/cli-output.md) — Commander overrides that keep stdout parseable, severity forcing, validation ordering, and what redaction must not eat.
- [Config and storage](gotchas/config-storage.md) — atomic writes, permission windows, path-traversal rejection, and platform differences.
