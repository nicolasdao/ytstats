import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command, Option } from 'commander';

import { createReporter } from './output.js';
import { EXIT_CODES, YtStatsError, ERROR_CODES, SETUP_GUIDE, fail } from './errors.js';
import { diagnose, DIAGNOSTICS, EXIT } from './diagnostics.js';
import { resolveDateRange } from './dates.js';
import { getAuthenticatedClient, login, logout, identifyLegacyTokens } from './auth/session.js';
import {
  resolveCredentials, saveCredentials, validateClientId,
  projectNumberFromClientId, consoleUrl,
} from './auth/credentials.js';

/** Fallback when no credentials resolved, so no project is known yet. */
const CONSOLE_HOST = 'https://console.cloud.google.com';
import { listAccounts, setDefaultAccount, migrateLegacyTokens } from './auth/tokens.js';
import { captionsScopeMissing } from './auth/oauth.js';
import { configDir, writeJson, removeFile } from './config/store.js';
import { diagnoseGoogleError } from './errors.js';
import { createApis } from './api/client.js';
import * as data from './api/data.js';
import * as analytics from './api/analytics.js';
import * as reporting from './api/reporting.js';
import * as captions from './api/captions.js';
import { fetchAll } from './fetch-all.js';
import { syncReports, findExpiringReports } from './sync.js';
import { archiveStatus, dataDir, readTranscript, writeTranscript } from './archive.js';

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
    session = { getAuthenticatedClient, login, logout, identifyLegacyTokens },
    now = () => new Date(),
    // Injected for the same reason every other effect is: without it no test can
    // drive an authenticated command, so the whole post-auth half of the CLI —
    // including which warnings a command emits — was unreachable from the suite.
    makeApis = createApis,
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
    // Commander appends the Command instance as the final argument. Passing
    // `...args` straight through therefore handed the *Command object* to the
    // body's `globalOpts` parameter and dropped `program.opts()` entirely — so
    // `globalOpts.account` was always undefined and `--account` silently did
    // nothing, in either position. Every multi-channel caller got the default
    // channel's data while believing they had selected another.
    const params = args.slice(0, -1);
    try {
      if (validate) {
        const problems = validate(...params, opts);
        if (problems?.length) return exit(reporter.fail(name, problems));
      }
      const result = await body(...params, opts);
      exit(reporter.succeed(name, result));
    } catch (err) {
      exit(reporter.fail(name, err));
    }
  };

  /**
   * The channel selector, accepted BEFORE the command (global) or after it
   * (per-command). Commander does not fold a post-command global option back
   * into the program's opts — it drops it silently — so reading only
   * `globalOpts.account` meant `ytstats daily --account @other` quietly
   * returned the DEFAULT channel's data, and `ytstats logout --account @other`
   * quietly revoked the default channel's token. Silently answering about the
   * wrong channel is the exact failure `AUTH_ACCOUNT_UNKNOWN` exists to prevent.
   */
  const accountFrom = (cmdOpts, globalOpts) => cmdOpts?.account ?? globalOpts?.account;

  /** Registers the selector on a command so both positions work. */
  const accountOption = cmd => cmd.option(
    '-a, --account <channel>',
    'channel id or @handle (also accepted before the command name)',
  );

  /** Authenticate and hand back the API bundle for a command body. */
  function withApis(globalOpts, cmdOpts) {
    const { client, account } = session.getAuthenticatedClient({
      account: accountFrom(cmdOpts, globalOpts),
    });
    return { apis: makeApis(client), account };
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
    .option('--with-captions', 'also request caption access, needed by `ytstats transcript` (write-capable scope)')
    .option('--timeout <seconds>', 'how long to wait for the browser callback', '300')
    .action(run('login', async (cmdOpts, globalOpts) => {
      const credentials = resolveCredentials({ clientSecretPath: cmdOpts.clientSecret });
      reporter.progress(`Using OAuth client from: ${credentials.source}`);

      // Surface a questionable client ID in the envelope, not just on stderr —
      // it is the leading cause of a browser "Access blocked" and a timed-out login.
      const idWarning = validateClientId(credentials.clientId);
      if (idWarning) reporter.warn(idWarning);

      if (cmdOpts.withCaptions) {
        reporter.progress(
          'Requesting caption access as well. Google will describe this as managing your ' +
          'YouTube account — it is the only scope captions have, and ytstats uses it to read.',
        );
      }

      const identity = await session.login({
        credentials,
        noBrowser: !cmdOpts.browser,
        withCaptions: Boolean(cmdOpts.withCaptions),
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
    .option('-a, --account <channel>', 'channel id or @handle (also accepted before the command name)')
    .option('--all', 'log out of every channel on this machine', false)
    .option('--forget-credentials', 'also delete the stored OAuth client id/secret', false)
    .action(run('logout', async (cmdOpts, globalOpts) => {
      const result = await session.logout({
        account: accountFrom(cmdOpts, globalOpts),
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
      let clientId = null;
      let project = null;
      try {
        // A client ID is public by OAuth design — only the secret is sensitive —
        // and with five resolution sources, "which one did it pick" is not
        // answerable from the source label alone.
        const credentials = resolveCredentials();
        credentialSource = credentials.source;
        clientId = credentials.clientId;
        // Which Google Cloud project these credentials belong to. Otherwise the
        // only way to find out is decoding the client ID by hand, and every
        // console link is a guess for anyone with more than one project.
        project = {
          id: credentials.projectId ?? null,
          number: projectNumberFromClientId(clientId),
          consoleUrl: consoleUrl('/auth/audience', credentials),
        };
      } catch {
        // Not configured yet; reported as null below.
      }
      return {
        authenticated: accounts.length > 0,
        configDir: configDir(),
        credentialSource,
        clientId,
        project,
        accounts,
        setupGuide: accounts.length === 0 ? SETUP_GUIDE : undefined,
      };
    }));

  program
    .command('doctor')
    .description('check every prerequisite and report exactly what is missing')
    .option('-a, --account <channel>', 'channel id or @handle (also accepted before the command name)')
    .action(run('doctor', async (cmdOpts, globalOpts) => {
      // Ordered from cheapest to most expensive; each check reports pass/fail
      // independently so the caller sees the whole picture in one round trip.
      const checks = [];
      // `status` carries what `ok` cannot: some prerequisites are real but not
      // verifiable from here. `ok` stays boolean for existing consumers, and an
      // `unknown` never drags down `healthy` — we did not find a problem, we
      // were unable to look.
      const record = (id, label, ok, detail, diagnostic, status) => {
        checks.push({
          id,
          label,
          ok,
          status: status ?? (ok ? 'pass' : 'fail'),
          detail,
          diagnostic: diagnostic ?? null,
        });
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

      // 4-6. Each of the three APIs is enabled independently in Google Cloud, so
      // each needs its own probe. Reaching only the Data API and reporting
      // "healthy" is worse than not checking: setup looks complete, then the
      // first `daily` or `reach` fails with API_NOT_ENABLED.
      if (credentials && accounts.length) {
        const { apis } = withApis(globalOpts, cmdOpts);
        const range = resolveDateRange({ days: 1 });

        // 4. Data API v3
        try {
          const channel = await data.fetchChannel(apis);
          if (channel) {
            record('api_reachable', 'YouTube Data API reachable and token valid', true,
              `${channel.title} — ${channel.subscriberCount} subscribers`);
          } else {
            record('api_reachable', 'YouTube Data API reachable and token valid', false, null,
              diagnose(DIAGNOSTICS.AUTH_NO_CHANNEL));
          }
        } catch (err) {
          record('api_reachable', 'YouTube Data API reachable and token valid', false, null,
            err.diagnostic ?? diagnoseGoogleError(err));
        }

        // 5. Analytics API v2 — everything with a date window depends on this.
        try {
          await analytics.fetchDailyAnalytics(apis, range);
          record('api_analytics', 'YouTube Analytics API enabled', true, 'one-day query succeeded');
        } catch (err) {
          record('api_analytics', 'YouTube Analytics API enabled', false, null,
            err.diagnostic ?? diagnoseGoogleError(err));
        }

        // 6. Reporting API v1 — the only source of thumbnail impressions and CTR.
        let reportingWorks = false;
        try {
          const jobs = await reporting.listJobs(apis);
          reportingWorks = true;
          record('api_reporting', 'YouTube Reporting API enabled', true,
            `${jobs.length} reporting job(s) on this channel`);
        } catch (err) {
          record('api_reporting', 'YouTube Reporting API enabled', false, null,
            err.diagnostic ?? diagnoseGoogleError(err));
        }

        // 7. Reporting jobs actually scheduled.
        //
        // The only check here that reports a loss rather than a blockage. An
        // enabled API with no job still answers every request successfully — it
        // just returns data YouTube never generated. Because creating a job
        // backfills 30 days and nothing recovers more, the cost of noticing late
        // is measured in months of history, so this fails rather than warns.
        if (reportingWorks) {
          try {
            const audit = await reporting.auditReportingJobs(apis);
            if (audit.missing.length === 0) {
              record('reporting_jobs', 'Reporting jobs scheduled for every report type', true,
                `${audit.active.length}/${audit.available.length} report types collecting`);
            } else {
              record('reporting_jobs', 'Reporting jobs scheduled for every report type', false,
                `${audit.active.length}/${audit.available.length} report types collecting. `
                + `Not collecting: ${audit.missing.map(t => t.id).join(', ')}. `
                + 'YouTube generates nothing for these until a job exists, and creating one later '
                + 'backfills only 30 days.',
                diagnose(DIAGNOSTICS.REPORTING_JOBS_MISSING, {
                  detail: `${audit.missing.length} report type(s) have no job: `
                    + audit.missing.map(t => t.id).join(', '),
                }));
            }
          } catch (err) {
            record('reporting_jobs', 'Reporting jobs scheduled for every report type', false, null,
              err.diagnostic ?? diagnoseGoogleError(err));
          }
          // 7b. Generated reports actually downloaded.
          //
          // Jobs and archiving are separate failures with the same symptom. A
          // perfectly configured job still loses data if nothing collects from
          // it, because reports expire 60 days after generation — so checking
          // only that jobs exist would call that setup healthy too.
          try {
            const { pending, urgent } = await findExpiringReports(apis, { now: now() });
            if (!pending.length) {
              record('reports_archived', 'Generated reports downloaded to the local archive', true,
                'nothing outstanding');
            } else if (!urgent.length) {
              record('reports_archived', 'Generated reports downloaded to the local archive', true,
                `${pending.length} report(s) not yet archived, none within 14 days of expiry. `
                + 'Run: ytstats sync');
            } else {
              const soonest = urgent[0];
              record('reports_archived', 'Generated reports downloaded to the local archive', false,
                `${urgent.length} of ${pending.length} un-archived report(s) expire within 14 days `
                + `(soonest: ${soonest.reportTypeId}, ${soonest.daysUntilExpiry} day(s) left).`,
                diagnose(DIAGNOSTICS.REPORTS_EXPIRING, {
                  detail: `${urgent.length} report(s) expire within 14 days; `
                    + `${soonest.reportTypeId} has ${soonest.daysUntilExpiry} day(s) left`,
                }));
            }
          } catch (err) {
            record('reports_archived', 'Generated reports downloaded to the local archive', false, null,
              err.diagnostic ?? diagnoseGoogleError(err));
          }
        } else {
          record('reporting_jobs', 'Reporting jobs scheduled for every report type', false,
            'skipped — the Reporting API is not reachable', null);
          record('reports_archived', 'Generated reports downloaded to the local archive', false,
            'skipped — the Reporting API is not reachable', null);
        }
      } else {
        for (const [id, label] of [
          ['api_reachable', 'YouTube Data API reachable and token valid'],
          ['api_analytics', 'YouTube Analytics API enabled'],
          ['api_reporting', 'YouTube Reporting API enabled'],
          ['reporting_jobs', 'Reporting jobs scheduled for every report type'],
          ['reports_archived', 'Generated reports downloaded to the local archive'],
        ]) record(id, label, false, 'skipped — earlier checks failed', null);
      }

      // 9. Consent screen published to Production.
      //
      // No Google API exposes this, so it cannot be checked directly — and it is
      // the one setup step whose failure is delayed: in Testing, Google expires
      // refresh tokens after 7 days. Reporting it as `unknown` rather than
      // omitting it keeps a real prerequisite visible instead of letting
      // `healthy: true` imply a step nobody looked at.
      //
      // Age is the one honest signal: a token still working after 7 days proves
      // Production, because Testing would already have killed it.
      // authorizedAt, never savedAt — savedAt is rewritten on every token refresh,
      // so for an actively used install it always reads as "just now" and this
      // check would never fire.
      const oldest = accounts
        .map(a => Date.parse(a.authorizedAt ?? ''))
        .filter(t => Number.isFinite(t))
        .sort((a, b) => a - b)[0];
      const ageDays = oldest ? (now().getTime() - oldest) / 86_400_000 : null;
      const apiWorks = checks.find(c => c.id === 'api_reachable')?.ok === true;

      if (apiWorks && ageDays !== null && ageDays > 7) {
        record('consent_screen', 'OAuth consent screen published to Production', true,
          `proven — a token ${Math.floor(ageDays)} days old still works, which Testing mode would have expired`);
      } else {
        // Pin the link to this project. A bare console URL opens whichever
        // project the browser last used, so telling someone to "check the
        // consent screen" can send them to the wrong one entirely.
        const consentUrl = credentials
          ? consoleUrl('/auth/audience', credentials)
          : `${CONSOLE_HOST}/auth/audience`;
        record('consent_screen', 'OAuth consent screen published to Production', true,
          'cannot be verified — no API exposes this. In Testing, Google expires refresh tokens after 7 days. '
          + `Confirm the status reads "In production" at ${consentUrl}`,
          null, 'unknown');
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
      let legacy;
      try {
        legacy = JSON.parse(fs.readFileSync(tokensFile, 'utf-8'));
      } catch {
        // A mistyped path is as ordinary as an expired token during a migration;
        // neither is an internal error.
        throw fail(DIAGNOSTICS.INPUT_INVALID_VALUE, {
          value: tokensFile,
          expected: 'a readable JSON token file containing a refresh_token',
        });
      }

      const identity = await session.identifyLegacyTokens({ credentials, tokens: legacy });
      if (!identity?.channelId) {
        throw new YtStatsError('Those tokens do not resolve to a YouTube channel.', {
          code: ERROR_CODES.NO_YOUTUBE_CHANNEL,
        });
      }

      saveCredentials(credentials);
      const result = migrateLegacyTokens(tokensFile, {
        channelId: identity.channelId,
        channelTitle: identity.channelTitle,
        customUrl: identity.customUrl,
      });

      reporter.progress(result.migrated
        ? `Imported tokens for ${identity.channelTitle ?? identity.channelId}.`
        : `Nothing imported (${result.reason}).`);
      return { ...result, channelId: identity.channelId, channelTitle: identity.channelTitle ?? null };
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
    .option('-a, --account <channel>', 'channel id or @handle (also accepted before the command name)')
    .action(run('channel', async (cmdOpts, globalOpts) => {
      const { apis } = withApis(globalOpts, cmdOpts);
      return data.fetchChannel(apis);
    }));

  program
    .command('videos')
    .description('all videos with metadata and current view/like/comment counts')
    .option('-a, --account <channel>', 'channel id or @handle (also accepted before the command name)')
    .option('-n, --limit <number>', 'maximum videos to return')
    .addOption(new Option('-s, --sort <field>', 'sort field')
      .choices(['publishedAt', 'viewCount', 'likeCount', 'commentCount', 'durationSeconds'])
      .default('publishedAt'))
    .addOption(new Option('--order <dir>', 'sort direction').choices(['asc', 'desc']).default('desc'))
    .addOption(new Option('-t, --type <type>', 'filter by content type')
      .choices(['SHORTS', 'VIDEO_ON_DEMAND', 'LIVE_STREAM']))
    .action(run('videos', async (cmdOpts, globalOpts) => {
      const { apis } = withApis(globalOpts, cmdOpts);
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

  /**
   * Dimensions that can partition an existing report rather than adding a new one.
   *
   * Deliberately just these two: each addition is a value the agent skill and the
   * docs must teach a reader to interpret, and the API's support for a segment
   * varies by report — see the exclusion below and `docs/gotchas/youtube-api.md`.
   */
  const SEGMENTS = ['subscribedStatus', 'youtubeProduct'];

  const simple = (name, description, fn, { segmentable = true } = {}) => {
    const cmd = accountOption(program.command(name).description(description));
    // Declared even where it is refused, so `--segment` on those commands fails as
    // an invalid choice naming the flag rather than as an unknown option. Hidden
    // from their help, because advertising a flag that always fails is worse.
    const segment = new Option('--segment <dimension>', 'partition rows by a second dimension')
      .choices(SEGMENTS);
    if (!segmentable) segment.hideHelp();

    dateOptions(cmd).addOption(segment).action(run(
      name,
      async (cmdOpts, globalOpts) => {
        const { apis } = withApis(globalOpts, cmdOpts);
        const range = rangeFrom(cmdOpts);
        reporter.progress(`Querying ${range.startDate} to ${range.endDate}...`);

        // Collected here rather than per-command so every dataset reports a
        // dropped metric. Without this the tiered fallback is invisible on these
        // commands: rows arrive with a null column and nothing says why — the
        // same shape as the reach-CSV regression, which stayed hidden for two
        // months precisely because ok stayed true and no warning fired.
        const dropped = [];
        const rows = await fn(
          apis,
          { ...range, segment: cmdOpts.segment, onDegraded: m => dropped.push(...m) },
          cmdOpts,
        );

        // Empty is ambiguous — say explicitly that the query worked and found nothing.
        if (Array.isArray(rows) && rows.length === 0) {
          reporter.warn(diagnose(DIAGNOSTICS.DATA_EMPTY, {
            step: name, detail: `No rows for ${range.startDate}..${range.endDate}`,
          }));
        }
        if (dropped.length) {
          reporter.warn(diagnose(DIAGNOSTICS.ANALYTICS_METRICS_UNSUPPORTED, {
            step: name,
            detail: `Unavailable for this channel: ${dropped.join(', ')}`,
            dropped: dropped.join(', '),
          }));
        }
        // `period` is the clean range — never the object carrying onDegraded.
        return { period: range, rows };
      },
      {
        validate: cmdOpts => {
          const problems = validateRange(cmdOpts);
          // Rejected here rather than at the API, which answers a segmented
          // insightTrafficSourceDetail query with an opaque "query is not
          // supported" that names neither the flag nor the reason.
          if (cmdOpts.segment && !segmentable) {
            problems.push(diagnose(DIAGNOSTICS.INPUT_INVALID_CHOICE, {
              flag: '--segment',
              value: cmdOpts.segment,
              allowed: [],
              detail: `${name} cannot be segmented — it reads the insightTrafficSourceDetail `
                + 'dimension, which tolerates only the views metric and fails outright when a '
                + 'second dimension is added. Run it unsegmented.',
            }));
          }
          return problems;
        },
      },
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
    (apis, range) => analytics.fetchSearchTerms(apis, range), { segmentable: false })
    .option('-n, --limit <number>', 'maximum terms (max 25)', '25');

  simple('geography', 'viewer breakdown by country',
    (apis, range, opts) => analytics.fetchGeography(apis, { ...range, maxResults: Number(opts.limit) }))
    .option('-n, --limit <number>', 'maximum countries', '50');

  dateOptions(
    program
      .command('retention <videoId>')
      .description('audience retention curve for one video (ratios >1.0 mean rewatching)')
      .option('-a, --account <channel>', 'channel id or @handle (also accepted before the command name)'),
  ).action(run('retention', async (videoId, cmdOpts, globalOpts) => {
    const { apis } = withApis(globalOpts, cmdOpts);
    const range = rangeFrom(cmdOpts);

    // Without this, a channel that cannot serve the drop-off metrics gets a curve
    // whose new fields are all null and nothing anywhere saying why — the exact
    // shape of the reach-CSV regression this project already paid for once.
    const dropped = [];
    const curve = await analytics.fetchAudienceRetention(apis, {
      ...range,
      videoId,
      onDegraded: m => dropped.push(...m),
    });
    if (dropped.length) {
      reporter.warn(diagnose(DIAGNOSTICS.ANALYTICS_METRICS_UNSUPPORTED, {
        detail: `Unavailable for this channel: ${dropped.join(', ')}`,
        dropped: dropped.join(', '),
      }));
    }
    return { videoId, period: range, curve };
  }));

  accountOption(
    program
      .command('transcript <videoId>')
      .description('caption transcript with cue timings, for a video you own'),
  ).action(run('transcript', async (videoId, cmdOpts, globalOpts) => {
    const { apis, account } = withApis(globalOpts, cmdOpts);

    // Pre-flight only when the stored grant is KNOWN to lack the scope. A null
    // scopes array means unknown — accounts saved before the field existed have
    // one — and refusing those would lock out every pre-upgrade user to prevent a
    // problem most of them do not have. Let Google's own 403 speak in that case.
    if (captionsScopeMissing(account)) {
      throw fail(DIAGNOSTICS.AUTH_SCOPE_MISSING, {
        account: account.channelTitle ?? account.channelId,
      });
    }

    reporter.progress(`Listing caption tracks for ${videoId}...`);
    const tracks = await captions.listCaptionTracks(apis, videoId);
    const track = captions.selectCaptionTrack(tracks);

    if (!track) {
      // Worked and found nothing — distinguishable from failed, per the same
      // convention every dataset command follows.
      reporter.warn(diagnose(DIAGNOSTICS.DATA_EMPTY, {
        step: 'transcript',
        detail: `Video ${videoId} has no usable caption track (${tracks.length} found, drafts excluded)`,
      }));
      return {
        videoId, trackId: null, language: null, trackKind: null,
        lastUpdated: null, cachedAt: null, cues: [],
      };
    }

    // Captions can be edited after upload, so the cache keys on the track's
    // lastUpdated rather than merely on the video id. captions.list is the cheap
    // call; captions.download is the one worth avoiding.
    const cached = readTranscript(videoId);
    if (cached && cached.trackId === track.id && cached.lastUpdated === track.lastUpdated) {
      reporter.progress('Using the cached transcript; the track has not changed since.');
      return cached;
    }

    reporter.progress(`Downloading the ${track.trackKind === 'ASR' ? 'auto-generated' : 'author-written'} ${track.language ?? 'default'} track...`);
    const { cues } = await captions.downloadCaptionTrack(apis, track.id);

    const record = {
      videoId,
      // Which track spoke is part of the answer: an auto-generated transcript and
      // an author-written one are different claims about the same video.
      trackId: track.id,
      language: track.language,
      trackKind: track.trackKind,
      lastUpdated: track.lastUpdated,
      cachedAt: now().toISOString(),
      cues,
    };
    writeTranscript(videoId, record);

    if (cues.length === 0) {
      reporter.warn(diagnose(DIAGNOSTICS.DATA_EMPTY, {
        step: 'transcript',
        detail: `Caption track ${track.id} downloaded but contained no cues`,
      }));
    }
    return record;
  }));

  dateOptions(
    program
      .command('query')
      .description('arbitrary YouTube Analytics API query')
    .option('-a, --account <channel>', 'channel id or @handle (also accepted before the command name)')
      .requiredOption('-m, --metrics <list>', 'comma-separated metrics, e.g. views,likes')
      .option('--dimensions <list>', 'comma-separated dimensions, e.g. day')
      .option('--filters <filters>', 'dimension filters, e.g. video==VIDEO_ID')
      .option('--sort <field>', 'sort field, prefix with - for descending')
      .option('-n, --max <number>', 'maximum rows'),
  ).action(run('query', async (cmdOpts, globalOpts) => {
    const { apis } = withApis(globalOpts, cmdOpts);
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
    .option('-a, --account <channel>', 'channel id or @handle (also accepted before the command name)')
    .action(run('reach', async (cmdOpts, globalOpts) => {
      const { apis } = withApis(globalOpts, cmdOpts);
      const result = await reporting.fetchReach(apis, { onProgress: m => reporter.progress(m) });
      if (result.pending) reporter.warn(result.message);
      return result;
    }));

  program
    .command('reach-jobs')
    .description('list YouTube Reporting API jobs on this channel')
    .option('-a, --account <channel>', 'channel id or @handle (also accepted before the command name)')
    .action(run('reach-jobs', async (cmdOpts, globalOpts) => {
      const { apis } = withApis(globalOpts, cmdOpts);
      return reporting.listJobs(apis);
    }));

  // ------------------------------------------------------------- reports
  //
  // The Reporting API only generates a report once a job exists for it, and a job
  // created today backfills 30 days and no more. These two commands exist so that
  // gap is visible and closable before it becomes unrecoverable history.

  accountOption(
    program
      .command('reports')
      .description('which Reporting API report types are collecting data, and which are not'),
  ).action(run('reports', async (cmdOpts, globalOpts) => {
    const { apis } = withApis(globalOpts, cmdOpts);
    const audit = await reporting.auditReportingJobs(apis);

    if (audit.missing.length) {
      reporter.warn(diagnose(DIAGNOSTICS.REPORTING_JOBS_MISSING, {
        detail: `${audit.missing.length} of ${audit.available.length} report type(s) have no job: `
          + audit.missing.map(t => t.id).join(', '),
      }));
    }
    return audit;
  }));

  accountOption(
    program
      .command('reports-enable')
      .description('create Reporting API jobs so YouTube starts generating the missing reports')
      .option('--all', 'create a job for every report type that has none', false)
      .option('-t, --type <id...>', 'create jobs for specific report type ids'),
  ).action(run('reports-enable', async (cmdOpts, globalOpts) => {
    const { apis } = withApis(globalOpts, cmdOpts);
    const audit = await reporting.auditReportingJobs(apis);

    const wanted = cmdOpts.type?.length ? cmdOpts.type : audit.missing.map(t => t.id);
    const result = await reporting.ensureJobs(apis, wanted, { onProgress: m => reporter.progress(m) });

    // A requested id that this channel cannot schedule is worth naming: silently
    // returning "0 created" reads as "nothing to do" rather than "that was wrong".
    for (const f of result.failed) reporter.warn(`${f.reportTypeId}: ${f.message}`);

    return {
      ...result,
      requested: wanted,
      // First reports arrive 24-48h later, so an immediate re-run showing zero
      // rows is expected rather than a sign the jobs did not take.
      note: result.created.length
        ? `${result.created.length} job(s) created. YouTube generates the first reports within `
          + '24-48 hours, including a 30-day backfill. Download regularly — reports expire 60 days '
          + 'after generation (30 days for backfill reports).'
        : 'No new jobs were needed.',
    };
  }, { validate: cmdOpts => (
    cmdOpts.all || cmdOpts.type?.length
      ? []
      : [diagnose(DIAGNOSTICS.INPUT_MISSING_REQUIRED, {
        flag: '--all',
        detail: 'Pass --all to create every missing job, or --type <id> for specific report types. '
          + 'Run ytstats reports first to see what is missing',
      })]
  ) }));

  // ------------------------------------------------------------- archive
  //
  // Creating jobs makes YouTube generate reports; it does not stop them expiring
  // 60 days later. `sync` is what turns a rolling window into history.

  accountOption(
    program
      .command('sync')
      .description('download every outstanding Reporting API report into the local archive'),
  ).action(run('sync', async (cmdOpts, globalOpts) => {
    const { apis } = withApis(globalOpts, cmdOpts);
    const result = await syncReports(apis, { onProgress: m => reporter.progress(m) });
    for (const f of result.failed) reporter.warn(`${f.reportTypeId}: ${f.message}`);
    return {
      ...result,
      dataDir: dataDir(),
      note: 'Reports expire 60 days after generation (30 for backfill). Run this on a schedule '
        + 'shorter than that — the archive is the only copy of anything older.',
    };
  }));

  // Reads local files only — no auth, like `status`.
  program
    .command('archive')
    .description('what the local report archive holds')
    .action(run('archive', async () => archiveStatus()));

  // ------------------------------------------------------------- fetch

  dateOptions(
    program
      .command('fetch')
      .description('every dimension in a single JSON document (the one to pipe into a script)')
    .option('-a, --account <channel>', 'channel id or @handle (also accepted before the command name)')
      .option('--no-retention', 'skip retention curves (they cost one API call per video)')
      .option('--retention-limit <number>', 'how many recent videos to pull retention for', '50')
      .option('--reach', 'also include thumbnail impressions/CTR from the Reporting API', false),
  ).action(run('fetch', async (cmdOpts, globalOpts) => {
    const { apis } = withApis(globalOpts, cmdOpts);
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
