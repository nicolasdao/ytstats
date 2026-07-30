import fs from 'node:fs';
import { readJson, writeJson, removeFile } from '../config/store.js';
import { TOKENS_FILE } from '../config/paths.js';
import { YtStatsError, ERROR_CODES } from '../errors.js';

/**
 * tokens.json shape:
 * {
 *   version: 1,
 *   default: "UC...",
 *   accounts: { "UC...": { channelId, channelTitle, customUrl, clientId, scopes, tokens, savedAt } }
 * }
 *
 * Keyed by channel so one machine can hold several channels; `default` is what
 * commands use when --account is not given.
 *
 * `clientId` records which OAuth client issued this account's refresh token. It
 * is not a secret, and it is not used to authenticate — it exists so that a
 * later run can tell whether the credentials it resolved are the ones the token
 * actually belongs to. Absent on accounts saved before this field existed.
 *
 * `scopes` records what Google actually granted, from the `scope` string on the
 * token response. It matters because not every scope is requested every time:
 * captions access is opt-in, so a stored token may or may not carry it and the
 * grant has to be recorded rather than inferred from the default scope list.
 * Absent (null) on accounts saved before this field existed — which means
 * unknown, not empty. Scope names are not secrets and are safe to print.
 */
function emptyStore() {
  return { version: 1, default: null, accounts: {} };
}

function read() {
  const raw = readJson(TOKENS_FILE);
  if (!raw || typeof raw !== 'object' || !raw.accounts) return emptyStore();
  return { ...emptyStore(), ...raw };
}

function write(store) {
  writeJson(TOKENS_FILE, store);
  return store;
}

/** Persist (or update) one channel's tokens. First account logged in wins the default. */
export function saveAccount({ channelId, channelTitle, customUrl, clientId, scopes, authorizedAt, tokens }) {
  if (!channelId) {
    throw new YtStatsError('Cannot save credentials without a channel id.', {
      code: ERROR_CODES.AUTH_FAILED,
    });
  }

  const store = read();
  const existing = store.accounts[channelId];

  store.accounts[channelId] = {
    channelId,
    channelTitle: channelTitle ?? existing?.channelTitle ?? null,
    customUrl: customUrl ?? existing?.customUrl ?? null,
    // Falls back like the fields above: the refresh-token write-back path calls
    // this without a clientId, and must not erase the binding recorded at login.
    clientId: clientId ?? existing?.clientId ?? null,
    // Falls back for the same reason as clientId: the refresh write-back supplies
    // no scopes, and erasing the recorded grant would make every later scope check
    // read "unknown" — disarming it exactly one refresh after login.
    scopes: scopes ?? existing?.scopes ?? null,
    // When the refresh token was ISSUED — set at login, preserved across refreshes.
    // `savedAt` cannot serve this purpose: it is rewritten on every token refresh,
    // so for anyone actually using the tool it always reads as "just now", and any
    // check on token age silently never fires.
    authorizedAt: authorizedAt ?? existing?.authorizedAt ?? null,
    // A refresh happens without a new refresh_token; keep the one we already hold.
    tokens: { ...(existing?.tokens ?? {}), ...tokens },
    savedAt: new Date().toISOString(),
  };

  if (!store.default || !store.accounts[store.default]) store.default = channelId;
  write(store);
  return store.accounts[channelId];
}

/**
 * Look up an account by channel id or @handle. With no selector, returns the
 * default account. An unknown selector returns null — never a silent fallback to
 * the default, which would query the wrong channel.
 */
export function loadAccount(selector) {
  const store = read();

  if (!selector) {
    return store.default ? store.accounts[store.default] ?? null : null;
  }

  if (store.accounts[selector]) return store.accounts[selector];

  const wanted = String(selector).toLowerCase();
  const match = Object.values(store.accounts).find(
    a => a.customUrl?.toLowerCase() === wanted || a.channelTitle?.toLowerCase() === wanted,
  );
  return match ?? null;
}

/** Accounts without token material — safe to print. A client ID is not a secret. */
export function listAccounts() {
  const store = read();
  return Object.values(store.accounts).map(a => ({
    channelId: a.channelId,
    channelTitle: a.channelTitle,
    customUrl: a.customUrl,
    clientId: a.clientId ?? null,
    scopes: a.scopes ?? null,
    authorizedAt: a.authorizedAt ?? null,
    savedAt: a.savedAt,
    isDefault: a.channelId === store.default,
  }));
}

export function setDefaultAccount(channelId) {
  const store = read();
  if (!store.accounts[channelId]) {
    throw new YtStatsError(`Not logged in to channel ${channelId}.`, {
      code: ERROR_CODES.NOT_AUTHENTICATED,
      hint: 'Run `ytstats status` to see which channels are available.',
    });
  }
  store.default = channelId;
  write(store);
  return store.accounts[channelId];
}

/** Remove one account, promoting another to default if needed. */
export function removeAccount(channelId) {
  const store = read();
  if (!store.accounts[channelId]) return false;

  delete store.accounts[channelId];
  if (store.default === channelId) {
    store.default = Object.keys(store.accounts)[0] ?? null;
  }

  if (Object.keys(store.accounts).length === 0) removeFile(TOKENS_FILE);
  else write(store);
  return true;
}

export function clearAllAccounts() {
  return removeFile(TOKENS_FILE);
}

/**
 * One-time import of the pre-1.0 per-project token file (.yta/tokens.json).
 * Never overwrites an account that already exists.
 */
export function migrateLegacyTokens(legacyPath, { channelId, channelTitle, customUrl } = {}) {
  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
  } catch {
    return { migrated: false, reason: 'no-legacy-file' };
  }

  if (!legacy?.refresh_token) return { migrated: false, reason: 'no-refresh-token' };
  if (!channelId) return { migrated: false, reason: 'unknown-channel' };
  if (loadAccount(channelId)) return { migrated: false, reason: 'already-logged-in' };

  saveAccount({ channelId, channelTitle, customUrl, tokens: legacy });
  return { migrated: true, channelId };
}
