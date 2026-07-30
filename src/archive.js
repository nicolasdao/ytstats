import fs from 'node:fs';
import path from 'node:path';
import { configDir } from './config/paths.js';
import { normalizeReportingDate } from './api/transforms.js';

/**
 * Durable local archive for Reporting API data.
 *
 * This exists because the Reporting API is a *delivery* API, not an archive.
 * Reports expire off Google's servers 60 days after generation (30 days for the
 * backfill ones), so creating jobs starts collection but preserves nothing on its
 * own. A channel that pulls twice a year keeps two 60-day windows and loses the
 * rest — silently, because nothing reports an absence.
 *
 * The Analytics API needs no equivalent: it is a query API over YouTube's own
 * long-lived store and can be asked for any range at any time. Only the Reporting
 * API is ephemeral, so only its output is archived here.
 *
 * Storage is append-only NDJSON per report type. Appending is crash-safe in a way
 * that rewriting a whole JSON document is not: a torn write loses at most the
 * final line, and replay skips unparseable lines rather than failing the read.
 */

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Where the archive lives. Analytics rows are personal data, so the same 0600
 * discipline as the credential store applies.
 *
 * Kept separate from the config directory's own files by a `data/` subdirectory,
 * so `YTSTATS_CONFIG_DIR` still moves everything for a given channel together.
 */
export function resolveDataDir({ env, config }) {
  if (env.YTSTATS_DATA_DIR) return path.resolve(env.YTSTATS_DATA_DIR);
  return path.join(config, 'data');
}

export function dataDir() {
  return resolveDataDir({ env: process.env, config: configDir() });
}

const reportsDir = () => path.join(dataDir(), 'reports');

/** Report type ids come from Google, but they land in a path — so validate. */
function safeType(reportTypeId) {
  if (typeof reportTypeId !== 'string' || !/^[a-zA-Z0-9_]+$/.test(reportTypeId)) {
    throw new Error(`Invalid report type id: ${JSON.stringify(reportTypeId)}`);
  }
  return reportTypeId;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    fs.chmodSync(dir, DIR_MODE);
  } catch {
    // Windows and exotic filesystems: not fatal.
  }
  return dir;
}

const fileFor = type => path.join(reportsDir(), `${safeType(type)}.ndjson`);
const INGESTED = 'ingested.json';

/**
 * Column names that identify a row rather than measure it.
 *
 * Needed because last-wins dedupe has to know what "the same row" means, and the
 * CSV header alone does not say which columns are dimensions. Getting this wrong
 * in the permissive direction merges distinct rows into one — silent data loss of
 * exactly the kind this module exists to prevent — so the rule below is
 * deliberately biased towards treating a column as a dimension.
 *
 * `date` has to be listed explicitly: it arrives as `20260328.0`, which every
 * numeric heuristic reads as a metric.
 */
const KNOWN_DIMENSIONS = new Set([
  'date', 'channel_id', 'video_id', 'playlist_id', 'asset_id',
  'age_group', 'gender', 'country_code', 'province_code', 'city_id', 'dma_id',
  'device_type', 'operating_system', 'playback_location_type', 'playback_location_detail',
  'traffic_source_type', 'traffic_source_detail', 'sharing_service',
  'subtitle_language', 'subscribed_status', 'live_or_on_demand', 'content_type',
  'annotation_id', 'annotation_type', 'card_id', 'card_type',
  'end_screen_element_id', 'end_screen_element_type',
  'creator_content_type', 'youtube_product', 'audience_retention_type',
  'ad_type', 'claimed_status', 'uploader_type', 'language_code',
]);

const isNumericish = v =>
  v === '' || v === null || v === undefined || typeof v === 'number' ||
  /^-?(0|[1-9]\d*)(\.\d+)?$/.test(String(v));

/**
 * Which columns form the identity of a row.
 *
 * A column counts as a dimension if it is a known one, looks like an id, or holds
 * any non-numeric value anywhere in the file — metrics are always numeric, so a
 * single non-numeric value is proof it is not one. An unrecognised dimension that
 * happens to be numeric everywhere is the one case this misses, which is why the
 * known list carries the numeric-looking names explicitly.
 */
export function keyColumns(columns, rows) {
  return columns.filter(col =>
    KNOWN_DIMENSIONS.has(col) ||
    col.endsWith('_id') ||
    rows.some(r => !isNumericish(r[col])),
  );
}

// Joined on NUL, written as an escape so this file stays ASCII text: a raw NUL
// byte makes grep and other tooling treat the source as binary. The separator
// must be something that cannot occur inside a CSV cell, or two distinct rows
// could produce the same key and one would silently overwrite the other.
const keyOf = (row, cols) => cols.map(c => String(row[c] ?? '')).join('\u0000');

/** Report ids already downloaded, so a re-run costs nothing and duplicates nothing. */
export function readIngested() {
  try {
    const raw = fs.readFileSync(path.join(dataDir(), INGESTED), 'utf-8');
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed?.reportIds) ? parsed.reportIds : []);
  } catch {
    // Absent or corrupt is the same answer: nothing is known to be ingested.
    // Re-downloading is cheap and dedupe makes it harmless.
    return new Set();
  }
}

export function writeIngested(ids) {
  const dir = ensureDir(dataDir());
  const target = path.join(dir, INGESTED);
  const tmp = path.join(dir, `.${INGESTED}.tmp-${process.pid}`);
  fs.writeFileSync(tmp, JSON.stringify({ reportIds: [...ids] }, null, 2) + '\n', { mode: FILE_MODE });
  fs.renameSync(tmp, target);
  return target;
}

/**
 * Append rows for one report type.
 *
 * Provenance travels with every row because corrections arrive as *later reports
 * covering the same period*. Without `_createTime` there is no way to tell which
 * of two conflicting rows is the corrected one, and the archive would resolve
 * collisions by file order — which is not guaranteed to match report order.
 */
export function appendRows(reportTypeId, rows, { reportId, jobId, createTime } = {}) {
  if (!rows?.length) return 0;
  const dir = ensureDir(reportsDir());
  const file = path.join(dir, `${safeType(reportTypeId)}.ndjson`);

  const lines = rows.map(row => JSON.stringify({
    ...row,
    ...(row.date !== undefined ? { date: normalizeReportingDate(row.date) } : {}),
    _reportId: reportId ?? null,
    _jobId: jobId ?? null,
    _createTime: createTime ?? null,
  }));

  fs.appendFileSync(file, lines.join('\n') + '\n', { mode: FILE_MODE });
  try {
    fs.chmodSync(file, FILE_MODE);
  } catch {
    // Windows: no-op.
  }
  return rows.length;
}

/**
 * Every stored row for a report type, deduped last-wins.
 *
 * "Last" means newest `_createTime`, not last in the file — a re-ingest after a
 * manual copy, or two processes appending, must not let file order decide which
 * figure survives. Ties fall back to file order, which is the original semantic.
 */
export function readRows(reportTypeId, { raw = false } = {}) {
  let text;
  try {
    text = fs.readFileSync(fileFor(reportTypeId), 'utf-8');
  } catch {
    return [];
  }

  const parsed = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // A torn final line from an interrupted append. Skipping it loses one row;
      // failing the read would lose the whole archive.
    }
  }
  if (raw || !parsed.length) return parsed;

  const columns = [...new Set(parsed.flatMap(Object.keys))].filter(c => !c.startsWith('_'));
  const cols = keyColumns(columns, parsed);

  const best = new Map();
  for (const [i, row] of parsed.entries()) {
    const k = keyOf(row, cols);
    const prev = best.get(k);
    if (!prev || rank(row, i) >= rank(prev.row, prev.i)) best.set(k, { row, i });
  }
  return [...best.values()].map(({ row }) => row);
}

const rank = (row, i) => (Date.parse(row._createTime ?? '') || 0) * 1e6 + i;

/** What the archive holds, per report type — the answer to "is this working". */
export function archiveStatus() {
  let files = [];
  try {
    files = fs.readdirSync(reportsDir()).filter(f => f.endsWith('.ndjson'));
  } catch {
    return { dataDir: dataDir(), reportTypes: [], totalRows: 0, ingestedReports: readIngested().size };
  }

  const reportTypes = files.map(f => {
    const type = f.replace(/\.ndjson$/, '');
    const rows = readRows(type);
    const dates = rows.map(r => r.date).filter(Boolean).sort();
    return {
      reportTypeId: type,
      rows: rows.length,
      firstDate: dates[0] ?? null,
      lastDate: dates[dates.length - 1] ?? null,
      bytes: statSize(path.join(reportsDir(), f)),
    };
  }).sort((a, b) => a.reportTypeId.localeCompare(b.reportTypeId));

  return {
    dataDir: dataDir(),
    reportTypes,
    totalRows: reportTypes.reduce((n, t) => n + t.rows, 0),
    ingestedReports: readIngested().size,
  };
}

function statSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** Days until a report generated at `createTime` expires. Null when unknown. */
export function daysUntilExpiry(createTime, { now = new Date(), lifetimeDays = 60 } = {}) {
  const t = Date.parse(createTime ?? '');
  if (!Number.isFinite(t)) return null;
  return Math.floor(lifetimeDays - (now.getTime() - t) / 86_400_000);
}
