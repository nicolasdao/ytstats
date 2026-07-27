import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';

import { createReporter } from './output.js';
import { EXIT_CODES, YtStatsError, ERROR_CODES, SETUP_GUIDE, fail } from './errors.js';
import { diagnose, DIAGNOSTICS, EXIT } from './diagnostics.js';
import { resolveDateRange } from './dates.js';
import { getAuthenticatedClient, login, logout } from './auth/session.js';
import { resolveCredentials, saveCredentials, validateClientId } from './auth/credentials.js';
import { listAccounts, setDefaultAccount, migrateLegacyTokens } from './auth/tokens.js';
import { configDir, writeJson, removeFile } from './config/store.js';
import { diagnoseGoogleError } from './errors.js';
import { createApis } from './api/client.js';
import * as data from './api/data.js';
import * as analytics from './api/analytics.js';
import * as reporting from './api/reporting.js';
import { fetchAll } from './fetch-all.js';

const pkg = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf-8'),
);

/**
 * Build the CLI. Everything stateful is injected so the whole surface can be
 * driven from tests without spawning a process.
 */
export function buildProgram(deps = {}) {
  const {
    stdout = s => process.stdout.write(s + '\n'),
    stderr = s => process.stderr.write(s + '\n'),
    exit = code => { process.exitCode = code; },
    session = { getAuthenticatedClient, login, logout },
    now = () => new Date(),
  } = deps;

  const program = new Command();
  let reporter = createReporter({ stdout, stderr });

  // Commander's default behaviour is to print usage to stderr and call
  // process.exit — which leaves stdout EMPTY. An agent parsing stdout would get
  // nothing at all, so every usage error is converted into the same envelope.
  program.exitOverride();
  program.configureOutput({
    writeErr: () => {},      // suppressed; we re-emit as a diagnostic
    writeOut: s => stdout(s.replace(/\n$/, '')),
  });

  program
    .name('ytstats')
    .description(
      'Pull your YouTube channel stats and analytics as JSON.\n\n' +
      'Bring your own Google Cloud OAuth credentials — there is no shared client id,\n' +
      'no server, and nothing leaves your machine. Run `ytstats login` to get started.',
    )
    .version(pkg.version)
    .option('-a, --account <channel>', 'channel id or @handle when several are logged in')
    .option('--compact', 'single-line JSON instead of pretty-printed', false)
    .option('-q, --quiet', 'suppress progress output on stderr', false)
    .showHelpAfterError('(run `ytstats --help` for usage)');

  // Rebuild the reporter once global flags are known.
  program.hook('preAction', thisCommand => {
    const o = thisCommand.opts();
    reporter = createReporter({ stdout, stderr, quiet: o.quiet, compact: o.compact });
  });

  /**
   * Wrap a command body: diagnostics in, one envelope + exit code out.
   *
   * `validate` runs BEFORE authentication and collects every input problem at
   * once. Checking auth first would hide a malformed date behind a login error,
   * costing an agent an extra loop iteration to discover the second problem.
   */
  const run = (name, body, { validate } = {}) => async (...args) => {
    const opts = program.opts();
    try {
      if (validate) {
        const problems = validate(...args, opts);
        if (problems?.length) return exit(reporter.fail(name, problems));
      }
      const result = await body(...args, opts);
      exit(reporter.succeed(name, result));
    } catch (err) {
      exit(reporter.fail(name, err));
    }
  };

  /** Authenticate and hand back the API bundle for a command body. */
  function withApis(globalOpts) {
    const { client, account } = session.getAuthenticatedClient({ account: globalOpts.account });
    return { apis: createApis(client), account };
  }

  const rangeFrom = (cmdOpts) =>
    resolveDateRange({ days: cmdOpts.days, start: cmdOpts.start, end: cmdOpts.end, now: now() });

  /** Collect date/range problems without throwing, so all are reported together. */
  function validateRange(cmdOpts) {
    const problems = [];
    for (const flag of ['start', 'end']) {
      const value = cmdOpts[flag];
      if (value === undefined) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        problems.push(diagnose(DIAGNOSTICS.INPUT_INVALID_DATE, {
          flag: `--${flag}`, value, expected: 'YYYY-MM-DD (e.g. 2026-01-01)',
        }));
        continue;
      }
      const parsed = new Date(`${value}T00:00:00Z`);
      if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
        problems.push(diagnose(DIAGNOSTICS.INPUT_INVALID_DATE, {
          flag: `--${flag}`, value, expected: 'an existing calendar date in YYYY-MM-DD form',
        }));
      }
    }

    if (cmdOpts.days !== undefined) {
      const n = Number(cmdOpts.days);
      if (!Number.isFinite(n) || n <= 0) {
        problems.push(diagnose(DIAGNOSTICS.INPUT_INVALID_RANGE, {
          flag: '--days', value: cmdOpts.days, expected: 'a positive integer, e.g. 90',
        }));
      }
    }

    if (!problems.length && cmdOpts.start && cmdOpts.end && cmdOpts.start > cmdOpts.end) {
      problems.push(diagnose(DIAGNOSTICS.INPUT_INVALID_RANGE, {
        flag: '--start', value: cmdOpts.start,
        expected: `a date on or before --end (${cmdOpts.end})`,
      }));
    }

    return problems;
  }

  const dateOptions = cmd =>
    cmd
      .option('-d, --days <number>', 'days of history to cover', '90')
      .option('--start <date>', 'start date YYYY-MM-DD (overrides --days)')
      .option('--end <date>', 'end date YYYY-MM-DD (default: today)');

  // ---------------------------------------------------------------- auth

  program
    .command('login')
    .description('sign in to YouTube with your own Google Cloud OAuth client')
    .option('-c, --client-secret <path>', 'path to the client_secret JSON downloaded from Google Cloud')
    .option('--no-browser', 'print the URL and paste the redirect back (headless/SSH)')
    .option('--timeout <seconds>', 'how long to wait for the browser callback', '300')
    .action(run('login', async (cmdOpts, globalOpts) => {
      const credentials = resolveCredentials({ clientSecretPath: cmdOpts.clientSecret });
      reporter.progress(`Using OAuth client from: ${credentials.source}`);

      // Surface a questionable client ID in the envelope, not just on stderr —
      // it is the leading cause of a browser "Access blocked" and a timed-out login.
      const idWarning = validateClientId(credentials.clientId);
      if (idWarning) reporter.warn(idWarning);

      const identity = await session.login({
        credentials,
        noBrowser: !cmdOpts.browser,
        timeoutMs: Number(cmdOpts.timeout) * 1000,
        deps: { log: msg => reporter.progress(msg) },
      });

      reporter.progress(`Signed in as ${identity.channelTitle ?? identity.channelId}.`);
      reporter.progress(`Credentials stored in ${configDir()} (readable only by you).`);
      return {
        channelId: identity.channelId,
        channelTitle: identity.channelTitle,
        customUrl: identity.customUrl,
        configDir: configDir(),
      };
    }));

  program
    .command('logout')
    .description('revoke tokens with Google and forget them locally')
    .option('--all', 'log out of every channel on this machine', false)
    .option('--forget-credentials', 'also delete the stored OAuth client id/secret', false)
    .action(run('logout', async (cmdOpts, globalOpts) => {
      const result = await session.logout({
        account: globalOpts.account,
        all: cmdOpts.all,
        forgetCredentials: cmdOpts.forgetCredentials,
      });
      reporter.progress(result.loggedOut ? 'Logged out.' : 'Nothing to log out of.');
      return result;
    }));

  program
    .command('status')
    .description('show which channels are signed in and where credentials live')
    .action(run('status', async () => {
      const accounts = listAccounts();
      let credentialSource = null;
      try {
        credentialSource = resolveCredentials().source;
      } catch {
        // Not configured yet; reported as null below.
      }
      return {
        authenticated: accounts.length > 0,
        configDir: configDir(),
        credentialSource,
        accounts,
        setupGuide: accounts.length === 0 ? SETUP_GUIDE : undefined,
      };
    }));

  program
    .command('doctor')
    .description('check every prerequisite and report exactly what is missing')
    .action(run('doctor', async (cmdOpts, globalOpts) => {
      // Ordered from cheapest to most expensive; each check reports pass/fail
      // independently so the caller sees the whole picture in one round trip.
      const checks = [];
      const record = (id, label, ok, detail, diagnostic) => {
        checks.push({ id, label, ok, detail, diagnostic: diagnostic ?? null });
        return ok;
      };

      // 1. Config directory writable
      let dir = null;
      try {
        dir = configDir();
        const probe = `.doctor-${process.pid}.json`;
        writeJson(probe, { ok: true });
        removeFile(probe);
        record('config_writable', 'Config directory is writable', true, dir);
      } catch (err) {
        record('config_writable', 'Config directory is writable', false, dir,
          diagnose(DIAGNOSTICS.CONFIG_UNWRITABLE, { detail: err.message }));
      }

      // 2. OAuth client credentials present
      let credentials = null;
      try {
        credentials = resolveCredentials();
        record('credentials', 'OAuth client credentials found', true, `source: ${credentials.source}`);
      } catch (err) {
        record('credentials', 'OAuth client credentials found', false, null,
          err.diagnostic ?? diagnose(DIAGNOSTICS.AUTH_NO_CREDENTIALS));
      }

      // 3. At least one signed-in account
      const accounts = listAccounts();
      if (accounts.length) {
        record('signed_in', 'Signed in to at least one channel', true,
          accounts.map(a => `${a.channelTitle ?? a.channelId} (${a.channelId})`).join(', '));
      } else {
        record('signed_in', 'Signed in to at least one channel', false, null,
          diagnose(DIAGNOSTICS.AUTH_NO_TOKENS));
      }

      // 4. Live API reachability — only meaningful if the above passed
      if (credentials && accounts.length) {
        try {
          const { apis } = withApis(globalOpts);
          const channel = await data.fetchChannel(apis);
          if (channel) {
            record('api_reachable', 'YouTube API reachable and token valid', true,
              `${channel.title} — ${channel.subscriberCount} subscribers`);
          } else {
            record('api_reachable', 'YouTube API reachable and token valid', false, null,
              diagnose(DIAGNOSTICS.AUTH_NO_CHANNEL));
          }
        } catch (err) {
          record('api_reachable', 'YouTube API reachable and token valid', false, null,
            err.diagnostic ?? diagnoseGoogleError(err));
        }
      } else {
        record('api_reachable', 'YouTube API reachable and token valid', false,
          'skipped — earlier checks failed', null);
      }

      const failed = checks.filter(c => !c.ok && c.diagnostic);
      for (const c of failed) reporter.warn(c.diagnostic);

      return {
        healthy: checks.every(c => c.ok),
        configDir: dir,
        checks: checks.map(({ diagnostic, ...rest }) => ({
          ...rest,
          diagnosticCode: diagnostic?.code ?? null,
        })),
        blocking: failed.map(c => c.diagnostic),
      };
    }));

  program
    .command('import-legacy <tokensFile>')
    .description('import tokens from a pre-ytstats project-local tokens.json')
    .option('-c, --client-secret <path>', 'client_secret JSON matching those tokens')
    .action(run('import-legacy', async (tokensFile, cmdOpts) => {
      const credentials = resolveCredentials({ clientSecretPath: cmdOpts.clientSecret });

      // The legacy file holds no channel identity, so exchange the tokens for it
      // before storing anything.
      const legacy = JSON.parse(fs.readFileSync(tokensFile, 'utf-8'));
      const client = new (await import('googleapis')).google.auth.OAuth2(
        credentials.clientId, credentials.clientSecret, 'http://127.0.0.1',
      );
      client.setCredentials(legacy);

      const { google } = await import('googleapis');
      const res = await google.youtube({ version: 'v3', auth: client })
        .channels.list({ part: 'snippet', mine: true });
      const channel = res.data.items?.[0];
      if (!channel) {
        throw new YtStatsError('Those tokens do not resolve to a YouTube channel.', {
          code: ERROR_CODES.NO_YOUTUBE_CHANNEL,
        });
      }

      saveCredentials(credentials);
      const result = migrateLegacyTokens(tokensFile, {
        channelId: channel.id,
        channelTitle: channel.snippet?.title,
        customUrl: channel.snippet?.customUrl,
      });

      reporter.progress(result.migrated
        ? `Imported tokens for ${channel.snippet?.title ?? channel.id}.`
        : `Nothing imported (${result.reason}).`);
      return { ...result, channelId: channel.id, channelTitle: channel.snippet?.title ?? null };
    }));

  program
    .command('use <channel>')
    .description('set the default channel for subsequent commands')
    .action(run('use', async channel => {
      const account = setDefaultAccount(channel);
      return { channelId: account.channelId, channelTitle: account.channelTitle };
    }));

  // ---------------------------------------------------------------- data

  program
    .command('channel')
    .description('channel metadata and lifetime stats')
    .action(run('channel', async (cmdOpts, globalOpts) => {
      const { apis } = withApis(globalOpts);
      return data.fetchChannel(apis);
    }));

  program
    .command('videos')
    .description('all videos with metadata and current view/like/comment counts')
    .option('-n, --limit <number>', 'maximum videos to return')
    .addOption(new Option('-s, --sort <field>', 'sort field')
      .choices(['publishedAt', 'viewCount', 'likeCount', 'commentCount', 'durationSeconds'])
      .default('publishedAt'))
    .addOption(new Option('--order <dir>', 'sort direction').choices(['asc', 'desc']).default('desc'))
    .addOption(new Option('-t, --type <type>', 'filter by content type')
      .choices(['SHORTS', 'VIDEO_ON_DEMAND', 'LIVE_STREAM']))
    .action(run('videos', async (cmdOpts, globalOpts) => {
      const { apis } = withApis(globalOpts);
      reporter.progress('Listing videos...');
      const channel = await data.fetchChannel(apis);
      if (!channel) throw new YtStatsError('No channel found.', { code: ERROR_CODES.NO_YOUTUBE_CHANNEL });

      const ids = await data.fetchAllVideoIds(apis, channel.uploadsPlaylistId);
      let videos = await data.fetchVideos(apis, ids);

      if (cmdOpts.type) videos = videos.filter(v => v.contentType === cmdOpts.type);
      const dir = cmdOpts.order === 'asc' ? 1 : -1;
      videos.sort((a, b) => {
        const x = a[cmdOpts.sort], y = b[cmdOpts.sort];
        if (x === y) return 0;
        return (x > y ? 1 : -1) * dir;
      });
      if (cmdOpts.limit) videos = videos.slice(0, Number(cmdOpts.limit));
      return videos;
    }));

  // ------------------------------------------------------------ analytics

  const simple = (name, description, fn) => {
    const cmd = program.command(name).description(description);
    dateOptions(cmd).action(run(
      name,
      async (cmdOpts, globalOpts) => {
        const { apis } = withApis(globalOpts);
        const range = rangeFrom(cmdOpts);
        reporter.progress(`Querying ${range.startDate} to ${range.endDate}...`);
        const rows = await fn(apis, range, cmdOpts);
        // Empty is ambiguous — say explicitly that the query worked and found nothing.
        if (Array.isArray(rows) && rows.length === 0) {
          reporter.warn(diagnose(DIAGNOSTICS.DATA_EMPTY, {
            step: name, detail: `No rows for ${range.startDate}..${range.endDate}`,
          }));
        }
        return { period: range, rows };
      },
      { validate: cmdOpts => validateRange(cmdOpts) },
    ));
    return cmd;
  };

  simple('daily', 'day-by-day views, watch time, likes, comments, subscribers',
    (apis, range) => analytics.fetchDailyAnalytics(apis, range));

  simple('traffic', 'where views come from, by traffic source type',
    (apis, range) => analytics.fetchTrafficSources(apis, range));

  simple('demographics', 'viewer age and gender split',
    (apis, range) => analytics.fetchDemographics(apis, range));

  simple('devices', 'views by device type',
    (apis, range) => analytics.fetchDeviceTypes(apis, range));

  simple('content-types', 'Shorts vs long-form vs live performance',
    (apis, range) => analytics.fetchContentTypes(apis, range));

  simple('playback-locations', 'where viewers watch (Shorts feed, watch page, embedded)',
    (apis, range) => analytics.fetchPlaybackLocations(apis, range));

  simple('video-analytics', 'per-video metrics for the period (top 200 by views)',
    (apis, range) => analytics.fetchVideoAnalytics(apis, range));

  simple('search-terms', 'what people search on YouTube to find your channel',
    (apis, range) => analytics.fetchSearchTerms(apis, range))
    .option('-n, --limit <number>', 'maximum terms (max 25)', '25');

  simple('geography', 'viewer breakdown by country',
    (apis, range, opts) => analytics.fetchGeography(apis, { ...range, maxResults: Number(opts.limit) }))
    .option('-n, --limit <number>', 'maximum countries', '50');

  dateOptions(
    program
      .command('retention <videoId>')
      .description('audience retention curve for one video (ratios >1.0 mean rewatching)'),
  ).action(run('retention', async (videoId, cmdOpts, globalOpts) => {
    const { apis } = withApis(globalOpts);
    const range = rangeFrom(cmdOpts);
    const curve = await analytics.fetchAudienceRetention(apis, { ...range, videoId });
    return { videoId, period: range, curve };
  }));

  dateOptions(
    program
      .command('query')
      .description('arbitrary YouTube Analytics API query')
      .requiredOption('-m, --metrics <list>', 'comma-separated metrics, e.g. views,likes')
      .option('--dimensions <list>', 'comma-separated dimensions, e.g. day')
      .option('--filters <filters>', 'dimension filters, e.g. video==VIDEO_ID')
      .option('--sort <field>', 'sort field, prefix with - for descending')
      .option('-n, --max <number>', 'maximum rows'),
  ).action(run('query', async (cmdOpts, globalOpts) => {
    const { apis } = withApis(globalOpts);
    const range = rangeFrom(cmdOpts);
    return analytics.runCustomReport(apis, {
      ...range,
      metrics: cmdOpts.metrics,
      dimensions: cmdOpts.dimensions,
      filters: cmdOpts.filters,
      sort: cmdOpts.sort,
      maxResults: cmdOpts.max ? Number(cmdOpts.max) : undefined,
    });
  }));

  // ------------------------------------------------------------- reach

  program
    .command('reach')
    .description('thumbnail impressions and CTR (Reporting API; 1-2 days behind)')
    .action(run('reach', async (cmdOpts, globalOpts) => {
      const { apis } = withApis(globalOpts);
      const result = await reporting.fetchReach(apis, { onProgress: m => reporter.progress(m) });
      if (result.pending) reporter.warn(result.message);
      return result;
    }));

  program
    .command('reach-jobs')
    .description('list YouTube Reporting API jobs on this channel')
    .action(run('reach-jobs', async (cmdOpts, globalOpts) => {
      const { apis } = withApis(globalOpts);
      return reporting.listReachJobs(apis);
    }));

  // ------------------------------------------------------------- fetch

  dateOptions(
    program
      .command('fetch')
      .description('every dimension in a single JSON document (the one to pipe into a script)')
      .option('--no-retention', 'skip retention curves (they cost one API call per video)')
      .option('--retention-limit <number>', 'how many recent videos to pull retention for', '50')
      .option('--reach', 'also include thumbnail impressions/CTR from the Reporting API', false),
  ).action(run('fetch', async (cmdOpts, globalOpts) => {
    const { apis } = withApis(globalOpts);
    const range = rangeFrom(cmdOpts);
    reporter.progress(`Fetching ${range.startDate} to ${range.endDate}...`);

    const result = await fetchAll(apis, {
      range,
      retention: cmdOpts.retention,
      retentionLimit: Number(cmdOpts.retentionLimit),
      reach: cmdOpts.reach,
      onProgress: m => reporter.progress(m),
    });

    for (const w of result.warnings) reporter.warn(`${w.step}: ${w.message}`);
    for (const n of result.notes) reporter.progress(n);
    return result;
  }));

  program.addHelpText('after', `
Examples:
  ytstats login --client-secret ~/Downloads/client_secret_123.json
  ytstats fetch --days 90 > snapshot.json
  ytstats videos --type SHORTS --sort viewCount | jq '.data[0:5]'
  ytstats query -m views,likes --dimensions day --start 2026-01-01

Output contract:
  stdout  exactly one JSON document: {ok, command, fetchedAt, data} or {ok:false, error}
  stderr  progress and warnings, safe to discard
  exit    0 ok, ${EXIT_CODES.AUTH} auth, ${EXIT_CODES.INPUT} bad input, ${EXIT_CODES.API} API error
`);

  return program;
}

/**
 * Translate a Commander failure into a diagnostic.
 *
 * Commander reports usage problems by writing prose to stderr and exiting, which
 * leaves an agent with an empty stdout and nothing to act on. Every one of these
 * becomes a normal envelope instead.
 */
export function diagnoseCommanderError(err, program) {
  const message = err?.message ?? '';
  const commands = program?.commands?.map(c => c.name()) ?? [];

  switch (err?.code) {
    case 'commander.unknownCommand': {
      const value = message.match(/unknown command '([^']+)'/)?.[1];
      return diagnose(DIAGNOSTICS.INPUT_UNKNOWN_COMMAND, { value, allowed: commands });
    }
    case 'commander.unknownOption': {
      const flag = message.match(/unknown option '([^']+)'/)?.[1];
      return diagnose(DIAGNOSTICS.INPUT_UNKNOWN_OPTION, { flag, detail: message });
    }
    case 'commander.missingMandatoryOptionValue':
    case 'commander.missingArgument': {
      const flag = message.match(/'([^']+)'/)?.[1];
      return diagnose(DIAGNOSTICS.INPUT_MISSING_REQUIRED, { flag, detail: message });
    }
    case 'commander.invalidArgument': {
      // e.g. option '-t, --type <type>' argument 'BOGUS' is invalid. Allowed choices are A, B.
      const flag = message.match(/option '([^']+)'/)?.[1];
      const value = message.match(/argument '([^']+)'/)?.[1];
      const allowed = message.match(/Allowed choices are ([^.]+)\./)?.[1]?.split(', ');
      return diagnose(DIAGNOSTICS.INPUT_INVALID_CHOICE, { flag, value, allowed, detail: message });
    }
    case 'commander.excessArguments':
      return diagnose(DIAGNOSTICS.INPUT_INVALID_VALUE, {
        detail: message, expected: 'fewer positional arguments',
      });
    default:
      return diagnose(DIAGNOSTICS.INPUT_INVALID_VALUE, { detail: message });
  }
}

/** Entry point used by bin/ytstats.js. */
export async function main(argv = process.argv, deps = {}) {
  const stdout = deps.stdout ?? (s => process.stdout.write(s + '\n'));
  const stderr = deps.stderr ?? (s => process.stderr.write(s + '\n'));
  const setExit = deps.exit ?? (code => { process.exitCode = code; });

  const program = buildProgram({ stdout, stderr, exit: setExit, ...deps });

  try {
    await program.parseAsync(argv);
  } catch (err) {
    // --help and --version are successful terminations, not failures.
    if (err?.code === 'commander.helpDisplayed' || err?.code === 'commander.help') return setExit(EXIT.OK);
    if (err?.code === 'commander.version') return setExit(EXIT.OK);

    const compact = argv.includes('--compact');
    const quiet = argv.includes('--quiet') || argv.includes('-q');
    const reporter = createReporter({ stdout, stderr, compact, quiet });

    const diagnostic = String(err?.code ?? '').startsWith('commander.')
      ? diagnoseCommanderError(err, program)
      : err;

    setExit(reporter.fail(commandNameFrom(argv), diagnostic));
  }
}

/** Best-effort command name for the envelope when parsing never got that far. */
function commandNameFrom(argv) {
  const rest = argv.slice(2).filter(a => !a.startsWith('-'));
  return rest[0] ?? 'ytstats';
}
