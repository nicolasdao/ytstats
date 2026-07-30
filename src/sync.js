import * as reporting from './api/reporting.js';
import { parseCsv } from './api/transforms.js';
import { readIngested, writeIngested, appendRows, daysUntilExpiry } from './archive.js';

/**
 * Pull every report not yet archived, across every job.
 *
 * This is the half of the problem that creating jobs does not solve. A job makes
 * YouTube *generate* reports; it does not stop them expiring 60 days later. Only
 * downloading them into the archive turns a rolling window into history.
 *
 * Idempotent by report id, so running it on a schedule is safe and cheap — an
 * already-archived report is skipped without a download.
 */
export async function syncReports(apis, { onProgress } = {}) {
  const jobs = await reporting.listJobs(apis);
  const ingested = readIngested();

  const result = {
    jobs: jobs.length,
    downloaded: 0,
    skipped: 0,
    rows: 0,
    byType: {},
    failed: [],
  };

  try {
    for (const [j, job] of jobs.entries()) {
      onProgress?.(`Syncing ${job.reportTypeId} (${j + 1}/${jobs.length})...`);

      let reports;
      try {
        reports = await reporting.listReports(apis, job.id);
      } catch (err) {
        // One unreadable job must not abandon the other nineteen — the reports
        // they hold are on the same expiry clock.
        result.failed.push({ reportTypeId: job.reportTypeId, jobId: job.id, message: err.message });
        continue;
      }

      for (const report of reports) {
        if (ingested.has(report.id)) {
          result.skipped++;
          continue;
        }
        try {
          const csv = await reporting.downloadReport(apis, report.downloadUrl);
          const rows = parseCsv(csv);
          appendRows(job.reportTypeId, rows, {
            reportId: report.id,
            jobId: job.id,
            createTime: report.createTime ?? null,
          });
          // Marked only after a successful append, so a crash mid-write leaves the
          // report un-ingested and it is retried rather than silently skipped.
          ingested.add(report.id);
          result.downloaded++;
          result.rows += rows.length;
          result.byType[job.reportTypeId] = (result.byType[job.reportTypeId] ?? 0) + rows.length;
        } catch (err) {
          result.failed.push({
            reportTypeId: job.reportTypeId,
            reportId: report.id,
            message: err.message,
          });
        }
      }
    }
  } finally {
    // Persist progress even when the run aborts. Re-downloading is harmless, but
    // losing the record of a long sync means doing all of it again.
    writeIngested(ingested);
  }

  return result;
}

/**
 * Reports that exist on Google's servers but are not archived yet, with how long
 * is left before they expire.
 *
 * The signal `doctor` needs: jobs can be perfectly configured while data quietly
 * ages out because nothing ever downloaded it.
 */
export async function findExpiringReports(apis, { now = new Date(), warnWithinDays = 14 } = {}) {
  const jobs = await reporting.listJobs(apis);
  const ingested = readIngested();

  const pending = [];
  for (const job of jobs) {
    let reports;
    try {
      reports = await reporting.listReports(apis, job.id);
    } catch {
      continue;
    }
    for (const report of reports) {
      if (ingested.has(report.id)) continue;
      const days = daysUntilExpiry(report.createTime, { now });
      pending.push({
        reportTypeId: job.reportTypeId,
        reportId: report.id,
        createTime: report.createTime ?? null,
        daysUntilExpiry: days,
      });
    }
  }

  pending.sort((a, b) => (a.daysUntilExpiry ?? Infinity) - (b.daysUntilExpiry ?? Infinity));
  return {
    pending,
    urgent: pending.filter(p => p.daysUntilExpiry !== null && p.daysUntilExpiry <= warnWithinDays),
  };
}
