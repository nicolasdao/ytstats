import { call } from './client.js';
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

export async function fetchDailyAnalytics(apis, { startDate, endDate }) {
  const data = await query(apis, {
    startDate,
    endDate,
    // Thumbnail impressions/CTR are documented for this API but always fail;
    // reach data comes from the Reporting API instead.
    metrics: 'views,estimatedMinutesWatched,averageViewDuration,likes,dislikes,comments,shares,subscribersGained,subscribersLost',
    dimensions: 'day',
    sort: 'day',
  });

  return rowsFromAnalytics(data).map(r => ({
    date: r.day,
    views: num(r.views),
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

export async function fetchVideoAnalytics(apis, { startDate, endDate, maxResults = MAX_VIDEO_ROWS }) {
  const data = await query(apis, {
    startDate,
    endDate,
    metrics: 'views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage,likes,comments,shares,subscribersGained,subscribersLost',
    dimensions: 'video',
    sort: '-views',
    maxResults: Math.min(maxResults, MAX_VIDEO_ROWS),
  });

  return rowsFromAnalytics(data).map(r => ({
    videoId: r.video,
    views: num(r.views),
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

export async function fetchTrafficSources(apis, { startDate, endDate }) {
  const data = await query(apis, {
    startDate,
    endDate,
    metrics: 'views,estimatedMinutesWatched',
    dimensions: 'insightTrafficSourceType',
    sort: '-views',
  });
  return rowsFromAnalytics(data).map(r => ({
    sourceType: r.insightTrafficSourceType,
    views: num(r.views),
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

export async function fetchDeviceTypes(apis, { startDate, endDate }) {
  const data = await query(apis, {
    startDate,
    endDate,
    metrics: 'views,estimatedMinutesWatched',
    dimensions: 'deviceType',
    sort: '-views',
  });
  return rowsFromAnalytics(data).map(r => ({
    deviceType: r.deviceType,
    views: num(r.views),
    estimatedMinutesWatched: num(r.estimatedMinutesWatched),
  }));
}

/**
 * Shorts vs long-form vs live, using YouTube's own creatorContentType.
 * Values are lowercase here (`shorts`, `videoOnDemand`) whereas the duration-based
 * `contentType` on a video resource is uppercase (`SHORTS`). They can disagree.
 */
export async function fetchContentTypes(apis, { startDate, endDate }) {
  const data = await query(apis, {
    startDate,
    endDate,
    metrics: 'views,estimatedMinutesWatched,likes,shares,subscribersGained,subscribersLost',
    dimensions: 'creatorContentType',
    sort: '-views',
  });
  return rowsFromAnalytics(data).map(r => ({
    contentType: r.creatorContentType,
    views: num(r.views),
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

export async function fetchGeography(apis, { startDate, endDate, maxResults = 50 }) {
  const data = await query(apis, {
    startDate,
    endDate,
    metrics: 'views,estimatedMinutesWatched,subscribersGained,subscribersLost',
    dimensions: 'country',
    sort: '-views',
    maxResults,
  });
  return rowsFromAnalytics(data).map(r => ({
    country: r.country,
    views: num(r.views),
    estimatedMinutesWatched: num(r.estimatedMinutesWatched),
    subscribersGained: num(r.subscribersGained),
    subscribersLost: num(r.subscribersLost),
  }));
}

export async function fetchPlaybackLocations(apis, { startDate, endDate }) {
  const data = await query(apis, {
    startDate,
    endDate,
    metrics: 'views,estimatedMinutesWatched',
    dimensions: 'insightPlaybackLocationType',
    sort: '-views',
  });
  return rowsFromAnalytics(data).map(r => ({
    locationType: r.insightPlaybackLocationType,
    views: num(r.views),
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
 */
export async function fetchAudienceRetention(apis, { videoId, startDate, endDate }) {
  const data = await query(apis, {
    startDate,
    endDate,
    metrics: 'audienceWatchRatio',
    dimensions: 'elapsedVideoTimeRatio',
    filters: `video==${videoId}`,
  });
  return rowsFromAnalytics(data).map(r => ({
    position: r.elapsedVideoTimeRatio,
    ratio: r.audienceWatchRatio,
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
