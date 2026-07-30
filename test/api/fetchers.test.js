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
import {
  fetchReach,
  ensureReachJob,
  listReachJobs,
  listReportTypes,
  auditReportingJobs,
  ensureJobs,
} from '../../src/api/reporting.js';
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
    expect(rows[0]).toMatchObject({ position: 0, ratio: 1.54 });
    expect(rows[1]).toMatchObject({ position: 0.5, ratio: 0.82 });
  });

  it('retention asks for the drop-off metrics, not just the watch ratio', async () => {
    const { analytics, calls } = analyticsApi(() =>
      resp(['elapsedVideoTimeRatio', 'audienceWatchRatio'], [[0, 1]]));
    await fetchAudienceRetention({ analytics }, { videoId: 'v1', startDate: 'a', endDate: 'b' });

    // audienceWatchRatio alone cannot distinguish leaving from skipping ahead.
    expect(calls[0].metrics).toBe(
      'audienceWatchRatio,relativeRetentionPerformance,startedWatching,stoppedWatching,totalSegmentImpressions',
    );
    expect(calls[0].dimensions).toBe('elapsedVideoTimeRatio');
  });

  it('retention returns real drop-off values, not just the right column count', async () => {
    // Asserting a value rather than a shape: reading the wrong column name yields
    // a full set of nulls that a length check happily passes. See the reach CSV
    // regression in docs/gotchas/youtube-api.md.
    const { analytics } = analyticsApi(() =>
      resp(
        ['elapsedVideoTimeRatio', 'audienceWatchRatio', 'relativeRetentionPerformance', 'startedWatching', 'stoppedWatching', 'totalSegmentImpressions'],
        [[0.25, 0.71, 1.12, 40, 260, 1500]],
      ));
    const rows = await fetchAudienceRetention({ analytics }, { videoId: 'v1', startDate: 'a', endDate: 'b' });

    expect(rows[0]).toEqual({
      position: 0.25,
      ratio: 0.71,
      relativeRetentionPerformance: 1.12,
      startedWatching: 40,
      stoppedWatching: 260,
      totalSegmentImpressions: 1500,
    });
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

describe('Analytics API — metric degradation', () => {
  const NOT_SUPPORTED = { response: { status: 400, data: { error: { message: 'The query is not supported.' } } } };

  it('drops relativeRetentionPerformance before the segment counts', async () => {
    // Losing the whole richer set because one peer-comparison metric is
    // unavailable would throw away the drop-off counts for no reason.
    const { analytics, calls } = analyticsApi(params => {
      if (params.metrics.includes('relativeRetentionPerformance')) throw NOT_SUPPORTED;
      return resp(['elapsedVideoTimeRatio', 'audienceWatchRatio', 'stoppedWatching'], [[0, 1, 12]]);
    });
    const dropped = [];
    const rows = await fetchAudienceRetention(
      { analytics },
      { videoId: 'v1', startDate: 'a', endDate: 'b', onDegraded: m => dropped.push(...m) },
    );

    expect(calls).toHaveLength(2);
    expect(calls[1].metrics).toBe('audienceWatchRatio,startedWatching,stoppedWatching,totalSegmentImpressions');
    expect(dropped).toEqual(['relativeRetentionPerformance']);
    expect(rows[0].stoppedWatching).toBe(12);
  });

  it('falls all the way back to audienceWatchRatio rather than losing retention', async () => {
    const { analytics, calls } = analyticsApi(params => {
      if (params.metrics !== 'audienceWatchRatio') throw NOT_SUPPORTED;
      return resp(['elapsedVideoTimeRatio', 'audienceWatchRatio'], [[0, 0.9]]);
    });
    const dropped = [];
    const rows = await fetchAudienceRetention(
      { analytics },
      { videoId: 'v1', startDate: 'a', endDate: 'b', onDegraded: m => dropped.push(...m) },
    );

    expect(calls).toHaveLength(3);
    expect(rows[0].ratio).toBe(0.9);
    expect(rows[0].stoppedWatching).toBeNull();
    expect(dropped).toContain('stoppedWatching');
  });

  it('rethrows a failure that is not about metric support', async () => {
    // A 403 must not be silently retried into a smaller query — that would
    // report degraded data for what is actually an auth or permission problem.
    const forbidden = { response: { status: 403, data: { error: { message: 'Forbidden' } } } };
    const { analytics, calls } = analyticsApi(() => { throw forbidden; });
    const err = await fetchDailyAnalytics({ analytics }, { startDate: 'a', endDate: 'b' }).catch(e => e);

    expect(err.code).toBe(ERROR_CODES.ACCESS_DENIED);
    expect(calls).toHaveLength(1);
  });

  it.each([
    ['daily', fetchDailyAnalytics, 'day'],
    ['video analytics', fetchVideoAnalytics, 'video'],
    ['traffic sources', fetchTrafficSources, 'insightTrafficSourceType'],
    ['device types', fetchDeviceTypes, 'deviceType'],
    ['content types', fetchContentTypes, 'creatorContentType'],
    ['geography', fetchGeography, 'country'],
    ['playback locations', fetchPlaybackLocations, 'insightPlaybackLocationType'],
  ])('%s requests engagedViews alongside views', async (_name, fn, dimension) => {
    // views changed meaning for Shorts on 2025-04-30; engagedViews preserves the
    // old definition and is what makes numbers comparable across that date.
    const { analytics, calls } = analyticsApi(() => resp([dimension, 'views'], [['x', 1]]));
    await fn({ analytics }, { startDate: 'a', endDate: 'b' });

    expect(calls[0].metrics).toMatch(/(^|,)views(,|$)/);
    expect(calls[0].metrics).toMatch(/(^|,)engagedViews(,|$)/);
  });

  it('keeps engagedViews off the fragile insightTrafficSourceDetail dimension', async () => {
    // That dimension errors on any metric beyond views — a documented trap.
    const { analytics, calls } = analyticsApi(() => resp(['insightTrafficSourceDetail', 'views'], [['x', 1]]));
    await fetchSearchTerms({ analytics }, { startDate: 'a', endDate: 'b' });
    await fetchTrafficSourceDetails({ analytics }, { startDate: 'a', endDate: 'b', sourceType: 'RELATED_VIDEO' });

    expect(calls[0].metrics).toBe('views');
    expect(calls[1].metrics).toBe('views');
  });
});

describe('Analytics API — segmentation', () => {
  const NOT_SUPPORTED = { response: { status: 400, data: { error: { message: 'The query is not supported.' } } } };

  /**
   * CAPTURED VERBATIM from the live Analytics API on 2026-07-30, for
   * `dimensions=day,subscribedStatus` narrowed to the metrics that segment
   * accepts. Do not tidy it or invent extra rows — the point of this fixture is
   * that it is what YouTube actually returned, including the second row where
   * the same day appears again for the other segment value.
   */
  const REAL_DAILY_SUBSCRIBED = {
    data: {
      kind: 'youtubeAnalytics#resultTable',
      columnHeaders: [
        { name: 'day', columnType: 'DIMENSION', dataType: 'STRING' },
        { name: 'subscribedStatus', columnType: 'DIMENSION', dataType: 'STRING' },
        { name: 'views', columnType: 'METRIC', dataType: 'INTEGER' },
        { name: 'engagedViews', columnType: 'METRIC', dataType: 'INTEGER' },
        { name: 'estimatedMinutesWatched', columnType: 'METRIC', dataType: 'INTEGER' },
        { name: 'averageViewDuration', columnType: 'METRIC', dataType: 'INTEGER' },
        { name: 'likes', columnType: 'METRIC', dataType: 'INTEGER' },
        { name: 'dislikes', columnType: 'METRIC', dataType: 'INTEGER' },
        { name: 'shares', columnType: 'METRIC', dataType: 'INTEGER' },
      ],
      rows: [
        ['2026-07-23', 'UNSUBSCRIBED', 27, 27, 57, 128, 2, 0, 0],
        ['2026-07-23', 'SUBSCRIBED', 2, 2, 5, 175, 1, 0, 0],
        ['2026-07-24', 'UNSUBSCRIBED', 41, 40, 66, 100, 0, 0, 0],
      ],
    },
  };

  /** CAPTURED VERBATIM, `dimensions=deviceType,youtubeProduct`, same session. */
  const REAL_DEVICES_PRODUCT = {
    data: {
      kind: 'youtubeAnalytics#resultTable',
      columnHeaders: [
        { name: 'deviceType', columnType: 'DIMENSION', dataType: 'STRING' },
        { name: 'youtubeProduct', columnType: 'DIMENSION', dataType: 'STRING' },
        { name: 'views', columnType: 'METRIC', dataType: 'INTEGER' },
        { name: 'engagedViews', columnType: 'METRIC', dataType: 'INTEGER' },
        { name: 'estimatedMinutesWatched', columnType: 'METRIC', dataType: 'INTEGER' },
      ],
      rows: [
        ['DESKTOP', 'CORE', 92, 84, 115],
        ['MOBILE', 'CORE', 50, 39, 45],
        ['TV', 'CORE', 5, 5, 15],
      ],
    },
  };

  it('appends the segment dimension and returns it as a column with real values', async () => {
    const { analytics, calls } = analyticsApi(() => REAL_DAILY_SUBSCRIBED);
    const rows = await fetchDailyAnalytics(
      { analytics },
      { startDate: 'a', endDate: 'b', segment: 'subscribedStatus' },
    );

    expect(calls[0].dimensions).toBe('day,subscribedStatus');
    // A value, not a shape: a row whose subscribedStatus were undefined would
    // still have the key and still have the right length.
    expect(rows[0]).toMatchObject({ date: '2026-07-23', subscribedStatus: 'UNSUBSCRIBED', views: 27, likes: 2 });
    expect(rows[1]).toMatchObject({ date: '2026-07-23', subscribedStatus: 'SUBSCRIBED', views: 2 });
  });

  it('narrows the metrics to what subscribedStatus accepts, and says what it cost', async () => {
    // The whole query fails if any of these three is requested alongside the
    // segment — so `daily --segment subscribedStatus` returns nothing at all
    // unless they are dropped first.
    const { analytics, calls } = analyticsApi(() => REAL_DAILY_SUBSCRIBED);
    const dropped = [];
    await fetchDailyAnalytics(
      { analytics },
      { startDate: 'a', endDate: 'b', segment: 'subscribedStatus', onDegraded: m => dropped.push(...m) },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].metrics).toBe(
      'views,engagedViews,estimatedMinutesWatched,averageViewDuration,likes,dislikes,shares',
    );
    expect(dropped).toEqual(['comments', 'subscribersGained', 'subscribersLost']);
  });

  it('narrows further for youtubeProduct, which rejects every engagement metric', async () => {
    const { analytics, calls } = analyticsApi(() => REAL_DAILY_SUBSCRIBED);
    const dropped = [];
    await fetchDailyAnalytics(
      { analytics },
      { startDate: 'a', endDate: 'b', segment: 'youtubeProduct', onDegraded: m => dropped.push(...m) },
    );

    expect(calls[0].metrics).toBe('views,engagedViews,estimatedMinutesWatched,averageViewDuration');
    expect(dropped).toEqual(
      expect.arrayContaining(['likes', 'dislikes', 'comments', 'shares', 'subscribersGained', 'subscribersLost']),
    );
  });

  it('a dropped metric reads as null, never zero', async () => {
    const { analytics } = analyticsApi(() => REAL_DAILY_SUBSCRIBED);
    const rows = await fetchDailyAnalytics(
      { analytics },
      { startDate: 'a', endDate: 'b', segment: 'subscribedStatus' },
    );
    expect(rows[0].subscribersGained).toBeNull();
    expect(rows[0].comments).toBeNull();
  });

  it('leaves an unsegmented query byte-for-byte unchanged', async () => {
    // The default shape is the contract every existing consumer already reads.
    const { analytics, calls } = analyticsApi(() => resp(['day', 'views'], [['2026-03-01', 1]]));
    const rows = await fetchDailyAnalytics({ analytics }, { startDate: 'a', endDate: 'b' });

    expect(calls[0].dimensions).toBe('day');
    expect(calls[0].metrics).toBe(
      'views,engagedViews,estimatedMinutesWatched,averageViewDuration,likes,dislikes,comments,shares,subscribersGained,subscribersLost',
    );
    expect(rows[0]).not.toHaveProperty('subscribedStatus');
    expect(rows[0]).not.toHaveProperty('youtubeProduct');
  });

  it('still tiers within the narrowed set when a channel rejects engagedViews', async () => {
    // Narrowing for the segment and tiering for the channel are independent —
    // losing one must not disable the other.
    const { analytics, calls } = analyticsApi(params => {
      if (params.metrics.includes('engagedViews')) throw NOT_SUPPORTED;
      return REAL_DEVICES_PRODUCT;
    });
    const dropped = [];
    const rows = await fetchDeviceTypes(
      { analytics },
      { startDate: 'a', endDate: 'b', segment: 'youtubeProduct', onDegraded: m => dropped.push(...m) },
    );

    expect(calls).toHaveLength(2);
    expect(calls[1].metrics).toBe('views,estimatedMinutesWatched');
    expect(dropped).toContain('engagedViews');
    expect(rows[0]).toMatchObject({ deviceType: 'DESKTOP', youtubeProduct: 'CORE', views: 92 });
  });

  it.each([
    ['traffic sources', fetchTrafficSources, 'insightTrafficSourceType'],
    ['content types', fetchContentTypes, 'creatorContentType'],
    ['geography', fetchGeography, 'country'],
    ['playback locations', fetchPlaybackLocations, 'insightPlaybackLocationType'],
    ['video analytics', fetchVideoAnalytics, 'video'],
  ])('%s appends the segment to its own dimension', async (_name, fn, dimension) => {
    const { analytics, calls } = analyticsApi(() => resp([dimension, 'subscribedStatus', 'views'], [['x', 'SUBSCRIBED', 1]]));
    const rows = await fn({ analytics }, { startDate: 'a', endDate: 'b', segment: 'subscribedStatus' });

    expect(calls[0].dimensions).toBe(`${dimension},subscribedStatus`);
    expect(rows[0].subscribedStatus).toBe('SUBSCRIBED');
  });

  it('demographics takes the dimension without narrowing, since viewerPercentage survives', async () => {
    const { analytics, calls } = analyticsApi(
      () => resp(['ageGroup', 'gender', 'subscribedStatus', 'viewerPercentage'], [['age25-34', 'male', 'SUBSCRIBED', 12.5]]),
    );
    const rows = await fetchDemographics({ analytics }, { startDate: 'a', endDate: 'b', segment: 'subscribedStatus' });

    expect(calls[0].dimensions).toBe('ageGroup,gender,subscribedStatus');
    expect(calls[0].metrics).toBe('viewerPercentage');
    expect(rows[0]).toEqual({ ageGroup: 'age25-34', gender: 'male', subscribedStatus: 'SUBSCRIBED', viewerPercentage: 12.5 });
  });

  it('never segments the fragile insightTrafficSourceDetail fetchers', async () => {
    // They tolerate only `views` and break on an added dimension, so a segment
    // must not reach them even if a library caller passes one.
    const { analytics, calls } = analyticsApi(() => resp(['insightTrafficSourceDetail', 'views'], [['x', 1]]));
    await fetchSearchTerms({ analytics }, { startDate: 'a', endDate: 'b', segment: 'subscribedStatus' });
    await fetchTrafficSourceDetails(
      { analytics },
      { startDate: 'a', endDate: 'b', sourceType: 'YT_SEARCH', segment: 'subscribedStatus' },
    );

    expect(calls[0].dimensions).toBe('insightTrafficSourceDetail');
    expect(calls[1].dimensions).toBe('insightTrafficSourceDetail');
  });

  it('passes an unrecognised segment through so the API, not this table, judges it', async () => {
    const { analytics, calls } = analyticsApi(() => resp(['deviceType', 'audienceType', 'views'], [['MOBILE', 'ORGANIC', 3]]));
    await fetchDeviceTypes({ analytics }, { startDate: 'a', endDate: 'b', segment: 'audienceType' });

    expect(calls[0].dimensions).toBe('deviceType,audienceType');
    expect(calls[0].metrics).toBe('views,engagedViews,estimatedMinutesWatched');
  });
});

describe('Reporting API — job coverage', () => {
  const reportingApi = ({ reportTypes = [], jobs = [], createFails = [] } = {}) => {
    const created = [];
    return {
      created,
      apis: {
        reporting: {
          reportTypes: { list: vi.fn(async () => ({ data: { reportTypes } })) },
          jobs: {
            list: vi.fn(async () => ({ data: { jobs } })),
            create: vi.fn(async ({ requestBody }) => {
              if (createFails.includes(requestBody.reportTypeId)) {
                throw { response: { status: 403, data: { error: { message: 'not permitted' } } } };
              }
              created.push(requestBody);
              return { data: { id: `job-${requestBody.reportTypeId}` } };
            }),
          },
        },
      },
    };
  };

  it('excludes deprecated and system-managed types from what can be scheduled', async () => {
    const { apis } = reportingApi({
      reportTypes: [
        { id: 'channel_basic_a3', name: 'User activity' },
        { id: 'channel_basic_a2', name: 'Old', deprecateTime: '2025-01-01T00:00:00Z' },
        { id: 'channel_system', name: 'Managed', systemManaged: true },
      ],
    });
    const types = await listReportTypes(apis);
    const audit = await auditReportingJobs(apis);

    expect(types).toHaveLength(3);
    expect(audit.available.map(t => t.id)).toEqual(['channel_basic_a3']);
  });

  it('reports which report types are collecting nothing', async () => {
    const { apis } = reportingApi({
      reportTypes: [
        { id: 'channel_basic_a3' },
        { id: 'channel_reach_basic_a1' },
        { id: 'channel_combined_a3' },
      ],
      jobs: [{ id: 'job-1', reportTypeId: 'channel_reach_basic_a1', createTime: '2026-01-01T00:00:00Z' }],
    });
    const audit = await auditReportingJobs(apis);

    expect(audit.active.map(t => t.id)).toEqual(['channel_reach_basic_a1']);
    expect(audit.missing.map(t => t.id)).toEqual(['channel_basic_a3', 'channel_combined_a3']);
    expect(audit.coverage).toBeCloseTo(1 / 3);
  });

  it('pages reportTypes.list rather than reading only the first page', async () => {
    const pages = [
      { data: { reportTypes: [{ id: 'a' }], nextPageToken: 'p2' } },
      { data: { reportTypes: [{ id: 'b' }] } },
    ];
    let i = 0;
    const apis = { reporting: { reportTypes: { list: vi.fn(async () => pages[i++]) } } };

    expect((await listReportTypes(apis)).map(t => t.id)).toEqual(['a', 'b']);
  });

  it('creates only the missing jobs and never duplicates an existing one', async () => {
    const { apis, created } = reportingApi({
      jobs: [{ id: 'job-1', reportTypeId: 'channel_reach_basic_a1' }],
    });
    const out = await ensureJobs(apis, ['channel_reach_basic_a1', 'channel_basic_a3']);

    expect(created.map(r => r.reportTypeId)).toEqual(['channel_basic_a3']);
    expect(out.skipped[0]).toMatchObject({ reportTypeId: 'channel_reach_basic_a1', reason: 'already-scheduled' });
    expect(out.created[0]).toMatchObject({ reportTypeId: 'channel_basic_a3', jobId: 'job-channel_basic_a3' });
  });

  it('keeps creating jobs after one report type is rejected', async () => {
    // One unschedulable type must not stop the other fifteen from starting to
    // collect today — the backfill window is only 30 days.
    const { apis } = reportingApi({ createFails: ['channel_cards_a2'] });
    const out = await ensureJobs(apis, ['channel_cards_a2', 'channel_basic_a3']);

    expect(out.failed).toHaveLength(1);
    expect(out.failed[0].reportTypeId).toBe('channel_cards_a2');
    expect(out.created.map(c => c.reportTypeId)).toEqual(['channel_basic_a3']);
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

describe('reach report download error classification', () => {
  const job = { id: 'job-1', reportTypeId: 'channel_basic_a2' };

  function apisThatFailDownloadWith(status) {
    return {
      reporting: {
        jobs: {
          list: async () => ({ data: { jobs: [job] } }),
          create: async () => ({ data: job }),
          reports: {
            list: async () => ({ data: { reports: [{ id: 'r1', downloadUrl: 'https://x/y', startTime: '2026-07-01T00:00:00Z' }] } }),
          },
        },
      },
      // Mirrors the real downloadCsv: status preserved as structure, not prose.
      downloadCsv: async () => {
        const err = new Error(`Failed to download report (${status} Server Error)`);
        err.status = status;
        err.response = { status, data: undefined };
        throw err;
      },
    };
  }

  it('classifies a Google 5xx as API_UNAVAILABLE, so a caller knows to retry', async () => {
    // Previously this escaped call() entirely and surfaced as UNEXPECTED with
    // recoverable:false — permanently halting an agent on a transient hiccup.
    const err = await fetchReach(apisThatFailDownloadWith(500), {}).catch(e => e);
    expect(err.diagnostic.code).toBe('API_UNAVAILABLE');
    expect(err.diagnostic.retryable).toBe(true);
    expect(err.diagnostic.recoverable).toBe(true);
  });

  it('classifies a 403 on download as API_FORBIDDEN, not UNEXPECTED', async () => {
    const err = await fetchReach(apisThatFailDownloadWith(403), {}).catch(e => e);
    expect(err.diagnostic.code).toBe('API_FORBIDDEN');
  });
});

describe('reach CSV column names', () => {
  const job = { id: 'job-1', reportTypeId: 'channel_reach_basic_a1' };

  // The real channel_reach_basic_a1 header, captured from a live report.
  const CSV = [
    'date,channel_id,video_id,video_thumbnail_impressions,video_thumbnail_impressions_ctr',
    '20260725,UCnet,12OZx2jtfw0,1240,0.0561',
    '20260726,UCnet,e-Ni5p9LmxY,880,0.0312',
  ].join('\n');

  const apis = {
    reporting: {
      jobs: {
        list: async () => ({ data: { jobs: [job] } }),
        create: async () => ({ data: job }),
        reports: {
          list: async () => ({ data: { reports: [{ id: 'r1', downloadUrl: 'https://x/y', startTime: '2026-07-25T00:00:00Z' }] } }),
        },
      },
    },
    downloadCsv: async () => CSV,
  };

  it('reads the video_thumbnail_impressions columns the report actually uses', async () => {
    // Reading `impressions` / `impressions_ctr` yields undefined for every row,
    // which ?? null turns into ok:true with a full set of null rows — a silent
    // failure with no warning, indistinguishable from a channel with no data.
    const out = await fetchReach(apis, {});
    const row = out.rows.find(r => r.videoId === '12OZx2jtfw0');
    expect(row.impressions).toBe(1240);
    expect(row.impressionsCtr).toBeCloseTo(0.0561);
  });

  it('never returns rows where every impression field is null', async () => {
    const out = await fetchReach(apis, {});
    expect(out.rows.length).toBeGreaterThan(0);
    expect(out.rows.every(r => r.impressions === null)).toBe(false);
  });
});
