import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { useTempConfigDir } from '../helpers/tmp.js';
import { getAuthenticatedClient, login, logout, identifyLegacyTokens } from '../../src/auth/session.js';
import { saveCredentials } from '../../src/auth/credentials.js';
import { saveAccount, loadAccount, listAccounts } from '../../src/auth/tokens.js';
import { ERROR_CODES } from '../../src/errors.js';

const TOKENS = { access_token: 'ya29.aaa', refresh_token: '1//refresh-a', expiry_date: 999 };

/** Stand-in for google.auth.OAuth2 — same surface, no network. */
class FakeOAuth2 extends EventEmitter {
  constructor(clientId, clientSecret, redirectUri) {
    super();
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
    this.credentials = {};
    this.revoked = [];
  }
  setCredentials(c) { this.credentials = c; }
  async getToken() { return { tokens: TOKENS }; }
  async revokeToken(t) { this.revoked.push(t); }
}

function deps(overrides = {}) {
  return {
    OAuth2: FakeOAuth2,
    fetchIdentity: vi.fn(async () => ({
      channelId: 'UC-abc',
      channelTitle: 'Nic Dao',
      customUrl: '@nicolasdao',
    })),
    startLoopbackServer: vi.fn(async () => ({
      port: 51000,
      address: '127.0.0.1',
      redirectUri: 'http://127.0.0.1:51000',
      waitForCode: async () => ({ code: 'auth-code' }),
      close: vi.fn(),
    })),
    openBrowser: vi.fn(async () => {}),
    log: vi.fn(),
    ...overrides,
  };
}

describe('getAuthenticatedClient', () => {
  let tmp;
  beforeEach(() => { tmp = useTempConfigDir(); });
  afterEach(() => tmp.cleanup());

  it('throws AUTH_NO_TOKENS when credentials exist but nobody has logged in', () => {
    saveCredentials({ clientId: 'cid', clientSecret: 'sec' });
    const err = (() => { try { getAuthenticatedClient({ deps: deps() }); } catch (e) { return e; } })();
    expect(err.code).toBe('AUTH_NO_TOKENS');
    expect(err.diagnostic.remediation.commands[0].run).toMatch(/ytstats login/);
  });

  it('reports the missing OAuth client first when nothing at all is configured', () => {
    // Reporting "not signed in" to someone who has not created a Google Cloud
    // project would send them to `login`, which cannot possibly succeed yet.
    const err = (() => {
      try { getAuthenticatedClient({ deps: deps(), env: {}, cwd: tmp.dir }); } catch (e) { return e; }
    })();
    expect(err.code).toBe('AUTH_NO_CREDENTIALS');
    expect(err.diagnostic.remediation.steps.join(' ')).toMatch(/console\.cloud\.google\.com/);
  });

  it('rejects a token issued by a different OAuth client, precisely', () => {
    // Google binds a refresh token to the issuing client, so this would fail at
    // refresh time as invalid_grant -> AUTH_TOKEN_EXPIRED, which blames the
    // consent screen and sends the caller to fix entirely the wrong thing.
    saveCredentials({ clientId: 'client-B', clientSecret: 'sec-B' });
    saveAccount({ channelId: 'UC-abc', channelTitle: 'Nic', clientId: 'client-A', tokens: TOKENS });

    const err = (() => {
      try { getAuthenticatedClient({ deps: deps(), env: {}, cwd: tmp.dir }); } catch (e) { return e; }
    })();

    expect(err.code).toBe('AUTH_CLIENT_MISMATCH');
    expect(err.diagnostic.context.expected).toBe('client-A');
    expect(err.diagnostic.context.value).toBe('client-B');
    expect(err.diagnostic.retryable).toBe(false);
  });

  it('allows an account whose client matches the resolved one', () => {
    saveCredentials({ clientId: 'client-A', clientSecret: 'sec-A' });
    saveAccount({ channelId: 'UC-abc', channelTitle: 'Nic', clientId: 'client-A', tokens: TOKENS });
    const { account } = getAuthenticatedClient({ deps: deps(), env: {}, cwd: tmp.dir });
    expect(account.channelId).toBe('UC-abc');
  });

  it('allows an account stored before clientId was recorded', () => {
    // Backward compatibility: an absent binding is unknown, not a mismatch.
    // Failing these would log out every existing user on upgrade.
    saveCredentials({ clientId: 'client-B', clientSecret: 'sec-B' });
    saveAccount({ channelId: 'UC-abc', channelTitle: 'Nic', tokens: TOKENS });
    const { account } = getAuthenticatedClient({ deps: deps(), env: {}, cwd: tmp.dir });
    expect(account.channelId).toBe('UC-abc');
  });

  it('checks the account selector before the client binding', () => {
    // An unknown --account is the more specific complaint; reporting a mismatch
    // for a channel that is not even signed in would misdirect.
    saveCredentials({ clientId: 'client-B', clientSecret: 'sec-B' });
    saveAccount({ channelId: 'UC-abc', channelTitle: 'Nic', clientId: 'client-A', tokens: TOKENS });
    const err = (() => {
      try {
        getAuthenticatedClient({ account: 'UC-nope', deps: deps(), env: {}, cwd: tmp.dir });
      } catch (e) { return e; }
    })();
    expect(err.code).toBe('AUTH_ACCOUNT_UNKNOWN');
  });

  it('throws MISSING_CREDENTIALS when tokens exist but the client secret is gone', () => {
    saveAccount({ channelId: 'UC-abc', channelTitle: 'Nic', tokens: TOKENS });
    const err = (() => {
      try { getAuthenticatedClient({ deps: deps(), env: {}, cwd: tmp.dir }); } catch (e) { return e; }
    })();
    expect(err.code).toBe('AUTH_NO_CREDENTIALS');
  });

  it('returns a client primed with the stored tokens', () => {
    saveCredentials({ clientId: 'cid', clientSecret: 'sec' });
    saveAccount({ channelId: 'UC-abc', channelTitle: 'Nic', tokens: TOKENS });
    const { client, account } = getAuthenticatedClient({ deps: deps() });
    expect(client.credentials).toEqual(TOKENS);
    expect(client.clientId).toBe('cid');
    expect(account.channelId).toBe('UC-abc');
  });

  it('persists rotated tokens when the client refreshes them', () => {
    saveCredentials({ clientId: 'cid', clientSecret: 'sec' });
    saveAccount({ channelId: 'UC-abc', channelTitle: 'Nic', tokens: TOKENS });
    const { client } = getAuthenticatedClient({ deps: deps() });

    client.emit('tokens', { access_token: 'ya29.rotated', expiry_date: 4242 });

    const stored = loadAccount('UC-abc').tokens;
    expect(stored.access_token).toBe('ya29.rotated');
    expect(stored.expiry_date).toBe(4242);
    // Google omits refresh_token on refresh; the original must survive.
    expect(stored.refresh_token).toBe('1//refresh-a');
  });

  it('selects a named account', () => {
    saveCredentials({ clientId: 'cid', clientSecret: 'sec' });
    saveAccount({ channelId: 'UC-1', channelTitle: 'One', tokens: TOKENS });
    saveAccount({ channelId: 'UC-2', channelTitle: 'Two', tokens: TOKENS });
    const { account } = getAuthenticatedClient({ account: 'UC-2', deps: deps() });
    expect(account.channelId).toBe('UC-2');
  });

  it('fails loudly for an unknown --account instead of using the default', () => {
    saveCredentials({ clientId: 'cid', clientSecret: 'sec' });
    saveAccount({ channelId: 'UC-1', channelTitle: 'One', tokens: TOKENS });
    const err = (() => {
      try { getAuthenticatedClient({ account: 'UC-ghost', deps: deps() }); } catch (e) { return e; }
    })();
    expect(err.code).toBe('AUTH_ACCOUNT_UNKNOWN');
    expect(err.message).toMatch(/UC-ghost/);
  });
});

describe('login', () => {
  let tmp;
  beforeEach(() => { tmp = useTempConfigDir(); });
  afterEach(() => tmp.cleanup());

  it('runs the loopback flow and stores tokens plus credentials', async () => {
    const d = deps();
    const result = await login({
      credentials: { clientId: '123456789012-abc123def456.apps.googleusercontent.com', clientSecret: 'sec', source: 'file.json' },
      deps: d,
    });

    expect(result.channelId).toBe('UC-abc');
    expect(result.channelTitle).toBe('Nic Dao');
    expect(loadAccount('UC-abc').tokens.refresh_token).toBe('1//refresh-a');
    expect(listAccounts()).toHaveLength(1);
    expect(d.openBrowser).toHaveBeenCalledOnce();
  });

  it('records the scopes Google granted, split out of the token response', async () => {
    // What came back, not what was asked for. The captions scope is opt-in, so the
    // grant varies per login and cannot be inferred from the SCOPES constant.
    class Granting extends FakeOAuth2 {
      async getToken() {
        return {
          tokens: {
            ...TOKENS,
            scope: 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/yt-analytics.readonly',
          },
        };
      }
    }
    await login({
      credentials: { clientId: '123456789012-abc123def456.apps.googleusercontent.com', clientSecret: 'sec' },
      deps: deps({ OAuth2: Granting }),
    });
    expect(loadAccount('UC-abc').scopes).toEqual([
      'https://www.googleapis.com/auth/youtube.readonly',
      'https://www.googleapis.com/auth/yt-analytics.readonly',
    ]);
    expect(listAccounts()[0].scopes).toHaveLength(2);
  });

  it('stores null rather than synthesizing scopes when the response carries none', async () => {
    // A fabricated grant record is worse than no record: a pre-flight scope check
    // would trust it and refuse a call the token is actually authorized to make.
    await login({
      credentials: { clientId: '123456789012-abc123def456.apps.googleusercontent.com', clientSecret: 'sec' },
      deps: deps(),
    });
    expect(loadAccount('UC-abc').scopes).toBeNull();
  });

  it('requests the captions scope only when --with-captions is used', async () => {
    const d = deps();
    await login({
      credentials: { clientId: '123456789012-abc123def456.apps.googleusercontent.com', clientSecret: 'sec' },
      withCaptions: true,
      deps: d,
    });
    const scope = new URL(d.openBrowser.mock.calls[0][0]).searchParams.get('scope');
    expect(scope).toContain('youtube.force-ssl');
    expect(scope.split(' ')).toHaveLength(4);
  });

  it('never requests the captions scope by default', async () => {
    // The read-only guarantee: an ordinary login must not quietly acquire write access.
    const d = deps();
    await login({
      credentials: { clientId: '123456789012-abc123def456.apps.googleusercontent.com', clientSecret: 'sec' },
      deps: d,
    });
    const scope = new URL(d.openBrowser.mock.calls[0][0]).searchParams.get('scope');
    expect(scope).not.toContain('force-ssl');
    expect(scope.split(' ')).toHaveLength(3);
  });

  it('carries the captions scope through the --no-browser flow too', async () => {
    // The paste flow builds its own auth URL, so it is a second place the scope
    // list has to reach — and the one a headless user hits.
    const logged = [];
    const d = deps({
      log: msg => logged.push(msg),
      promptForRedirectUrl: vi.fn(async () => 'http://127.0.0.1:1/?code=pasted-code'),
    });
    await login({
      credentials: { clientId: '123456789012-abc123def456.apps.googleusercontent.com', clientSecret: 'sec' },
      noBrowser: true,
      withCaptions: true,
      deps: d,
    });
    const authUrl = logged.find(m => m.includes('accounts.google.com'));
    expect(new URL(authUrl.trim()).searchParams.get('scope')).toContain('youtube.force-ssl');
  });

  it('opens the browser at Google, not at the loopback server', async () => {
    const d = deps();
    await login({ credentials: { clientId: '123456789012-abc123def456.apps.googleusercontent.com', clientSecret: 'sec' }, deps: d });
    const url = d.openBrowser.mock.calls[0][0];
    expect(url).toMatch(/^https:\/\/accounts\.google\.com/);
    expect(url).toMatch(/code_challenge_method=S256/);
  });

  it('sends the PKCE verifier when redeeming the code', async () => {
    let seen;
    class Spy extends FakeOAuth2 {
      async getToken(opts) { seen = opts; return { tokens: TOKENS }; }
    }
    await login({
      credentials: { clientId: '123456789012-abc123def456.apps.googleusercontent.com', clientSecret: 'sec' },
      deps: deps({ OAuth2: Spy }),
    });
    expect(seen.code).toBe('auth-code');
    expect(seen.codeVerifier).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(seen.redirect_uri).toBe('http://127.0.0.1:51000');
  });

  it('always shuts the loopback server down, even when the flow fails', async () => {
    const close = vi.fn();
    const d = deps({
      startLoopbackServer: vi.fn(async () => ({
        port: 1, address: '127.0.0.1', redirectUri: 'http://127.0.0.1:1',
        waitForCode: async () => { throw new Error('user bailed'); },
        close,
      })),
    });
    await expect(login({ credentials: { clientId: '123456789012-abc123def456.apps.googleusercontent.com', clientSecret: 's' }, deps: d })).rejects.toThrow();
    expect(close).toHaveBeenCalled();
  });

  it('does not persist anything when identity lookup fails', async () => {
    const d = deps({ fetchIdentity: vi.fn(async () => { throw new Error('boom'); }) });
    await expect(login({ credentials: { clientId: '123456789012-abc123def456.apps.googleusercontent.com', clientSecret: 's' }, deps: d })).rejects.toThrow();
    expect(listAccounts()).toEqual([]);
  });

  it('reports NO_YOUTUBE_CHANNEL when the account owns no channel', async () => {
    const d = deps({ fetchIdentity: vi.fn(async () => null) });
    const err = await login({ credentials: { clientId: '123456789012-abc123def456.apps.googleusercontent.com', clientSecret: 's' }, deps: d }).catch(e => e);
    expect(err.code).toBe('AUTH_NO_CHANNEL');
  });

  it('skips the browser in --no-browser mode and uses the pasted URL', async () => {
    const d = deps({
      promptForRedirectUrl: vi.fn(async () => 'http://127.0.0.1:51000/?code=pasted-code&state=IGNORED'),
    });
    const result = await login({
      credentials: { clientId: '123456789012-abc123def456.apps.googleusercontent.com', clientSecret: 's' },
      noBrowser: true,
      deps: d,
    });
    expect(result.channelId).toBe('UC-abc');
    expect(d.openBrowser).not.toHaveBeenCalled();
    expect(d.startLoopbackServer).not.toHaveBeenCalled();
  });
});

describe('logout', () => {
  let tmp;
  beforeEach(() => { tmp = useTempConfigDir(); });
  afterEach(() => tmp.cleanup());

  it('revokes the token with Google and forgets the account', async () => {
    saveCredentials({ clientId: 'cid', clientSecret: 'sec' });
    saveAccount({ channelId: 'UC-abc', channelTitle: 'Nic', tokens: TOKENS });

    const result = await logout({ deps: deps() });
    expect(result.revoked).toBe(true);
    expect(loadAccount('UC-abc')).toBeNull();
  });

  it('still forgets the account when revocation fails offline', async () => {
    saveCredentials({ clientId: 'cid', clientSecret: 'sec' });
    saveAccount({ channelId: 'UC-abc', channelTitle: 'Nic', tokens: TOKENS });

    class Offline extends FakeOAuth2 {
      async revokeToken() { throw new Error('ENOTFOUND'); }
    }
    const result = await logout({ deps: deps({ OAuth2: Offline }) });
    expect(result.revoked).toBe(false);
    expect(loadAccount('UC-abc')).toBeNull();
  });

  it('is a no-op when nobody is logged in', async () => {
    const result = await logout({ deps: deps() });
    expect(result.loggedOut).toBe(false);
  });

  it('--all clears every account and the stored client secret', async () => {
    saveCredentials({ clientId: 'cid', clientSecret: 'sec' });
    saveAccount({ channelId: 'UC-1', channelTitle: 'One', tokens: TOKENS });
    saveAccount({ channelId: 'UC-2', channelTitle: 'Two', tokens: TOKENS });

    await logout({ all: true, forgetCredentials: true, deps: deps() });
    expect(listAccounts()).toEqual([]);
  });
});

describe('identifyLegacyTokens', () => {
  let tmp;
  beforeEach(() => { tmp = useTempConfigDir(); });
  afterEach(() => tmp.cleanup());

  const CREDS = { clientId: 'cid', clientSecret: 'sec' };

  it('returns the channel identity the legacy tokens belong to', async () => {
    const identity = await identifyLegacyTokens({
      credentials: CREDS, tokens: TOKENS, deps: deps(),
    });
    expect(identity.channelId).toBe('UC-abc');
  });

  it('maps an expired legacy refresh token to AUTH_TOKEN_EXPIRED, not UNEXPECTED', async () => {
    // The whole point of a migration is that the old setup went stale, so this is
    // the *expected* failure. Reporting UNEXPECTED tells the user to file a bug
    // against a tool that is working correctly — and its recoverable:false stops
    // an agent dead instead of sending it to `ytstats login`.
    const err = await identifyLegacyTokens({
      credentials: CREDS,
      tokens: TOKENS,
      deps: deps({ fetchIdentity: async () => { throw new Error('invalid_grant'); } }),
    }).catch(e => e);

    // The envelope surfaces the DIAGNOSTICS vocabulary; err.code carries the
    // coarser internal ERROR_CODES value. Assert on what the caller actually sees.
    expect(err.diagnostic.code).toBe('AUTH_TOKEN_EXPIRED');
    expect(err.diagnostic.recoverable).toBe(true);
    expect(err.diagnostic.remediation.commands.some(c => /ytstats login/.test(c.run))).toBe(true);
  });

  it('maps a revoked legacy token to AUTH_TOKEN_REVOKED', async () => {
    const err = await identifyLegacyTokens({
      credentials: CREDS,
      tokens: TOKENS,
      deps: deps({ fetchIdentity: async () => { throw new Error('invalid_grant: token revoked'); } }),
    }).catch(e => e);
    expect(err.diagnostic.code).toBe('AUTH_TOKEN_REVOKED');
  });

  it('never reports a Google failure as UNEXPECTED', async () => {
    const err = await identifyLegacyTokens({
      credentials: CREDS,
      tokens: TOKENS,
      deps: deps({ fetchIdentity: async () => { throw new Error('quotaExceeded'); } }),
    }).catch(e => e);
    expect(err.diagnostic.code).not.toBe('UNEXPECTED');
    expect(err.diagnostic.code).toBe('API_QUOTA_EXCEEDED');
  });
});
