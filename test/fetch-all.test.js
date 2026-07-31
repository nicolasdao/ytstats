import { describe, it, expect, vi } from 'vitest';
import { fetchAll } from '../src/fetch-all.js';
import { YtStatsError, ERROR_CODES } from '../src/errors.js';

/** A fetchers bundle where every step succeeds; individual steps get overridden per test. */
function fetchers(overrides = {}) {
  return {
    fetchChannel: vi.fn(async () => ({ id: 'UC1', title: 'Nic', uploadsPlaylistId: 'UU1' })),
    fetchAllVideoIds: vi.fn(async () => ['v1', 'v2']),
    fetchVideos: vi.fn(async () => [
      { id: 'v1', contentType: 'SHORTS', title: 'a' },
      { id: 'v2', contentType: 'VIDEO_ON_DEMAND', title: 'b' },
    ]),
    fetchDailyAnalytics: vi.fn(async () => [{ date: '2026-07-01', views: 10 }]),
    fetchCardMetrics: vi.fn(async () => [{ date: '2026-07-01', cardClicks: 1 }]),
    fetchVideoAnalytics: vi.fn(async () => [{ videoId: 'v1', views: 10 }]),
    fetchTrafficSources: vi.fn(async () => [{ sourceType: 'SHORTS', views: 8 }]),
    fetchDemographics: vi.fn(async () => [{ ageGroup: 'age25-34', gender: 'male', viewerPercentage: 40 }]),
    fetchDeviceTypes: vi.fn(async () => [{ deviceType: 'MOBILE', views: 9 }]),
    fetchContentTypes: vi.fn(async () => [{ contentType: 'shorts', views: 8 }]),
    fetchSearchTerms: vi.fn(async () => [{ searchTerm: 'ai', views: 2 }]),
    fetchGeography: vi.fn(async () => [{ country: 'AU', views: 5 }]),
    fetchSubGeography: vi.fn(async () => [{ level: 'city', region: 'Sydney', views: 3 }]),
    fetchOperatingSystems: vi.fn(async () => [{ operatingSystem: 'ANDROID', views: 6 }]),
    fetchSharingServices: vi.fn(async () => [{ sharingService: 'COPY_PASTE', shares: 2 }]),
    fetchPlaylists: vi.fn(async () => [{ playlistId: 'PL1', views: 4 }]),
    fetchRevenue: vi.fn(async () => [{ date: '2026-07-01', estimatedRevenue: 0 }]),
    fetchPlaybackLocations: vi.fn(async () => [{ locationType: 'SHORTS_FEED', views: 7 }]),
    fetchTrafficSourceDetails: vi.fn(async () => [{ sourceType: 'YT_SEARCH', detail: 'ai', views: 2 }]),
    fetchAudienceRetention: vi.fn(async () => [{ position: 0, ratio: 1.2 }]),
    ...overrides,
  };
}

const range = { startDate: '2026-04-28', endDate: '2026-07-27' };

describe('fetchAll', () => {
  it('returns every dimension in one document', async () => {
    const out = await fetchAll({}, { range, fetchers: fetchers() });

    expect(Object.keys(out.data)).toEqual(expect.arrayContaining([
      'channel', 'videos', 'daily', 'videoAnalytics', 'trafficSources', 'demographics',
      'deviceTypes', 'contentTypes', 'searchTerms', 'geography', 'playbackLocations',
      'trafficSourceDetails', 'audienceRetention',
      'cities', 'operatingSystems', 'sharingServices', 'playlists', 'revenue',
    ]));
    expect(out.data.channel.id).toBe('UC1');
    expect(out.data.videos).toHaveLength(2);
  });

  it('records the period it covered', async () => {
    const out = await fetchAll({}, { range, fetchers: fetchers() });
    expect(out.period).toEqual({ startDate: '2026-04-28', endDate: '2026-07-27', days: 90 });
  });

  it('merges card metrics into the matching daily rows', async () => {
    const out = await fetchAll({}, { range, fetchers: fetchers() });
    expect(out.data.daily[0]).toMatchObject({ date: '2026-07-01', views: 10, cardClicks: 1 });
  });

  it('continues and warns when one analytics step fails', async () => {
    const f = fetchers({
      fetchDemographics: vi.fn(async () => { throw new YtStatsError('nope', { code: ERROR_CODES.QUERY_NOT_SUPPORTED }); }),
    });
    const out = await fetchAll({}, { range, fetchers: f });

    expect(out.data.demographics).toEqual([]);
    expect(out.warnings).toHaveLength(1);
    expect(out.warnings[0]).toMatchObject({ step: 'demographics', code: ERROR_CODES.QUERY_NOT_SUPPORTED });
    expect(out.data.geography).toHaveLength(1);
  });

  it('aborts when the channel itself cannot be read', async () => {
    const f = fetchers({ fetchChannel: vi.fn(async () => null) });
    const err = await fetchAll({}, { range, fetchers: f }).catch(e => e);
    expect(err.code).toBe(ERROR_CODES.NO_YOUTUBE_CHANNEL);
  });

  it('propagates an auth failure rather than degrading to an empty document', async () => {
    const f = fetchers({
      fetchChannel: vi.fn(async () => { throw new YtStatsError('gone', { code: ERROR_CODES.NOT_AUTHENTICATED }); }),
    });
    const err = await fetchAll({}, { range, fetchers: f }).catch(e => e);
    expect(err.code).toBe(ERROR_CODES.NOT_AUTHENTICATED);
  });

  it('pulls retention per video and keys it by video id', async () => {
    const out = await fetchAll({}, { range, fetchers: fetchers() });
    expect(out.data.audienceRetention).toEqual({
      v1: [{ position: 0, ratio: 1.2 }],
      v2: [{ position: 0, ratio: 1.2 }],
    });
  });

  it('skips retention entirely when asked (it costs one call per video)', async () => {
    const f = fetchers();
    const out = await fetchAll({}, { range, fetchers: f, retention: false });
    expect(f.fetchAudienceRetention).not.toHaveBeenCalled();
    expect(out.data.audienceRetention).toEqual({});
  });

  it('caps retention to the most recent N videos and says so', async () => {
    const f = fetchers({
      fetchVideos: vi.fn(async () => [
        { id: 'v1', publishedAt: '2026-01-01T00:00:00Z' },
        { id: 'v2', publishedAt: '2026-06-01T00:00:00Z' },
        { id: 'v3', publishedAt: '2026-07-01T00:00:00Z' },
      ]),
    });
    const out = await fetchAll({}, { range, fetchers: f, retentionLimit: 2 });

    expect(f.fetchAudienceRetention).toHaveBeenCalledTimes(2);
    expect(Object.keys(out.data.audienceRetention).sort()).toEqual(['v2', 'v3']);
    expect(out.notes.join(' ')).toMatch(/retention.*2 of 3/i);
  });

  it('does not let one video\'s retention failure kill the rest', async () => {
    let n = 0;
    const f = fetchers({
      fetchAudienceRetention: vi.fn(async () => {
        if (++n === 1) throw new Error('boom');
        return [{ position: 0, ratio: 1 }];
      }),
    });
    const out = await fetchAll({}, { range, fetchers: f });
    expect(Object.keys(out.data.audienceRetention)).toHaveLength(1);
    expect(out.warnings.some(w => w.step.startsWith('retention'))).toBe(true);
  });

  it('queries traffic source details for the source types actually present', async () => {
    const f = fetchers({
      fetchTrafficSources: vi.fn(async () => [
        { sourceType: 'YT_SEARCH', views: 10 },
        { sourceType: 'RELATED_VIDEO', views: 5 },
      ]),
    });
    await fetchAll({}, { range, fetchers: f });
    const asked = f.fetchTrafficSourceDetails.mock.calls.map(c => c[1].sourceType);
    expect(asked).toEqual(expect.arrayContaining(['YT_SEARCH', 'RELATED_VIDEO']));
  });

  it('reports progress for each step', async () => {
    const onProgress = vi.fn();
    await fetchAll({}, { range, fetchers: fetchers(), onProgress });
    expect(onProgress.mock.calls.length).toBeGreaterThan(5);
    expect(onProgress.mock.calls.flat().join(' ')).toMatch(/channel/i);
  });

  it('includes reach only when explicitly requested', async () => {
    const fetchReach = vi.fn(async () => ({ pending: false, rows: [{ date: '2026-07-01' }] }));
    const without = await fetchAll({}, { range, fetchers: fetchers() });
    expect(without.data.reach).toBeUndefined();

    const withReach = await fetchAll({}, { range, fetchers: { ...fetchers(), fetchReach }, reach: true });
    expect(withReach.data.reach.rows).toHaveLength(1);
  });
});
