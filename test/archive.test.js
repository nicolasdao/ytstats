import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { useTempConfigDir, mode, isWindows } from './helpers/tmp.js';
import {
  resolveDataDir,
  dataDir,
  appendRows,
  readRows,
  readIngested,
  writeIngested,
  archiveStatus,
  keyColumns,
  daysUntilExpiry,
} from '../src/archive.js';
import { syncReports, findExpiringReports } from '../src/sync.js';

let tmp;
beforeEach(() => { tmp = useTempConfigDir(); });
afterEach(() => {
  delete process.env.YTSTATS_DATA_DIR;
  tmp.cleanup();
});

describe('archive — location', () => {
  it('defaults under the config dir so YTSTATS_CONFIG_DIR moves everything together', () => {
    expect(resolveDataDir({ env: {}, config: '/cfg' })).toBe(path.join('/cfg', 'data'));
  });

  it('YTSTATS_DATA_DIR wins and is resolved to absolute', () => {
    const out = resolveDataDir({ env: { YTSTATS_DATA_DIR: 'rel/data' }, config: '/cfg' });
    expect(path.isAbsolute(out)).toBe(true);
    expect(out.endsWith(path.join('rel', 'data'))).toBe(true);
  });

  it('rejects a report type id that would escape the archive directory', () => {
    expect(() => appendRows('../../etc/passwd', [{ a: 1 }])).toThrow(/Invalid report type id/);
    expect(() => appendRows('a/b', [{ a: 1 }])).toThrow(/Invalid report type id/);
  });

  it.skipIf(isWindows)('writes rows 0600 — analytics rows are personal data', () => {
    appendRows('channel_basic_a3', [{ date: '2026-01-01', views: 1 }]);
    expect(mode(path.join(dataDir(), 'reports', 'channel_basic_a3.ndjson'))).toBe('0600');
  });
});

describe('archive — dimension detection', () => {
  it('treats date as a dimension despite looking numeric', () => {
    // 20260328.0 passes every numeric heuristic. Classifying it as a metric would
    // merge every date into one row — silent loss of the whole time series.
    const rows = [{ date: '20260328.0', views: '10' }, { date: '20260329.0', views: '12' }];
    expect(keyColumns(['date', 'views'], rows)).toEqual(['date']);
  });

  it('treats any column with a non-numeric value as a dimension', () => {
    const rows = [{ country_code: 'US', views: '5' }, { country_code: 'FR', views: '7' }];
    expect(keyColumns(['country_code', 'views'], rows)).toContain('country_code');
    expect(keyColumns(['country_code', 'views'], rows)).not.toContain('views');
  });

  it('treats an unknown *_id column as a dimension', () => {
    const rows = [{ widget_id: '1', views: '5' }];
    expect(keyColumns(['widget_id', 'views'], rows)).toContain('widget_id');
  });
});

describe('archive — append and replay', () => {
  it('round-trips rows and normalizes the reporting date format', () => {
    appendRows('channel_basic_a3', [{ date: '20260328.0', video_id: 'v1', views: '10' }],
      { reportId: 'r1', createTime: '2026-03-29T00:00:00Z' });

    const rows = readRows('channel_basic_a3');
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2026-03-28');
    expect(rows[0].views).toBe('10');
    expect(rows[0]._reportId).toBe('r1');
  });

  it('later corrections win over earlier figures for the same key', () => {
    // Overlapping reports carry corrected numbers for days already reported.
    // Keeping both would double-count; keeping the earlier one reports stale data.
    appendRows('channel_basic_a3', [{ date: '2026-03-28', video_id: 'v1', views: '10' }],
      { reportId: 'r1', createTime: '2026-03-29T00:00:00Z' });
    appendRows('channel_basic_a3', [{ date: '2026-03-28', video_id: 'v1', views: '14' }],
      { reportId: 'r2', createTime: '2026-03-30T00:00:00Z' });

    const rows = readRows('channel_basic_a3');
    expect(rows).toHaveLength(1);
    expect(rows[0].views).toBe('14');
  });

  it('resolves by createTime, not file order', () => {
    // A re-ingest can append an older report after a newer one. Letting file
    // order decide would overwrite a correction with the figure it corrected.
    appendRows('channel_basic_a3', [{ date: '2026-03-28', video_id: 'v1', views: '14' }],
      { reportId: 'r2', createTime: '2026-03-30T00:00:00Z' });
    appendRows('channel_basic_a3', [{ date: '2026-03-28', video_id: 'v1', views: '10' }],
      { reportId: 'r1', createTime: '2026-03-29T00:00:00Z' });

    expect(readRows('channel_basic_a3')[0].views).toBe('14');
  });

  it('keeps distinct videos on the same date apart', () => {
    appendRows('channel_basic_a3', [
      { date: '2026-03-28', video_id: 'v1', views: '10' },
      { date: '2026-03-28', video_id: 'v2', views: '20' },
    ], { reportId: 'r1', createTime: '2026-03-29T00:00:00Z' });

    expect(readRows('channel_basic_a3')).toHaveLength(2);
  });

  it('survives a torn final line instead of losing the whole archive', () => {
    appendRows('channel_basic_a3', [{ date: '2026-03-28', video_id: 'v1', views: '10' }],
      { reportId: 'r1', createTime: '2026-03-29T00:00:00Z' });
    fs.appendFileSync(path.join(dataDir(), 'reports', 'channel_basic_a3.ndjson'), '{"date":"2026-0');

    const rows = readRows('channel_basic_a3');
    expect(rows).toHaveLength(1);
    expect(rows[0].views).toBe('10');
  });

  it('returns [] for a report type never archived', () => {
    expect(readRows('channel_cards_a1')).toEqual([]);
  });
});

describe('archive — status and ingest tracking', () => {
  it('reports row counts and date coverage per report type', () => {
    appendRows('channel_basic_a3', [
      { date: '2026-03-01', video_id: 'v1', views: '1' },
      { date: '2026-03-05', video_id: 'v1', views: '2' },
    ], { reportId: 'r1', createTime: '2026-03-06T00:00:00Z' });

    const status = archiveStatus();
    const t = status.reportTypes.find(x => x.reportTypeId === 'channel_basic_a3');
    expect(t.rows).toBe(2);
    expect(t.firstDate).toBe('2026-03-01');
    expect(t.lastDate).toBe('2026-03-05');
    expect(status.totalRows).toBe(2);
  });

  it('treats a corrupt ingested file as nothing ingested rather than failing', () => {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(path.join(dataDir(), 'ingested.json'), '{not json');
    expect(readIngested().size).toBe(0);
  });

  it('round-trips the ingested set', () => {
    writeIngested(new Set(['a', 'b']));
    expect([...readIngested()].sort()).toEqual(['a', 'b']);
  });
});

describe('archive — expiry', () => {
  it('counts down from a 60-day lifetime', () => {
    const now = new Date('2026-03-31T00:00:00Z');
    expect(daysUntilExpiry('2026-03-01T00:00:00Z', { now })).toBe(30);
  });

  it('returns null for an unknown createTime rather than a misleading number', () => {
    expect(daysUntilExpiry(null)).toBeNull();
    expect(daysUntilExpiry('not a date')).toBeNull();
  });
});

describe('sync', () => {
  const api = ({ jobs = [], reports = {}, csv = 'date,video_id,views\n2026-03-01,v1,10\n' } = {}) => ({
    reporting: {
      jobs: {
        list: vi.fn(async () => ({ data: { jobs } })),
        reports: { list: vi.fn(async ({ jobId }) => ({ data: { reports: reports[jobId] ?? [] } })) },
      },
    },
    downloadCsv: vi.fn(async () => csv),
  });

  it('downloads outstanding reports into the archive', async () => {
    const apis = api({
      jobs: [{ id: 'j1', reportTypeId: 'channel_basic_a3' }],
      reports: { j1: [{ id: 'r1', downloadUrl: 'u1', createTime: '2026-03-02T00:00:00Z' }] },
    });

    const out = await syncReports(apis);
    expect(out.downloaded).toBe(1);
    expect(out.rows).toBe(1);
    expect(readRows('channel_basic_a3')[0].views).toBe(10);
  });

  it('is idempotent — a second run downloads nothing', async () => {
    const apis = api({
      jobs: [{ id: 'j1', reportTypeId: 'channel_basic_a3' }],
      reports: { j1: [{ id: 'r1', downloadUrl: 'u1', createTime: '2026-03-02T00:00:00Z' }] },
    });

    await syncReports(apis);
    const second = await syncReports(apis);

    expect(second.downloaded).toBe(0);
    expect(second.skipped).toBe(1);
    expect(apis.downloadCsv).toHaveBeenCalledTimes(1);
    expect(readRows('channel_basic_a3')).toHaveLength(1);
  });

  it('does not mark a report ingested when the download fails', async () => {
    // Marking on attempt rather than success would skip it forever, and the
    // report expires in 60 days — a permanent hole from one transient failure.
    const apis = api({
      jobs: [{ id: 'j1', reportTypeId: 'channel_basic_a3' }],
      reports: { j1: [{ id: 'r1', downloadUrl: 'u1', createTime: '2026-03-02T00:00:00Z' }] },
    });
    apis.downloadCsv = vi.fn(async () => { throw new Error('boom'); });

    const out = await syncReports(apis);
    expect(out.failed).toHaveLength(1);
    expect(readIngested().has('r1')).toBe(false);
  });

  it('keeps syncing other jobs after one job fails to list', async () => {
    const apis = api({
      jobs: [
        { id: 'bad', reportTypeId: 'channel_cards_a1' },
        { id: 'j1', reportTypeId: 'channel_basic_a3' },
      ],
      reports: { j1: [{ id: 'r1', downloadUrl: 'u1', createTime: '2026-03-02T00:00:00Z' }] },
    });
    apis.reporting.jobs.reports.list = vi.fn(async ({ jobId }) => {
      if (jobId === 'bad') throw new Error('nope');
      return { data: { reports: [{ id: 'r1', downloadUrl: 'u1', createTime: '2026-03-02T00:00:00Z' }] } };
    });

    const out = await syncReports(apis);
    expect(out.failed).toHaveLength(1);
    expect(out.downloaded).toBe(1);
  });

  it('flags un-archived reports that are close to expiring', async () => {
    const apis = api({
      jobs: [{ id: 'j1', reportTypeId: 'channel_basic_a3' }],
      reports: { j1: [
        { id: 'old', downloadUrl: 'u1', createTime: '2026-01-01T00:00:00Z' },
        { id: 'new', downloadUrl: 'u2', createTime: '2026-02-25T00:00:00Z' },
      ] },
    });

    const { pending, urgent } = await findExpiringReports(apis, { now: new Date('2026-02-26T00:00:00Z') });
    expect(pending).toHaveLength(2);
    expect(urgent.map(u => u.reportId)).toEqual(['old']);
    expect(urgent[0].daysUntilExpiry).toBeLessThanOrEqual(14);
  });

  it('stops flagging a report once it has been archived', async () => {
    const apis = api({
      jobs: [{ id: 'j1', reportTypeId: 'channel_basic_a3' }],
      reports: { j1: [{ id: 'old', downloadUrl: 'u1', createTime: '2026-01-01T00:00:00Z' }] },
    });

    await syncReports(apis);
    const { pending } = await findExpiringReports(apis, { now: new Date('2026-02-26T00:00:00Z') });
    expect(pending).toEqual([]);
  });
});
