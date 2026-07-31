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

/**
 * Metrics each segment dimension accepts. Captured against a live channel on
 * 2026-07-30 by requesting every metric individually.
 *
 * A segment does not merely partition a report — it also restricts which metrics
 * that report may request, and an unsupported metric fails the WHOLE query rather
 * than returning a null column. `day,subscribedStatus` with the unsegmented daily
 * metric list returns nothing at all; drop `comments`, `subscribersGained` and
 * `subscribersLost` and the same query returns rows.
 *
 * youtubeProduct is stricter still: it rejects every engagement and subscriber
 * metric, keeping only view and watch-time figures.
 */
const SEGMENT_METRICS = {
  subscribedStatus: ['views', 'engagedViews', 'estimatedMinutesWatched', 'averageViewDuration',
    'averageViewPercentage', 'likes', 'dislikes', 'shares'],
  youtubeProduct: ['views', 'engagedViews', 'estimatedMinutesWatched', 'averageViewDuration',
    'averageViewPercentage'],
};

/**
 * Append a segment dimension and narrow each metric tier to what it accepts.
 *
 * Whatever the segment costs is reported through `onDegraded`, exactly as a tiered
 * metric drop is — a caller must never receive a null column with nothing saying
 * why. An unknown segment passes through untouched so the API, not this table, has
 * the final word on a dimension it has not been taught about.
 */
function withSegment({ dimensions, tiers, segment, onDegraded }) {
  if (!segment) return { dimensions, tiers };
  const dims = `${dimensions},${segment}`;

  const allowed = SEGMENT_METRICS[segment];
  if (!allowed) return { dimensions: dims, tiers };

  const dropped = tiers[0].split(',').filter(m => !allowed.includes(m));
  if (dropped.length) onDegraded?.(dropped);

  const narrowed = tiers
    .map(t => t.split(',').filter(m => allowed.includes(m)).join(','))
    .filter((t, i, all) => t && all.indexOf(t) === i);

  return { dimensions: dims, tiers: narrowed };
}

/** Surface the segment as a column, so a row says which slice it belongs to. */
const seg = (r, segment) => (segment ? { [segment]: r[segment] ?? null } : {});

const isUnsupported = err =>
  err?.code === ERROR_CODES.QUERY_NOT_SUPPORTED || err?.diagnostic?.code === 'API_QUERY_NOT_SUPPORTED';

/**
 * Run a query against progressively smaller metric sets until one returns data.
 *
 * Which metrics a channel supports varies, and an unsupported one fails the whole
 * query rather than returning a null column. Requesting a newer metric such as
 * engagedViews unconditionally would therefore turn a working dataset into no
 * dataset for anyone whose channel rejects it — so every addition is a tier that
 * falls back to the set already known to work.
 *
 * **A rejection is not always an error.** Some metric combinations are refused with
 * HTTP 200 and an empty `rows` array instead of `The query is not supported.`
 * Retention is the case that proved it: on a live channel, asking for
 * `startedWatching`/`stoppedWatching` alongside the rest returned zero rows, while
 * `audienceWatchRatio` alone returned 100 — so treating the first success as
 * authoritative reported "this video has no retention data" for every video on the
 * channel, with ok: true and no warning. Requesting those two metrics on their own
 * errors outright, which is how the silent variant was found.
 *
 * An empty tier is therefore treated as a degradation signal, not an answer: keep
 * descending, and if a thinner tier returns rows, use it and report what was
 * dropped. When every tier is empty the dataset is genuinely empty — return the
 * richest response so the columns still describe what was asked, and report no
 * degradation, because nothing was actually lost.
 *
 * Tiers are ordered richest first; the last one's failure is a real error, rethrown
 * untouched.
 */
async function queryTiered(apis, params, tiers, onDegraded) {
  const full = tiers[0].split(',');
  let firstEmpty = null;

  for (const [i, metrics] of tiers.entries()) {
    let data;
    try {
      data = await query(apis, { ...params, metrics });
    } catch (err) {
      // A non-support error must never be downgraded into "degraded data" — a 403
      // or a network failure is an auth problem, not a thinner dataset.
      if (!isUnsupported(err)) throw err;
      if (i === tiers.length - 1) {
        if (firstEmpty) return firstEmpty;
        throw err;
      }
      continue;
    }

    if (data?.rows?.length) {
      if (i > 0) {
        const kept = new Set(metrics.split(','));
        onDegraded?.(full.filter(m => !kept.has(m)));
      }
      return data;
    }

    firstEmpty ??= data;
  }

  return firstEmpty;
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

export async function fetchDailyAnalytics(apis, { startDate, endDate, segment, onDegraded }) {
  const { dimensions, tiers } = withSegment({
    // Thumbnail impressions/CTR are documented for this API but always fail;
    // reach data comes from the Reporting API instead.
    dimensions: 'day',
    tiers: [`views,engagedViews,${DAILY_METRICS}`, `views,${DAILY_METRICS}`],
    segment,
    onDegraded,
  });

  const data = await queryTiered(
    apis,
    { startDate, endDate, dimensions, sort: 'day' },
    tiers,
    onDegraded,
  );

  return rowsFromAnalytics(data).map(r => ({
    date: r.day,
    ...seg(r, segment),
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

export async function fetchVideoAnalytics(apis, { startDate, endDate, maxResults = MAX_VIDEO_ROWS, segment, onDegraded }) {
  const { dimensions, tiers } = withSegment({
    dimensions: 'video',
    tiers: [`views,engagedViews,${VIDEO_METRICS}`, `views,${VIDEO_METRICS}`],
    segment,
    onDegraded,
  });

  const data = await queryTiered(
    apis,
    {
      startDate,
      endDate,
      dimensions,
      sort: '-views',
      maxResults: Math.min(maxResults, MAX_VIDEO_ROWS),
    },
    tiers,
    onDegraded,
  );

  return rowsFromAnalytics(data).map(r => ({
    videoId: r.video,
    ...seg(r, segment),
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

export async function fetchTrafficSources(apis, { startDate, endDate, segment, onDegraded }) {
  const { dimensions, tiers } = withSegment({
    dimensions: 'insightTrafficSourceType',
    tiers: ['views,engagedViews,estimatedMinutesWatched', 'views,estimatedMinutesWatched'],
    segment,
    onDegraded,
  });
  const data = await queryTiered(
    apis,
    { startDate, endDate, dimensions, sort: '-views' },
    tiers,
    onDegraded,
  );
  return rowsFromAnalytics(data).map(r => ({
    sourceType: r.insightTrafficSourceType,
    ...seg(r, segment),
    views: num(r.views),
    engagedViews: num(r.engagedViews),
    estimatedMinutesWatched: num(r.estimatedMinutesWatched),
  }));
}

export async function fetchDemographics(apis, { startDate, endDate, segment }) {
  // The one report whose metric (viewerPercentage) no segment restricts, so it
  // needs no narrowing — only the extra dimension.
  const data = await query(apis, {
    startDate,
    endDate,
    metrics: 'viewerPercentage',
    dimensions: segment ? `ageGroup,gender,${segment}` : 'ageGroup,gender',
  });
  return rowsFromAnalytics(data).map(r => ({
    ageGroup: r.ageGroup,
    gender: r.gender,
    ...seg(r, segment),
    viewerPercentage: num(r.viewerPercentage),
  }));
}

export async function fetchDeviceTypes(apis, { startDate, endDate, segment, onDegraded }) {
  const { dimensions, tiers } = withSegment({
    dimensions: 'deviceType',
    tiers: ['views,engagedViews,estimatedMinutesWatched', 'views,estimatedMinutesWatched'],
    segment,
    onDegraded,
  });
  const data = await queryTiered(
    apis,
    { startDate, endDate, dimensions, sort: '-views' },
    tiers,
    onDegraded,
  );
  return rowsFromAnalytics(data).map(r => ({
    deviceType: r.deviceType,
    ...seg(r, segment),
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

export async function fetchContentTypes(apis, { startDate, endDate, segment, onDegraded }) {
  const { dimensions, tiers } = withSegment({
    dimensions: 'creatorContentType',
    tiers: [`views,engagedViews,${CONTENT_TYPE_METRICS}`, `views,${CONTENT_TYPE_METRICS}`],
    segment,
    onDegraded,
  });
  const data = await queryTiered(
    apis,
    { startDate, endDate, dimensions, sort: '-views' },
    tiers,
    onDegraded,
  );
  return rowsFromAnalytics(data).map(r => ({
    contentType: r.creatorContentType,
    ...seg(r, segment),
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

export async function fetchGeography(apis, { startDate, endDate, maxResults = 50, segment, onDegraded }) {
  const { dimensions, tiers } = withSegment({
    dimensions: 'country',
    tiers: [`views,engagedViews,${GEO_METRICS}`, `views,${GEO_METRICS}`],
    segment,
    onDegraded,
  });
  const data = await queryTiered(
    apis,
    { startDate, endDate, dimensions, sort: '-views', maxResults },
    tiers,
    onDegraded,
  );
  return rowsFromAnalytics(data).map(r => ({
    country: r.country,
    ...seg(r, segment),
    views: num(r.views),
    engagedViews: num(r.engagedViews),
    estimatedMinutesWatched: num(r.estimatedMinutesWatched),
    subscribersGained: num(r.subscribersGained),
    subscribersLost: num(r.subscribersLost),
  }));
}

export async function fetchPlaybackLocations(apis, { startDate, endDate, segment, onDegraded }) {
  const { dimensions, tiers } = withSegment({
    dimensions: 'insightPlaybackLocationType',
    tiers: ['views,engagedViews,estimatedMinutesWatched', 'views,estimatedMinutesWatched'],
    segment,
    onDegraded,
  });
  const data = await queryTiered(
    apis,
    { startDate, endDate, dimensions, sort: '-views' },
    tiers,
    onDegraded,
  );
  return rowsFromAnalytics(data).map(r => ({
    locationType: r.insightPlaybackLocationType,
    ...seg(r, segment),
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
 *
 * The reverse case is real too, and costs more: a channel can serve
 * relativeRetentionPerformance while refusing the drop-off counts. Verified live on
 * 2026-07-31 — `startedWatching` or `stoppedWatching` on their own return
 * `An internal error has occurred.`, and folded into a larger set they return zero
 * rows rather than an error. Without the third tier such a channel falls all the
 * way to bare audienceWatchRatio and loses the peer comparison for no reason.
 */
const RETENTION_TIERS = [
  'audienceWatchRatio,relativeRetentionPerformance,startedWatching,stoppedWatching,totalSegmentImpressions',
  'audienceWatchRatio,startedWatching,stoppedWatching,totalSegmentImpressions',
  'audienceWatchRatio,relativeRetentionPerformance,totalSegmentImpressions',
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
