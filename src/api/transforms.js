/**
 * Pure shaping helpers. No network, no auth — everything here is deterministic so
 * it can be tested directly.
 *
 * ytstats emits idiomatic camelCase JSON. Mapping that onto any particular
 * database schema is the consumer's job, not this package's.
 */

const DURATION_RE = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/;

/** ISO 8601 duration (PT15M33S, P1DT2H) to whole seconds. 0 when absent/invalid. */
export function parseDuration(iso) {
  if (!iso || typeof iso !== 'string') return 0;
  const m = iso.match(DURATION_RE);
  if (!m) return 0;
  const [, d, h, min, s] = m;
  return (
    Number(d || 0) * 86400 +
    Number(h || 0) * 3600 +
    Number(min || 0) * 60 +
    Math.floor(Number(s || 0))
  );
}

/**
 * Duration-based content classification.
 *
 * Deliberately identical to the historical behaviour: <=60s is a Short. YouTube's
 * own creatorContentType uses extra signals and can disagree — a 62s video meant
 * as a Short lands in VIDEO_ON_DEMAND here. Callers wanting YouTube's own view
 * should read the contentTypes analytics dimension instead.
 */
export function classifyContent(video) {
  if (video?.liveStreamingDetails) return 'LIVE_STREAM';
  const seconds = parseDuration(video?.contentDetails?.duration);
  if (seconds > 0 && seconds <= 60) return 'SHORTS';
  return 'VIDEO_ON_DEMAND';
}

/**
 * Minimal RFC 4180 CSV parser: quoted fields, embedded commas/newlines, and ""
 * escapes. The Reporting API emits video titles and search terms, both of which
 * routinely contain commas, so naive splitting silently corrupts rows.
 */
export function parseCsv(text) {
  if (typeof text !== 'string' || text.trim() === '') return [];

  const records = [];
  let field = '';
  let record = [];
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += ch;
      continue;
    }

    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { record.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { record.push(field); records.push(record); record = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || record.length) { record.push(field); records.push(record); }

  if (records.length < 2) return [];

  const headers = records[0].map(h => h.trim());
  return records.slice(1)
    .filter(r => r.some(v => v !== ''))
    .map(values => {
      const row = {};
      headers.forEach((h, i) => { row[h] = coerce(values[i]); });
      return row;
    });
}

/**
 * Numeric-looking cells become numbers, except values with a leading zero, which
 * are identifiers (video ids, zero-padded codes) that must stay strings.
 */
function coerce(value) {
  if (value === undefined || value === '') return null;
  const v = String(value).trim();
  if (v === '') return null;
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(v)) return Number(v);
  return v;
}

/** Reporting API dates arrive as 20260328.0; everything else uses ISO. Unify. */
export function normalizeReportingDate(value) {
  if (value === null || value === undefined) return value ?? null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(?:\.0+)?$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : value;
}

/** Analytics responses are columnHeaders + positional rows; zip into objects. */
export function rowsFromAnalytics(data) {
  if (!data?.rows?.length || !data?.columnHeaders?.length) return [];
  const headers = data.columnHeaders.map(h => h.name);
  return data.rows.map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = row[i]; });
    return obj;
  });
}

const int = v => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
};

export function normalizeChannel(channel) {
  const s = channel?.snippet ?? {};
  const cd = channel?.contentDetails ?? {};
  const st = channel?.statistics ?? {};

  return {
    id: channel?.id ?? null,
    title: s.title ?? null,
    description: s.description ?? null,
    customUrl: s.customUrl ?? null,
    publishedAt: s.publishedAt ?? null,
    country: s.country ?? null,
    // YouTube rounds this to 3 significant figures above 1,000 subscribers.
    subscriberCount: int(st.subscriberCount),
    viewCount: int(st.viewCount),
    videoCount: int(st.videoCount),
    uploadsPlaylistId: cd.relatedPlaylists?.uploads ?? null,
    thumbnailUrl: s.thumbnails?.high?.url ?? s.thumbnails?.default?.url ?? null,
  };
}

export function normalizeVideo(video) {
  const s = video?.snippet ?? {};
  const cd = video?.contentDetails ?? {};
  const st = video?.statistics ?? {};
  const status = video?.status ?? {};

  return {
    id: video?.id ?? null,
    channelId: s.channelId ?? null,
    title: s.title ?? null,
    description: s.description ?? null,
    publishedAt: s.publishedAt ?? null,
    thumbnailUrl:
      s.thumbnails?.maxres?.url ?? s.thumbnails?.high?.url ?? s.thumbnails?.default?.url ?? null,
    duration: cd.duration ?? null,
    durationSeconds: parseDuration(cd.duration),
    definition: cd.definition ?? null,
    dimension: cd.dimension ?? null,
    caption: cd.caption === 'true' || cd.caption === true,
    tags: Array.isArray(s.tags) ? s.tags : [],
    categoryId: s.categoryId ?? null,
    privacyStatus: status.privacyStatus ?? null,
    madeForKids: Boolean(status.madeForKids),
    viewCount: int(st.viewCount),
    likeCount: int(st.likeCount),
    commentCount: int(st.commentCount),
    contentType: classifyContent(video),
  };
}
