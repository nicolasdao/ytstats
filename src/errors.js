import { diagnose, DIAGNOSTICS } from './diagnostics.js';

/**
 * Stable machine-readable error codes. These are part of the public contract:
 * scripts consuming ytstats JSON branch on `error.code`, so treat them as API.
 */
export const ERROR_CODES = {
  MISSING_CREDENTIALS: 'MISSING_CREDENTIALS',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
  AUTH_FAILED: 'AUTH_FAILED',
  AUTH_TIMEOUT: 'AUTH_TIMEOUT',
  ACCESS_DENIED: 'ACCESS_DENIED',
  API_NOT_ENABLED: 'API_NOT_ENABLED',
  NO_YOUTUBE_CHANNEL: 'NO_YOUTUBE_CHANNEL',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',
  QUERY_NOT_SUPPORTED: 'QUERY_NOT_SUPPORTED',
  NOT_FOUND: 'NOT_FOUND',
  INVALID_INPUT: 'INVALID_INPUT',
  API_ERROR: 'API_ERROR',
  UNKNOWN: 'UNKNOWN',
};

/** Process exit codes, one per broad failure class. */
export const EXIT_CODES = {
  OK: 0,
  GENERAL: 1,
  AUTH: 2,
  INPUT: 3,
  API: 4,
};

export class YtStatsError extends Error {
  constructor(message, { code = ERROR_CODES.UNKNOWN, exitCode, hint, cause, details, diagnostic } = {}) {
    super(message);
    this.name = 'YtStatsError';
    this.code = code;
    this.exitCode = exitCode ?? defaultExitCode(code);
    if (hint) this.hint = hint;
    if (cause) this.cause = cause;
    if (details) this.details = details;
    // The diagnostic is what reaches the caller; message/hint are for humans.
    if (diagnostic) this.diagnostic = diagnostic;
  }
}

/**
 * Throw a fully-specified diagnostic.
 * Preferred over `new YtStatsError(...)` everywhere a failure is anticipated.
 */
export function fail(definition, context = {}) {
  const d = diagnose(definition, context);
  return new YtStatsError(`${d.title}: ${d.detail}`, {
    code: d.code,
    exitCode: d.remediation ? undefined : ERROR_CODES.UNKNOWN,
    hint: d.remediation?.summary,
    diagnostic: d,
  });
}

function defaultExitCode(code) {
  switch (code) {
    case ERROR_CODES.MISSING_CREDENTIALS:
    case ERROR_CODES.INVALID_CREDENTIALS:
    case ERROR_CODES.NOT_AUTHENTICATED:
    case ERROR_CODES.AUTH_FAILED:
    case ERROR_CODES.AUTH_TIMEOUT:
    case ERROR_CODES.ACCESS_DENIED:
    case ERROR_CODES.NO_YOUTUBE_CHANNEL:
      return EXIT_CODES.AUTH;
    case ERROR_CODES.INVALID_INPUT:
      return EXIT_CODES.INPUT;
    case ERROR_CODES.API_NOT_ENABLED:
    case ERROR_CODES.QUOTA_EXCEEDED:
    case ERROR_CODES.QUERY_NOT_SUPPORTED:
    case ERROR_CODES.API_ERROR:
      return EXIT_CODES.API;
    default:
      return EXIT_CODES.GENERAL;
  }
}

export const SETUP_GUIDE = [
  'Set up your own Google Cloud credentials (takes about 5 minutes):',
  '',
  '  1. Create/select a project:  https://console.cloud.google.com/projectcreate',
  '  2. Enable these three APIs in that project:',
  '       YouTube Data API v3      https://console.cloud.google.com/apis/library/youtube.googleapis.com',
  '       YouTube Analytics API    https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com',
  '       YouTube Reporting API    https://console.cloud.google.com/apis/library/youtubereporting.googleapis.com',
  '  3. Configure the OAuth consent screen (External) and add yourself as a test user:',
  '       https://console.cloud.google.com/apis/credentials/consent',
  '  4. Create credentials > OAuth client ID > Application type: Desktop app, then download the JSON:',
  '       https://console.cloud.google.com/apis/credentials',
  '  5. ytstats login --client-secret /path/to/client_secret_XXX.json',
  '',
  'Your credentials stay on this machine. ytstats has no server and no shared client ID.',
].join('\n');

/**
 * Classify a Google API failure into a precise diagnostic.
 *
 * The ordering matters: the most specific signals (reason codes, message
 * fingerprints) are checked before the generic HTTP status buckets, because a
 * 403 can mean four unrelated things.
 */
export function diagnoseGoogleError(err) {
  if (err instanceof YtStatsError && err.diagnostic) return err.diagnostic;

  const status = err?.response?.status ?? err?.status;
  const apiErr = err?.response?.data?.error;
  const reason = apiErr?.errors?.[0]?.reason || err?.errors?.[0]?.reason;
  const message =
    apiErr?.message ||
    err?.response?.data?.error_description ||
    (typeof apiErr === 'string' ? apiErr : '') ||
    err?.message ||
    '';
  const detail = message || `HTTP ${status ?? 'unknown'}`;

  // Network-level failures never reach an HTTP status.
  const netCode = err?.code;
  if (['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPROTO', 'UND_ERR_CONNECT_TIMEOUT'].includes(netCode)
      || /fetch failed|request to .* failed|getaddrinfo|socket hang up|network/i.test(message)) {
    return diagnose(DIAGNOSTICS.NETWORK_UNREACHABLE, { detail });
  }

  if (reason === 'accessNotConfigured' || /has not been used in project|is disabled|API has not been used/i.test(message)) {
    return diagnose(DIAGNOSTICS.API_NOT_ENABLED, { detail });
  }

  if (reason === 'NoLinkedYouTubeAccount' || /NoLinkedYouTubeAccount/i.test(message)) {
    return diagnose(DIAGNOSTICS.AUTH_NO_CHANNEL, { detail });
  }

  if (reason === 'quotaExceeded' || /quota.*exceed/i.test(message)) {
    return diagnose(DIAGNOSTICS.API_QUOTA_EXCEEDED, { detail });
  }

  if (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || status === 429) {
    return diagnose(DIAGNOSTICS.API_RATE_LIMITED, { detail });
  }

  if (/query is not supported/i.test(message)) {
    return diagnose(DIAGNOSTICS.API_QUERY_NOT_SUPPORTED, { detail });
  }

  // invalid_grant is the single most common auth failure and has a specific fix.
  if (/invalid_grant/i.test(message)) {
    return diagnose(/revok/i.test(message) ? DIAGNOSTICS.AUTH_TOKEN_REVOKED : DIAGNOSTICS.AUTH_TOKEN_EXPIRED, { detail });
  }

  if (/token has been revoked|Token has been expired or revoked/i.test(message)) {
    return diagnose(DIAGNOSTICS.AUTH_TOKEN_REVOKED, { detail });
  }

  if (status === 401 || /Invalid Credentials|unauthorized/i.test(message)) {
    return diagnose(DIAGNOSTICS.AUTH_TOKEN_EXPIRED, { detail });
  }

  if (status === 403) return diagnose(DIAGNOSTICS.API_FORBIDDEN, { detail });
  if (status === 404) return diagnose(DIAGNOSTICS.API_NOT_FOUND, { detail });
  if (status >= 500) return diagnose(DIAGNOSTICS.API_UNAVAILABLE, { detail });
  if (status === 400) return diagnose(DIAGNOSTICS.API_QUERY_NOT_SUPPORTED, { detail });

  return diagnose(DIAGNOSTICS.UNEXPECTED, { detail });
}

/**
 * Map a Google API error onto a typed YtStatsError carrying a diagnostic.
 */
export function mapGoogleError(err) {
  if (err instanceof YtStatsError) return err;

  const d = diagnoseGoogleError(err);
  return new YtStatsError(`${d.title}: ${d.detail}`, {
    code: legacyCodeFor(d.code),
    hint: d.remediation.summary,
    diagnostic: d,
    cause: err,
  });
}

/** Bridge new diagnostic codes back to the original ERROR_CODES vocabulary. */
function legacyCodeFor(code) {
  const map = {
    AUTH_NO_CREDENTIALS: ERROR_CODES.MISSING_CREDENTIALS,
    AUTH_CREDENTIALS_MALFORMED: ERROR_CODES.INVALID_CREDENTIALS,
    AUTH_CREDENTIALS_NOT_FOUND: ERROR_CODES.INVALID_CREDENTIALS,
    AUTH_SERVICE_ACCOUNT: ERROR_CODES.INVALID_CREDENTIALS,
    AUTH_NO_TOKENS: ERROR_CODES.NOT_AUTHENTICATED,
    AUTH_TOKEN_EXPIRED: ERROR_CODES.NOT_AUTHENTICATED,
    AUTH_TOKEN_REVOKED: ERROR_CODES.NOT_AUTHENTICATED,
    AUTH_ACCOUNT_UNKNOWN: ERROR_CODES.NOT_AUTHENTICATED,
    AUTH_CONSENT_DECLINED: ERROR_CODES.ACCESS_DENIED,
    AUTH_TIMEOUT: ERROR_CODES.AUTH_TIMEOUT,
    AUTH_STATE_MISMATCH: ERROR_CODES.AUTH_FAILED,
    AUTH_NO_CHANNEL: ERROR_CODES.NO_YOUTUBE_CHANNEL,
    API_NOT_ENABLED: ERROR_CODES.API_NOT_ENABLED,
    API_QUOTA_EXCEEDED: ERROR_CODES.QUOTA_EXCEEDED,
    API_RATE_LIMITED: ERROR_CODES.QUOTA_EXCEEDED,
    API_QUERY_NOT_SUPPORTED: ERROR_CODES.QUERY_NOT_SUPPORTED,
    API_FORBIDDEN: ERROR_CODES.ACCESS_DENIED,
    API_NOT_FOUND: ERROR_CODES.NOT_FOUND,
    API_UNAVAILABLE: ERROR_CODES.API_ERROR,
    NETWORK_UNREACHABLE: ERROR_CODES.API_ERROR,
  };
  return map[code] ?? ERROR_CODES.UNKNOWN;
}

/** @deprecated retained so the legacy mapping tests keep their meaning */
export function mapGoogleErrorLegacy(err) {
  if (err instanceof YtStatsError) return err;

  const status = err?.response?.status ?? err?.code;
  const apiErr = err?.response?.data?.error;
  const reason =
    apiErr?.errors?.[0]?.reason ||
    (typeof apiErr === 'string' ? apiErr : undefined) ||
    err?.errors?.[0]?.reason;
  const message = apiErr?.message || err?.response?.data?.error_description || err?.message || 'Unknown API error';

  if (reason === 'accessNotConfigured' || /has not been used in project|is disabled/i.test(message)) {
    return new YtStatsError('A required YouTube API is not enabled in your Google Cloud project.', {
      code: ERROR_CODES.API_NOT_ENABLED,
      hint:
        'Enable YouTube Data API v3, YouTube Analytics API and YouTube Reporting API, then retry:\n' +
        '  https://console.cloud.google.com/apis/library/youtube.googleapis.com\n' +
        '  https://console.cloud.google.com/apis/library/youtubeanalytics.googleapis.com\n' +
        '  https://console.cloud.google.com/apis/library/youtubereporting.googleapis.com',
      cause: err,
      details: { message },
    });
  }

  if (reason === 'NoLinkedYouTubeAccount' || /NoLinkedYouTubeAccount/i.test(message)) {
    return new YtStatsError('That Google account has no YouTube channel linked to it.', {
      code: ERROR_CODES.NO_YOUTUBE_CHANNEL,
      hint:
        'Run `ytstats logout` then `ytstats login` and pick the Google account that owns your channel.\n' +
        'Note: service accounts can never be used — YouTube APIs require a real channel owner.',
      cause: err,
    });
  }

  if (reason === 'quotaExceeded' || reason === 'rateLimitExceeded' || status === 429) {
    return new YtStatsError('YouTube API quota exceeded for your Google Cloud project.', {
      code: ERROR_CODES.QUOTA_EXCEEDED,
      hint: 'The Data API allows 10,000 units/day. Quota resets at midnight Pacific Time. Check usage at https://console.cloud.google.com/apis/dashboard',
      cause: err,
    });
  }

  if (/query is not supported/i.test(message)) {
    return new YtStatsError(`YouTube rejected this Analytics query: ${message}`, {
      code: ERROR_CODES.QUERY_NOT_SUPPORTED,
      hint: 'Not every metric/dimension combination is valid. See https://developers.google.com/youtube/analytics/channel_reports',
      cause: err,
    });
  }

  if (status === 401 || /invalid_grant|Invalid Credentials/i.test(message)) {
    return new YtStatsError('Your saved authentication is no longer valid.', {
      code: ERROR_CODES.NOT_AUTHENTICATED,
      hint:
        'Run `ytstats login` again.\n' +
        'If this keeps happening weekly, your OAuth consent screen is still in "Testing" mode — ' +
        'refresh tokens expire after 7 days there. Publish it to Production to stop the expiry.',
      cause: err,
    });
  }

  if (status === 403) {
    return new YtStatsError(`Access denied by YouTube: ${message}`, {
      code: ERROR_CODES.ACCESS_DENIED,
      hint: 'Confirm the signed-in account owns this channel and that you granted all requested scopes.',
      cause: err,
    });
  }

  if (status === 404) {
    return new YtStatsError(message, { code: ERROR_CODES.NOT_FOUND, cause: err });
  }

  return new YtStatsError(message, { code: ERROR_CODES.API_ERROR, cause: err, details: { status } });
}

const SECRET_PATTERNS = [
  /GOCSPX-[A-Za-z0-9_-]+/g,           // Google client secrets
  /\bya29\.[A-Za-z0-9._-]+/g,          // Google access tokens
  /\b1\/\/[A-Za-z0-9._-]{20,}/g,       // Google refresh tokens
  /\b4\/[0-9A-Za-z_-]{20,}/g,          // Google authorization codes
  // Deliberately NOT matching a bare "code" field: every diagnostic carries
  // `"code": "AUTH_NO_TOKENS"`, which is public API and must survive redaction.
  /"(client_secret|clientSecret|refresh_token|access_token|code_verifier|codeVerifier|authorization_code)"\s*:\s*"[^"]*"/g,
  /[?&](code|code_verifier|client_secret)=[^&\s"]+/g,
];

/**
 * Strip anything that looks like a secret out of text destined for logs or JSON
 * output. Belt-and-braces: we also never deliberately log these values.
 */
export function redact(text) {
  if (typeof text !== 'string') return text;
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, m => (m.startsWith('"') ? m.replace(/:\s*"[^"]*"/, ': "[REDACTED]"') : '[REDACTED]'));
  }
  return out;
}
