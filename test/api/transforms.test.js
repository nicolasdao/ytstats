import { describe, it, expect } from 'vitest';
import {
  parseDuration,
  classifyContent,
  parseCsv,
  normalizeReportingDate,
  rowsFromAnalytics,
  normalizeChannel,
  normalizeVideo,
} from '../../src/api/transforms.js';

describe('parseDuration', () => {
  it.each([
    ['PT15M33S', 933],
    ['PT1H2M3S', 3723],
    ['PT59S', 59],
    ['PT1M', 60],
    ['PT2H', 7200],
    ['P0D', 0],
  ])('%s -> %i seconds', (iso, secs) => {
    expect(parseDuration(iso)).toBe(secs);
  });

  it('returns 0 for missing or unparseable input', () => {
    expect(parseDuration(null)).toBe(0);
    expect(parseDuration('')).toBe(0);
    expect(parseDuration('garbage')).toBe(0);
  });

  it('handles multi-day durations', () => {
    expect(parseDuration('P1DT2H')).toBe(93600);
  });
});

describe('classifyContent', () => {
  it('classifies a live stream regardless of duration', () => {
    expect(classifyContent({ liveStreamingDetails: {}, contentDetails: { duration: 'PT10S' } }))
      .toBe('LIVE_STREAM');
  });

  it('classifies <=60s as SHORTS', () => {
    expect(classifyContent({ contentDetails: { duration: 'PT60S' } })).toBe('SHORTS');
    expect(classifyContent({ contentDetails: { duration: 'PT25S' } })).toBe('SHORTS');
  });

  it('classifies >60s as VIDEO_ON_DEMAND', () => {
    expect(classifyContent({ contentDetails: { duration: 'PT61S' } })).toBe('VIDEO_ON_DEMAND');
  });

  it('classifies a zero/unknown duration as VIDEO_ON_DEMAND, not SHORTS', () => {
    expect(classifyContent({ contentDetails: {} })).toBe('VIDEO_ON_DEMAND');
  });
});

describe('parseCsv', () => {
  it('parses a header row and typed values', () => {
    const rows = parseCsv('date,video_id,impressions,ctr\n20260328.0,abc,1500,0.0561');
    // 20260328.0 lands as a number here; normalizeReportingDate turns it into ISO.
    expect(rows).toEqual([{ date: 20260328, video_id: 'abc', impressions: 1500, ctr: 0.0561 }]);
    expect(normalizeReportingDate(rows[0].date)).toBe('2026-03-28');
  });

  it('returns [] for an empty body or header-only CSV', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('a,b,c')).toEqual([]);
  });

  it('handles quoted fields containing commas', () => {
    const rows = parseCsv('title,views\n"Hello, World",12');
    expect(rows[0].title).toBe('Hello, World');
    expect(rows[0].views).toBe(12);
  });

  it('handles escaped quotes inside quoted fields', () => {
    const rows = parseCsv('title,views\n"She said ""hi""",3');
    expect(rows[0].title).toBe('She said "hi"');
  });

  it('tolerates CRLF line endings', () => {
    const rows = parseCsv('a,b\r\n1,2\r\n');
    expect(rows).toEqual([{ a: 1, b: 2 }]);
  });

  it('keeps ID-like values as strings instead of coercing them to numbers', () => {
    const rows = parseCsv('video_id,views\n0012345,7');
    expect(rows[0].video_id).toBe('0012345');
  });

  it('leaves empty cells as null', () => {
    const rows = parseCsv('a,b\n1,');
    expect(rows[0].b).toBeNull();
  });
});

describe('normalizeReportingDate', () => {
  // The Reporting API CSV emits 20260328.0 while every other surface uses ISO.
  // Normalising here means consumers never see two date formats.
  it.each([
    ['20260328.0', '2026-03-28'],
    ['20260328', '2026-03-28'],
    [20260328, '2026-03-28'],
    ['2026-03-28', '2026-03-28'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeReportingDate(input)).toBe(expected);
  });

  it('passes through anything it cannot recognise', () => {
    expect(normalizeReportingDate('nonsense')).toBe('nonsense');
    expect(normalizeReportingDate(null)).toBeNull();
  });
});

describe('rowsFromAnalytics', () => {
  it('zips column headers onto row arrays', () => {
    const data = {
      columnHeaders: [{ name: 'day' }, { name: 'views' }],
      rows: [['2026-03-01', 10], ['2026-03-02', 20]],
    };
    expect(rowsFromAnalytics(data)).toEqual([
      { day: '2026-03-01', views: 10 },
      { day: '2026-03-02', views: 20 },
    ]);
  });

  it('returns [] when the API reports no rows', () => {
    expect(rowsFromAnalytics({ columnHeaders: [{ name: 'day' }] })).toEqual([]);
    expect(rowsFromAnalytics({ rows: [] })).toEqual([]);
    expect(rowsFromAnalytics({})).toEqual([]);
    expect(rowsFromAnalytics(null)).toEqual([]);
  });
});

describe('normalizeChannel', () => {
  const raw = {
    id: 'UC123',
    snippet: {
      title: 'Nic Dao', description: 'd', customUrl: '@nicolasdao',
      publishedAt: '2020-01-01T00:00:00Z', country: 'AU',
      thumbnails: { high: { url: 'h.jpg' } },
    },
    contentDetails: { relatedPlaylists: { uploads: 'UU123' } },
    statistics: { subscriberCount: '36', viewCount: '5000', videoCount: '18' },
  };

  it('emits clean camelCase with numeric stats', () => {
    expect(normalizeChannel(raw)).toMatchObject({
      id: 'UC123',
      title: 'Nic Dao',
      customUrl: '@nicolasdao',
      country: 'AU',
      subscriberCount: 36,
      viewCount: 5000,
      videoCount: 18,
      uploadsPlaylistId: 'UU123',
      thumbnailUrl: 'h.jpg',
    });
  });

  it('does not embed a raw_json blob', () => {
    expect(normalizeChannel(raw)).not.toHaveProperty('raw_json');
    expect(normalizeChannel(raw)).not.toHaveProperty('rawJson');
  });

  it('survives a sparse channel resource', () => {
    expect(normalizeChannel({ id: 'UC1' })).toMatchObject({ id: 'UC1', subscriberCount: 0 });
  });
});

describe('normalizeVideo', () => {
  const raw = {
    id: 'vid1',
    snippet: {
      channelId: 'UC123', title: 'How I use AI', description: 'desc',
      publishedAt: '2026-03-01T10:00:00Z', tags: ['ai', 'productivity'], categoryId: '28',
      thumbnails: { maxres: { url: 'max.jpg' }, high: { url: 'high.jpg' } },
    },
    contentDetails: { duration: 'PT25S', definition: 'hd', dimension: '2d', caption: 'true' },
    statistics: { viewCount: '1200', likeCount: '48', commentCount: '3' },
    status: { privacyStatus: 'public', madeForKids: false },
  };

  it('emits clean camelCase with derived fields', () => {
    expect(normalizeVideo(raw)).toMatchObject({
      id: 'vid1',
      channelId: 'UC123',
      title: 'How I use AI',
      durationSeconds: 25,
      contentType: 'SHORTS',
      viewCount: 1200,
      likeCount: 48,
      commentCount: 3,
      caption: true,
      madeForKids: false,
      privacyStatus: 'public',
      thumbnailUrl: 'max.jpg',
    });
  });

  it('keeps tags as a real array, not a JSON string', () => {
    expect(normalizeVideo(raw).tags).toEqual(['ai', 'productivity']);
  });

  it('prefers maxres then high then default thumbnails', () => {
    expect(normalizeVideo({ id: 'v', snippet: { thumbnails: { default: { url: 'd.jpg' } } } }).thumbnailUrl)
      .toBe('d.jpg');
  });

  it('defaults missing statistics to 0 rather than NaN', () => {
    const v = normalizeVideo({ id: 'v', snippet: {}, statistics: {} });
    expect(v.viewCount).toBe(0);
    expect(Number.isNaN(v.likeCount)).toBe(false);
  });
});
