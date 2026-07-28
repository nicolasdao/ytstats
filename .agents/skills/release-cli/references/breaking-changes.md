# ytstats Breaking-Change Scan

`ytstats` makes stability promises that a generic diff read will miss. A removed diagnostic `code` is one deleted line that looks cosmetic and is in fact a public-API break — consumers branch on those values.

Source of truth: `docs/contributing.md` § The stability contract, and `docs/output-contract.md`.

Run this scan in Step 4, **after** classifying and **before** proposing a bump. When it fires, warn and ask the user to confirm the bump level. Never force major silently.

## What counts as breaking

| Signal | Why it breaks consumers |
|---|---|
| A diagnostic `code` removed or repurposed | Codes are public API — agents and scripts branch on them |
| An envelope key removed or renamed | The envelope is shape-invariant; consumers never check for existence |
| `data` populated while `ok` is false | Contract says `data` is `null` on failure, never partial |
| A command removed or renamed | Scripted callers invoke by name |
| A flag removed, or its default changed meaningfully | Same |
| An exit code remapped to a different class | Callers branch on 0/1/2/3/4 |
| An export dropped from `src/index.js` | The library surface is public |

Adding a new diagnostic code, command, flag, or export is **not** breaking — it is `Added`, a minor bump.

## Scan procedure

Set `BASE` to the last release tag, or the initial commit when no tag exists.

**1. Diagnostic codes removed or renamed**

```bash
git diff $BASE..HEAD -- src/diagnostics.js | grep -E "^-\s+code: '" 
git diff $BASE..HEAD -- src/errors.js | grep -E "^-\s+[A-Z_]+: '"
```

Any removed `code:` line is a candidate break. Cross-check that it was not simply moved — compare the full before/after code lists rather than trusting the diff hunk:

```bash
git show $BASE:src/diagnostics.js | grep -oE "code: '[A-Z_]+'" | sort -u > /tmp/codes-before
grep -oE "code: '[A-Z_]+'" src/diagnostics.js | sort -u > /tmp/codes-after
comm -23 /tmp/codes-before /tmp/codes-after   # present before, gone now = breaking
comm -13 /tmp/codes-before /tmp/codes-after   # new codes = Added, minor
```

**2. Envelope shape changed**

```bash
git diff $BASE..HEAD -- src/output.js
```

Look at `renderEnvelope()`. The keys `ok`, `command`, `fetchedAt`, `data`, `errors`, `warnings`, `nextSteps`, `meta` must all still be present unconditionally. A key becoming conditional is as breaking as removing it — the invariant is that consumers never branch on existence.

Also confirm `data` is still forced to `null` when `ok` is false.

**3. Commands removed or renamed**

```bash
git show $BASE:src/cli.js | grep -oE "\.command\('[a-z-]+" | sort -u > /tmp/cmds-before
grep -oE "\.command\('[a-z-]+" src/cli.js | sort -u > /tmp/cmds-after
comm -23 /tmp/cmds-before /tmp/cmds-after     # removed commands = breaking
```

Remember `simple(...)` also defines commands — check its call sites too, not only literal `.command(` calls.

**4. Exit codes remapped**

```bash
git diff $BASE..HEAD -- src/diagnostics.js src/errors.js | grep -E "EXIT|exitCode"
```

The classes are `0` success, `1` general, `2` auth, `3` input, `4` API. A diagnostic moving between classes changes what a caller's branch does.

**5. Library exports dropped**

```bash
git diff $BASE..HEAD -- src/index.js | grep -E "^-\s*export"
```

## Reporting a finding

Present it concretely — the signal, the evidence, and the consequence:

> The scan found a possible breaking change. `AUTH_CLIENT_ID_SUSPICIOUS` was present in `src/diagnostics.js` at v0.1.0 and is gone at HEAD. Diagnostic codes are public API per `docs/contributing.md`, so removing one is a major bump. Your changes otherwise read as a minor.
>
> Bump as major, or was this code never released?

That last question matters. A code added *and* removed within the same unreleased window was never public, so removing it is not a break. Check whether it appears in any released version before insisting on major.

## Limits of this scan

It is a heuristic over `grep` and diffs, not a type checker. It can miss:

- A code whose **meaning** changed while the string stayed the same — the contract forbids repurposing, and no grep detects it. Session context is the only signal.
- A behavioral change under a stable surface, such as a diagnostic's `retryable` flipping from `true` to `false`.
- A `data` payload whose internal shape changed while the envelope keys held.

Treat a clean scan as "no *detected* break", not proof of compatibility. In Mode A, weigh what you know from the session above what the scan reports.
