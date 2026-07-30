---
description: Traps in the CLI wiring and the output envelope — Commander overrides, severity forcing, validation ordering, and redaction.
tags: [cli, output, diagnostics, commander, gotchas]
source:
  - src/cli.js
  - src/output.js
  - src/errors.js
  - src/diagnostics.js
---

# CLI and Output Gotchas

Why the CLI wiring and the envelope look the way they do. Most entries here exist because the obvious implementation violates the output contract.

Related: [output-contract.md](../output-contract.md) for the envelope schema, [cli.md](../cli.md) for the command surface.

## Commander's default behaviour writes nothing to stdout

On a usage error Commander prints prose to stderr and calls `process.exit`, leaving stdout **empty**. An agent parsing stdout gets nothing at all — which breaks the contract's central promise that every code path emits one JSON document.

Two overrides fix this and both are load-bearing:

```js
program.exitOverride();          // throw instead of process.exit
program.configureOutput({
  writeErr: () => {},            // suppressed; re-emitted as a diagnostic
  writeOut: s => stdout(s.replace(/\n$/, '')),
});
```

`exitOverride()` converts the exit into a throw that `main()` catches and routes through `diagnoseCommanderError()`. Removing either override silently reintroduces the empty-stdout failure.

**Where handled:** `buildProgram()` in `src/cli.js`.

## --help and --version arrive as thrown errors

Because of `exitOverride()`, a successful `--help` or `--version` reaches `main()`'s `catch` block like any failure. Treating everything caught there as an error would make help exit non-zero and emit an error envelope.

`main()` checks for `commander.helpDisplayed`, `commander.help`, and `commander.version` first and returns `EXIT.OK`.

**Where handled:** `main()` in `src/cli.js`.

## Global flags are not known when the reporter is first built

`createReporter()` is called once at build time, before `--compact` and `--quiet` have been parsed. Using that first reporter for output would ignore both flags.

A `preAction` hook rebuilds the reporter once global options are available. In `main()`'s error path — where parsing may never have reached the hook — the flags are instead sniffed directly out of `argv`.

**Where handled:** the `preAction` hook in `buildProgram()`, and the `argv.includes('--compact')` sniffing in `main()`.

## warn() forces severity to warning, and must

`reporter.warn()` overwrites the diagnostic's `severity` with `SEVERITY.WARNING`. Routing a diagnostic through `warn()` *is* the decision that it is non-fatal, so the definition's own severity is not authoritative there.

Without this, `doctor` — whose entire job is to report the auth problems it found — would emit `ok: true` while exiting 2, because `exitCodeFor()` reads severity. That combination is incoherent for a consumer.

**Where handled:** `warn()` in `createReporter()`, `src/output.js`.

## data is null on failure, never partial

When `ok` is false, `data` is set to `null` — not to whatever was collected before the failure. A consumer that reads `data` without checking `ok` would otherwise act on half a dataset and never know.

```js
data: ok ? (data ?? null) : null,
```

**Where handled:** `renderEnvelope()` in `src/output.js`.

## Errors carrying warning severity are re-sorted into warnings

`renderEnvelope()` does not trust the caller's error/warning split. It partitions both input lists by each diagnostic's actual `severity`, so a warning-severity diagnostic passed in `errors` lands in `warnings` and does not make `ok` false.

This is why `reporter.fail()` can pass `[...list, ...warningsBuffer]` as one array without corrupting `ok`.

**Where handled:** `errorList` / `warningList` construction in `renderEnvelope()`, `src/output.js`.

## Input is validated before authentication

Every `run()` wrapper executes its `validate` callback before touching the network. Checking auth first would hide a malformed date behind a login error, costing an agent an extra round trip to discover the second problem.

`validateRange()` also collects *every* problem rather than throwing on the first, so `--start 01/01/2026 --end yesterday --days -3` reports three diagnostics in one envelope.

**Where handled:** the `run()` wrapper and `validateRange()` in `src/cli.js`.

## The range check is skipped when a date is already invalid

`validateRange()` only compares `start > end` when `problems` is still empty. Comparing an unparseable date string would produce a second, misleading `INPUT_INVALID_RANGE` on top of the real `INPUT_INVALID_DATE` — two diagnostics for one mistake.

**Where handled:** the `if (!problems.length && …)` guard in `validateRange()`, `src/cli.js`.

## Date validation exists in two places, deliberately

`validateRange()` in `src/cli.js` collects problems as diagnostics without throwing; `assertIsoDate()` in `src/dates.js` throws `YtStatsError`. They overlap on purpose — the CLI needs to report all problems at once, while `resolveDateRange()` must stay safe for library callers who never went through the CLI.

Changing one without the other lets a bad date through one entry point. `src/dates.js` additionally enforces `MAX_DAYS` (3650), which the CLI validator does not check.

**Where handled:** `validateRange()` in `src/cli.js`, `assertIsoDate()` and `resolveDateRange()` in `src/dates.js`.

## Redaction deliberately spares the "code" field

The redaction patterns strip Google client secrets, access tokens, refresh tokens, and authorization codes. They deliberately do **not** match a bare `"code"` JSON field, because every diagnostic carries `"code": "AUTH_NO_TOKENS"` — public API that must survive redaction.

Broadening the pattern to catch `"code"` generically would blank out the one field consumers branch on.

**Where handled:** `SECRET_PATTERNS` in `src/errors.js`, with a comment marking the exclusion.

## Redaction runs on the serialized JSON, not the object

`renderEnvelope()` calls `redact(json)` after `JSON.stringify`, so redaction sees the final text including any secret that leaked into a nested `detail` string. Redacting the object first would miss anything embedded in prose.

The reporter applies `redact()` to every stderr write for the same reason.

**Where handled:** `renderEnvelope()` and `createReporter()` in `src/output.js`.

## Google error classification is order-dependent

`diagnoseGoogleError()` checks specific signals — network error codes, reason strings, message fingerprints — **before** generic HTTP status buckets. A 403 alone can mean four unrelated things (`accessNotConfigured`, `quotaExceeded`, `NoLinkedYouTubeAccount`, plain forbidden), so reordering the checks silently degrades precise diagnostics into `API_FORBIDDEN`.

`invalid_grant` is checked before the generic 401 branch for the same reason: it has a specific, actionable cause that "token expired" alone does not convey.

**Where handled:** the ordered `if` chain in `diagnoseGoogleError()`, `src/errors.js`.

## An empty result set is reported explicitly

An empty `rows` array is ambiguous — it could mean the query failed silently or that the channel genuinely had no activity. Every `simple()` command emits a `DATA_EMPTY` warning when the query succeeds with zero rows, so the caller can tell the two apart.

Commands built by hand follow the same convention rather than inventing their own: `transcript` emits `DATA_EMPTY` for a video with no usable caption track, because "captions are switched off" and "the request failed" must not look alike either.

**Where handled:** the `rows.length === 0` branch in `simple()`, and the no-track branch of the `transcript` action, `src/cli.js`.

## --no-retention is Commander's negation, so the option reads as `retention`

`.option('--no-retention', …)` makes Commander expose `cmdOpts.retention`, defaulting to `true` and becoming `false` when the flag is passed. There is no `cmdOpts.noRetention`. The same applies to `--no-browser`, read as `!cmdOpts.browser` in the `login` action.

**Where handled:** the `fetch` and `login` command definitions in `src/cli.js`.

## Exit codes are also in the envelope

A consumer that can only see stdout — piped, captured, or read by an agent that never observed the process status — still needs the exit code. It is duplicated at `meta.exitCode`.

`exitCodeFor()` returns the **worst** code across all error-severity diagnostics, and `EXIT.OK` when there are none, which is why warnings never affect it.

**Where handled:** `exitCodeFor()` in `src/diagnostics.js`, surfaced via `meta.exitCode` in `renderEnvelope()`.

## The bin shim is the last line of defence

`bin/ytstats.js` wraps `main()` in a final `.catch()` that writes to stderr and sets exit code 1. Its only job is to guarantee that an unanticipated throw never puts a stack trace on stdout, which is reserved for the JSON document.

**Where handled:** `bin/ytstats.js`.

## Diagnostic detail is folded from context, so callers need not format it

`diagnose()` appends `Option: …`, `Received: …`, `Expected: …`, `Allowed: …`, `Step: …`, `Account: …`, and `Underlying: …` onto `detail` from whatever context keys were supplied. A caller reading only `detail` still learns exactly what was wrong.

Stack-like lines are stripped from context strings by `clean()` — diagnostics are prose, never traces.

**Where handled:** `diagnose()` and `clean()` in `src/diagnostics.js`.
