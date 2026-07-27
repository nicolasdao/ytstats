import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJson, removeFile } from '../config/store.js';
import { CREDENTIALS_FILE } from '../config/paths.js';
import { YtStatsError, ERROR_CODES, SETUP_GUIDE, fail } from '../errors.js';
import { DIAGNOSTICS, diagnose } from '../diagnostics.js';

/**
 * Normalise any of the shapes Google hands out into { clientId, clientSecret }.
 * Accepts the Desktop-app ("installed"), web, and already-flat forms.
 */
export function parseClientSecret(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new YtStatsError('Credential file is not a JSON object.', {
      code: ERROR_CODES.INVALID_CREDENTIALS,
    });
  }

  if (raw.type === 'service_account') {
    throw fail(DIAGNOSTICS.AUTH_SERVICE_ACCOUNT, {
      detail: raw.client_email ? `Key belongs to ${raw.client_email}` : undefined,
    });
  }

  const node = raw.installed || raw.web || raw;
  const clientId = node.client_id ?? node.clientId;
  const clientSecret = node.client_secret ?? node.clientSecret;

  if (!clientId) throw fail(DIAGNOSTICS.AUTH_CREDENTIALS_MALFORMED, { detail: 'No client_id in the file' });
  if (!clientSecret) throw fail(DIAGNOSTICS.AUTH_CREDENTIALS_MALFORMED, { detail: 'No client_secret in the file' });

  return { clientId, clientSecret };
}

function readClientSecretFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    throw fail(DIAGNOSTICS.AUTH_CREDENTIALS_NOT_FOUND, { value: file, flag: '--client-secret' });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw fail(DIAGNOSTICS.AUTH_CREDENTIALS_MALFORMED, {
      value: file, detail: 'File is not valid JSON',
    });
  }

  return parseClientSecret(parsed);
}

/**
 * Look for a downloaded client secret in a directory. Google names these
 * client_secret_<numbers>-<hash>.apps.googleusercontent.com.json, so we glob the
 * prefix. Exact `client_secret.json` wins; otherwise sort for determinism.
 */
export function discoverClientSecretFile(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }

  const candidates = entries
    .filter(f => f.startsWith('client_secret') && f.endsWith('.json'))
    .sort();
  if (candidates.length === 0) return null;

  const exact = candidates.find(f => f === 'client_secret.json');
  return path.join(dir, exact ?? candidates[0]);
}

/** Google issues IDs shaped <project-number>-<hash>.apps.googleusercontent.com */
const CLIENT_ID_SUFFIX = '.apps.googleusercontent.com';
const CANONICAL_CLIENT_ID = /^\d+-[A-Za-z0-9_]+\.apps\.googleusercontent\.com$/;

/**
 * Check the client ID before it is ever sent to Google.
 *
 * A malformed client ID does not produce an API error — Google renders
 * "Access blocked: Authorization Error" in the browser and simply never
 * redirects, so the CLI would block until its timeout with no useful diagnosis.
 * Catching it here turns a five-minute hang into an instant, precise failure.
 *
 * Returns a warning diagnostic for merely-unusual IDs; throws for impossible ones.
 */
export function validateClientId(clientId) {
  const id = String(clientId ?? '');

  if (!id.endsWith(CLIENT_ID_SUFFIX)) {
    throw fail(DIAGNOSTICS.AUTH_CLIENT_ID_INVALID, {
      value: id.length > 60 ? `${id.slice(0, 57)}...` : id,
      expected: `an ID ending in ${CLIENT_ID_SUFFIX}`,
    });
  }

  // Legacy clients occasionally deviate, so an unusual shape is a warning rather
  // than a hard failure — being wrong here must not lock anyone out.
  if (!CANONICAL_CLIENT_ID.test(id)) {
    return diagnose(DIAGNOSTICS.AUTH_CLIENT_ID_SUSPICIOUS, {
      value: id,
      expected: '<project-number>-<hash>.apps.googleusercontent.com',
    });
  }

  return null;
}

export function loadStoredCredentials() {
  const stored = readJson(CREDENTIALS_FILE);
  if (!stored?.clientId || !stored?.clientSecret) return null;
  return stored;
}

export function saveCredentials({ clientId, clientSecret, source }) {
  writeJson(CREDENTIALS_FILE, {
    version: 1,
    clientId,
    clientSecret,
    source: source ?? 'login',
    savedAt: new Date().toISOString(),
  });
  return { clientId, clientSecret };
}

export function clearCredentials() {
  return removeFile(CREDENTIALS_FILE);
}

/**
 * Resolve BYO OAuth client credentials.
 *
 * Precedence:
 *   1. --client-secret <file>
 *   2. YTSTATS_CLIENT_ID + YTSTATS_CLIENT_SECRET (both required)
 *   3. credentials.json saved by a previous `ytstats login`
 *   4. client_secret*.json auto-discovered in the working directory
 *
 * Returns { clientId, clientSecret, source }. `source` is for display only and
 * never contains the secret.
 */
export function resolveCredentials({ clientSecretPath, env = process.env, cwd = process.cwd() } = {}) {
  if (clientSecretPath) {
    return { ...readClientSecretFile(clientSecretPath), source: clientSecretPath };
  }

  if (env.YTSTATS_CLIENT_ID && env.YTSTATS_CLIENT_SECRET) {
    return {
      clientId: env.YTSTATS_CLIENT_ID,
      clientSecret: env.YTSTATS_CLIENT_SECRET,
      source: 'environment',
    };
  }

  const stored = loadStoredCredentials();
  if (stored) {
    return { clientId: stored.clientId, clientSecret: stored.clientSecret, source: 'stored' };
  }

  const discovered = discoverClientSecretFile(cwd);
  if (discovered) {
    return { ...readClientSecretFile(discovered), source: discovered };
  }

  throw fail(DIAGNOSTICS.AUTH_NO_CREDENTIALS, {
    detail: `Searched: --client-secret, YTSTATS_CLIENT_ID/SECRET env vars, stored credentials, and client_secret*.json in ${cwd}`,
  });
}
