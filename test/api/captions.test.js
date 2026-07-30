import { describe, it, expect, vi } from 'vitest';
import {
  listCaptionTracks,
  selectCaptionTrack,
  downloadCaptionTrack,
  fetchTranscript,
} from '../../src/api/captions.js';
import { parseCues } from '../../src/api/transforms.js';
import { ERROR_CODES } from '../../src/errors.js';

/** A real-shaped WebVTT body, including the noise YouTube actually emits. */
const VTT = `WEBVTT
Kind: captions
Language: en

00:00:00.000 --> 00:00:02.480
Right, so the thing nobody tells you

00:00:02.480 --> 00:00:05.120 align:start position:0%
about <i>retention</i> curves is that
the dip is not always the problem.

2
00:01:09.500 --> 00:01:12.000
Let me show you what I mean.
`;

function captionsApi({ items = [], body = VTT } = {}) {
  const calls = { list: [], download: [] };
  return {
    calls,
    youtube: {
      captions: {
        list: vi.fn(async params => { calls.list.push(params); return { data: { items } }; }),
        download: vi.fn(async params => { calls.download.push(params); return { data: body }; }),
      },
    },
  };
}

const track = (over = {}) => ({
  id: 'track-1',
  snippet: {
    language: 'en',
    trackKind: 'standard',
    isAutoSynced: false,
    isDraft: false,
    lastUpdated: '2026-07-01T10:00:00Z',
    ...over,
  },
});

describe('captions.list', () => {
  it('sends exactly part and videoId', async () => {
    const apis = captionsApi({ items: [track()] });
    await listCaptionTracks(apis, 'dQw4w9WgXcQ');
    expect(apis.calls.list).toEqual([{ part: 'snippet', videoId: 'dQw4w9WgXcQ' }]);
  });

  it('returns the fields the cache and the caller need', async () => {
    const apis = captionsApi({ items: [track()] });
    const [t] = await listCaptionTracks(apis, 'v1');
    expect(t).toEqual({
      id: 'track-1',
      language: 'en',
      trackKind: 'standard',
      isAutoSynced: false,
      isDraft: false,
      // The cache key: captions can be edited after upload.
      lastUpdated: '2026-07-01T10:00:00Z',
    });
  });

  it('returns an empty list for a video with captions turned off', async () => {
    const apis = captionsApi({ items: [] });
    expect(await listCaptionTracks(apis, 'v1')).toEqual([]);
  });

  it('maps a Google error rather than leaking it raw', async () => {
    // A bare await would surface as UNEXPECTED (recoverable: false) and halt an agent.
    const apis = {
      youtube: {
        captions: {
          list: vi.fn(async () => {
            const err = new Error('forbidden');
            err.response = { status: 403, data: { error: { errors: [{ reason: 'forbidden' }] } } };
            throw err;
          }),
        },
      },
    };
    const err = await listCaptionTracks(apis, 'v1').catch(e => e);
    expect(err.code).toBe(ERROR_CODES.ACCESS_DENIED);
    expect(err.diagnostic.code).toBe('API_FORBIDDEN');
    expect(err.diagnostic.recoverable).toBe(true);
  });
});

describe('captions.download', () => {
  it('sends exactly id and tfmt', async () => {
    const apis = captionsApi();
    await downloadCaptionTrack(apis, 'track-1');
    expect(apis.calls.download).toEqual([{ id: 'track-1', tfmt: 'vtt' }]);
  });

  it('honours an explicit format', async () => {
    const apis = captionsApi();
    await downloadCaptionTrack(apis, 'track-1', { format: 'srt' });
    expect(apis.calls.download).toEqual([{ id: 'track-1', tfmt: 'srt' }]);
  });

  it('parses the downloaded body into cues', async () => {
    const apis = captionsApi();
    const { cues } = await downloadCaptionTrack(apis, 'track-1');
    expect(cues).toHaveLength(3);
  });
});

describe('track selection', () => {
  it('prefers a manually written track over the auto-generated one', async () => {
    // ASR mishears names and anything over music, and the whole point is knowing
    // what was actually said at a drop-off.
    const chosen = selectCaptionTrack([
      { id: 'asr', trackKind: 'ASR', language: 'en', isDraft: false },
      { id: 'manual', trackKind: 'standard', language: 'en', isDraft: false },
    ]);
    expect(chosen.id).toBe('manual');
  });

  it('falls back to the auto-generated track when there is no manual one', () => {
    const chosen = selectCaptionTrack([{ id: 'asr', trackKind: 'ASR', language: 'en', isDraft: false }]);
    expect(chosen.id).toBe('asr');
  });

  it('skips drafts, which are not what viewers saw', () => {
    const chosen = selectCaptionTrack([
      { id: 'draft', trackKind: 'standard', language: 'en', isDraft: true },
      { id: 'asr', trackKind: 'ASR', language: 'en', isDraft: false },
    ]);
    expect(chosen.id).toBe('asr');
  });

  it('returns null when every track is a draft', () => {
    expect(selectCaptionTrack([{ id: 'd', trackKind: 'standard', isDraft: true }])).toBeNull();
  });

  it('returns null for a video with no tracks at all', () => {
    expect(selectCaptionTrack([])).toBeNull();
    expect(selectCaptionTrack(undefined)).toBeNull();
  });

  it('prefers the channel language among manual tracks', () => {
    const chosen = selectCaptionTrack(
      [
        { id: 'de', trackKind: 'standard', language: 'de', isDraft: false },
        { id: 'en', trackKind: 'standard', language: 'en', isDraft: false },
      ],
      { language: 'en' },
    );
    expect(chosen.id).toBe('en');
  });
});

describe('fetchTranscript', () => {
  it('lists, chooses, downloads and reports which track it used', async () => {
    const apis = captionsApi({ items: [track()] });
    const result = await fetchTranscript(apis, 'dQw4w9WgXcQ');

    expect(apis.calls.list).toEqual([{ part: 'snippet', videoId: 'dQw4w9WgXcQ' }]);
    expect(apis.calls.download).toEqual([{ id: 'track-1', tfmt: 'vtt' }]);
    // The choice is never silent: which track spoke is part of the answer.
    expect(result.track).toMatchObject({ id: 'track-1', trackKind: 'standard', language: 'en' });
    expect(result.cues).toHaveLength(3);
  });

  it('does not download anything when the video has no usable track', async () => {
    const apis = captionsApi({ items: [] });
    const result = await fetchTranscript(apis, 'v1');
    expect(result).toEqual({ videoId: 'v1', track: null, trackCount: 0, format: 'vtt', cues: [] });
    expect(apis.youtube.captions.download).not.toHaveBeenCalled();
  });
});

describe('parseCues', () => {
  it('reads real timestamps and real text, not just the right number of cues', () => {
    // Asserting cues.length alone passes against a result where every text is
    // undefined — exactly how the reach CSV column mismatch survived two months.
    const cues = parseCues(VTT);

    expect(cues[0]).toEqual({
      start: 0,
      end: 2.48,
      text: 'Right, so the thing nobody tells you',
    });
    expect(cues[2]).toEqual({
      start: 69.5,
      end: 72,
      text: 'Let me show you what I mean.',
    });
  });

  it('returns times as seconds in numbers, never timestamp strings', () => {
    const [first] = parseCues(VTT);
    expect(typeof first.start).toBe('number');
    expect(typeof first.end).toBe('number');
  });

  it('joins multi-line cue text and drops inline markup', () => {
    const [, second] = parseCues(VTT);
    expect(second.text).toBe('about retention curves is that the dip is not always the problem.');
  });

  it('ignores WebVTT cue settings after the end time', () => {
    const [, second] = parseCues(VTT);
    expect(second.end).toBe(5.12);
  });

  it('parses SubRip, which differs only by the comma before milliseconds', () => {
    const srt = '1\n00:00:01,250 --> 00:00:03,000\nHello there\n\n2\n00:00:03,000 --> 00:00:04,500\nSecond line\n';
    expect(parseCues(srt)).toEqual([
      { start: 1.25, end: 3, text: 'Hello there' },
      { start: 3, end: 4.5, text: 'Second line' },
    ]);
  });

  it('accepts a timestamp with the hour omitted', () => {
    expect(parseCues('01:02.500 --> 01:04.000\nShort form\n')).toEqual([
      { start: 62.5, end: 64, text: 'Short form' },
    ]);
  });

  it('returns null for an unparseable time rather than 0', () => {
    // 0 would read as "the very start of the video" and misalign every cue against
    // a retention curve, silently.
    const [cue] = parseCues('garbage --> 00:00:02.000\nText\n');
    expect(cue.start).toBeNull();
    expect(cue.end).toBe(2);
  });

  it('returns an empty array for empty or non-string input', () => {
    expect(parseCues('')).toEqual([]);
    expect(parseCues('   ')).toEqual([]);
    expect(parseCues(undefined)).toEqual([]);
    expect(parseCues(null)).toEqual([]);
  });

  it('drops a timing line with no text under it', () => {
    expect(parseCues('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\n')).toEqual([]);
  });
});
