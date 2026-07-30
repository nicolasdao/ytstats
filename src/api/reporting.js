import { call } from './client.js';
import { parseCsv, normalizeReportingDate } from './transforms.js';

/**
 * YouTube Reporting API v1.
 *
 * This is the only source of thumbnail impressions and CTR — the equivalent
 * Analytics API metrics are documented but always return "query is not supported"
 * (https://issuetracker.google.com/issues/254665034).
 *
 * It is asynchronous by design: create a job, YouTube generates daily CSVs, we
 * download them. First run therefore returns nothing for 24-48h, and the data is
 * always 1-2 days behind — the same lag YouTube Studio shows.
 *
 * The part that costs data if ignored: YouTube does not generate a report at all
 * until a job exists for it. Creating a job backfills only 30 days, and historical
 * reports expire 30 days after generation — so every day without a job is a day of
 * that report permanently lost. auditReportingJobs() exists to make that visible
 * before the loss is irreversible rather than after.
 */
export const REACH_REPORT_TYPE = 'channel_reach_basic_a1';
const REACH_JOB_NAME = 'ytstats channel reach (CTR)';
const JOB_NAME_PREFIX = 'ytstats';

/** Page a Reporting API list method that returns { [key], nextPageToken }. */
async function pageAll(fn, key, params = {}) {
  const items = [];
  let pageToken;
  do {
    const res = await call(() => fn(pageToken ? { ...params, pageToken } : params));
    items.push(...(res.data[key] ?? []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return items;
}

/**
 * Report types this channel may schedule, discovered live.
 *
 * Deliberately not a hardcoded list. Google version-bumps report ids in place
 * (channel_basic_a2 → a3) and its own documentation pages disagree with each
 * other about the current set, so a constant would rot silently and we would
 * create jobs for ids that no longer exist.
 *
 * Uses reportTypes.list, which needs only yt-analytics.readonly — a scope
 * ytstats already requests, so this costs no additional consent.
 */
export async function listReportTypes(apis) {
  const types = await pageAll(p => apis.reporting.reportTypes.list(p), 'reportTypes');
  return types.map(t => ({
    id: t.id,
    name: t.name ?? null,
    // A deprecated type still lists but cannot usefully be scheduled, and a
    // system-managed one is created by YouTube itself — jobs.create rejects both.
    deprecated: Boolean(t.deprecateTime),
    deprecateTime: t.deprecateTime ?? null,
    systemManaged: Boolean(t.systemManaged),
  }));
}

export async function listJobs(apis) {
  return pageAll(p => apis.reporting.jobs.list(p), 'jobs');
}

/** Kept under its original name: `reporting.listReachJobs` is a published export. */
export const listReachJobs = listJobs;

/**
 * Compare what this channel could collect against what it is collecting.
 *
 * `missing` is the actionable part — every entry is a report type accruing no
 * data right now, and no later action recovers more than the trailing 30 days.
 */
export async function auditReportingJobs(apis) {
  const [types, jobs] = await Promise.all([listReportTypes(apis), listJobs(apis)]);

  const activeIds = new Set(jobs.map(j => j.reportTypeId));
  const schedulable = types.filter(t => !t.deprecated && !t.systemManaged);

  const active = schedulable.filter(t => activeIds.has(t.id));
  const missing = schedulable.filter(t => !activeIds.has(t.id));

  return {
    available: schedulable,
    active,
    missing,
    jobs: jobs.map(j => ({
      id: j.id,
      reportTypeId: j.reportTypeId,
      name: j.name ?? null,
      createTime: j.createTime ?? null,
    })),
    // Jobs whose report type is no longer schedulable still produce data; they
    // are counted as active above only if the type is still listed, so report
    // the raw total separately rather than implying the two must agree.
    jobCount: jobs.length,
    coverage: schedulable.length ? active.length / schedulable.length : 1,
  };
}

/**
 * Create jobs for the given report type ids, skipping those already scheduled.
 *
 * One failure does not abort the rest: a type that this channel cannot schedule
 * should not prevent the other fifteen from starting to collect today.
 */
export async function ensureJobs(apis, reportTypeIds, { onProgress } = {}) {
  const existing = await listJobs(apis);
  const byType = new Map(existing.map(j => [j.reportTypeId, j]));

  const created = [];
  const skipped = [];
  const failed = [];

  for (const [i, reportTypeId] of reportTypeIds.entries()) {
    const already = byType.get(reportTypeId);
    if (already) {
      skipped.push({ reportTypeId, jobId: already.id, reason: 'already-scheduled' });
      continue;
    }
    onProgress?.(`Creating reporting job ${i + 1}/${reportTypeIds.length}: ${reportTypeId}...`);
    try {
      const res = await call(() =>
        apis.reporting.jobs.create({
          requestBody: { reportTypeId, name: `${JOB_NAME_PREFIX} ${reportTypeId}` },
        }),
      );
      created.push({ reportTypeId, jobId: res.data.id ?? null, createTime: res.data.createTime ?? null });
    } catch (err) {
      failed.push({ reportTypeId, code: err.diagnostic?.code ?? err.code ?? null, message: err.message });
    }
  }

  return { created, skipped, failed };
}

/** Find or create the reach job. Safe to call on every run. */
export async function ensureReachJob(apis) {
  const jobs = await listJobs(apis);
  const existing = jobs.find(j => j.reportTypeId === REACH_REPORT_TYPE);
  if (existing) return existing;

  const res = await call(() =>
    apis.reporting.jobs.create({
      requestBody: { reportTypeId: REACH_REPORT_TYPE, name: REACH_JOB_NAME },
    }),
  );
  return res.data;
}

export async function listReports(apis, jobId) {
  const reports = [];
  let pageToken;
  do {
    const params = { jobId };
    if (pageToken) params.pageToken = pageToken;
    const res = await call(() => apis.reporting.jobs.reports.list(params));
    reports.push(...(res.data.reports ?? []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return reports;
}

/**
 * Download one report body.
 *
 * Goes through `call()` like every other request here: `downloadCsv` is a bare
 * fetch, so without the wrapper a Google 5xx escapes classification and lands as
 * UNEXPECTED / recoverable:false, halting a caller on a transient failure.
 */
export async function downloadReport(apis, downloadUrl) {
  return call(() => apis.downloadCsv(downloadUrl));
}

/**
 * Download every available reach report and merge them.
 *
 * Reports overlap, so rows are deduped on (date, videoId) with the last write
 * winning — later reports carry corrected figures for the same day.
 */
export async function fetchReach(apis, { onProgress } = {}) {
  const job = await ensureReachJob(apis);
  const reports = await listReports(apis, job.id);

  if (reports.length === 0) {
    return {
      job: { id: job.id, reportTypeId: job.reportTypeId, createTime: job.createTime ?? null },
      reportCount: 0,
      pending: true,
      message:
        'Reporting job is set up. YouTube generates the first reports within 24-48 hours ' +
        '(including a 30-day backfill). Re-run `ytstats reach` after that.',
      rows: [],
    };
  }

  const deduped = new Map();
  for (const [i, report] of reports.entries()) {
    onProgress?.(`Downloading reach report ${i + 1}/${reports.length}...`);
    // Wrapped like every other request in this file. Without call(), a Google
    // 5xx on the download escapes classification entirely and lands as
    // UNEXPECTED / recoverable:false — halting a caller on a transient failure.
    const csv = await call(() => apis.downloadCsv(report.downloadUrl));
    for (const row of parseCsv(csv)) {
      const date = normalizeReportingDate(row.date);
      const videoId = row.video_id ?? null;
      deduped.set(`${date}|${videoId}`, {
        date,
        channelId: row.channel_id ?? null,
        videoId,
        // The channel_reach_basic_a1 CSV names these columns
        // video_thumbnail_impressions / video_thumbnail_impressions_ctr. Reading
        // `impressions` / `impressions_ctr` yields undefined for every row, which
        // ?? null turns into a successful-looking response full of nulls — the
        // worst failure shape, since ok stays true and no warning fires. The
        // shorter names are accepted too in case the schema ever changes.
        impressions: row.video_thumbnail_impressions ?? row.impressions ?? null,
        // Decimal fraction, not a percentage: 0.0561 means 5.61%.
        impressionsCtr: row.video_thumbnail_impressions_ctr ?? row.impressions_ctr ?? null,
      });
    }
  }

  const rows = Array.from(deduped.values()).sort((a, b) =>
    a.date === b.date ? String(a.videoId).localeCompare(String(b.videoId)) : a.date < b.date ? -1 : 1,
  );

  return {
    job: { id: job.id, reportTypeId: job.reportTypeId, createTime: job.createTime ?? null },
    reportCount: reports.length,
    pending: false,
    rows,
  };
}
