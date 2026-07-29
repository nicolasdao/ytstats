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

  // Google includes project_id in the file it hands out. Keeping it turns every
  // console link into a project-specific one — a bare console URL resolves to
  // whichever project the browser happens to have active, which for anyone
  // signed into several accounts or projects is very often the wrong one.
  const projectId = node.project_id ?? node.projectId ?? null;

  return { clientId, clientSecret, projectId };
}

function readClientSecretFile(file, flag = '--client-secret') {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    throw fail(DIAGNOSTICS.AUTH_CREDENTIALS_NOT_FOUND, { value: file, flag });
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

export function saveCredentials({ clientId, clientSecret, projectId, source }) {
  writeJson(CREDENTIALS_FILE, {
    version: 1,
    clientId,
    clientSecret,
    projectId: projectId ?? null,
    source: source ?? 'login',
    savedAt: new Date().toISOString(),
  });
  return { clientId, clientSecret, projectId: projectId ?? null };
}

/**
 * The Google Cloud project number is the leading segment of every client ID
 * (`<project-number>-<hash>.apps.googleusercontent.com`), so it is always
 * recoverable even for credentials stored before projectId was kept, and for
 * the env-var pair where no file exists to read it from.
 */
export function projectNumberFromClientId(clientId) {
  const m = /^(\d+)-/.exec(String(clientId ?? ''));
  return m ? m[1] : null;
}

/**
 * A Google Cloud console URL pinned to a specific project.
 *
 * Without the parameter the console resolves to whatever project the browser
 * last used, which is a coin flip for anyone with several.
 *
 * `?project=<PROJECT_ID>` is documented and reliable. The numeric project number
 * is a **best-effort fallback**: Google documents no support for it, so the
 * console may ignore it and fall back to the last-used project — which is
 * exactly where an unpinned link lands anyway, so the fallback is never worse
 * than omitting the parameter. It applies only to credentials stored before
 * `projectId` was kept, and to the env-var pair where no file exists to read it
 * from; a fresh `login` records the id and takes the reliable path.
 */
export function consoleUrl(path, { projectId, clientId } = {}) {
  const base = `https://console.cloud.google.com${path}`;
  const project = projectId || projectNumberFromClientId(clientId);
  return project ? `${base}?project=${encodeURIComponent(project)}` : base;
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
 *   3. YTSTATS_CREDENTIALS_FILE — a path to the JSON Google issued
 *   4. credentials.json saved by a previous `ytstats login`
 *   5. client_secret*.json auto-discovered in the working directory
 *
 * The env-var pair is checked before the env-var path so that adding the path
 * form changes nothing for anyone already exporting the pair.
 *
 * Returns { clientId, clientSecret, source }. `source` is for display only and
 * never contains the secret.
 */
export function resolveCredentials({ clientSecretPath, env = process.env, cwd = process.cwd() } = {}) {
  if (clientSecretPath) {
    return { ...readClientSecretFile(clientSecretPath), source: clientSecretPath };
  }

  if (env.YTSTATS_CLIENT_ID && env.YTSTATS_CLIENT_SECRET) {
    // No file to read project_id from; the number still falls out of the client ID.
    return {
      clientId: env.YTSTATS_CLIENT_ID,
      clientSecret: env.YTSTATS_CLIENT_SECRET,
      projectId: null,
      source: 'environment',
    };
  }

  // A path in the environment leaks less than a secret in the environment, and
  // it points straight at the file Google hands out — no extracting two fields.
  if (env.YTSTATS_CREDENTIALS_FILE) {
    return {
      ...readClientSecretFile(env.YTSTATS_CREDENTIALS_FILE, 'YTSTATS_CREDENTIALS_FILE'),
      source: env.YTSTATS_CREDENTIALS_FILE,
    };
  }

  const stored = loadStoredCredentials();
  if (stored) {
    return {
      clientId: stored.clientId,
      clientSecret: stored.clientSecret,
      // Absent on credentials saved before this field existed; the number still resolves.
      projectId: stored.projectId ?? null,
      source: 'stored',
    };
  }

  const discovered = discoverClientSecretFile(cwd);
  if (discovered) {
    return { ...readClientSecretFile(discovered), source: discovered };
  }

  throw fail(DIAGNOSTICS.AUTH_NO_CREDENTIALS, {
    detail:
      'Searched: --client-secret, YTSTATS_CLIENT_ID/SECRET env vars, YTSTATS_CREDENTIALS_FILE, ' +
      `stored credentials, and client_secret*.json in ${cwd}`,
  });
}
