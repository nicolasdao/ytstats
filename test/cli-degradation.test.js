import { describe, it, expect, vi } from 'vitest';
import { buildProgram } from '../src/cli.js';

/**
 * Drives authenticated commands with an injected API bundle.
 *
 * These paths were previously unreachable from the suite: `createApis` was called
 * directly inside `withApis`, so nothing could assert what an authenticated
 * command emits. That is exactly where a missing warning hides.
 */
function harness({ query }) {
  const out = [];
  const err = [];
  const program = buildProgram({
    stdout: s => out.push(s),
    stderr: s => err.push(s),
    exit: () => {},
    session: { getAuthenticatedClient: () => ({ client: {}, account: { channelId: 'UC1' } }) },
    makeApis: () => ({ analytics: { reports: { query } } }),
  });
  return { program, envelope: () => JSON.parse(out.join('\n')), err };
}

/** An analytics response in the API's columnHeaders/rows shape. */
const resp = (headers, rows) => ({ data: { columnHeaders: headers.map(name => ({ name })), rows } });
const NOT_SUPPORTED = { response: { status: 400, data: { error: { message: 'The query is not supported.' } } } };

/** Rejects any query containing `metric`, accepts everything else. */
const rejecting = metric => vi.fn(async params => {
  if (params.metrics.includes(metric)) throw NOT_SUPPORTED;
  return resp(['day', 'views'], [['2026-03-01', 10]]);
});

describe('dataset commands report a dropped metric', () => {
  // Every one of these requests engagedViews in its first tier. A channel that
  // cannot serve it gets rows with a null column; without a warning that is
  // indistinguishable from a metric that is genuinely zero.
  it.each([
    'daily',
    'traffic',
    'devices',
    'content-types',
    'geography',
    'playback-locations',
    'video-analytics',
  ])('%s warns when engagedViews is unavailable', async command => {
    const { program, envelope } = harness({ query: rejecting('engagedViews') });
    await program.parseAsync(['node', 'ytstats', command, '--days', '7']);

    const env = envelope();
    expect(env.ok).toBe(true);
    const codes = env.warnings.map(w => w.code);
    expect(codes).toContain('ANALYTICS_METRICS_UNSUPPORTED');
    const warning = env.warnings.find(w => w.code === 'ANALYTICS_METRICS_UNSUPPORTED');
    expect(warning.detail).toMatch(/engagedViews/);
  });

  it('stays silent when nothing was dropped', async () => {
    // A warning on a clean run would train callers to ignore it.
    const { program, envelope } = harness({
      query: vi.fn(async () => resp(['day', 'views', 'engagedViews'], [['2026-03-01', 10, 8]])),
    });
    await program.parseAsync(['node', 'ytstats', 'daily', '--days', '7']);

    const env = envelope();
    expect(env.warnings.map(w => w.code)).not.toContain('ANALYTICS_METRICS_UNSUPPORTED');
  });

  it('names the dropped metric in context so a caller need not parse prose', async () => {
    const { program, envelope } = harness({ query: rejecting('engagedViews') });
    await program.parseAsync(['node', 'ytstats', 'daily', '--days', '7']);

    const warning = envelope().warnings.find(w => w.code === 'ANALYTICS_METRICS_UNSUPPORTED');
    expect(warning.context.dropped).toBe('engagedViews');
    expect(warning.context.step).toBe('daily');
  });

  it('a dropped metric never makes the command fail', async () => {
    // The rows are correct, they just carry fewer fields. Failing would lose a
    // usable dataset over a missing column.
    const { program, envelope } = harness({ query: rejecting('engagedViews') });
    await program.parseAsync(['node', 'ytstats', 'daily', '--days', '7']);

    const env = envelope();
    expect(env.ok).toBe(true);
    expect(env.errors).toEqual([]);
    expect(env.meta.exitCode).toBe(0);
    expect(env.data.rows.length).toBeGreaterThan(0);
  });

  it('period never carries the onDegraded callback into the output', async () => {
    // `period` is echoed back to the caller; leaking a function into it would be
    // dropped by JSON.stringify and read as a missing field.
    const { program, envelope } = harness({ query: rejecting('engagedViews') });
    await program.parseAsync(['node', 'ytstats', 'daily', '--days', '7']);

    // Exactly these two — no onDegraded, and nothing else smuggled in.
    expect(Object.keys(envelope().data.period).sort()).toEqual(['endDate', 'startDate']);
  });

  it('retention warns too, via its own wiring', async () => {
    const { program, envelope } = harness({
      query: vi.fn(async params => {
        if (params.metrics !== 'audienceWatchRatio') throw NOT_SUPPORTED;
        return resp(['elapsedVideoTimeRatio', 'audienceWatchRatio'], [[0, 0.9]]);
      }),
    });
    await program.parseAsync(['node', 'ytstats', 'retention', 'vid123', '--days', '7']);

    const env = envelope();
    expect(env.ok).toBe(true);
    const warning = env.warnings.find(w => w.code === 'ANALYTICS_METRICS_UNSUPPORTED');
    expect(warning.detail).toMatch(/stoppedWatching/);
    expect(env.data.curve[0].ratio).toBe(0.9);
  });
});
