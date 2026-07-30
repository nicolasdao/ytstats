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

/**
 * A VERBATIM excerpt of what YouTube actually returned for a real ASR track
 * (video 4vllqHl-BLk, captured 2026-07-30). Every quirk below broke the parser
 * when it was pinned only to a hand-written fixture:
 *   - a WHITESPACE-ONLY line inside the first cue (line 6)
 *   - rolling captions: each cue repeats the previous cue's text
 *   - word-level timings as inline markup: Here<00:00:00.400><c> are</c>
 * Do not "tidy" this string. Its awkwardness is the test.
 */
const REAL_ASR_VTT = "WEBVTT\nKind: captions\nLanguage: en\n\n00:00:00.000 --> 00:00:03.270 align:start position:0%\n \nHere<00:00:00.400><c> are</c><00:00:00.880><c> three</c><00:00:01.199><c> warning</c><00:00:01.600><c> signs</c><00:00:02.080><c> that</c><00:00:02.480><c> AI</c>\n\n00:00:03.270 --> 00:00:03.280 align:start position:0%\nHere are three warning signs that AI\n \n\n00:00:03.280 --> 00:00:07.190 align:start position:0%\nHere are three warning signs that AI\nmight<00:00:03.679><c> be</c><00:00:03.919><c> burning</c><00:00:04.319><c> you</c><00:00:04.560><c> out.</c><00:00:05.520><c> One,</c><00:00:06.560><c> you</c><00:00:06.879><c> can't</c>\n";

/** googleapis returns captions.download as a Blob, not a string. */
const blob = text => ({ text: async () => text });

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
      // Normalized: the API returns "standard" lowercase.
      trackKind: 'STANDARD',
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

describe('real YouTube payloads — the shapes a hand-written fixture hides', () => {
  it('reads a Blob body, which is what googleapis actually returns', async () => {
    // String(blob) is "[object Blob]" and parses to zero cues, while ok stays true
    // and a track is still reported. Shipped once; pinned now.
    const apis = captionsApi({ items: [track()], body: blob(REAL_ASR_VTT) });
    const { cues } = await downloadCaptionTrack(apis, 'track-1');
    expect(cues.length).toBeGreaterThan(0);
    expect(cues[0].text).toBe('Here are three warning signs that AI');
  });

  it('normalizes trackKind, which the API returns lowercase', async () => {
    // Google documents ASR/standard/forced in capitals and returns "asr".
    const apis = captionsApi({ items: [track({ trackKind: 'asr' })] });
    const [t] = await listCaptionTracks(apis, 'v1');
    expect(t.trackKind).toBe('ASR');
  });

  it('still prefers a manual track when the API says "asr" in lowercase', () => {
    // A raw !== 'ASR' comparison classified every auto track as author-written,
    // silently inverting the preference this function exists to express.
    const chosen = selectCaptionTrack([
      { id: 'asr', trackKind: 'asr', language: 'en', isDraft: false },
      { id: 'manual', trackKind: 'standard', language: 'en', isDraft: false },
    ]);
    expect(chosen.id).toBe('manual');
  });

  it('parses the real rolling ASR track without losing or repeating lines', () => {
    const cues = parseCues(REAL_ASR_VTT);

    // Three source cues collapse to two: the middle one only repeats the first.
    expect(cues).toEqual([
      { start: 0, end: 3.27, text: 'Here are three warning signs that AI' },
      { start: 3.28, end: 7.19, text: "might be burning you out. One, you can't" },
    ]);
  });

  it('keeps the opening line despite the whitespace-only line inside the cue', () => {
    // Trimming before the blank-line check dropped the first cue of every ASR track.
    expect(parseCues(REAL_ASR_VTT)[0].start).toBe(0);
  });

  it('does not repeat a sentence at several timestamps', () => {
    // Rolling captions restate prior text; emitting it each time would make the
    // "what was said at this moment" reading wrong, not merely verbose.
    const texts = parseCues(REAL_ASR_VTT).map(c => c.text);
    expect(new Set(texts).size).toBe(texts.length);
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
    expect(result.track).toMatchObject({ id: 'track-1', trackKind: 'STANDARD', language: 'en' });
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
