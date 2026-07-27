import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { diagnose, isDiagnostic, exitCodeFor, DIAGNOSTICS, SEVERITY, EXIT } from './diagnostics.js';
export { SEVERITY, EXIT };
import { redact } from './errors.js';

const pkg = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8'),
);

/**
 * The output contract.
 *
 *   stdout  exactly one JSON document, always, success or failure
 *   stderr  human-readable progress; safe to discard entirely
 *
 * The envelope is shape-invariant: every key is present on every response, so a
 * consumer never has to branch on whether a field exists. On failure `data` is
 * null (never partial, never absent) and `errors` is non-empty.
 *
 *   { ok, command, fetchedAt, data, errors[], warnings[], nextSteps[], meta }
 */

const HELP_COMMAND = 'ytstats --help';

export function renderEnvelope({
  command,
  data = null,
  errors = [],
  warnings = [],
  compact = false,
  fetchedAt,
} = {}) {
  const errorList = errors.map(toDiagnostic).filter(d => d.severity === SEVERITY.ERROR);
  const warningList = [
    ...warnings.map(toDiagnostic),
    ...errors.map(toDiagnostic).filter(d => d.severity === SEVERITY.WARNING),
  ];

  const ok = errorList.length === 0;

  const envelope = {
    ok,
    command: command ?? null,
    fetchedAt: fetchedAt ?? new Date().toISOString(),
    // Never hand back half a dataset alongside an error: a consumer that reads
    // `data` without checking `ok` would silently act on partial results.
    data: ok ? (data ?? null) : null,
    errors: errorList,
    warnings: warningList,
    nextSteps: buildNextSteps([...errorList, ...warningList]),
    meta: {
      version: pkg.version,
      exitCode: exitCodeFor([...errorList, ...warningList]),
      helpCommand: HELP_COMMAND,
      docs: 'https://www.npmjs.com/package/ytstats',
    },
  };

  const json = JSON.stringify(envelope, null, compact ? undefined : 2);
  return redact(json);
}

/** Accept a diagnostic, a YtStatsError carrying one, or any stray throw. */
function toDiagnostic(value) {
  if (isDiagnostic(value)) return value;

  if (value?.diagnostic && isDiagnostic(value.diagnostic)) return value.diagnostic;

  if (value instanceof Error) {
    return diagnose(DIAGNOSTICS.UNEXPECTED, { detail: value.message });
  }

  return diagnose(DIAGNOSTICS.UNEXPECTED, { detail: String(value) });
}

/**
 * Flatten remediation into an ordered, deduplicated list of things to do next.
 * Errors first, warnings after — an agent should fix what blocked it before
 * acting on advisories.
 */
function buildNextSteps(diagnostics) {
  const steps = [];
  const seen = new Set();

  const push = text => {
    const value = String(text).trim();
    if (value && !seen.has(value)) {
      seen.add(value);
      steps.push(value);
    }
  };

  const ordered = [
    ...diagnostics.filter(d => d.severity === SEVERITY.ERROR),
    ...diagnostics.filter(d => d.severity === SEVERITY.WARNING),
  ];

  for (const d of ordered) {
    for (const cmd of d.remediation.commands ?? []) push(`${cmd.run}  # ${cmd.description}`);
    if (!d.remediation.commands?.length) push(d.remediation.summary);
  }

  return steps;
}

/**
 * Reporter bound to a pair of sinks. Injecting them keeps stream discipline
 * directly testable rather than relying on process-level capture.
 */
export function createReporter({
  stdout = s => process.stdout.write(s + '\n'),
  stderr = s => process.stderr.write(s + '\n'),
  quiet = false,
  compact = false,
  exitZero = false,
} = {}) {
  const warningsBuffer = [];

  const reporter = {
    /** Human-facing progress. Never stdout. */
    progress(message) {
      if (!quiet) stderr(redact(String(message)));
    },

    /**
     * Attach a non-fatal diagnostic to the eventual envelope, and echo it for
     * humans. Warnings never make `ok` false and never affect the exit code.
     *
     * Severity is forced to 'warning' here: routing a diagnostic through warn()
     * IS the decision that it is non-fatal. Without this, `doctor` — whose whole
     * job is to report auth problems it found — would exit 2 while reporting
     * ok:true, which is incoherent.
     */
    warn(diagnostic) {
      const d = { ...toDiagnostic(diagnostic), severity: SEVERITY.WARNING };
      warningsBuffer.push(d);
      if (!quiet) stderr(redact(`warning: ${d.title} — ${d.detail}`));
      return d;
    },

    /** Terminal success. Emits the one and only stdout document. */
    succeed(command, data, opts = {}) {
      stdout(renderEnvelope({ command, data, warnings: warningsBuffer, compact, ...opts }));
      return exitZero ? EXIT.OK : exitCodeFor(warningsBuffer);
    },

    /** Terminal failure. Envelope to stdout, guidance to stderr. Returns the exit code. */
    fail(command, errors, opts = {}) {
      const list = (Array.isArray(errors) ? errors : [errors]).map(toDiagnostic);
      stdout(renderEnvelope({ command, errors: [...list, ...warningsBuffer], compact, ...opts }));

      if (!quiet) {
        for (const d of list) {
          stderr(redact(`error [${d.code}]: ${d.title}`));
          stderr(redact(`  ${d.detail}`));
          if (d.remediation.summary) stderr(redact(`  fix: ${d.remediation.summary}`));
          for (const cmd of d.remediation.commands ?? []) stderr(redact(`    $ ${cmd.run}`));
        }
      }

      return exitZero ? EXIT.OK : exitCodeFor(list);
    },
  };

  return reporter;
}
