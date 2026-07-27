import { describe, it, expect } from 'vitest';
import { validateClientId } from '../src/auth/credentials.js';

/**
 * Regression guard for a real incident: a malformed client ID does not fail via
 * the API. Google renders "Access blocked: Authorization Error" in the browser
 * and never redirects, so login blocked for five minutes and then reported
 * AUTH_TIMEOUT — whose advice ("retry") could never work.
 */
describe('client ID pre-flight validation', () => {
  it('accepts a real Google client ID', () => {
    expect(validateClientId('123456789012-abc123def456.apps.googleusercontent.com')).toBeNull();
  });

  it('accepts underscores in the hash segment', () => {
    expect(validateClientId('12345-a_b_c123.apps.googleusercontent.com')).toBeNull();
  });

  it('rejects anything without the Google suffix, before any browser opens', () => {
    const err = (() => { try { validateClientId('not-a-client-id'); } catch (e) { return e; } })();
    expect(err.code).toBe('AUTH_CLIENT_ID_INVALID');
    expect(err.diagnostic.retryable).toBe(false);
    expect(err.diagnostic.context.expected).toMatch(/apps\.googleusercontent\.com/);
  });

  it.each([undefined, null, '', 'GOCSPX-a-secret-not-an-id'])('rejects %s', value => {
    expect(() => validateClientId(value)).toThrow();
  });

  it('warns but does not block on an unusual-but-suffixed ID', () => {
    // Exactly the shape that caused the five-minute hang.
    const w = validateClientId('123.apps.googleusercontent.com');
    expect(w.code).toBe('AUTH_CLIENT_ID_SUSPICIOUS');
    expect(w.severity).toBe('warning');
    expect(w.detail).toMatch(/Access blocked/);
  });

  it('truncates an absurdly long value rather than echoing it whole', () => {
    const err = (() => { try { validateClientId('x'.repeat(500)); } catch (e) { return e; } })();
    expect(err.diagnostic.context.value.length).toBeLessThan(70);
  });
});

describe('AUTH_TIMEOUT no longer gives advice that cannot work', () => {
  it('names "Access blocked" as the likely cause and is not marked retryable', async () => {
    const { DIAGNOSTICS, diagnose } = await import('../src/diagnostics.js');
    const d = diagnose(DIAGNOSTICS.AUTH_TIMEOUT);
    expect(d.retryable).toBe(false);
    expect(d.cause).toMatch(/Access blocked/);
    expect(d.remediation.steps.join(' ')).toMatch(/credentials|consent/i);
  });
});
