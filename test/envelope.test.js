import { describe, it, expect } from 'vitest';
import { renderEnvelope, createReporter } from '../src/output.js';
import { diagnose, DIAGNOSTICS, isDiagnostic } from '../src/diagnostics.js';
import { YtStatsError } from '../src/errors.js';

/**
 * The agent-facing contract.
 *
 * The consumer is an LLM in a retry loop, not a human reading a terminal. So the
 * envelope must be shape-stable (same keys every time, success or failure),
 * self-describing (why it failed, precisely), and actionable (what command to run
 * next). Nothing here may ever require reading a stack trace or prose.
 */

describe('envelope shape is invariant', () => {
  const REQUIRED_KEYS = ['ok', 'command', 'fetchedAt', 'data', 'errors', 'warnings', 'nextSteps', 'meta'];

  it('success carries every key', () => {
    const out = JSON.parse(renderEnvelope({ command: 'channel', data: { id: 'UC1' } }));
    expect(Object.keys(out).sort()).toEqual([...REQUIRED_KEYS].sort());
    expect(out.ok).toBe(true);
    expect(out.errors).toEqual([]);
    expect(out.data).toEqual({ id: 'UC1' });
  });

  it('failure carries the same keys, never a missing field', () => {
    const out = JSON.parse(renderEnvelope({
      command: 'channel',
      errors: [diagnose(DIAGNOSTICS.AUTH_NO_TOKENS)],
    }));
    expect(Object.keys(out).sort()).toEqual([...REQUIRED_KEYS].sort());
    expect(out.ok).toBe(false);
  });

  it('data is null on failure, never absent and never partial', () => {
    const out = JSON.parse(renderEnvelope({
      command: 'fetch',
      errors: [diagnose(DIAGNOSTICS.AUTH_NO_TOKENS)],
    }));
    expect(out).toHaveProperty('data');
    expect(out.data).toBeNull();
  });

  it('ok is false whenever there is at least one error', () => {
    const out = JSON.parse(renderEnvelope({
      command: 'x', data: { partial: true },
      errors: [diagnose(DIAGNOSTICS.AUTH_NO_TOKENS)],
    }));
    expect(out.ok).toBe(false);
    expect(out.data).toBeNull();
  });

  it('warnings alone keep ok true and preserve data', () => {
    const out = JSON.parse(renderEnvelope({
      command: 'fetch', data: { rows: [1] },
      warnings: [diagnose(DIAGNOSTICS.DATA_PARTIAL, { step: 'demographics', reason: 'unsupported' })],
    }));
    expect(out.ok).toBe(true);
    expect(out.data).toEqual({ rows: [1] });
    expect(out.warnings).toHaveLength(1);
  });

  it('meta reports version and exit code so the agent need not infer them', () => {
    const out = JSON.parse(renderEnvelope({
      command: 'x', errors: [diagnose(DIAGNOSTICS.INPUT_INVALID_DATE, { flag: '--start', value: 'x' })],
    }));
    expect(out.meta.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(out.meta.exitCode).toBe(3);
    expect(out.meta.helpCommand).toBe('ytstats --help');
  });
});

describe('every diagnostic is actionable', () => {
  const all = Object.values(DIAGNOSTICS);

  it('the catalog is non-trivial', () => {
    expect(all.length).toBeGreaterThan(20);
  });

  it.each(all.map(d => [d.code, d]))('%s is fully specified', (_code, def) => {
    const d = diagnose(def, { flag: '--x', value: 'y', step: 's', reason: 'r', account: 'a', detail: 'd' });

    expect(isDiagnostic(d)).toBe(true);
    expect(d.code).toMatch(/^[A-Z][A-Z0-9_]+$/);
    expect(['error', 'warning']).toContain(d.severity);
    expect(d.title.length).toBeGreaterThan(5);
    expect(d.detail.length).toBeGreaterThan(15);
    expect(typeof d.recoverable).toBe('boolean');
    expect(typeof d.retryable).toBe('boolean');

    // The whole point: something concrete to do next.
    expect(d.remediation.summary.length).toBeGreaterThan(10);
    expect(Array.isArray(d.remediation.steps)).toBe(true);
    expect(d.remediation.steps.length).toBeGreaterThan(0);
  });

  it.each(all.filter(d => d.recoverable).map(d => [d.code, d]))(
    '%s offers at least one runnable command',
    (_code, def) => {
      const d = diagnose(def, { flag: '--x', value: 'y' });
      expect(d.remediation.commands.length).toBeGreaterThan(0);
      for (const c of d.remediation.commands) {
        expect(c.run).toMatch(/^ytstats /);
        expect(c.description.length).toBeGreaterThan(5);
      }
    },
  );

  it('never leaks a stack trace into a diagnostic', () => {
    const d = diagnose(DIAGNOSTICS.UNEXPECTED, { detail: 'boom\n    at foo (/x/y.js:1:2)' });
    expect(JSON.stringify(d)).not.toMatch(/ {4}at .*:\d+:\d+/);
  });
});

describe('authentication failures are differentiated', () => {
  // One generic "not authenticated" forces the agent to guess. Each distinct
  // cause gets its own code and its own recovery path.
  const codes = [
    'AUTH_NO_CREDENTIALS',
    'AUTH_NO_TOKENS',
    'AUTH_TOKEN_EXPIRED',
    'AUTH_TOKEN_REVOKED',
    'AUTH_ACCOUNT_UNKNOWN',
    'AUTH_CONSENT_DECLINED',
    'AUTH_NO_CHANNEL',
    'AUTH_SERVICE_ACCOUNT',
  ];

  it.each(codes)('%s exists as its own diagnostic', code => {
    expect(DIAGNOSTICS[code]).toBeDefined();
    expect(DIAGNOSTICS[code].code).toBe(code);
  });

  it('distinguishes "no client secret" from "never logged in"', () => {
    const noCreds = diagnose(DIAGNOSTICS.AUTH_NO_CREDENTIALS);
    const noTokens = diagnose(DIAGNOSTICS.AUTH_NO_TOKENS);

    expect(noCreds.remediation.steps.join(' ')).toMatch(/Google Cloud|OAuth client/i);
    expect(noTokens.remediation.commands[0].run).toMatch(/^ytstats login/);
    expect(noCreds.detail).not.toBe(noTokens.detail);
  });

  it('tells the agent an expired token is retryable after a login', () => {
    const d = diagnose(DIAGNOSTICS.AUTH_TOKEN_EXPIRED);
    expect(d.recoverable).toBe(true);
    expect(d.remediation.commands.some(c => c.run.startsWith('ytstats login'))).toBe(true);
    // The 7-day Testing-mode trap is the usual cause; say so.
    expect(d.remediation.steps.join(' ')).toMatch(/Testing|Production/);
  });

  it('marks a service account as unrecoverable — no amount of retrying helps', () => {
    const d = diagnose(DIAGNOSTICS.AUTH_SERVICE_ACCOUNT);
    expect(d.recoverable).toBe(false);
    expect(d.retryable).toBe(false);
    expect(d.detail).toMatch(/service account/i);
  });
});

describe('input failures name the offending flag and the valid values', () => {
  it('an unknown command lists what is available', () => {
    const d = diagnose(DIAGNOSTICS.INPUT_UNKNOWN_COMMAND, {
      value: 'nonsense', allowed: ['channel', 'videos', 'fetch'],
    });
    expect(d.context.value).toBe('nonsense');
    expect(d.context.allowed).toEqual(['channel', 'videos', 'fetch']);
    expect(d.remediation.commands.some(c => c.run === 'ytstats --help')).toBe(true);
  });

  it('an invalid choice reports flag, value and allowed set', () => {
    const d = diagnose(DIAGNOSTICS.INPUT_INVALID_CHOICE, {
      flag: '--type', value: 'BOGUS', allowed: ['SHORTS', 'VIDEO_ON_DEMAND'],
    });
    expect(d.context).toMatchObject({ flag: '--type', value: 'BOGUS' });
    expect(d.detail).toMatch(/BOGUS/);
    expect(d.detail).toMatch(/SHORTS/);
  });

  it('a missing required option names it', () => {
    const d = diagnose(DIAGNOSTICS.INPUT_MISSING_REQUIRED, { flag: '--metrics' });
    expect(d.detail).toMatch(/--metrics/);
  });

  it('a bad date states the expected format', () => {
    const d = diagnose(DIAGNOSTICS.INPUT_INVALID_DATE, { flag: '--start', value: '01/01/2026' });
    expect(d.context.expected).toMatch(/YYYY-MM-DD/);
    expect(d.detail).toMatch(/01\/01\/2026/);
  });
});

describe('multiple problems are reported together', () => {
  it('collects every error rather than stopping at the first', () => {
    const out = JSON.parse(renderEnvelope({
      command: 'daily',
      errors: [
        diagnose(DIAGNOSTICS.INPUT_INVALID_DATE, { flag: '--start', value: '01/01/2026' }),
        diagnose(DIAGNOSTICS.INPUT_INVALID_DATE, { flag: '--end', value: 'yesterday' }),
      ],
    }));
    expect(out.errors).toHaveLength(2);
    expect(out.errors.map(e => e.context.flag)).toEqual(['--start', '--end']);
  });

  it('nextSteps flattens remediation into an ordered, deduplicated command list', () => {
    const out = JSON.parse(renderEnvelope({
      command: 'fetch',
      errors: [diagnose(DIAGNOSTICS.AUTH_NO_TOKENS), diagnose(DIAGNOSTICS.AUTH_NO_TOKENS)],
    }));
    expect(out.nextSteps.length).toBeGreaterThan(0);
    expect(new Set(out.nextSteps).size).toBe(out.nextSteps.length);
  });
});

describe('reporter still guarantees stream discipline', () => {
  it('writes exactly one JSON document to stdout on failure', () => {
    const stdout = [], stderr = [];
    const r = createReporter({ stdout: s => stdout.push(s), stderr: s => stderr.push(s) });
    r.progress('working...');
    r.fail('channel', [diagnose(DIAGNOSTICS.AUTH_NO_TOKENS)]);

    expect(stdout).toHaveLength(1);
    const out = JSON.parse(stdout[0]);
    expect(out.ok).toBe(false);
    expect(out.errors[0].code).toBe('AUTH_NO_TOKENS');
  });

  it('accepts a YtStatsError and converts it to a diagnostic', () => {
    const stdout = [];
    const r = createReporter({ stdout: s => stdout.push(s), stderr: () => {} });
    r.fail('channel', new YtStatsError('boom', { diagnostic: diagnose(DIAGNOSTICS.AUTH_TOKEN_EXPIRED) }));
    expect(JSON.parse(stdout[0]).errors[0].code).toBe('AUTH_TOKEN_EXPIRED');
  });

  it('converts an unrecognised throw into UNEXPECTED rather than crashing', () => {
    const stdout = [];
    const r = createReporter({ stdout: s => stdout.push(s), stderr: () => {} });
    r.fail('channel', new Error('kaboom'));
    const out = JSON.parse(stdout[0]);
    expect(out.errors[0].code).toBe('UNEXPECTED');
    expect(out.errors[0].detail).toMatch(/kaboom/);
  });
});

describe('exit codes stay coherent with ok', () => {
  it('a diagnostic routed through warn() never forces a non-zero exit', () => {
    const stdout = [];
    const r = createReporter({ stdout: s => stdout.push(s), stderr: () => {} });
    // AUTH_NO_TOKENS is severity:error in the catalog; warn() downgrades it.
    r.warn(diagnose(DIAGNOSTICS.AUTH_NO_TOKENS));
    const code = r.succeed('doctor', { healthy: false });

    const out = JSON.parse(stdout[0]);
    expect(out.ok).toBe(true);
    expect(code).toBe(0);
    expect(out.meta.exitCode).toBe(0);
    expect(out.warnings[0].severity).toBe('warning');
    // The full remediation survives the downgrade.
    expect(out.warnings[0].remediation.commands.length).toBeGreaterThan(0);
  });

  it('meta.exitCode always equals the process exit code', () => {
    const stdout = [];
    const r = createReporter({ stdout: s => stdout.push(s), stderr: () => {} });
    const code = r.fail('channel', [diagnose(DIAGNOSTICS.AUTH_NO_TOKENS)]);
    expect(JSON.parse(stdout[0]).meta.exitCode).toBe(code);
  });
});
