/**
 * Programmatic API.
 *
 * The CLI is the public contract, but importing the library avoids a process
 * spawn and a JSON round-trip when you are already in Node:
 *
 *   import { getAuthenticatedClient, createApis, fetchAll, resolveDateRange } from 'ytstats';
 *
 *   const { client } = getAuthenticatedClient();
 *   const result = await fetchAll(createApis(client), { range: resolveDateRange({ days: 90 }) });
 */
export { getAuthenticatedClient, login, logout, identifyLegacyTokens } from './auth/session.js';
export {
  resolveCredentials,
  saveCredentials,
  clearCredentials,
  loadStoredCredentials,
  discoverClientSecretFile,
  parseClientSecret,
} from './auth/credentials.js';
export {
  loadAccount,
  listAccounts,
  saveAccount,
  removeAccount,
  setDefaultAccount,
  clearAllAccounts,
  migrateLegacyTokens,
} from './auth/tokens.js';
export { SCOPES } from './auth/oauth.js';

export { createApis } from './api/client.js';
export * as data from './api/data.js';
export * as analytics from './api/analytics.js';
export * as reporting from './api/reporting.js';
export * from './api/transforms.js';

export { fetchAll } from './fetch-all.js';
export { resolveDateRange, daysBetween, toIsoDate } from './dates.js';
export { configDir } from './config/store.js';
export { renderEnvelope, createReporter } from './output.js';
export { YtStatsError, ERROR_CODES, EXIT_CODES, mapGoogleError, diagnoseGoogleError, fail, redact } from './errors.js';
export { DIAGNOSTICS, diagnose, isDiagnostic, SEVERITY, EXIT } from './diagnostics.js';
export { buildProgram, main } from './cli.js';
