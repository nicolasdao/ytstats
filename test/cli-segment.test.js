import { describe, it, expect, vi } from 'vitest';
import { buildProgram, main } from '../src/cli.js';

/**
 * Drives the segmented dataset commands in-process with an injected API bundle,
 * the same seam `cli-degradation.test.js` uses.
 */
function harness({ query, session } = {}) {
  const out = [];
  const codes = [];
  const deps = {
    stdout: s => out.push(s),
    stderr: () => {},
    exit: c => codes.push(c),
    session: session ?? { getAuthenticatedClient: () => ({ client: {}, account: { channelId: 'UC1' } }) },
    makeApis: () => ({ analytics: { reports: { query } } }),
  };
  return {
    deps,
    program: buildProgram(deps),
    envelope: () => JSON.parse(out.join('\n')),
    exitCode: () => codes.at(-1),
  };
}

/**
 * CAPTURED VERBATIM from the live Analytics API on 2026-07-30 —
 * `dimensions=day,subscribedStatus`, narrowed to the metrics that segment accepts.
 * The repeated date across two segment values is what a partitioned report looks
 * like; do not collapse it.
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

const NOT_SUPPORTED = { response: { status: 400, data: { error: { message: 'The query is not supported.' } } } };

describe('--segment on dataset commands', () => {
  it('returns the segment as a column on every row', async () => {
    const { program, envelope } = harness({ query: vi.fn(async () => REAL_DAILY_SUBSCRIBED) });
    await program.parseAsync(['node', 'ytstats', 'daily', '--days', '7', '--segment', 'subscribedStatus']);

    const env = envelope();
    expect(env.ok).toBe(true);
    expect(env.data.rows[0]).toMatchObject({
      date: '2026-07-23', subscribedStatus: 'UNSUBSCRIBED', views: 27,
    });
    expect(env.data.rows[1].subscribedStatus).toBe('SUBSCRIBED');
  });

  it('segmented rows partition the total rather than duplicating it', async () => {
    // The obvious way to misread a segmented result is to add it to the
    // unsegmented figure. Summing the segments must reproduce it instead.
    const { program, envelope } = harness({ query: vi.fn(async () => REAL_DAILY_SUBSCRIBED) });
    await program.parseAsync(['node', 'ytstats', 'daily', '--days', '7', '--segment', 'subscribedStatus']);

    const firstDay = envelope().data.rows.filter(r => r.date === '2026-07-23');
    expect(firstDay.reduce((n, r) => n + r.views, 0)).toBe(29);
  });

  it('warns which metrics the segment cost', async () => {
    // subscribedStatus cannot serve these three, and the whole query fails if
    // they are requested. Dropping them silently would leave three null columns
    // with nothing saying why.
    const { program, envelope } = harness({ query: vi.fn(async () => REAL_DAILY_SUBSCRIBED) });
    await program.parseAsync(['node', 'ytstats', 'daily', '--days', '7', '--segment', 'subscribedStatus']);

    const warning = envelope().warnings.find(w => w.code === 'ANALYTICS_METRICS_UNSUPPORTED');
    expect(warning.context.dropped).toBe('comments, subscribersGained, subscribersLost');
    expect(envelope().data.rows[0].comments).toBeNull();
  });

  it('leaves the unsegmented shape unchanged', async () => {
    const query = vi.fn(async () => ({
      data: { columnHeaders: [{ name: 'day' }, { name: 'views' }], rows: [['2026-03-01', 10]] },
    }));
    const { program, envelope } = harness({ query });
    await program.parseAsync(['node', 'ytstats', 'daily', '--days', '7']);

    expect(query.mock.calls[0][0].dimensions).toBe('day');
    expect(envelope().data.rows[0]).not.toHaveProperty('subscribedStatus');
  });

  it('lets the API judge a combination it rejects, rather than reporting empty', async () => {
    // Segment support varies by report and by channel. A rejection has to reach
    // the caller as a diagnostic — an empty dataset would read as "no activity".
    const { program, envelope, exitCode } = harness({ query: vi.fn(async () => { throw NOT_SUPPORTED; }) });
    await program.parseAsync(['node', 'ytstats', 'video-analytics', '--days', '7', '--segment', 'subscribedStatus']);

    const env = envelope();
    expect(env.ok).toBe(false);
    expect(env.data).toBeNull();
    expect(env.errors[0].code).toBe('API_QUERY_NOT_SUPPORTED');
    expect(exitCode()).toBe(4);
  });
});

describe('--segment rejection', () => {
  it('search-terms rejects it with INPUT_INVALID_CHOICE', async () => {
    // insightTrafficSourceDetail tolerates only `views` and fails outright on a
    // second dimension, so this is refused here rather than by YouTube.
    const query = vi.fn();
    const { program, envelope, exitCode } = harness({ query });
    await program.parseAsync(['node', 'ytstats', 'search-terms', '--days', '7', '--segment', 'subscribedStatus']);

    const env = envelope();
    expect(env.ok).toBe(false);
    expect(env.errors[0].code).toBe('INPUT_INVALID_CHOICE');
    expect(env.errors[0].context.flag).toBe('--segment');
    expect(env.errors[0].detail).toMatch(/insightTrafficSourceDetail/);
    expect(exitCode()).toBe(3);
  });

  it('rejects before authentication, so a bad flag costs no login round trip', async () => {
    const session = {
      getAuthenticatedClient: () => { throw new Error('authentication must not be reached'); },
    };
    const { program, envelope } = harness({ query: vi.fn(), session });
    await program.parseAsync(['node', 'ytstats', 'search-terms', '--days', '7', '--segment', 'youtubeProduct']);

    expect(envelope().errors[0].code).toBe('INPUT_INVALID_CHOICE');
  });

  it('never reaches the API when the segment is refused', async () => {
    const query = vi.fn();
    const { program } = harness({ query });
    await program.parseAsync(['node', 'ytstats', 'search-terms', '--days', '7', '--segment', 'subscribedStatus']);

    expect(query).not.toHaveBeenCalled();
  });

  it('reports every input problem at once', async () => {
    // One loop iteration should be enough to fix both.
    const { program, envelope } = harness({ query: vi.fn() });
    await program.parseAsync([
      'node', 'ytstats', 'search-terms', '--start', '01/01/2026', '--segment', 'subscribedStatus',
    ]);

    const codes = envelope().errors.map(e => e.code);
    expect(codes).toContain('INPUT_INVALID_DATE');
    expect(codes).toContain('INPUT_INVALID_CHOICE');
  });

  it('an unsupported dimension lists the accepted set', async () => {
    const out = [];
    await main(['node', 'ytstats', 'daily', '--days', '7', '--segment', 'nonsense'], {
      stdout: s => out.push(s),
      stderr: () => {},
      exit: () => {},
      session: { getAuthenticatedClient: () => ({ client: {}, account: { channelId: 'UC1' } }) },
      makeApis: () => ({ analytics: { reports: { query: vi.fn() } } }),
    });

    const env = JSON.parse(out.join('\n'));
    expect(env.ok).toBe(false);
    expect(env.errors[0].code).toBe('INPUT_INVALID_CHOICE');
    expect(env.errors[0].context.allowed).toEqual(['subscribedStatus', 'youtubeProduct']);
  });
});
