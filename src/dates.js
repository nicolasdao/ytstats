import { YtStatsError, ERROR_CODES } from './errors.js';

const DEFAULT_DAYS = 90;
const MAX_DAYS = 3650;
const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC YYYY-MM-DD. All API date arguments are plain calendar dates, never times. */
export function toIsoDate(date) {
  return date.toISOString().slice(0, 10);
}

function assertIsoDate(value, label) {
  if (!ISO_RE.test(value)) {
    throw new YtStatsError(`${label} must be in YYYY-MM-DD format, got "${value}".`, {
      code: ERROR_CODES.INVALID_INPUT,
    });
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  // Round-tripping catches calendar-invalid dates like 2026-02-31, which Date
  // silently rolls forward into March.
  if (Number.isNaN(parsed.getTime()) || toIsoDate(parsed) !== value) {
    throw new YtStatsError(`${label} is not a valid date: "${value}".`, {
      code: ERROR_CODES.INVALID_INPUT,
    });
  }
  return parsed;
}

/**
 * Resolve a reporting window.
 *
 * `--start`/`--end` win where given; otherwise the window is the last `days`
 * ending today (UTC).
 */
export function resolveDateRange({ days, start, end, now = new Date() } = {}) {
  const endDate = end ? (assertIsoDate(end, 'End date'), end) : toIsoDate(now);

  if (start) {
    assertIsoDate(start, 'Start date');
    if (start > endDate) {
      throw new YtStatsError(`Start date (${start}) must be before end date (${endDate}).`, {
        code: ERROR_CODES.INVALID_INPUT,
      });
    }
    return { startDate: start, endDate };
  }

  const count = days === undefined ? DEFAULT_DAYS : Number(days);
  if (!Number.isFinite(count)) {
    throw new YtStatsError(`--days must be a number, got "${days}".`, {
      code: ERROR_CODES.INVALID_INPUT,
    });
  }
  if (count <= 0) {
    throw new YtStatsError('--days must be a positive number.', { code: ERROR_CODES.INVALID_INPUT });
  }
  if (count > MAX_DAYS) {
    throw new YtStatsError(`--days must be ${MAX_DAYS} or fewer.`, { code: ERROR_CODES.INVALID_INPUT });
  }

  const endMs = new Date(`${endDate}T00:00:00Z`).getTime();
  return {
    startDate: toIsoDate(new Date(endMs - count * 86400000)),
    endDate,
  };
}

/** Whole days between two ISO dates. */
export function daysBetween(startDate, endDate) {
  const a = new Date(`${startDate}T00:00:00Z`).getTime();
  const b = new Date(`${endDate}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86400000);
}
