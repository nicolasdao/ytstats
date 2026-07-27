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
 */
export const REACH_REPORT_TYPE = 'channel_reach_basic_a1';
const REACH_JOB_NAME = 'ytstats channel reach (CTR)';

export async function listReachJobs(apis) {
  const res = await call(() => apis.reporting.jobs.list());
  return res.data.jobs ?? [];
}

/** Find or create the reach job. Safe to call on every run. */
export async function ensureReachJob(apis) {
  const jobs = await listReachJobs(apis);
  const existing = jobs.find(j => j.reportTypeId === REACH_REPORT_TYPE);
  if (existing) return existing;

  const res = await call(() =>
    apis.reporting.jobs.create({
      requestBody: { reportTypeId: REACH_REPORT_TYPE, name: REACH_JOB_NAME },
    }),
  );
  return res.data;
}

async function listReports(apis, jobId) {
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
    const csv = await apis.downloadCsv(report.downloadUrl);
    for (const row of parseCsv(csv)) {
      const date = normalizeReportingDate(row.date);
      const videoId = row.video_id ?? null;
      deduped.set(`${date}|${videoId}`, {
        date,
        channelId: row.channel_id ?? null,
        videoId,
        impressions: row.impressions ?? null,
        // Decimal fraction, not a percentage: 0.0561 means 5.61%.
        impressionsCtr: row.impressions_ctr ?? null,
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
