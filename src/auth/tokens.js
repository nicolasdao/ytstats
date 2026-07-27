import fs from 'node:fs';
import { readJson, writeJson, removeFile } from '../config/store.js';
import { TOKENS_FILE } from '../config/paths.js';
import { YtStatsError, ERROR_CODES } from '../errors.js';

/**
 * tokens.json shape:
 * {
 *   version: 1,
 *   default: "UC...",
 *   accounts: { "UC...": { channelId, channelTitle, customUrl, tokens, savedAt } }
 * }
 *
 * Keyed by channel so one machine can hold several channels; `default` is what
 * commands use when --account is not given.
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
export function saveAccount({ channelId, channelTitle, customUrl, tokens }) {
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

/** Accounts without token material — safe to print. */
export function listAccounts() {
  const store = read();
  return Object.values(store.accounts).map(a => ({
    channelId: a.channelId,
    channelTitle: a.channelTitle,
    customUrl: a.customUrl,
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
