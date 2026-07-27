import { describe, it, expect } from 'vitest';
import { resolveDateRange, toIsoDate } from '../src/dates.js';
import { ERROR_CODES } from '../src/errors.js';

const NOW = new Date('2026-07-27T10:30:00Z');

describe('toIsoDate', () => {
  it('formats a Date as YYYY-MM-DD in UTC', () => {
    expect(toIsoDate(new Date('2026-01-05T23:59:59Z'))).toBe('2026-01-05');
  });
});

describe('resolveDateRange', () => {
  it('defaults to the last 90 days ending today', () => {
    const { startDate, endDate } = resolveDateRange({ now: NOW });
    expect(endDate).toBe('2026-07-27');
    expect(startDate).toBe('2026-04-28');
  });

  it('honours an explicit day count', () => {
    expect(resolveDateRange({ days: 7, now: NOW })).toEqual({
      startDate: '2026-07-20',
      endDate: '2026-07-27',
    });
  });

  it('accepts explicit start and end dates', () => {
    expect(resolveDateRange({ start: '2026-01-01', end: '2026-01-31', now: NOW })).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-01-31',
    });
  });

  it('lets an explicit start override the day count', () => {
    const { startDate } = resolveDateRange({ days: 7, start: '2026-01-01', now: NOW });
    expect(startDate).toBe('2026-01-01');
  });

  it('rejects a malformed date', () => {
    const err = (() => {
      try { resolveDateRange({ start: '01/01/2026', now: NOW }); } catch (e) { return e; }
    })();
    expect(err.code).toBe(ERROR_CODES.INVALID_INPUT);
    expect(err.message).toMatch(/YYYY-MM-DD/);
  });

  it('rejects a calendar-invalid date', () => {
    expect(() => resolveDateRange({ start: '2026-02-31', now: NOW })).toThrow(/valid date/i);
  });

  it('rejects a start after the end', () => {
    expect(() => resolveDateRange({ start: '2026-06-01', end: '2026-01-01', now: NOW }))
      .toThrow(/before/i);
  });

  it('rejects a non-positive or absurd day count', () => {
    expect(() => resolveDateRange({ days: 0, now: NOW })).toThrow(/INVALID|positive/i);
    expect(() => resolveDateRange({ days: -5, now: NOW })).toThrow(/positive/i);
    expect(() => resolveDateRange({ days: 'abc', now: NOW })).toThrow(/number/i);
  });

  it('crosses year boundaries correctly', () => {
    expect(resolveDateRange({ days: 30, now: new Date('2026-01-15T00:00:00Z') }).startDate)
      .toBe('2025-12-16');
  });

  it('handles a leap day without drifting', () => {
    expect(resolveDateRange({ days: 1, now: new Date('2028-03-01T00:00:00Z') }).startDate)
      .toBe('2028-02-29');
  });
});
