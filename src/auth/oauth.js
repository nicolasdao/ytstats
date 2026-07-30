import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { YtStatsError, ERROR_CODES, fail } from '../errors.js';
import { DIAGNOSTICS } from '../diagnostics.js';

/**
 * The DEFAULT grant: read-only scopes only. Nothing here can modify a channel,
 * and this is what `ytstats login` requests unless the user opts into more.
 *
 * Do not add CAPTIONS_SCOPE to this list. Read-only is the promise every existing
 * user consented to, and widening the default would silently break it for all of
 * them — as well as forcing everyone to re-authorize, since a new scope
 * invalidates existing consent.
 */
export const SCOPES = Object.freeze([
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
]);

/**
 * OPT-IN only, requested by `ytstats login --with-captions` and nothing else.
 *
 * Captions have no read-only scope: both captions.list and captions.download
 * require youtube.force-ssl, which Google presents as "Manage your YouTube
 * account" — full read/write. That is why it is separate rather than a fourth
 * default, and why `transcript` is the only feature that needs it.
 */
export const CAPTIONS_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

/**
 * Whether a stored account is KNOWN to lack caption access.
 *
 * An absent `scopes` field means unknown, not missing: accounts saved before the
 * field existed have none, and treating that as "missing" would refuse every
 * pre-upgrade account — telling users to re-authorize to fix a problem most of
 * them do not have. Only a present array that lacks the scope is a real answer;
 * anything else lets the call proceed so a genuine Google 403 can speak instead.
 */
export function captionsScopeMissing(account) {
  return Array.isArray(account?.scopes) && !account.scopes.includes(CAPTIONS_SCOPE);
}

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

const base64url = buf =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * RFC 7636 PKCE pair. Protects the authorization code against interception by
 * another local process racing us on the loopback port.
 */
export function createPkcePair() {
  const verifier = base64url(crypto.randomBytes(64)).slice(0, 128);
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** Unguessable value tying the callback back to this specific login attempt. */
export function createState() {
  return base64url(crypto.randomBytes(24));
}

export function buildAuthUrl({ clientId, redirectUri, state, codeChallenge, scopes = SCOPES }) {
  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // offline + consent are what make Google return a refresh token.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  return url.toString();
}

function page(title, body, accent) {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
 body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
      display:flex;align-items:center;justify-content:center;height:100vh;margin:0;
      background:#0f1115;color:#e6e6e6}
 .card{max-width:30rem;padding:2.5rem;text-align:center}
 h1{font-size:1.35rem;margin:0 0 .5rem;color:${accent}}
 p{margin:0;color:#9aa0a6}
</style></head><body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

const SUCCESS_PAGE = page('Signed in to ytstats', 'You can close this tab and return to your terminal.', '#4ade80');
const failPage = reason => page('Sign-in failed', reason, '#f87171');

/**
 * Start the local callback listener.
 *
 * Binds 127.0.0.1 on an ephemeral port — never 0.0.0.0, so nothing off-machine can
 * reach it. The returned promise settles on the first legitimate callback.
 */
export async function startLoopbackServer({ state, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  let resolveCode, rejectCode;
  const codePromise = new Promise((res, rej) => { resolveCode = res; rejectCode = rej; });

  let settled = false;
  const settle = (fn, value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fn(value);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    // The browser asks for this unprompted; it is not the callback.
    if (url.pathname === '/favicon.ico') {
      res.writeHead(404).end();
      return;
    }
    if (url.pathname !== '/' && url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }

    const params = url.searchParams;
    const error = params.get('error');
    const code = params.get('code');
    const returnedState = params.get('state');

    if (error) {
      const denied = error === 'access_denied';
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        .end(failPage(denied ? 'You declined the permission request.' : `Google returned: ${error}`));
      settle(rejectCode, denied
        ? fail(DIAGNOSTICS.AUTH_CONSENT_DECLINED, { detail: `Google returned: ${error}` })
        : fail(DIAGNOSTICS.AUTH_STATE_MISMATCH, { detail: `Google returned: ${error}` }));
      return;
    }

    // Constant-time compare so the state cannot be probed byte by byte.
    if (!returnedState || !safeEqual(returnedState, state)) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        .end(failPage('Security check failed. Please start the login again.'));
      settle(rejectCode, fail(DIAGNOSTICS.AUTH_STATE_MISMATCH));
      return;
    }

    if (!code) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' })
        .end(failPage('No authorization code was returned.'));
      settle(rejectCode, fail(DIAGNOSTICS.AUTH_STATE_MISMATCH, { detail: 'No authorization code in the callback' }));
      return;
    }

    // The success page deliberately contains no code/token material.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(SUCCESS_PAGE);
    settle(resolveCode, { code });
  });

  const timer = setTimeout(() => {
    settle(rejectCode, fail(DIAGNOSTICS.AUTH_TIMEOUT));
  }, timeoutMs);
  timer.unref?.();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  const { port, address } = server.address();
  let closed = false;

  return {
    port,
    address,
    redirectUri: `http://127.0.0.1:${port}`,
    waitForCode: () => codePromise,
    close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      server.close();
      // Nothing should be waiting, but never leave a dangling promise.
      settle(rejectCode, new YtStatsError('Login cancelled.', { code: ERROR_CODES.AUTH_FAILED }));
      codePromise.catch(() => {});
    },
  };
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
