import { call } from './client.js';
import { ERROR_CODES } from '../errors.js';
import { rowsFromAnalytics } from './transforms.js';

/**
 * YouTube Analytics API v2 (reports.query, ids=channel==MINE).
 *
 * Two API limits are encoded here rather than left to callers, because exceeding
 * either produces an opaque failure:
 *   - dimensions=video rejects maxResults above 200
 *   - insightTrafficSourceDetail requires maxResults and errors above ~25, and
 *     only tolerates the `views` metric
 */
const MAX_VIDEO_ROWS = 200;
const MAX_DETAIL_ROWS = 25;

async function query(apis, { startDate, endDate, metrics, dimensions, filters, sort, maxResults }) {
  const params = { ids: 'channel==MINE', startDate, endDate, metrics };
  if (dimensions) params.dimensions = dimensions;
  if (filters) params.filters = filters;
  if (sort) params.sort = sort;
  if (maxResults) params.maxResults = maxResults;

  const res = await call(() => apis.analytics.reports.query(params));
  return res.data;
}

const num = v => (v === undefined || v === null ? null : v);

const isUnsupported = err =>
  err?.code === ERROR_CODES.QUERY_NOT_SUPPORTED || err?.diagnostic?.code === 'API_QUERY_NOT_SUPPORTED';

/**
 * Run a query against progressively smaller metric sets until one is accepted.
 *
 * Which metrics a channel supports varies, and an unsupported one fails the whole
 * query rather than returning a null column. Requesting a newer metric such as
 * engagedViews unconditionally would therefore turn a working dataset into no
 * dataset for anyone whose channel rejects it — so every addition is a tier that
 * falls back to the set already known to work.
 *
 * Tiers are ordered richest first; the last is the historical metric list and its
 * failure is a real error, rethrown untouched.
 */
async function queryTiered(apis, params, tiers, onDegraded) {
  const full = tiers[0].split(',');

  for (const [i, metrics] of tiers.entries()) {
    try {
      const data = await query(apis, { ...params, metrics });
      if (i > 0) {
        const kept = new Set(metrics.split(','));
        onDegraded?.(full.filter(m => !kept.has(m)));
      }
      return data;
    } catch (err) {
      if (i === tiers.length - 1 || !isUnsupported(err)) throw err;
    }
  }
}

/**
 * On 2025-04-30 YouTube redefined `views`: a Shorts view is now every play or
 * replay, with no minimum watch time. engagedViews preserves the pre-2025 meaning.
 *
 * Both are requested wherever the API allows it, because neither alone is
 * sufficient — `views` is what YouTube now reports, engagedViews is what makes a
 * number comparable to the same channel's numbers from before the change. A Shorts
 * channel reading only `views` will see a step change in April 2025 that no content
 * decision caused.
 */
const DAILY_METRICS = 'estimatedMinutesWatched,averageViewDuration,likes,dislikes,comments,shares,subscribersGained,subscribersLost';

export async function fetchDailyAnalytics(apis, { startDate, endDate, onDegraded }) {
  const data = await queryTiered(
    apis,
    {
      startDate,
      endDate,
      // Thumbnail impressions/CTR are documented for this API but always fail;
      // reach data comes from the Reporting API instead.
      dimensions: 'day',
      sort: 'day',
    },
    [`views,engagedViews,${DAILY_METRICS}`, `views,${DAILY_METRICS}`],
    onDegraded,
  );

  return rowsFromAnalytics(data).map(r => ({
    date: r.day,
    views: num(r.views),
    engagedViews: num(r.engagedViews),
    estimatedMinutesWatched: num(r.estimatedMinutesWatched),
    averageViewDuration: num(r.averageViewDuration),
    likes: num(r.likes),
    dislikes: num(r.dislikes),
    comments: num(r.comments),
    shares: num(r.shares),
    subscribersGained: num(r.subscribersGained),
    subscribersLost: num(r.subscribersLost),
  }));
}

/** Card/annotation metrics. Degrades to [] — some channels never have this data. */
export async function fetchCardMetrics(apis, { startDate, endDate }) {
  try {
    const data = await query(apis, {
      startDate,
      endDate,
      metrics: 'views,annotationClickThroughRate,cardClicks,cardImpressions',
      dimensions: 'day',
      sort: 'day',
    });
    return rowsFromAnalytics(data).map(r => ({
      date: r.day,
      annotationClickThroughRate: num(r.annotationClickThroughRate),
      cardClicks: num(r.cardClicks),
      cardImpressions: num(r.cardImpressions),
    }));
  } catch {
    return [];
  }
}

const VIDEO_METRICS = 'estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained,subscribersLost';

export async function fetchVideoAnalytics(apis, { startDate, endDate, maxResults = MAX_VIDEO_ROWS, onDegraded }) {
  const data = await queryTiered(
    apis,
    {
      startDate,
      endDate,
      dimensions: 'video',
      sort: '-views',
      maxResults: Math.min(maxResults, MAX_VIDEO_ROWS),
    },
    [`views,engagedViews,${VIDEO_METRICS}`, `views,${VIDEO_METRICS}`],
    onDegraded,
  );

  return rowsFromAnalytics(data).map(r => ({
    videoId: r.video,
    views: num(r.views),
    engagedViews: num(r.engagedViews),
    estimatedMinutesWatched: num(r.estimatedMinutesWatched),
    averageViewDuration: num(r.averageViewDuration),
    averageViewPercentage: num(r.averageViewPercentage),
    likes: num(r.likes),
    comments: num(r.comments),
    shares: num(r.shares),
    subscribersGained: num(r.subscribersGained),
    subscribersLost: num(r.subscribersLost),
  }));
}

export async function fetchTrafficSources(apis, { startDate, endDate, onDegraded }) {
  const data = await queryTiered(
    apis,
    { startDate, endDate, dimensions: 'insightTrafficSourceType', sort: '-views' },
    ['views,engagedViews,estimatedMinutesWatched', 'views,estimatedMinutesWatched'],
    onDegraded,
  );
  return rowsFromAnalytics(data).map(r => ({
    sourceType: r.insightTrafficSourceType,
    views: num(r.views),
    engagedViews: num(r.engagedViews),
    estimatedMinutesWatched: num(r.estimatedMinutesWatched),
  }));
}

export async function fetchDemographics(apis, { startDate, endDate }) {
  const data = await query(apis, {
    startDate,
    endDate,
    metrics: 'viewerPercentage',
    dimensions: 'ageGroup,gender',
  });
  return rowsFromAnalytics(data).map(r => ({
    ageGroup: r.ageGroup,
    gender: r.gender,
    viewerPercentage: num(r.viewerPercentage),
  }));
}

export async function fetchDeviceTypes(apis, { startDate, endDate, onDegraded }) {
  const data = await queryTiered(
    apis,
    { startDate, endDate, dimensions: 'deviceType', sort: '-views' },
    ['views,engagedViews,estimatedMinutesWatched', 'views,estimatedMinutesWatched'],
    onDegraded,
  );
  return rowsFromAnalytics(data).map(r => ({
    deviceType: r.deviceType,
    views: num(r.views),
    engagedViews: num(r.engagedViews),
    estimatedMinutesWatched: num(r.estimatedMinutesWatched),
  }));
}

/**
 * Shorts vs long-form vs live, using YouTube's own creatorContentType.
 * Values are lowercase here (`shorts`, `videoOnDemand`) whereas the duration-based
 * `contentType` on a video resource is uppercase (`SHORTS`). They can disagree.
 */
// The report where the 2025 `views` redefinition distorts most: it splits Shorts
// from long-form, and only Shorts changed counting method. Comparing the two on
// `views` alone overstates Shorts against long-form after April 2025.
const CONTENT_TYPE_METRICS = 'estimatedMinutesWatched,likes,shares,subscribersGained,subscribersLost';

export async function fetchContentTypes(apis, { startDate, endDate, onDegraded }) {
  const data = await queryTiered(
    apis,
    { startDate, endDate, dimensions: 'creatorContentType', sort: '-views' },
    [`views,engagedViews,${CONTENT_TYPE_METRICS}`, `views,${CONTENT_TYPE_METRICS}`],
    onDegraded,
  );
  return rowsFromAnalytics(data).map(r => ({
    contentType: r.creatorContentType,
    views: num(r.views),
    engagedViews: num(r.engagedViews),
    estimatedMinutesWatched: num(r.estimatedMinutesWatched),
    likes: num(r.likes),
    shares: num(r.shares),
    subscribersGained: num(r.subscribersGained),
    subscribersLost: num(r.subscribersLost),
  }));
}

export async function fetchSearchTerms(apis, { startDate, endDate, maxResults = MAX_DETAIL_ROWS }) {
  const data = await query(apis, {
    startDate,
    endDate,
    metrics: 'views',
    dimensions: 'insightTrafficSourceDetail',
    filters: 'insightTrafficSourceType==YT_SEARCH',
    sort: '-views',
    maxResults: Math.min(maxResults, MAX_DETAIL_ROWS),
  });
  return rowsFromAnalytics(data).map(r => ({
    searchTerm: r.insightTrafficSourceDetail,
    views: num(r.views),
  }));
}

const GEO_METRICS = 'estimatedMinutesWatched,subscribersGained,subscribersLost';

export async function fetchGeography(apis, { startDate, endDate, maxResults = 50, onDegraded }) {
  const data = await queryTiered(
    apis,
    { startDate, endDate, dimensions: 'country', sort: '-views', maxResults },
    [`views,engagedViews,${GEO_METRICS}`, `views,${GEO_METRICS}`],
    onDegraded,
  );
  return rowsFromAnalytics(data).map(r => ({
    country: r.country,
    views: num(r.views),
    engagedViews: num(r.engagedViews),
    estimatedMinutesWatched: num(r.estimatedMinutesWatched),
    subscribersGained: num(r.subscribersGained),
    subscribersLost: num(r.subscribersLost),
  }));
}

export async function fetchPlaybackLocations(apis, { startDate, endDate, onDegraded }) {
  const data = await queryTiered(
    apis,
    { startDate, endDate, dimensions: 'insightPlaybackLocationType', sort: '-views' },
    ['views,engagedViews,estimatedMinutesWatched', 'views,estimatedMinutesWatched'],
    onDegraded,
  );
  return rowsFromAnalytics(data).map(r => ({
    locationType: r.insightPlaybackLocationType,
    views: num(r.views),
    engagedViews: num(r.engagedViews),
    estimatedMinutesWatched: num(r.estimatedMinutesWatched),
  }));
}

export async function fetchTrafficSourceDetails(apis, { startDate, endDate, sourceType, maxResults = MAX_DETAIL_ROWS }) {
  const data = await query(apis, {
    startDate,
    endDate,
    // estimatedMinutesWatched triggers an internal error on this dimension.
    metrics: 'views',
    dimensions: 'insightTrafficSourceDetail',
    filters: `insightTrafficSourceType==${sourceType}`,
    sort: '-views',
    maxResults: Math.min(maxResults, MAX_DETAIL_ROWS),
  });
  return rowsFromAnalytics(data).map(r => ({
    sourceType,
    detail: r.insightTrafficSourceDetail,
    views: num(r.views),
  }));
}

/**
 * Retention curve for one video, ~100 points at 1% intervals.
 * Ratios above 1.0 are normal for Shorts (viewers loop) and are never clamped.
 *
 * audienceWatchRatio alone says how many people were still watching; it cannot say
 * whether a dip is people leaving or people skipping past. stoppedWatching and
 * startedWatching separate those two, and relativeRetentionPerformance compares the
 * curve against similar YouTube videos rather than against itself — the difference
 * between "60% at the midpoint" and "60% at the midpoint, which is above average".
 *
 * relativeRetentionPerformance is the most frequently unavailable (it needs a peer
 * set), so it gets its own tier and is dropped before the segment counts are.
 */
const RETENTION_TIERS = [
  'audienceWatchRatio,relativeRetentionPerformance,startedWatching,stoppedWatching,totalSegmentImpressions',
  'audienceWatchRatio,startedWatching,stoppedWatching,totalSegmentImpressions',
  'audienceWatchRatio',
];

export async function fetchAudienceRetention(apis, { videoId, startDate, endDate, onDegraded }) {
  const data = await queryTiered(
    apis,
    {
      startDate,
      endDate,
      dimensions: 'elapsedVideoTimeRatio',
      filters: `video==${videoId}`,
    },
    RETENTION_TIERS,
    onDegraded,
  );

  return rowsFromAnalytics(data).map(r => ({
    position: r.elapsedVideoTimeRatio,
    // `ratio` predates the other four and stays the primary name for compatibility.
    ratio: r.audienceWatchRatio,
    relativeRetentionPerformance: num(r.relativeRetentionPerformance),
    startedWatching: num(r.startedWatching),
    stoppedWatching: num(r.stoppedWatching),
    totalSegmentImpressions: num(r.totalSegmentImpressions),
  }));
}

/** Escape hatch: arbitrary metric/dimension combination, columns included. */
export async function runCustomReport(apis, opts) {
  const data = await query(apis, opts);
  return {
    columns: data.columnHeaders?.map(h => ({ name: h.name, type: h.dataType })) ?? [],
    rows: rowsFromAnalytics(data),
  };
}
