import readline from 'node:readline';
import { google } from 'googleapis';
import open from 'open';
import { resolveCredentials, saveCredentials, clearCredentials, validateClientId } from './credentials.js';
import { saveAccount, loadAccount, removeAccount, clearAllAccounts, listAccounts } from './tokens.js';
import { createPkcePair, createState, buildAuthUrl, startLoopbackServer, SCOPES, CAPTIONS_SCOPE } from './oauth.js';
import { YtStatsError, ERROR_CODES, mapGoogleError, fail } from '../errors.js';
import { DIAGNOSTICS } from '../diagnostics.js';

/**
 * Everything that touches the network or the terminal is injected, so the whole
 * session layer is testable without hitting Google or opening a browser.
 */
function defaultDeps() {
  return {
    OAuth2: google.auth.OAuth2,
    startLoopbackServer,
    openBrowser: url => open(url),
    fetchIdentity: defaultFetchIdentity,
    promptForRedirectUrl: defaultPrompt,
    log: msg => process.stderr.write(msg + '\n'),
  };
}

async function defaultFetchIdentity(client) {
  const yt = google.youtube({ version: 'v3', auth: client });
  const res = await yt.channels.list({ part: 'snippet,contentDetails', mine: true });
  const channel = res.data.items?.[0];
  if (!channel) return null;
  return {
    channelId: channel.id,
    channelTitle: channel.snippet?.title ?? null,
    customUrl: channel.snippet?.customUrl ?? null,
    uploadsPlaylistId: channel.contentDetails?.relatedPlaylists?.uploads ?? null,
  };
}

function defaultPrompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => rl.question(question, answer => { rl.close(); resolve(answer); }));
}

function newClient(deps, { clientId, clientSecret }, redirectUri) {
  const Ctor = deps.OAuth2;
  return new Ctor(clientId, clientSecret, redirectUri);
}

/**
 * Build an OAuth client bound to a stored account, wired so that any token Google
 * rotates during the process lifetime is written back to disk.
 */
export function getAuthenticatedClient({ account: selector, clientSecretPath, env, cwd, deps: injected } = {}) {
  const deps = { ...defaultDeps(), ...injected };

  // Distinguish the ways "not authenticated" can happen — each has a different
  // fix, so each gets its own diagnostic.
  //
  // Credentials are diagnosed BEFORE tokens: an OAuth client is the prerequisite
  // for logging in at all, so reporting "not signed in" to someone who has not
  // yet created a Google Cloud project sends them down the wrong recovery path.
  const credentials = resolveCredentials({ clientSecretPath, env, cwd });

  const account = loadAccount(selector);
  if (!account) {
    const known = listAccounts();
    if (selector) {
      throw fail(DIAGNOSTICS.AUTH_ACCOUNT_UNKNOWN, {
        account: selector,
        allowed: known.map(a => a.channelId),
        detail: known.length
          ? `Signed in: ${known.map(a => `${a.channelTitle ?? a.channelId} (${a.channelId})`).join(', ')}`
          : 'No channels are signed in on this machine.',
      });
    }
    throw fail(DIAGNOSTICS.AUTH_NO_TOKENS, {
      detail: `OAuth client resolved from: ${credentials.source}`,
    });
  }

  // Google binds a refresh token to the client that issued it, so a mismatch
  // here fails at refresh time as invalid_grant — which maps to
  // AUTH_TOKEN_EXPIRED and blames the consent screen. Diagnose it precisely
  // instead. Accounts stored before clientId was recorded have none, and must
  // keep working: only an actual disagreement is an error.
  if (account.clientId && account.clientId !== credentials.clientId) {
    throw fail(DIAGNOSTICS.AUTH_CLIENT_MISMATCH, {
      account: account.channelTitle ?? account.channelId,
      expected: account.clientId,
      value: credentials.clientId,
      detail: `Resolved from: ${credentials.source}`,
    });
  }

  const client = newClient(deps, credentials, 'http://127.0.0.1');
  client.setCredentials(account.tokens);

  // Google omits refresh_token on a refresh response; saveAccount merges rather
  // than replaces, so the long-lived token survives.
  client.on('tokens', tokens => {
    try {
      saveAccount({
        channelId: account.channelId,
        channelTitle: account.channelTitle,
        customUrl: account.customUrl,
        clientId: account.clientId,
        tokens,
      });
    } catch {
      // A read-only config dir must not break an otherwise working command.
    }
  });

  return { client, account, credentials };
}

/**
 * Interactive login. Default path opens the browser and captures the callback on
 * 127.0.0.1; `noBrowser` falls back to printing the URL and reading the pasted
 * redirect (for SSH/headless).
 *
 * `withCaptions` adds the opt-in captions scope, which is write-capable. It is
 * never implied — only an explicit --with-captions asks for it.
 */
export async function login({
  credentials: provided,
  clientSecretPath,
  noBrowser = false,
  withCaptions = false,
  env,
  cwd,
  timeoutMs,
  deps: injected,
} = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const credentials = provided ?? resolveCredentials({ clientSecretPath, env, cwd });
  const scopes = withCaptions ? [...SCOPES, CAPTIONS_SCOPE] : SCOPES;

  // Validate before opening a browser. Google does not reject a bad client ID via
  // the API — it renders "Access blocked" in the browser and never redirects, so
  // without this the command would block until timeout with a misleading cause.
  const idWarning = validateClientId(credentials.clientId);
  if (idWarning) deps.log(`warning: ${idWarning.title} — ${idWarning.detail}`);

  const { verifier, challenge } = createPkcePair();
  const state = createState();

  const { code, redirectUri } = noBrowser
    ? await pasteFlow({ deps, credentials, state, challenge, scopes })
    : await browserFlow({ deps, credentials, state, challenge, timeoutMs, scopes });

  const client = newClient(deps, credentials, redirectUri);

  let tokens;
  try {
    ({ tokens } = await client.getToken({ code, codeVerifier: verifier, redirect_uri: redirectUri }));
  } catch (err) {
    throw mapGoogleError(err);
  }
  client.setCredentials(tokens);

  // Identify the channel before persisting anything, so a failed lookup cannot
  // leave a half-written account behind.
  let identity;
  try {
    identity = await deps.fetchIdentity(client);
  } catch (err) {
    throw mapGoogleError(err);
  }

  if (!identity?.channelId) throw fail(DIAGNOSTICS.AUTH_NO_CHANNEL);

  saveCredentials({ ...credentials, source: credentials.source });
  saveAccount({
    channelId: identity.channelId,
    channelTitle: identity.channelTitle,
    customUrl: identity.customUrl,
    // Record which client issued this token, so a later run with different
    // credentials resolved can say so precisely rather than failing at refresh.
    clientId: credentials.clientId,
    // What Google actually granted, not what we asked for. The captions scope is
    // opt-in, so the grant varies per login and cannot be inferred from SCOPES.
    // Absent means unknown — never synthesized, because a fabricated grant record
    // is worse than none: a pre-flight scope check would trust it.
    scopes: tokens.scope ? tokens.scope.split(' ') : null,
    // Only a login issues a refresh token, so this is the one place it is set.
    authorizedAt: new Date().toISOString(),
    tokens,
  });

  return identity;
}

async function browserFlow({ deps, credentials, state, challenge, timeoutMs, scopes = SCOPES }) {
  const server = await deps.startLoopbackServer({ state, timeoutMs });
  try {
    const authUrl = buildAuthUrl({
      clientId: credentials.clientId,
      redirectUri: server.redirectUri,
      state,
      codeChallenge: challenge,
      scopes,
    });

    deps.log('Opening your browser to sign in with Google...');
    deps.log(`If it does not open, paste this URL:\n${authUrl}\n`);
    await deps.openBrowser(authUrl);

    const { code } = await server.waitForCode();
    return { code, redirectUri: server.redirectUri };
  } finally {
    server.close();
  }
}

async function pasteFlow({ deps, credentials, state, challenge, scopes = SCOPES }) {
  // No loopback listener here, so Google's redirect will simply fail to load and
  // the user copies the URL out of the address bar.
  const redirectUri = 'http://127.0.0.1:1';
  const authUrl = buildAuthUrl({
    clientId: credentials.clientId,
    redirectUri,
    state,
    codeChallenge: challenge,
    scopes,
  });

  deps.log('Open this URL in any browser, approve access, then copy the URL you land on:\n');
  deps.log(authUrl + '\n');

  const answer = await deps.promptForRedirectUrl('Paste the redirect URL (or just the code): ');
  const code = extractCode(answer);
  if (!code) {
    throw new YtStatsError('Could not find an authorization code in that input.', {
      code: ERROR_CODES.AUTH_FAILED,
      hint: 'Paste the full URL from the address bar, including the ?code=... part.',
    });
  }
  return { code, redirectUri };
}

/**
 * Exchange a legacy token file's tokens for the channel identity that owns them.
 *
 * The legacy file carries no channel id, so `import-legacy` must ask Google who
 * these tokens belong to before anything is stored. The call is wrapped in
 * `mapGoogleError` for the same reason `login()` wraps its own: an expired
 * refresh token is the *expected* outcome of a migration — people migrate
 * precisely because the old setup went stale — and it must surface as
 * AUTH_TOKEN_EXPIRED with a `ytstats login` next step, not as UNEXPECTED
 * telling the user to file a bug against a tool that is working correctly.
 */
export async function identifyLegacyTokens({ credentials, tokens, deps: injected } = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const client = newClient(deps, credentials, 'http://127.0.0.1');
  client.setCredentials(tokens);

  try {
    return await deps.fetchIdentity(client);
  } catch (err) {
    throw mapGoogleError(err);
  }
}

function extractCode(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  try {
    return new URL(text).searchParams.get('code');
  } catch {
    return text; // They pasted the bare code.
  }
}

/** Revoke with Google (best effort) and forget the account locally. */
export async function logout({ account: selector, all = false, forgetCredentials = false, env, cwd, deps: injected } = {}) {
  const deps = { ...defaultDeps(), ...injected };
  const accounts = all ? listAccounts() : [loadAccount(selector)].filter(Boolean);

  if (accounts.length === 0) {
    if (forgetCredentials) clearCredentials();
    return { loggedOut: false, revoked: false, accounts: [] };
  }

  let credentials = null;
  try {
    credentials = resolveCredentials({ env, cwd });
  } catch {
    // Without the client secret we cannot revoke, but we can still forget locally.
  }

  let revoked = false;
  for (const summary of accounts) {
    const full = loadAccount(summary.channelId);
    if (credentials && full?.tokens) {
      try {
        const client = newClient(deps, credentials, 'http://127.0.0.1');
        client.setCredentials(full.tokens);
        await client.revokeToken(full.tokens.refresh_token || full.tokens.access_token);
        revoked = true;
      } catch {
        // Offline or already-invalid token: local removal below is what matters.
      }
    }
    removeAccount(summary.channelId);
  }

  if (all) clearAllAccounts();
  if (forgetCredentials) clearCredentials();

  return { loggedOut: true, revoked, accounts: accounts.map(a => a.channelId) };
}
