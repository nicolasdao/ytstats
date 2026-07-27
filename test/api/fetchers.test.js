import { describe, it, expect, vi } from 'vitest';
import { fetchChannel, fetchAllVideoIds, fetchVideos } from '../../src/api/data.js';
import {
  fetchDailyAnalytics,
  fetchVideoAnalytics,
  fetchTrafficSources,
  fetchDemographics,
  fetchDeviceTypes,
  fetchContentTypes,
  fetchSearchTerms,
  fetchGeography,
  fetchPlaybackLocations,
  fetchTrafficSourceDetails,
  fetchAudienceRetention,
  runCustomReport,
} from '../../src/api/analytics.js';
import { fetchReach, ensureReachJob, listReachJobs } from '../../src/api/reporting.js';
import { ERROR_CODES } from '../../src/errors.js';

/** Build an analytics response in the API's columnHeaders/rows shape. */
const resp = (headers, rows) => ({
  data: { columnHeaders: headers.map(name => ({ name })), rows },
});

function analyticsApi(handler) {
  const calls = [];
  return {
    calls,
    analytics: {
      reports: {
        query: vi.fn(async params => {
          calls.push(params);
          return handler(params);
        }),
      },
    },
  };
}

describe('Data API — channel', () => {
  it('returns the normalized channel', async () => {
    const apis = {
      youtube: {
        channels: { list: vi.fn(async () => ({ data: { items: [{ id: 'UC1', snippet: { title: 'T' }, statistics: { subscriberCount: '36' } }] } })) },
      },
    };
    const channel = await fetchChannel(apis);
    expect(channel).toMatchObject({ id: 'UC1', title: 'T', subscriberCount: 36 });
  });

  it('returns null when the account owns no channel', async () => {
    const apis = { youtube: { channels: { list: vi.fn(async () => ({ data: { items: [] } })) } } };
    expect(await fetchChannel(apis)).toBeNull();
  });

  it('maps a disabled-API failure to a typed error', async () => {
    const apis = {
      youtube: {
        channels: {
          list: vi.fn(async () => {
            throw { response: { status: 403, data: { error: { message: 'disabled', errors: [{ reason: 'accessNotConfigured' }] } } } };
          }),
        },
      },
    };
    const err = await fetchChannel(apis).catch(e => e);
    expect(err.code).toBe(ERROR_CODES.API_NOT_ENABLED);
  });
});

describe('Data API — videos', () => {
  it('pages through the uploads playlist', async () => {
    const pages = [
      { data: { items: [{ contentDetails: { videoId: 'v1' } }], nextPageToken: 'p2' } },
      { data: { items: [{ contentDetails: { videoId: 'v2' } }] } },
    ];
    let i = 0;
    const apis = { youtube: { playlistItems: { list: vi.fn(async () => pages[i++]) } } };

    expect(await fetchAllVideoIds(apis, 'UU1')).toEqual(['v1', 'v2']);
    expect(apis.youtube.playlistItems.list).toHaveBeenCalledTimes(2);
  });

  it('uses the uploads playlist rather than search.list (1 quota unit vs 100)', async () => {
    const apis = {
      youtube: {
        playlistItems: { list: vi.fn(async () => ({ data: { items: [] } })) },
        search: { list: vi.fn() },
      },
    };
    await fetchAllVideoIds(apis, 'UU1');
    expect(apis.youtube.search.list).not.toHaveBeenCalled();
  });

  it('batches video detail lookups in groups of 50', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `v${i}`);
    const list = vi.fn(async ({ id }) => ({
      data: { items: id.split(',').map(x => ({ id: x, snippet: {}, contentDetails: { duration: 'PT30S' } })) },
    }));
    const apis = { youtube: { videos: { list } } };

    const videos = await fetchVideos(apis, ids);
    expect(videos).toHaveLength(120);
    expect(list).toHaveBeenCalledTimes(3);
    expect(list.mock.calls[0][0].id.split(',')).toHaveLength(50);
    expect(videos[0].contentType).toBe('SHORTS');
  });

  it('returns [] for an empty id list without calling the API', async () => {
    const apis = { youtube: { videos: { list: vi.fn() } } };
    expect(await fetchVideos(apis, [])).toEqual([]);
    expect(apis.youtube.videos.list).not.toHaveBeenCalled();
  });
});

describe('Analytics API — query shapes', () => {
  it('daily analytics asks for day-dimensioned metrics', async () => {
    const { analytics, calls } = analyticsApi(() => resp(['day', 'views'], [['2026-03-01', 10]]));
    const rows = await fetchDailyAnalytics({ analytics }, { startDate: '2026-01-01', endDate: '2026-03-30' });

    expect(calls[0]).toMatchObject({ ids: 'channel==MINE', dimensions: 'day', sort: 'day' });
    expect(rows[0]).toMatchObject({ date: '2026-03-01', views: 10 });
  });

  it('per-video analytics caps maxResults at 200 (the API rejects more)', async () => {
    const { analytics, calls } = analyticsApi(() => resp(['video', 'views'], [['v1', 5]]));
    await fetchVideoAnalytics({ analytics }, { startDate: 'a', endDate: 'b' });
    expect(calls[0].maxResults).toBe(200);
    expect(calls[0].dimensions).toBe('video');
  });

  it('per-video analytics keys rows by videoId', async () => {
    const { analytics } = analyticsApi(() =>
      resp(['video', 'views', 'averageViewPercentage'], [['v1', 5, 62.5]]));
    const rows = await fetchVideoAnalytics({ analytics }, { startDate: 'a', endDate: 'b' });
    expect(rows[0]).toMatchObject({ videoId: 'v1', views: 5, averageViewPercentage: 62.5 });
  });

  it('traffic source details cap maxResults at 25 (50+ returns an internal error)', async () => {
    const { analytics, calls } = analyticsApi(() => resp(['insightTrafficSourceDetail', 'views'], [['x', 1]]));
    await fetchTrafficSourceDetails({ analytics }, { startDate: 'a', endDate: 'b', sourceType: 'RELATED_VIDEO' });
    expect(calls[0].maxResults).toBe(25);
    expect(calls[0].filters).toBe('insightTrafficSourceType==RELATED_VIDEO');
    // estimatedMinutesWatched breaks this dimension; only views is safe.
    expect(calls[0].metrics).toBe('views');
  });

  it('search terms filter on YT_SEARCH', async () => {
    const { analytics, calls } = analyticsApi(() => resp(['insightTrafficSourceDetail', 'views'], [['ai tools', 9]]));
    const rows = await fetchSearchTerms({ analytics }, { startDate: 'a', endDate: 'b' });
    expect(calls[0].filters).toBe('insightTrafficSourceType==YT_SEARCH');
    expect(rows[0]).toMatchObject({ searchTerm: 'ai tools', views: 9 });
  });

  it('retention preserves ratios above 1.0 (Shorts looping, not a bug)', async () => {
    const { analytics, calls } = analyticsApi(() =>
      resp(['elapsedVideoTimeRatio', 'audienceWatchRatio'], [[0, 1.54], [0.5, 0.82]]));
    const rows = await fetchAudienceRetention({ analytics }, { videoId: 'v1', startDate: 'a', endDate: 'b' });

    expect(calls[0].filters).toBe('video==v1');
    expect(rows[0]).toEqual({ position: 0, ratio: 1.54 });
    expect(rows[1]).toEqual({ position: 0.5, ratio: 0.82 });
  });

  it.each([
    ['demographics', fetchDemographics, 'ageGroup,gender'],
    ['device types', fetchDeviceTypes, 'deviceType'],
    ['content types', fetchContentTypes, 'creatorContentType'],
    ['geography', fetchGeography, 'country'],
    ['playback locations', fetchPlaybackLocations, 'insightPlaybackLocationType'],
    ['traffic sources', fetchTrafficSources, 'insightTrafficSourceType'],
  ])('%s uses the %s dimension', async (_name, fn, dimension) => {
    const { analytics, calls } = analyticsApi(() => resp([dimension.split(',')[0], 'views'], [['x', 1]]));
    await fn({ analytics }, { startDate: 'a', endDate: 'b' });
    expect(calls[0].dimensions).toBe(dimension);
  });

  it('never requests thumbnail impression metrics (unsupported on this API)', async () => {
    const { analytics, calls } = analyticsApi(() => resp(['day', 'views'], [['2026-03-01', 1]]));
    await fetchDailyAnalytics({ analytics }, { startDate: 'a', endDate: 'b' });
    expect(calls[0].metrics).not.toMatch(/videoThumbnailImpressions/);
  });

  it('maps an unsupported query to QUERY_NOT_SUPPORTED', async () => {
    const { analytics } = analyticsApi(() => {
      throw { response: { status: 400, data: { error: { message: 'The query is not supported.' } } } };
    });
    const err = await fetchDemographics({ analytics }, { startDate: 'a', endDate: 'b' }).catch(e => e);
    expect(err.code).toBe(ERROR_CODES.QUERY_NOT_SUPPORTED);
  });

  it('runCustomReport returns columns alongside rows', async () => {
    const { analytics, calls } = analyticsApi(() => ({
      data: {
        columnHeaders: [{ name: 'day', dataType: 'STRING' }, { name: 'views', dataType: 'INTEGER' }],
        rows: [['2026-03-01', 10]],
      },
    }));
    const out = await runCustomReport({ analytics }, {
      startDate: 'a', endDate: 'b', metrics: 'views', dimensions: 'day',
    });
    expect(out.columns).toEqual([
      { name: 'day', type: 'STRING' },
      { name: 'views', type: 'INTEGER' },
    ]);
    expect(out.rows).toEqual([{ day: '2026-03-01', views: 10 }]);
    expect(calls[0].metrics).toBe('views');
  });
});

describe('Reporting API — reach', () => {
  function reportingApi({ jobs = [], reports = [], csv = '' } = {}) {
    const created = [];
    return {
      created,
      apis: {
        reporting: {
          jobs: {
            list: vi.fn(async () => ({ data: { jobs } })),
            create: vi.fn(async ({ requestBody }) => {
              created.push(requestBody);
              return { data: { id: 'job-new', reportTypeId: requestBody.reportTypeId } };
            }),
            reports: { list: vi.fn(async () => ({ data: { reports } })) },
          },
        },
        downloadCsv: vi.fn(async () => csv),
      },
    };
  }

  it('reuses an existing reach job instead of creating a duplicate', async () => {
    const { apis, created } = reportingApi({ jobs: [{ id: 'job-1', reportTypeId: 'channel_reach_basic_a1' }] });
    const job = await ensureReachJob(apis);
    expect(job.id).toBe('job-1');
    expect(created).toEqual([]);
  });

  it('creates the reach job on first use', async () => {
    const { apis, created } = reportingApi();
    const job = await ensureReachJob(apis);
    expect(job.id).toBe('job-new');
    expect(created[0].reportTypeId).toBe('channel_reach_basic_a1');
  });

  it('explains the 24-48h wait when the job exists but has produced nothing', async () => {
    const { apis } = reportingApi({ jobs: [{ id: 'job-1', reportTypeId: 'channel_reach_basic_a1' }] });
    const out = await fetchReach(apis);
    expect(out.rows).toEqual([]);
    expect(out.pending).toBe(true);
    expect(out.message).toMatch(/24-48 hours/);
  });

  it('downloads, normalizes dates and dedupes by date+video', async () => {
    const csv = [
      'date,channel_id,video_id,impressions,impressions_ctr',
      '20260328.0,UC1,vidA,1000,0.05',
      '20260328.0,UC1,vidA,1200,0.06',
      '20260329.0,UC1,vidB,500,0.04',
    ].join('\n');
    const { apis } = reportingApi({
      jobs: [{ id: 'job-1', reportTypeId: 'channel_reach_basic_a1' }],
      reports: [{ id: 'r1', downloadUrl: 'https://x/1' }],
      csv,
    });

    const out = await fetchReach(apis);
    expect(out.pending).toBe(false);
    expect(out.rows).toHaveLength(2);
    expect(out.rows[0]).toMatchObject({ date: '2026-03-28', videoId: 'vidA', impressions: 1200, impressionsCtr: 0.06 });
    expect(out.rows.every(r => /^\d{4}-\d{2}-\d{2}$/.test(r.date))).toBe(true);
  });

  it('listReachJobs surfaces every job', async () => {
    const { apis } = reportingApi({ jobs: [{ id: 'a', reportTypeId: 't1' }, { id: 'b', reportTypeId: 't2' }] });
    expect(await listReachJobs(apis)).toHaveLength(2);
  });
});
