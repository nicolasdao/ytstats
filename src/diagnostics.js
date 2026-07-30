/**
 * The diagnostic catalog.
 *
 * Designed for an LLM in a retry loop, not a human reading a terminal. Every
 * anticipated failure gets its own code and its own recovery path, because a
 * single generic "not authenticated" forces the caller to guess which of six
 * different problems it has.
 *
 * A diagnostic answers four questions:
 *   what happened      title + detail
 *   why                cause
 *   can I fix it       recoverable / retryable
 *   what do I run now  remediation.commands
 *
 * `code` values are public API. Add new ones freely; never repurpose an existing
 * one, and never delete one without a major version bump.
 */

export const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

export const EXIT = { OK: 0, GENERAL: 1, AUTH: 2, INPUT: 3, API: 4, PARTIAL: 5 };

const CONSOLE = 'https://console.cloud.google.com';
const SETUP_DOC = 'https://www.npmjs.com/package/ytstats#setup';

/** Shorthand for the credential-setup walkthrough reused by several diagnostics. */
const SETUP_STEPS = [
  `Create or select a Google Cloud project: ${CONSOLE}/projectcreate`,
  `Enable YouTube Data API v3: ${CONSOLE}/apis/library/youtube.googleapis.com`,
  `Enable YouTube Analytics API: ${CONSOLE}/apis/library/youtubeanalytics.googleapis.com`,
  `Enable YouTube Reporting API: ${CONSOLE}/apis/library/youtubereporting.googleapis.com`,
  `Configure the consent screen audience (External), add yourself as a test user, then publish to Production: ${CONSOLE}/auth/audience`,
  `Create an OAuth client > Application type "Desktop app": ${CONSOLE}/auth/clients`,
  'Download the client JSON immediately — since June 2025 the secret is shown only at creation, and afterwards the console displays just its last four characters. It cannot be re-downloaded.',
  'Run: ytstats login --client-secret /path/to/client_secret_XXX.json',
];

const LOGIN_CMD = {
  run: 'ytstats login --client-secret <path-to-client_secret.json>',
  description: 'Authenticate with your own Google Cloud OAuth client',
};
const STATUS_CMD = {
  run: 'ytstats status',
  description: 'Show which channels are signed in and where credentials are stored',
};
const DOCTOR_CMD = {
  run: 'ytstats doctor',
  description: 'Run every readiness check and report exactly what is missing',
};
const HELP_CMD = { run: 'ytstats --help', description: 'List all commands and their options' };

/**
 * @typedef {object} DiagnosticDef
 * @property {string}  code
 * @property {string}  severity
 * @property {number}  exitCode
 * @property {boolean} recoverable  the caller can fix this and retry
 * @property {boolean} retryable    retrying the same call unchanged may succeed
 */
const def = d => Object.freeze({ severity: SEVERITY.ERROR, exitCode: EXIT.GENERAL, ...d });

export const DIAGNOSTICS = {
  // ─────────────────────────────────────────────────────────── authentication

  AUTH_NO_CREDENTIALS: def({
    code: 'AUTH_NO_CREDENTIALS',
    exitCode: EXIT.AUTH,
    recoverable: true,
    retryable: false,
    title: 'No Google OAuth client credentials found',
    detail:
      'ytstats ships no client ID — each user brings their own Google Cloud OAuth client. ' +
      'None was found via --client-secret, the YTSTATS_CLIENT_ID/YTSTATS_CLIENT_SECRET environment ' +
      'variables, previously stored credentials, or a client_secret*.json in the working directory.',
    cause: 'The one-time Google Cloud setup has not been completed on this machine.',
    remediation: {
      summary: 'Create a Google Cloud OAuth client (Desktop app) and pass it to ytstats login.',
      steps: SETUP_STEPS,
      commands: [LOGIN_CMD, DOCTOR_CMD],
      docs: [SETUP_DOC, `${CONSOLE}/auth/clients`],
    },
  }),

  AUTH_NO_TOKENS: def({
    code: 'AUTH_NO_TOKENS',
    exitCode: EXIT.AUTH,
    recoverable: true,
    retryable: false,
    title: 'Not signed in',
    detail:
      'OAuth client credentials are available, but no YouTube account has been authorized on this ' +
      'machine yet. No access or refresh token is stored.',
    cause: 'ytstats login has not been run, or the stored tokens were removed by ytstats logout.',
    remediation: {
      summary: 'Run the login flow once; the browser opens and the callback is captured automatically.',
      steps: [
        'Run: ytstats login',
        'Approve the requested read-only scopes in the browser that opens.',
        'On a headless or SSH machine use: ytstats login --no-browser',
      ],
      commands: [
        { run: 'ytstats login', description: 'Open the browser and authorize this machine' },
        { run: 'ytstats login --no-browser', description: 'Headless variant: prints a URL, reads the pasted redirect' },
        STATUS_CMD,
      ],
      docs: [SETUP_DOC],
    },
  }),

  AUTH_TOKEN_EXPIRED: def({
    code: 'AUTH_TOKEN_EXPIRED',
    exitCode: EXIT.AUTH,
    recoverable: true,
    retryable: false,
    title: 'Stored refresh token is no longer valid',
    detail:
      'Google rejected the stored refresh token (invalid_grant). The token was not merely stale — ' +
      'automatic refresh already failed, so re-authorization is required.',
    cause:
      'Most commonly the OAuth consent screen is still in "Testing" mode, where Google expires refresh ' +
      'tokens after 7 days. Also caused by a password change or 6 months of inactivity.',
    remediation: {
      summary: 'Sign in again, then publish your consent screen to Production so it stops recurring.',
      steps: [
        'Run: ytstats login',
        `Then fix the root cause: open ${CONSOLE}/auth/audience`,
        'If Publishing status is "Testing", click "PUBLISH APP" and confirm.',
        'Then run ytstats login again. Google does not document whether a token issued while in Testing keeps its 7-day expiry after publishing, so re-authorizing is the only way to be certain you hold a long-lived one.',
        'Verification is not required for personal use — under 100 users you click past a one-time "unverified app" warning. Publishing does not list your app anywhere.',
      ],
      commands: [
        { run: 'ytstats login', description: 'Re-authorize this machine' },
        DOCTOR_CMD,
      ],
      docs: [`${CONSOLE}/auth/audience`],
    },
  }),

  AUTH_TOKEN_REVOKED: def({
    code: 'AUTH_TOKEN_REVOKED',
    exitCode: EXIT.AUTH,
    recoverable: true,
    retryable: false,
    title: 'Access was revoked for this application',
    detail:
      'The stored token was explicitly revoked — either by ytstats logout elsewhere, or by removing ' +
      'this app from the Google account permissions page.',
    cause: 'Access removed at https://myaccount.google.com/permissions or by a prior logout.',
    remediation: {
      summary: 'Authorize again.',
      steps: ['Run: ytstats login', 'Approve the requested scopes.'],
      commands: [{ run: 'ytstats login', description: 'Re-authorize this machine' }],
      docs: ['https://myaccount.google.com/permissions'],
    },
  }),

  AUTH_ACCOUNT_UNKNOWN: def({
    code: 'AUTH_ACCOUNT_UNKNOWN',
    exitCode: EXIT.AUTH,
    recoverable: true,
    retryable: false,
    title: 'Requested account is not signed in',
    detail: 'The --account selector did not match any signed-in channel on this machine.',
    cause: 'A channel id or @handle was given that has never been authorized here, or a typo.',
    remediation: {
      summary: 'List the signed-in channels and use one of them, or log in to the one you want.',
      steps: [
        'Run: ytstats status  — the accounts array lists every signed-in channel id and handle.',
        'Re-run your command with --account <channelId> using a value from that list.',
        'Or run ytstats login to add the missing channel.',
      ],
      commands: [STATUS_CMD, { run: 'ytstats login', description: 'Add another channel' }],
      docs: [SETUP_DOC],
    },
  }),

  AUTH_CLIENT_MISMATCH: def({
    code: 'AUTH_CLIENT_MISMATCH',
    exitCode: EXIT.AUTH,
    recoverable: true,
    retryable: false,
    title: 'Stored token belongs to a different OAuth client',
    detail:
      'This channel was authorized with one Google Cloud OAuth client, but a different client ID was ' +
      'resolved for this run. Google binds a refresh token to the client that issued it, so refreshing ' +
      'with the wrong client would fail as invalid_grant — which reads like an expired token and sends ' +
      'you to fix the wrong thing.',
    cause:
      'Usually a second ytstats login with a different client_secret file overwrote the stored ' +
      'credentials while another channel was still signed in, since credentials.json holds one client ' +
      'for the whole config directory. Also reached by setting YTSTATS_CLIENT_ID/SECRET or ' +
      'YTSTATS_CREDENTIALS_FILE to a different client than the one this channel was authorized with.',
    remediation: {
      summary:
        'Give each OAuth client its own config directory, or re-authorize this channel with the client ' +
        'that is now resolving.',
      steps: [
        'Run: ytstats status  — clientId shows what resolved, and each account shows the client it was authorized with.',
        'To keep several clients side by side, isolate them: export YTSTATS_CONFIG_DIR=~/.ytstats/<name>',
        'Point at that client\'s file in the same shell: export YTSTATS_CREDENTIALS_FILE=/path/to/client_secret.json',
        'Or, to consolidate on the client that is resolving now, re-run: ytstats login',
      ],
      commands: [
        STATUS_CMD,
        { run: 'ytstats login', description: 'Re-authorize this channel with the client that is resolving now' },
        DOCTOR_CMD,
      ],
      docs: [SETUP_DOC],
    },
  }),

  AUTH_CONSENT_DECLINED: def({
    code: 'AUTH_CONSENT_DECLINED',
    exitCode: EXIT.AUTH,
    recoverable: true,
    retryable: true,
    title: 'Authorization was declined in the browser',
    detail: 'Google returned access_denied — the consent screen was dismissed or a scope was refused.',
    cause: 'The user clicked Cancel, or the Google account is not listed as a test user on the consent screen.',
    remediation: {
      summary: 'Retry the login and approve all scopes; if it fails again, add yourself as a test user.',
      steps: [
        'Run: ytstats login',
        'Approve every requested scope — all three are read-only.',
        `If the consent screen refuses your account, add it as a test user: ${CONSOLE}/auth/audience`,
      ],
      commands: [{ run: 'ytstats login', description: 'Retry authorization' }],
      docs: [`${CONSOLE}/auth/audience`],
    },
  }),

  AUTH_TIMEOUT: def({
    code: 'AUTH_TIMEOUT',
    exitCode: EXIT.AUTH,
    recoverable: true,
    retryable: false,
    title: 'Browser sign-in did not complete in time',
    detail:
      'The local callback listener timed out waiting for Google to redirect back. Note that a plain ' +
      'retry usually does NOT help: the most common cause is that Google refused the request in the ' +
      'browser and never redirected at all.',
    cause:
      'Most often Google showed "Access blocked: Authorization Error" because the OAuth client is not ' +
      'usable — wrong/typo\'d client ID, the client was deleted, it belongs to a different project than ' +
      'the enabled APIs, or the consent screen is unconfigured. Less often: the flow was abandoned, or ' +
      'the machine has no browser.',
    remediation: {
      summary:
        'Check what the browser actually showed. If it said "Access blocked", fix the OAuth client — ' +
        'retrying the same command will keep timing out.',
      steps: [
        'If the browser showed "Access blocked: Authorization Error": the OAuth client is the problem, not the timeout.',
        `  - Confirm the client ID still exists and is of type "Desktop app": ${CONSOLE}/auth/clients`,
        `  - Confirm the OAuth consent screen is configured and you are a test user (or it is published): ${CONSOLE}/auth/audience`,
        '  - Re-download the client JSON and pass it again with --client-secret.',
        'If the browser never opened, run: ytstats login --no-browser',
        'If you simply walked away, re-run: ytstats login',
      ],
      commands: [
        { run: 'ytstats login --client-secret <path>', description: 'Retry with a freshly downloaded OAuth client' },
        { run: 'ytstats login --no-browser', description: 'Paste-the-URL flow for headless machines' },
        DOCTOR_CMD,
      ],
      docs: [`${CONSOLE}/auth/clients`, `${CONSOLE}/auth/audience`],
    },
  }),

  AUTH_CLIENT_ID_INVALID: def({
    code: 'AUTH_CLIENT_ID_INVALID',
    exitCode: EXIT.AUTH,
    recoverable: true,
    retryable: false,
    title: 'OAuth client ID is not a valid Google client ID',
    detail:
      'Google client IDs always end in .apps.googleusercontent.com. Sending a malformed one produces ' +
      '"Access blocked: Authorization Error" in the browser and no redirect ever arrives, so the login ' +
      'would hang until it timed out. Rejected up front instead.',
    cause: 'A hand-edited, truncated, placeholder, or non-Google client ID.',
    remediation: {
      summary: 'Download the real OAuth client JSON from Google Cloud and pass that file unmodified.',
      steps: [
        `Open ${CONSOLE}/auth/clients`,
        'Under "OAuth 2.0 Client IDs", pick the Desktop app client (create one if there is none).',
        'Click the download icon — do not hand-edit the file.',
        'Run: ytstats login --client-secret /path/to/that/file.json',
      ],
      commands: [LOGIN_CMD, DOCTOR_CMD],
      docs: [`${CONSOLE}/auth/clients`],
    },
  }),

  AUTH_CLIENT_ID_SUSPICIOUS: def({
    code: 'AUTH_CLIENT_ID_SUSPICIOUS',
    severity: SEVERITY.WARNING,
    exitCode: EXIT.OK,
    recoverable: true,
    retryable: false,
    title: 'OAuth client ID does not look like one Google issues',
    detail:
      'Real client IDs look like 123456789012-abc123def456.apps.googleusercontent.com. This one has the ' +
      'right suffix but not the usual <project-number>-<hash> form. If Google shows "Access blocked" in ' +
      'the browser, this is why.',
    cause: 'A trimmed, placeholder, or legacy client ID.',
    remediation: {
      summary: 'Proceeding anyway — but if the browser shows "Access blocked", the client JSON is suspect.',
      steps: [
        `Check the client at ${CONSOLE}/auth/clients — it must exist and be of type "Desktop app".`,
        'Since June 2025 the client secret is downloadable only at creation; afterwards the console shows only its last four characters. There is no re-download.',
        'If the file is wrong or lost, add a new secret to the existing client (or create a new client) and download it at that moment.',
        'Pass the downloaded file unmodified to --client-secret.',
      ],
      commands: [LOGIN_CMD],
      docs: [`${CONSOLE}/auth/clients`],
    },
  }),

  AUTH_STATE_MISMATCH: def({
    code: 'AUTH_STATE_MISMATCH',
    exitCode: EXIT.AUTH,
    recoverable: true,
    retryable: true,
    title: 'Sign-in aborted by a security check',
    detail:
      'The OAuth state parameter returned by the browser did not match the one this process generated, ' +
      'so the authorization code was discarded.',
    cause: 'A stale browser tab from an earlier login attempt, or another process answering on the callback port.',
    remediation: {
      summary: 'Close old sign-in tabs and run login again.',
      steps: ['Close any leftover Google sign-in tabs.', 'Run: ytstats login'],
      commands: [{ run: 'ytstats login', description: 'Start a fresh authorization' }],
      docs: [SETUP_DOC],
    },
  }),

  AUTH_SERVICE_ACCOUNT: def({
    code: 'AUTH_SERVICE_ACCOUNT',
    exitCode: EXIT.AUTH,
    recoverable: false,
    retryable: false,
    title: 'Service account keys cannot be used with YouTube APIs',
    detail:
      'The supplied file is a service account key. A service account owns no YouTube channel and there ' +
      'is no way to link one, so Google rejects it with NoLinkedYouTubeAccount. This is a platform ' +
      'limitation with no workaround — domain-wide delegation does not help either.',
    cause: 'A service account JSON was passed where an OAuth client ID was expected.',
    remediation: {
      summary: 'Create an OAuth client ID of type "Desktop app" instead. Do not retry with a service account.',
      steps: [
        `Open ${CONSOLE}/auth/clients`,
        'Create credentials > OAuth client ID > Application type: Desktop app.',
        'Download that JSON and pass it to ytstats login --client-secret.',
      ],
      commands: [LOGIN_CMD],
      docs: ['https://developers.google.com/youtube/v3/guides/authentication'],
    },
  }),

  AUTH_NO_CHANNEL: def({
    code: 'AUTH_NO_CHANNEL',
    exitCode: EXIT.AUTH,
    recoverable: true,
    retryable: false,
    title: 'Signed-in Google account has no YouTube channel',
    detail:
      'Authorization succeeded but channels.list returned nothing, so this Google account owns no channel ' +
      'and there is no analytics data to read.',
    cause: 'Signed in with the wrong Google account, or a Brand Account channel not owned by this login.',
    remediation: {
      summary: 'Log out and sign in with the Google account that owns the channel.',
      steps: [
        'Run: ytstats logout',
        'Run: ytstats login  — and pick the Google account that owns the channel.',
        'For a Brand Account, choose the brand profile on the account chooser screen.',
      ],
      commands: [
        { run: 'ytstats logout', description: 'Forget the current account' },
        { run: 'ytstats login', description: 'Sign in with the channel owner account' },
      ],
      docs: [SETUP_DOC],
    },
  }),

  AUTH_CREDENTIALS_MALFORMED: def({
    code: 'AUTH_CREDENTIALS_MALFORMED',
    exitCode: EXIT.AUTH,
    recoverable: true,
    retryable: false,
    title: 'Credential file could not be read as an OAuth client',
    detail:
      'The file exists but is not the JSON Google produces for an OAuth client ID — it lacks a usable ' +
      'client_id/client_secret pair under "installed" or "web".',
    cause: 'Wrong file passed, a truncated download, or an API key instead of an OAuth client.',
    remediation: {
      summary: 'Re-download the OAuth client JSON and pass that exact file.',
      steps: [
        `Open ${CONSOLE}/auth/clients`,
        'Find your OAuth 2.0 Client ID (Desktop app) and click the download icon.',
        'Pass that file: ytstats login --client-secret /path/to/downloaded.json',
      ],
      commands: [LOGIN_CMD],
      docs: [`${CONSOLE}/auth/clients`],
    },
  }),

  AUTH_CREDENTIALS_NOT_FOUND: def({
    code: 'AUTH_CREDENTIALS_NOT_FOUND',
    exitCode: EXIT.AUTH,
    recoverable: true,
    retryable: false,
    title: 'Credential file does not exist at the given path',
    detail: 'The path passed to --client-secret could not be opened.',
    cause: 'Typo in the path, a relative path resolved from an unexpected working directory, or the file was moved.',
    remediation: {
      summary: 'Check the path and pass an absolute one.',
      steps: [
        'Confirm the file exists at that exact path.',
        'Prefer an absolute path — relative paths resolve from the current working directory.',
        'Alternatively place it as client_secret.json in the working directory and run: ytstats login',
      ],
      commands: [LOGIN_CMD, DOCTOR_CMD],
      docs: [SETUP_DOC],
    },
  }),

  // ──────────────────────────────────────────────────────────── Google APIs

  API_NOT_ENABLED: def({
    code: 'API_NOT_ENABLED',
    exitCode: EXIT.API,
    recoverable: true,
    retryable: true,
    title: 'A required YouTube API is not enabled in your Google Cloud project',
    detail:
      'Google rejected the request with accessNotConfigured. ytstats needs all three YouTube APIs enabled ' +
      'in the same project that issued your OAuth client.',
    cause: 'One or more of the three APIs was never enabled, or was enabled in a different project.',
    remediation: {
      summary: 'Enable all three APIs in the project that owns your OAuth client, then retry.',
      steps: [
        `Enable YouTube Data API v3: ${CONSOLE}/apis/library/youtube.googleapis.com`,
        `Enable YouTube Analytics API: ${CONSOLE}/apis/library/youtubeanalytics.googleapis.com`,
        `Enable YouTube Reporting API: ${CONSOLE}/apis/library/youtubereporting.googleapis.com`,
        'Enabling can take up to a minute to propagate. Then retry the same command.',
      ],
      commands: [DOCTOR_CMD],
      docs: [`${CONSOLE}/apis/library`],
    },
  }),

  API_QUOTA_EXCEEDED: def({
    code: 'API_QUOTA_EXCEEDED',
    exitCode: EXIT.API,
    recoverable: true,
    retryable: true,
    title: 'YouTube API quota exhausted for your Google Cloud project',
    detail:
      'The Data API allows 10,000 units per day per project. That budget is spent. The quota resets at ' +
      'midnight Pacific Time.',
    cause: 'Too many calls today — commonly a large fetch with retention enabled, which costs one call per video.',
    remediation: {
      summary: 'Wait for the reset, or reduce the cost of the call.',
      steps: [
        'Wait until midnight Pacific Time for the daily reset.',
        'Reduce cost meanwhile: ytstats fetch --no-retention  (retention is one API call per video)',
        'Or narrow the window: ytstats fetch --days 7',
        `Inspect usage: ${CONSOLE}/apis/dashboard`,
      ],
      commands: [
        { run: 'ytstats fetch --no-retention', description: 'Cheapest full fetch — skips per-video retention' },
        { run: 'ytstats fetch --days 7 --no-retention', description: 'Cheaper still: narrow window, no retention' },
      ],
      docs: [`${CONSOLE}/apis/dashboard`],
    },
  }),

  API_RATE_LIMITED: def({
    code: 'API_RATE_LIMITED',
    exitCode: EXIT.API,
    recoverable: true,
    retryable: true,
    title: 'Temporarily rate limited by YouTube',
    detail: 'Google returned a rate limit response. This is transient, unlike a daily quota exhaustion.',
    cause: 'Too many requests in a short window.',
    remediation: {
      summary: 'Wait a few seconds and retry the same command.',
      steps: ['Wait 5-30 seconds.', 'Retry the identical command — no changes needed.'],
      commands: [DOCTOR_CMD],
      docs: [`${CONSOLE}/apis/dashboard`],
    },
  }),

  API_QUERY_NOT_SUPPORTED: def({
    code: 'API_QUERY_NOT_SUPPORTED',
    exitCode: EXIT.API,
    recoverable: true,
    retryable: false,
    title: 'YouTube rejected this metric/dimension combination',
    detail:
      'The Analytics API refuses many otherwise-documented combinations, and which ones are refused varies ' +
      'by channel. Notably videoThumbnailImpressions never works on channel reports — use ytstats reach instead.',
    cause: 'An unsupported metrics/dimensions/filters combination for this channel.',
    remediation: {
      summary: 'Simplify the query, or use a purpose-built command instead of a raw query.',
      steps: [
        'Drop dimensions one at a time until the query is accepted.',
        'For thumbnail impressions or CTR use: ytstats reach  (the Analytics API cannot serve these).',
        'Check the supported combinations in the channel reports reference.',
      ],
      commands: [
        { run: 'ytstats reach', description: 'The only working source of impressions and CTR' },
        { run: 'ytstats query -m views --dimensions day', description: 'A minimal query known to work' },
      ],
      docs: ['https://developers.google.com/youtube/analytics/channel_reports'],
    },
  }),

  API_FORBIDDEN: def({
    code: 'API_FORBIDDEN',
    exitCode: EXIT.API,
    recoverable: true,
    retryable: false,
    title: 'YouTube denied access to this resource',
    detail: 'Authentication succeeded but the account is not permitted to read the requested data.',
    cause: 'The signed-in account does not own the channel or video, or a required scope was not granted.',
    remediation: {
      summary: 'Confirm the account owns the resource and re-authorize to grant all scopes.',
      steps: [
        'Run: ytstats status  — confirm the signed-in channel is the one you expect.',
        'If it is wrong: ytstats logout, then ytstats login with the owning account.',
        'If it is right, re-run login and approve every requested scope.',
      ],
      commands: [STATUS_CMD, { run: 'ytstats login', description: 'Re-authorize with all scopes' }],
      docs: [SETUP_DOC],
    },
  }),

  API_NOT_FOUND: def({
    code: 'API_NOT_FOUND',
    exitCode: EXIT.API,
    recoverable: true,
    retryable: false,
    title: 'Requested resource does not exist',
    detail: 'YouTube returned 404 for the requested id.',
    cause: 'A video id that is wrong, deleted, or belongs to another channel.',
    remediation: {
      summary: 'Verify the id against your own video list.',
      steps: [
        'Run: ytstats videos  — the data array contains every valid video id for this channel.',
        'Re-run with an id from that list.',
      ],
      commands: [{ run: 'ytstats videos', description: 'List all valid video ids for this channel' }],
      docs: [SETUP_DOC],
    },
  }),

  API_UNAVAILABLE: def({
    code: 'API_UNAVAILABLE',
    exitCode: EXIT.API,
    recoverable: true,
    retryable: true,
    title: 'YouTube API is temporarily unavailable',
    detail: 'Google returned a 5xx server error. Nothing is wrong with the request.',
    cause: 'Transient Google-side outage or overload.',
    remediation: {
      summary: 'Retry the identical command after a short wait.',
      steps: ['Wait 10-60 seconds.', 'Retry the same command unchanged.', 'If it persists, check the Google Cloud status dashboard.'],
      commands: [DOCTOR_CMD],
      docs: ['https://status.cloud.google.com/'],
    },
  }),

  NETWORK_UNREACHABLE: def({
    code: 'NETWORK_UNREACHABLE',
    exitCode: EXIT.API,
    recoverable: true,
    retryable: true,
    title: 'Could not reach Google',
    detail: 'The HTTP request failed before a response was received — DNS, TLS, proxy, or no connectivity.',
    cause: 'No internet access, a firewall, or a proxy intercepting the connection.',
    remediation: {
      summary: 'Restore connectivity to googleapis.com and retry.',
      steps: [
        'Confirm this machine has internet access.',
        'Confirm oauth2.googleapis.com and www.googleapis.com are reachable and not blocked.',
        'If behind a proxy, set HTTPS_PROXY before retrying.',
      ],
      commands: [DOCTOR_CMD],
      docs: ['https://status.cloud.google.com/'],
    },
  }),

  // ──────────────────────────────────────────────────────────────── input

  INPUT_UNKNOWN_COMMAND: def({
    code: 'INPUT_UNKNOWN_COMMAND',
    exitCode: EXIT.INPUT,
    recoverable: true,
    retryable: false,
    title: 'Unknown command',
    detail: 'That command does not exist.',
    cause: 'A typo, or a command from a different version of the CLI.',
    remediation: {
      summary: 'Use one of the supported commands.',
      steps: [
        'Run: ytstats --help  — lists every command.',
        'The allowed set is included in this diagnostic under context.allowed.',
      ],
      commands: [HELP_CMD],
      docs: [SETUP_DOC],
    },
  }),

  INPUT_UNKNOWN_OPTION: def({
    code: 'INPUT_UNKNOWN_OPTION',
    exitCode: EXIT.INPUT,
    recoverable: true,
    retryable: false,
    title: 'Unknown option',
    detail: 'That flag is not recognised by this command.',
    cause: 'A typo, or a flag that belongs to a different subcommand.',
    remediation: {
      summary: 'Check the flags this specific command accepts.',
      steps: ['Run: ytstats <command> --help  — lists the flags valid for that command.'],
      commands: [HELP_CMD],
      docs: [SETUP_DOC],
    },
  }),

  INPUT_MISSING_REQUIRED: def({
    code: 'INPUT_MISSING_REQUIRED',
    exitCode: EXIT.INPUT,
    recoverable: true,
    retryable: false,
    title: 'Required option missing',
    detail: 'A mandatory option was not supplied.',
    cause: 'The command cannot run without this value.',
    remediation: {
      summary: 'Supply the missing option and re-run.',
      steps: ['Add the flag named in context.flag.', 'Run: ytstats <command> --help  to see its expected value.'],
      commands: [HELP_CMD],
      docs: [SETUP_DOC],
    },
  }),

  INPUT_INVALID_CHOICE: def({
    code: 'INPUT_INVALID_CHOICE',
    exitCode: EXIT.INPUT,
    recoverable: true,
    retryable: false,
    title: 'Option value is not one of the allowed choices',
    detail: 'The value supplied is outside the permitted set.',
    cause: 'A value not in the enumerated list for this flag.',
    remediation: {
      summary: 'Re-run using one of the allowed values listed in context.allowed.',
      steps: ['Pick a value from context.allowed.', 'Re-run the command with that value.'],
      commands: [HELP_CMD],
      docs: [SETUP_DOC],
    },
  }),

  INPUT_INVALID_DATE: def({
    code: 'INPUT_INVALID_DATE',
    exitCode: EXIT.INPUT,
    recoverable: true,
    retryable: false,
    title: 'Date is not in the expected format',
    detail: 'Dates must be ISO calendar dates formatted YYYY-MM-DD.',
    cause: 'A locale-style date (01/01/2026), a natural-language date, or a calendar-invalid day.',
    // Guaranteed on the diagnostic even when a call site forgets to pass it.
    defaults: { expected: 'YYYY-MM-DD (e.g. 2026-01-01)' },
    remediation: {
      summary: 'Re-run using YYYY-MM-DD.',
      steps: [
        'Format the date as YYYY-MM-DD, e.g. 2026-01-01.',
        'Or drop --start/--end and use --days <n> for a relative window.',
      ],
      commands: [
        { run: 'ytstats daily --days 30', description: 'Relative window, no date parsing needed' },
        HELP_CMD,
      ],
      docs: [SETUP_DOC],
    },
  }),

  INPUT_INVALID_RANGE: def({
    code: 'INPUT_INVALID_RANGE',
    exitCode: EXIT.INPUT,
    recoverable: true,
    retryable: false,
    title: 'Date range is inverted or out of bounds',
    detail: 'The start date must be on or before the end date, and --days must be a positive number.',
    cause: 'Start and end were swapped, or a non-positive/absurd day count was supplied.',
    defaults: { expected: '--start on or before --end; --days a positive integer' },
    remediation: {
      summary: 'Correct the range and re-run.',
      steps: ['Ensure --start is on or before --end.', 'Ensure --days is a positive integer.'],
      commands: [{ run: 'ytstats daily --days 30', description: 'A known-good relative window' }, HELP_CMD],
      docs: [SETUP_DOC],
    },
  }),

  INPUT_INVALID_VALUE: def({
    code: 'INPUT_INVALID_VALUE',
    exitCode: EXIT.INPUT,
    recoverable: true,
    retryable: false,
    title: 'Option value is not valid',
    detail: 'The supplied value could not be interpreted for this flag.',
    cause: 'Wrong type or an out-of-range value.',
    remediation: {
      summary: 'Correct the value and re-run.',
      steps: ['Check context.expected for what this flag accepts.', 'Run: ytstats <command> --help'],
      commands: [HELP_CMD],
      docs: [SETUP_DOC],
    },
  }),

  // ──────────────────────────────────────────────────────────────── data

  DATA_PARTIAL: def({
    code: 'DATA_PARTIAL',
    severity: SEVERITY.WARNING,
    exitCode: EXIT.OK,
    recoverable: true,
    retryable: true,
    title: 'Some datasets could not be fetched',
    detail:
      'One or more analytics steps failed while the rest succeeded. The affected datasets are empty in ' +
      'data — empty here means "not fetched", not "no activity".',
    cause: 'YouTube rejects certain metric/dimension combinations for certain channels.',
    remediation: {
      summary: 'Treat the named datasets as unknown rather than zero. Others are complete and usable.',
      steps: [
        'Read warnings[].context.step for which datasets are missing.',
        'Do not interpret an empty dataset listed here as zero activity.',
        'Retrying may succeed if the cause was transient.',
      ],
      commands: [DOCTOR_CMD],
      docs: ['https://developers.google.com/youtube/analytics/channel_reports'],
    },
  }),

  DATA_EMPTY: def({
    code: 'DATA_EMPTY',
    severity: SEVERITY.WARNING,
    exitCode: EXIT.OK,
    recoverable: true,
    retryable: false,
    title: 'Query succeeded but returned no rows',
    detail: 'YouTube accepted the query and returned zero rows. This is genuinely no data, not a failure.',
    cause: 'The window predates the channel, the channel had no activity, or the metric does not apply.',
    remediation: {
      summary: 'Widen the window or confirm the channel had activity in this period.',
      steps: ['Try a wider window, e.g. --days 90.', 'Run: ytstats channel  to confirm the channel has views at all.'],
      commands: [
        { run: 'ytstats channel', description: 'Confirm the channel has lifetime activity' },
        { run: 'ytstats daily --days 90', description: 'Retry over a wider window' },
      ],
      docs: [SETUP_DOC],
    },
  }),

  REACH_PENDING: def({
    code: 'REACH_PENDING',
    severity: SEVERITY.WARNING,
    exitCode: EXIT.OK,
    recoverable: true,
    retryable: true,
    title: 'Reach reporting job created — data not generated yet',
    detail:
      'Impressions and CTR come from the asynchronous Reporting API. The job now exists, but YouTube has ' +
      'not produced any report files yet. This is expected on first use and is not an error.',
    cause: 'First run of ytstats reach. YouTube generates the first reports within 24-48 hours, including a 30-day backfill.',
    remediation: {
      summary: 'Wait 24-48 hours, then run ytstats reach again. Nothing else is required.',
      steps: [
        'Do not re-create the job — it already exists and re-running is harmless.',
        'Re-run ytstats reach after 24-48 hours.',
        'Note this data is permanently 1-2 days behind; today and yesterday will never be present.',
      ],
      commands: [
        { run: 'ytstats reach', description: 'Re-run after 24-48 hours to download the generated reports' },
        { run: 'ytstats reach-jobs', description: 'Confirm the reporting job exists' },
      ],
      docs: ['https://developers.google.com/youtube/reporting/v1/reports'],
    },
  }),

  REPORTING_JOBS_MISSING: def({
    code: 'REPORTING_JOBS_MISSING',
    severity: SEVERITY.WARNING,
    exitCode: EXIT.OK,
    recoverable: true,
    // Re-running the same command changes nothing — jobs must be created first.
    retryable: false,
    title: 'Reporting jobs are missing, so YouTube is not collecting this data',
    detail:
      'The YouTube Reporting API only generates a report once a job exists for it. Report types with no ' +
      'job are producing nothing right now, and creating a job later backfills just 30 days — everything ' +
      'older is unrecoverable by any means. This is silent by design: queries keep succeeding and the ' +
      'missing history never appears as an error.',
    cause:
      'A reporting job was never created for these report types. ytstats only creates the reach job, and ' +
      'only when ytstats reach is first run.',
    remediation: {
      summary: 'Create the missing jobs now — the backfill window is 30 days and it is already running.',
      steps: [
        'Run: ytstats reports  to see which report types have no job.',
        'Run: ytstats reports-enable --all  to create a job for every schedulable type.',
        'Wait 24-48 hours, then the first reports (including a 30-day backfill) become downloadable.',
        'Download regularly: reports expire 60 days after generation (30 days for backfill reports), ' +
          'so a job nobody collects from still loses data.',
      ],
      commands: [
        { run: 'ytstats reports', description: 'Show which report types have no job' },
        { run: 'ytstats reports-enable --all', description: 'Create a job for every missing report type' },
      ],
      docs: ['https://developers.google.com/youtube/reporting/v1/reports'],
    },
  }),

  REPORTS_EXPIRING: def({
    code: 'REPORTS_EXPIRING',
    severity: SEVERITY.WARNING,
    exitCode: EXIT.OK,
    recoverable: true,
    retryable: false,
    title: 'Generated reports are about to expire and have not been archived',
    detail:
      'YouTube has generated reports that have never been downloaded. Reports expire 60 days after ' +
      'generation (30 days for backfill reports), so these will disappear from Google\'s servers and ' +
      'the periods they cover will have no record anywhere. Reporting jobs make YouTube generate data; ' +
      'they do not preserve it.',
    cause:
      'ytstats sync has not been run recently enough. The Reporting API is a delivery mechanism with ' +
      'expiring artifacts, not an archive.',
    remediation: {
      summary: 'Run ytstats sync now, then put it on a schedule shorter than 60 days.',
      steps: [
        'Run: ytstats sync  to download everything outstanding into the local archive.',
        'Schedule it — monthly is comfortable against a 60-day expiry, weekly is safer.',
        'Run: ytstats archive  to confirm what is now stored locally.',
        'Back up the archive directory; it is the only copy of data older than 60 days.',
      ],
      commands: [
        { run: 'ytstats sync', description: 'Download every outstanding report into the local archive' },
        { run: 'ytstats archive', description: 'Show what the local archive currently holds' },
      ],
      docs: ['https://developers.google.com/youtube/reporting/v1/reports'],
    },
  }),

  ANALYTICS_METRICS_UNSUPPORTED: def({
    code: 'ANALYTICS_METRICS_UNSUPPORTED',
    severity: SEVERITY.WARNING,
    exitCode: EXIT.OK,
    recoverable: true,
    retryable: false,
    title: 'Some metrics are unavailable for this channel, so a reduced set was returned',
    detail:
      'YouTube rejected the full metric list for this query, so ytstats retried with the subset it accepts. ' +
      'The returned rows are correct — they simply carry fewer fields. Which metrics a channel supports ' +
      'varies, so this is not necessarily a fault.',
    cause:
      'The Analytics API rejects some documented metric/dimension combinations per channel. Newer metrics ' +
      'such as engagedViews and relativeRetentionPerformance are the usual ones missing.',
    remediation: {
      summary: 'Nothing to fix — read context.dropped to see which metrics were unavailable.',
      steps: [
        'Check context.dropped for the metrics YouTube would not return.',
        'Treat the absent fields as unknown rather than zero.',
        'Use ytstats query -m <metric> to test a single metric against this channel directly.',
      ],
      commands: [
        { run: 'ytstats query -m engagedViews --dimensions day', description: 'Test one metric against this channel' },
      ],
      docs: ['https://developers.google.com/youtube/analytics/metrics'],
    },
  }),

  CONFIG_UNWRITABLE: def({
    code: 'CONFIG_UNWRITABLE',
    exitCode: EXIT.GENERAL,
    recoverable: true,
    retryable: false,
    title: 'Configuration directory is not writable',
    detail: 'Credentials and tokens could not be saved, so authentication cannot persist between runs.',
    cause: 'Directory permissions, a read-only filesystem, or a container without a writable home.',
    remediation: {
      summary: 'Point YTSTATS_CONFIG_DIR at a writable directory.',
      steps: [
        'Set YTSTATS_CONFIG_DIR to a writable path, e.g. export YTSTATS_CONFIG_DIR=$PWD/.ytstats',
        'Re-run: ytstats login',
        'For CI, supply YTSTATS_CLIENT_ID and YTSTATS_CLIENT_SECRET as environment variables instead.',
      ],
      commands: [DOCTOR_CMD, LOGIN_CMD],
      docs: [SETUP_DOC],
    },
  }),

  UNEXPECTED: def({
    code: 'UNEXPECTED',
    exitCode: EXIT.GENERAL,
    recoverable: false,
    retryable: true,
    title: 'Unexpected internal error',
    detail: 'ytstats hit a condition it does not recognise. This is a bug worth reporting.',
    cause: 'Unanticipated failure — the underlying message is in context.detail.',
    remediation: {
      summary: 'Retry once; if it persists, run doctor and report the diagnostic.',
      steps: [
        'Retry the command once — some transient failures present this way.',
        'Run: ytstats doctor  to check whether the environment is healthy.',
        'If reproducible, report the issue including this diagnostic (it contains no secrets).',
      ],
      commands: [DOCTOR_CMD],
      docs: [SETUP_DOC],
    },
  }),
};

/** Strip anything resembling a stack frame; diagnostics are prose, never traces. */
function clean(text) {
  return String(text ?? '')
    .split('\n')
    .filter(line => !/^\s*at\s.+:\d+:\d+\)?$/.test(line.trimEnd()))
    .join('\n')
    .trim();
}

/**
 * Instantiate a diagnostic from its definition, interpolating call-site context.
 *
 * @param {DiagnosticDef} definition  an entry from DIAGNOSTICS
 * @param {object} [context]          flag, value, allowed, expected, step, account, detail…
 */
export function diagnose(definition, context = {}) {
  if (!definition?.code) {
    return diagnose(DIAGNOSTICS.UNEXPECTED, { detail: 'diagnose() called without a definition' });
  }

  const ctx = {};
  for (const [k, v] of Object.entries({ ...definition.defaults, ...context })) {
    if (v !== undefined && v !== null) ctx[k] = typeof v === 'string' ? clean(v) : v;
  }

  // Fold the specifics into detail so a caller reading only `detail` still learns
  // exactly what was wrong with their input.
  let detail = definition.detail;
  const bits = [];
  if (ctx.flag) bits.push(`Option: ${ctx.flag}`);
  if (ctx.value !== undefined) bits.push(`Received: ${JSON.stringify(ctx.value)}`);
  if (ctx.expected) bits.push(`Expected: ${ctx.expected}`);
  if (Array.isArray(ctx.allowed) && ctx.allowed.length) bits.push(`Allowed: ${ctx.allowed.join(', ')}`);
  if (ctx.step) bits.push(`Step: ${ctx.step}`);
  if (ctx.account) bits.push(`Account: ${ctx.account}`);
  if (ctx.detail) bits.push(`Underlying: ${ctx.detail}`);
  if (bits.length) detail = `${detail} ${bits.join('. ')}.`;

  return {
    code: definition.code,
    severity: definition.severity,
    title: definition.title,
    detail,
    cause: definition.cause,
    recoverable: definition.recoverable,
    retryable: definition.retryable,
    remediation: {
      summary: definition.remediation.summary,
      steps: [...definition.remediation.steps],
      commands: (definition.remediation.commands ?? []).map(c => ({ ...c })),
      docs: [...(definition.remediation.docs ?? [])],
    },
    context: ctx,
  };
}

export function isDiagnostic(value) {
  return Boolean(value && typeof value === 'object' && value.code && value.remediation && value.severity);
}

/** Worst exit code across a set of diagnostics; OK when there are no errors. */
export function exitCodeFor(diagnostics = []) {
  const errors = diagnostics.filter(d => d.severity === SEVERITY.ERROR);
  if (errors.length === 0) return EXIT.OK;
  const byCode = new Map(Object.values(DIAGNOSTICS).map(d => [d.code, d.exitCode]));
  return errors.reduce((worst, d) => Math.max(worst, byCode.get(d.code) ?? EXIT.GENERAL), EXIT.OK);
}
