import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { useTempConfigDir, mode, isWindows } from './helpers/tmp.js';
import { buildProgram } from '../src/cli.js';
import { readTranscript, writeTranscript, dataDir } from '../src/archive.js';
import { SCOPES, CAPTIONS_SCOPE } from '../src/auth/oauth.js';

const VTT = `WEBVTT

00:00:00.000 --> 00:00:02.480
Right, so the thing nobody tells you

00:00:02.480 --> 00:00:05.120
about retention curves.
`;

/** A YouTube id WITH A HYPHEN — the shape that breaks the report-type validator. */
const HYPHEN_ID = 'dQw4-9WgXcQ';

const TRACK = {
  id: 'track-1',
  snippet: {
    language: 'en',
    trackKind: 'standard',
    isDraft: false,
    lastUpdated: '2026-07-01T10:00:00Z',
  },
};

/**
 * Drives `transcript` in-process with an injected API bundle, so the whole command
 * body — cache, warnings, scope check — is reachable without network or browser.
 */
function harness({ items = [TRACK], body = VTT, scopes = [...SCOPES, CAPTIONS_SCOPE] } = {}) {
  const out = [];
  const calls = { list: [], download: [] };
  const program = buildProgram({
    stdout: s => out.push(s),
    stderr: () => {},
    exit: () => {},
    session: {
      getAuthenticatedClient: () => ({
        client: {},
        account: { channelId: 'UC1', channelTitle: 'Nic', scopes },
      }),
    },
    makeApis: () => ({
      youtube: {
        captions: {
          list: vi.fn(async p => { calls.list.push(p); return { data: { items } }; }),
          download: vi.fn(async p => { calls.download.push(p); return { data: body }; }),
        },
      },
    }),
  });
  return { program, calls, envelope: () => JSON.parse(out.join('\n')) };
}

describe('transcript command', () => {
  let tmp;
  beforeEach(() => { tmp = useTempConfigDir(); });
  afterEach(() => tmp.cleanup());

  it('returns cues with start, end and text as seconds', async () => {
    const { program, envelope } = harness();
    await program.parseAsync(['node', 'ytstats', 'transcript', HYPHEN_ID]);

    const env = envelope();
    expect(env.ok).toBe(true);
    expect(Object.keys(env.data.cues[0]).sort()).toEqual(['end', 'start', 'text']);
    expect(env.data.cues[0]).toEqual({
      start: 0,
      end: 2.48,
      text: 'Right, so the thing nobody tells you',
    });
    expect(typeof env.data.cues[0].start).toBe('number');
  });

  it('reports which track it used, so the choice is never silent', async () => {
    const { program, envelope } = harness();
    await program.parseAsync(['node', 'ytstats', 'transcript', HYPHEN_ID]);
    expect(envelope().data).toMatchObject({
      videoId: HYPHEN_ID,
      trackId: 'track-1',
      language: 'en',
      trackKind: 'standard',
      lastUpdated: '2026-07-01T10:00:00Z',
    });
  });

  it('caches under a video id containing a hyphen', async () => {
    // The trap: safeType rejects hyphens, and most YouTube ids have one. A
    // transcript store reusing that validator would throw for most videos.
    const { program, envelope } = harness();
    await program.parseAsync(['node', 'ytstats', 'transcript', HYPHEN_ID]);

    expect(envelope().ok).toBe(true);
    const file = path.join(dataDir(), 'transcripts', `${HYPHEN_ID}.json`);
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).cues).toHaveLength(2);
  });

  it('does not download again when the track has not changed', async () => {
    const first = harness();
    await first.program.parseAsync(['node', 'ytstats', 'transcript', HYPHEN_ID]);
    expect(first.calls.download).toHaveLength(1);

    const second = harness();
    await second.program.parseAsync(['node', 'ytstats', 'transcript', HYPHEN_ID]);

    // Listing is cheap and is how staleness is detected; downloading is not.
    expect(second.calls.list).toHaveLength(1);
    expect(second.calls.download).toHaveLength(0);
    expect(second.envelope().data.cues).toHaveLength(2);
  });

  it('re-downloads when the caption track was edited', async () => {
    const first = harness();
    await first.program.parseAsync(['node', 'ytstats', 'transcript', HYPHEN_ID]);

    const edited = {
      ...TRACK,
      snippet: { ...TRACK.snippet, lastUpdated: '2026-07-20T09:00:00Z' },
    };
    const second = harness({ items: [edited], body: '00:00:01.000 --> 00:00:02.000\nRewritten line\n' });
    await second.program.parseAsync(['node', 'ytstats', 'transcript', HYPHEN_ID]);

    expect(second.calls.download).toHaveLength(1);
    expect(second.envelope().data.cues[0].text).toBe('Rewritten line');
  });

  it('warns rather than fails when the video has no caption track', async () => {
    const { program, envelope } = harness({ items: [] });
    await program.parseAsync(['node', 'ytstats', 'transcript', HYPHEN_ID]);

    const env = envelope();
    expect(env.ok).toBe(true);
    expect(env.warnings.map(w => w.code)).toContain('DATA_EMPTY');
    expect(env.data.cues).toEqual([]);
    expect(env.data.trackId).toBeNull();
  });

  it('fails with AUTH_SCOPE_MISSING when captions were never authorized', async () => {
    const { program, envelope } = harness({ scopes: [...SCOPES] });
    await program.parseAsync(['node', 'ytstats', 'transcript', HYPHEN_ID]);

    const env = envelope();
    expect(env.ok).toBe(false);
    expect(env.errors[0].code).toBe('AUTH_SCOPE_MISSING');
    expect(env.errors[0].retryable).toBe(false);
    expect(env.nextSteps[0]).toMatch(/login --with-captions/);
    expect(env.meta.exitCode).toBe(2);
    // data is null on failure, never partial.
    expect(env.data).toBeNull();
  });

  it('attempts the call for an account stored before scopes were recorded', async () => {
    // Absent means unknown, not missing. Refusing here would lock every
    // pre-upgrade account out of a feature it may well be authorized for.
    const { program, envelope, calls } = harness({ scopes: null });
    await program.parseAsync(['node', 'ytstats', 'transcript', HYPHEN_ID]);

    expect(envelope().ok).toBe(true);
    expect(calls.list).toHaveLength(1);
  });

  it('emits exactly one JSON document on the scope-missing path', async () => {
    const out = [];
    const program = buildProgram({
      stdout: s => out.push(s),
      stderr: () => {},
      exit: () => {},
      session: {
        getAuthenticatedClient: () => ({ client: {}, account: { channelId: 'UC1', scopes: [...SCOPES] } }),
      },
      makeApis: () => ({ youtube: { captions: {} } }),
    });
    await program.parseAsync(['node', 'ytstats', 'transcript', HYPHEN_ID]);
    expect(() => JSON.parse(out.join('\n'))).not.toThrow();
  });
});

describe('transcript store', () => {
  let tmp;
  beforeEach(() => { tmp = useTempConfigDir(); });
  afterEach(() => tmp.cleanup());

  it('round-trips a record for a hyphenated id', () => {
    writeTranscript(HYPHEN_ID, { videoId: HYPHEN_ID, cues: [{ start: 0, end: 1, text: 'hi' }] });
    expect(readTranscript(HYPHEN_ID).cues[0].text).toBe('hi');
  });

  it('returns null when nothing is cached', () => {
    expect(readTranscript('nothing-here')).toBeNull();
  });

  it('returns null for a corrupt cache rather than throwing', () => {
    // Same trade-off as readJson: an unreadable cache means "re-download", not "crash".
    writeTranscript(HYPHEN_ID, { videoId: HYPHEN_ID });
    fs.writeFileSync(path.join(dataDir(), 'transcripts', `${HYPHEN_ID}.json`), '{not json');
    expect(readTranscript(HYPHEN_ID)).toBeNull();
  });

  it('rejects a traversing id instead of sanitising it', () => {
    // The hyphen is allowed; separators, dots and NUL are not.
    for (const bad of ['../../etc/passwd', 'a/b', '.', '..', 'a\\b', 'a\0b', '', 'a.b']) {
      expect(() => writeTranscript(bad, {})).toThrow(/Invalid video id/);
    }
    expect(() => readTranscript('../../secrets')).toThrow(/Invalid video id/);
  });

  it.skipIf(isWindows)('stores transcripts 0600 in a 0700 directory', () => {
    writeTranscript(HYPHEN_ID, { videoId: HYPHEN_ID });
    expect(mode(path.join(dataDir(), 'transcripts', `${HYPHEN_ID}.json`))).toBe('0600');
    expect(mode(path.join(dataDir(), 'transcripts'))).toBe('0700');
  });

  it('keeps transcripts out of the report archive', () => {
    // Different lifetime and different shape: reports expire and are an append-only
    // row stream, transcripts do not expire and are one document per video. Mixing
    // them would make `archive` row totals meaningless.
    writeTranscript(HYPHEN_ID, { videoId: HYPHEN_ID });
    expect(fs.existsSync(path.join(dataDir(), 'transcripts'))).toBe(true);
    expect(fs.existsSync(path.join(dataDir(), 'reports'))).toBe(false);
  });
});
