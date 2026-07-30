import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import {
  createPkcePair,
  buildAuthUrl,
  startLoopbackServer,
  SCOPES,
  CAPTIONS_SCOPE,
  captionsScopeMissing,
} from '../../src/auth/oauth.js';
import { ERROR_CODES } from '../../src/errors.js';

const base64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

describe('PKCE', () => {
  it('produces a verifier within the RFC 7636 length bounds', () => {
    const { verifier } = createPkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  it('uses only unreserved base64url characters', () => {
    const { verifier, challenge } = createPkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9\-._~]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('derives the challenge as base64url(SHA256(verifier))', () => {
    const { verifier, challenge } = createPkcePair();
    expect(challenge).toBe(base64url(crypto.createHash('sha256').update(verifier).digest()));
  });

  it('is unpredictable across calls', () => {
    const seen = new Set(Array.from({ length: 50 }, () => createPkcePair().verifier));
    expect(seen.size).toBe(50);
  });
});

describe('buildAuthUrl', () => {
  const params = () => {
    const url = new URL(buildAuthUrl({
      clientId: 'cid.apps.googleusercontent.com',
      redirectUri: 'http://127.0.0.1:12345',
      state: 'st-123',
      codeChallenge: 'chal-abc',
    }));
    return url;
  };

  it('points at Google\'s authorization endpoint', () => {
    expect(params().origin + params().pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  });

  it('requests an authorization code with PKCE S256', () => {
    const p = params().searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('code_challenge')).toBe('chal-abc');
    expect(p.get('code_challenge_method')).toBe('S256');
  });

  it('carries the CSRF state and redirect URI', () => {
    const p = params().searchParams;
    expect(p.get('state')).toBe('st-123');
    expect(p.get('redirect_uri')).toBe('http://127.0.0.1:12345');
  });

  it('asks for offline access so a refresh token is issued', () => {
    const p = params().searchParams;
    expect(p.get('access_type')).toBe('offline');
    expect(p.get('prompt')).toBe('consent');
  });

  it('requests exactly the three read-only YouTube scopes', () => {
    const scope = params().searchParams.get('scope');
    expect(scope.split(' ').sort()).toEqual([...SCOPES].sort());
    expect(scope).not.toMatch(/force-ssl|upload|partner/);
  });

  it('enables incremental authorization, so adding a scope later keeps the old ones', () => {
    // What makes the opt-in captions scope additive rather than a replacement.
    expect(params().searchParams.get('include_granted_scopes')).toBe('true');
  });

  it('carries the captions scope only when it is passed explicitly', () => {
    const url = new URL(buildAuthUrl({
      clientId: 'cid.apps.googleusercontent.com',
      redirectUri: 'http://127.0.0.1:12345',
      state: 'st-123',
      codeChallenge: 'chal-abc',
      scopes: [...SCOPES, CAPTIONS_SCOPE],
    }));
    const scope = url.searchParams.get('scope');
    expect(scope).toContain('youtube.force-ssl');
    expect(scope.split(' ')).toHaveLength(4);
  });
});

describe('the captions scope stays out of the default grant', () => {
  it('keeps SCOPES at exactly the three read-only entries', () => {
    // Widening the default would break the read-only promise for every existing
    // user and force them all to re-authorize.
    expect(SCOPES).toHaveLength(3);
    expect(SCOPES).not.toContain(CAPTIONS_SCOPE);
    expect(SCOPES.every(s => s.includes('readonly'))).toBe(true);
  });

  it('is force-ssl, because captions have no read-only scope', () => {
    expect(CAPTIONS_SCOPE).toBe('https://www.googleapis.com/auth/youtube.force-ssl');
  });
});

describe('captionsScopeMissing treats an absent grant as unknown', () => {
  it('reports missing only for a recorded grant that lacks the scope', () => {
    expect(captionsScopeMissing({ scopes: [...SCOPES] })).toBe(true);
  });

  it('reports present when the scope was granted', () => {
    expect(captionsScopeMissing({ scopes: [...SCOPES, CAPTIONS_SCOPE] })).toBe(false);
  });

  it('does not report missing when scopes were never recorded', () => {
    // The upgrade path: accounts stored before the field existed have null, and
    // refusing them would log everyone out of a feature to fix a problem most of
    // them do not have. Let the call run and a real Google 403 speak instead.
    expect(captionsScopeMissing({ scopes: null })).toBe(false);
    expect(captionsScopeMissing({})).toBe(false);
    expect(captionsScopeMissing(undefined)).toBe(false);
  });

  it('reports missing for an empty recorded grant, which is a real answer', () => {
    expect(captionsScopeMissing({ scopes: [] })).toBe(true);
  });
});

describe('loopback callback server', () => {
  async function get(port, pathAndQuery) {
    const res = await fetch(`http://127.0.0.1:${port}${pathAndQuery}`);
    return { status: res.status, body: await res.text() };
  }

  it('binds to loopback only, never 0.0.0.0', async () => {
    const server = await startLoopbackServer({ state: 's' });
    expect(server.address).toBe('127.0.0.1');
    expect(server.redirectUri).toBe(`http://127.0.0.1:${server.port}`);
    server.close();
  });

  it('resolves with the authorization code when state matches', async () => {
    const server = await startLoopbackServer({ state: 'good-state' });
    const [result, page] = await Promise.all([
      server.waitForCode(),
      get(server.port, '/?code=auth-code-xyz&state=good-state'),
    ]);
    expect(result.code).toBe('auth-code-xyz');
    expect(page.status).toBe(200);
    expect(page.body).toMatch(/you can close this (tab|window)/i);
    server.close();
  });

  it('accepts the callback on /callback as well as /', async () => {
    const server = await startLoopbackServer({ state: 's' });
    const [result] = await Promise.all([
      server.waitForCode(),
      get(server.port, '/callback?code=c1&state=s'),
    ]);
    expect(result.code).toBe('c1');
    server.close();
  });

  it('rejects a mismatched state (CSRF defence) and says so on the page', async () => {
    const server = await startLoopbackServer({ state: 'expected' });
    const [err, page] = await Promise.all([
      server.waitForCode().catch(e => e),
      get(server.port, '/?code=c&state=attacker'),
    ]);
    expect(err.code).toBe('AUTH_STATE_MISMATCH');
    expect(err.message).toMatch(/security check|state/i);
    expect(page.status).toBe(400);
    server.close();
  });

  it('maps a user denial to ACCESS_DENIED', async () => {
    const server = await startLoopbackServer({ state: 's' });
    const [err] = await Promise.all([
      server.waitForCode().catch(e => e),
      get(server.port, '/?error=access_denied&state=s'),
    ]);
    expect(err.code).toBe('AUTH_CONSENT_DECLINED');
    server.close();
  });

  it('ignores favicon requests instead of treating them as the callback', async () => {
    const server = await startLoopbackServer({ state: 's' });
    const favicon = await get(server.port, '/favicon.ico');
    expect(favicon.status).toBe(404);

    const [result] = await Promise.all([
      server.waitForCode(),
      get(server.port, '/?code=real&state=s'),
    ]);
    expect(result.code).toBe('real');
    server.close();
  });

  it('times out with AUTH_TIMEOUT when the user never completes the flow', async () => {
    const server = await startLoopbackServer({ state: 's', timeoutMs: 120 });
    const err = await server.waitForCode().catch(e => e);
    expect(err.code).toBe('AUTH_TIMEOUT');
    server.close();
  });

  it('never echoes the authorization code back into the browser page', async () => {
    const server = await startLoopbackServer({ state: 's' });
    const [, page] = await Promise.all([
      server.waitForCode(),
      get(server.port, '/?code=super-secret-code&state=s'),
    ]);
    expect(page.body).not.toMatch(/super-secret-code/);
    server.close();
  });

  it('close() is idempotent', async () => {
    const server = await startLoopbackServer({ state: 's' });
    server.close();
    expect(() => server.close()).not.toThrow();
  });
});
