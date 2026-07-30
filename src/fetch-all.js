import * as data from './api/data.js';
import * as analytics from './api/analytics.js';
import * as reporting from './api/reporting.js';
import { daysBetween } from './dates.js';
import { YtStatsError, ERROR_CODES } from './errors.js';

/** Real implementations; tests inject fakes. */
function defaultFetchers() {
  return {
    fetchChannel: data.fetchChannel,
    fetchAllVideoIds: data.fetchAllVideoIds,
    fetchVideos: data.fetchVideos,
    fetchDailyAnalytics: analytics.fetchDailyAnalytics,
    fetchCardMetrics: analytics.fetchCardMetrics,
    fetchVideoAnalytics: analytics.fetchVideoAnalytics,
    fetchTrafficSources: analytics.fetchTrafficSources,
    fetchDemographics: analytics.fetchDemographics,
    fetchDeviceTypes: analytics.fetchDeviceTypes,
    fetchContentTypes: analytics.fetchContentTypes,
    fetchSearchTerms: analytics.fetchSearchTerms,
    fetchGeography: analytics.fetchGeography,
    fetchPlaybackLocations: analytics.fetchPlaybackLocations,
    fetchTrafficSourceDetails: analytics.fetchTrafficSourceDetails,
    fetchAudienceRetention: analytics.fetchAudienceRetention,
    fetchReach: reporting.fetchReach,
  };
}

const DEFAULT_RETENTION_LIMIT = 50;

/** Auth problems are fatal everywhere; degrading past them yields a useless document. */
const FATAL_CODES = new Set([
  ERROR_CODES.NOT_AUTHENTICATED,
  ERROR_CODES.MISSING_CREDENTIALS,
  ERROR_CODES.INVALID_CREDENTIALS,
  ERROR_CODES.NO_YOUTUBE_CHANNEL,
  ERROR_CODES.QUOTA_EXCEEDED,
]);

/**
 * Pull every dimension in one pass.
 *
 * Individual analytics steps degrade rather than abort: YouTube rejects certain
 * metric/dimension combinations for some channels, and losing demographics should
 * not cost you the other twelve datasets. Whatever failed is reported in
 * `warnings` so the caller can tell "no data" from "not fetched".
 */
export async function fetchAll(apis, {
  range,
  fetchers: injected,
  retention = true,
  retentionLimit = DEFAULT_RETENTION_LIMIT,
  reach = false,
  onProgress,
} = {}) {
  const f = { ...defaultFetchers(), ...injected };
  const { startDate, endDate } = range;
  const period = { startDate, endDate };

  const warnings = [];
  const notes = [];
  const progress = msg => onProgress?.(msg);

  // A metric fallback is not a step failure: the dataset arrived, with fewer
  // columns. Keeping it out of `warnings` preserves that list's meaning ("this
  // step returned nothing"), while still saying why a field is absent — the
  // alternative is a null column with no explanation anywhere.
  const degraded = new Map();
  const opts = name => ({
    ...period,
    onDegraded: dropped => {
      const set = degraded.get(name) ?? new Set();
      for (const m of dropped) set.add(m);
      degraded.set(name, set);
    },
  });

  async function step(name, fn, fallback) {
    progress(`Fetching ${name}...`);
    try {
      return await fn();
    } catch (err) {
      if (FATAL_CODES.has(err?.code)) throw err;
      warnings.push({
        step: name,
        code: err?.code ?? ERROR_CODES.UNKNOWN,
        message: err?.message ?? String(err),
      });
      return fallback;
    }
  }

  // Channel identity is the one hard requirement — everything else keys off it.
  progress('Fetching channel...');
  const channel = await f.fetchChannel(apis);
  if (!channel) {
    throw new YtStatsError('No YouTube channel found for the signed-in account.', {
      code: ERROR_CODES.NO_YOUTUBE_CHANNEL,
      hint: 'Sign in with the Google account that owns the channel: `ytstats logout` then `ytstats login`.',
    });
  }

  progress('Listing videos...');
  const videoIds = await step('videoIds', () => f.fetchAllVideoIds(apis, channel.uploadsPlaylistId), []);
  const videos = await step('videos', () => f.fetchVideos(apis, videoIds), []);

  const [daily, cards] = await Promise.all([
    step('daily', () => f.fetchDailyAnalytics(apis, opts('daily')), []),
    step('cardMetrics', () => f.fetchCardMetrics(apis, period), []),
  ]);

  const [
    videoAnalytics, trafficSources, demographics, deviceTypes,
    contentTypes, searchTerms, geography, playbackLocations,
  ] = await Promise.all([
    step('videoAnalytics', () => f.fetchVideoAnalytics(apis, opts('videoAnalytics')), []),
    step('trafficSources', () => f.fetchTrafficSources(apis, opts('trafficSources')), []),
    step('demographics', () => f.fetchDemographics(apis, period), []),
    step('deviceTypes', () => f.fetchDeviceTypes(apis, opts('deviceTypes')), []),
    step('contentTypes', () => f.fetchContentTypes(apis, opts('contentTypes')), []),
    step('searchTerms', () => f.fetchSearchTerms(apis, period), []),
    step('geography', () => f.fetchGeography(apis, opts('geography')), []),
    step('playbackLocations', () => f.fetchPlaybackLocations(apis, opts('playbackLocations')), []),
  ]);

  // Only drill into traffic source types the channel actually has.
  const detailTypes = trafficSources.map(t => t.sourceType).filter(Boolean);
  const detailResults = await Promise.all(
    detailTypes.map(sourceType =>
      step(`trafficSourceDetails:${sourceType}`,
        () => f.fetchTrafficSourceDetails(apis, { ...period, sourceType }),
        []),
    ),
  );

  const audienceRetention = {};
  if (retention && videos.length) {
    // One API call per video, so cap it — newest first, since that is what anyone
    // analysing retention actually cares about.
    const ordered = [...videos].sort(
      (a, b) => String(b.publishedAt ?? '').localeCompare(String(a.publishedAt ?? '')),
    );
    const targets = ordered.slice(0, retentionLimit);
    if (targets.length < videos.length) {
      notes.push(`Audience retention fetched for ${targets.length} of ${videos.length} videos (most recent first). Use --retention-limit to change.`);
    }

    for (const [i, video] of targets.entries()) {
      progress(`Fetching retention ${i + 1}/${targets.length}...`);
      // Aggregated under one name, not one per video — 50 identical notes saying
      // the channel lacks relativeRetentionPerformance is noise, not information.
      const curve = await step(`retention:${video.id}`,
        () => f.fetchAudienceRetention(apis, { ...opts('retention'), videoId: video.id }),
        null);
      if (curve?.length) audienceRetention[video.id] = curve;
    }
  }

  const result = {
    channel,
    videos,
    daily: mergeByDate(daily, cards),
    videoAnalytics,
    trafficSources,
    trafficSourceDetails: detailResults.flat(),
    demographics,
    deviceTypes,
    contentTypes,
    searchTerms,
    geography,
    playbackLocations,
    audienceRetention,
  };

  if (reach) {
    result.reach = await step('reach', () => f.fetchReach(apis, { onProgress }), { pending: true, rows: [] });
  }

  for (const [name, dropped] of degraded) {
    notes.push(
      `${name}: YouTube does not support ${[...dropped].join(', ')} for this channel, `
      + 'so those fields are absent. Treat them as unknown rather than zero.',
    );
  }

  return {
    period: { ...period, days: daysBetween(startDate, endDate) },
    warnings,
    notes,
    data: result,
  };
}

/** Fold the card-metrics rows into the daily rows sharing their date. */
function mergeByDate(daily, extra) {
  if (!extra?.length) return daily;
  const index = new Map(extra.map(row => [row.date, row]));
  return daily.map(row => {
    const match = index.get(row.date);
    if (!match) return row;
    const { date, ...rest } = match;
    return { ...row, ...rest };
  });
}
