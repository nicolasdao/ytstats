import { call } from './client.js';
import { parseCues } from './transforms.js';

/**
 * YouTube Data API v3 captions endpoints.
 *
 * These live on the Data API like the channel and video fetchers, but they are the
 * only calls in ytstats that need a write-capable scope: both captions.list and
 * captions.download require youtube.force-ssl, and Google offers no read-only
 * variant. That is why caption access is opt-in (`ytstats login --with-captions`)
 * rather than part of the default grant — see CAPTIONS_SCOPE in auth/oauth.js.
 *
 * captions.download additionally requires permission to EDIT the video, so it only
 * ever works for videos on a channel the signed-in user owns. There is no path to
 * another creator's transcript here, by design of the API.
 */

/** Download formats captions.download accepts and parseCues understands. */
const DOWNLOAD_FORMAT = 'vtt';

/**
 * Caption tracks on one video, cheapest call in the pair.
 *
 * `lastUpdated` is the field the transcript cache keys on: captions can be edited
 * after upload, so it is the only way to tell a cached transcript is still current
 * without paying for a second download.
 */
export async function listCaptionTracks(apis, videoId) {
  const res = await call(() => apis.youtube.captions.list({ part: 'snippet', videoId }));
  return (res.data.items ?? []).map(item => ({
    id: item.id,
    language: item.snippet?.language ?? null,
    // Google documents ASR / standard / forced in capitals but returns them
    // LOWERCASE ("asr"). Normalized here so consumers get one stable spelling —
    // reading the raw value made the manual-vs-ASR preference below silently
    // inert, since 'asr' !== 'ASR' classified every auto track as author-written.
    trackKind: item.snippet?.trackKind ? String(item.snippet.trackKind).toUpperCase() : null,
    isAutoSynced: item.snippet?.isAutoSynced ?? null,
    isDraft: item.snippet?.isDraft ?? null,
    lastUpdated: item.snippet?.lastUpdated ?? null,
  }));
}

/**
 * Pick the track worth downloading, or null when there is nothing usable.
 *
 * A manually written track beats an auto-generated one: ASR mishears names, jargon
 * and anything said over music, and a transcript is being read here to work out
 * WHAT was said at a drop-off point. Drafts are skipped outright — an unpublished
 * track is not what viewers saw.
 *
 * The chosen track is reported in the command output rather than applied silently,
 * because "the auto-generated track said this" and "the author wrote this" are
 * different claims about the same video.
 */
export function selectCaptionTrack(tracks, { language } = {}) {
  const usable = (tracks ?? []).filter(t => !t.isDraft);
  if (usable.length === 0) return null;

  // Case-insensitive: the API's real casing is lowercase, and a raw !== 'ASR'
  // comparison would treat every auto-generated track as author-written.
  const isAsr = t => String(t.trackKind ?? '').toUpperCase() === 'ASR';
  const manual = usable.filter(t => !isAsr(t));
  const preferred = language
    ? [
        ...manual.filter(t => t.language === language),
        ...manual,
        ...usable.filter(t => t.language === language),
      ]
    : [...manual];

  return preferred[0] ?? usable[0];
}

/**
 * Download one caption track and parse it into cues.
 *
 * Wrapped in call() like every other request in src/api/: a bare await on a
 * googleapis promise is a latent UNEXPECTED (recoverable: false), which halts an
 * agent on a failure that mapGoogleError would have classified as retryable.
 */
export async function downloadCaptionTrack(apis, trackId, { format = DOWNLOAD_FORMAT } = {}) {
  const res = await call(() => apis.youtube.captions.download({ id: trackId, tfmt: format }));
  const body = await readBody(res.data);
  return { format, body, cues: parseCues(body) };
}

/**
 * Caption bodies do not arrive as a string.
 *
 * googleapis hands this endpoint back as a **Blob**, and `String(blob)` yields the
 * literal "[object Blob]" — which parses to zero cues while every other signal
 * still reads as success: ok true, a track chosen, a file cached. That is the same
 * silently-empty shape as the reach-CSV regression, so the type is handled
 * explicitly rather than coerced.
 */
async function readBody(data) {
  if (typeof data === 'string') return data;
  if (data == null) return '';
  if (Buffer.isBuffer(data)) return data.toString('utf-8');
  if (typeof data.text === 'function') return data.text();
  if (typeof data.arrayBuffer === 'function') return Buffer.from(await data.arrayBuffer()).toString('utf-8');
  return String(data);
}

/**
 * List, choose, download, parse — the whole transcript read for one video.
 *
 * Returns `cues: []` with the chosen track null when the video has no usable
 * track, so the caller can report "worked and found nothing" as a warning instead
 * of an error. A video with captions turned off is not a failure.
 */
export async function fetchTranscript(apis, videoId, { language, format = DOWNLOAD_FORMAT } = {}) {
  const tracks = await listCaptionTracks(apis, videoId);
  const track = selectCaptionTrack(tracks, { language });
  if (!track) return { videoId, track: null, trackCount: tracks.length, format, cues: [] };

  const { cues } = await downloadCaptionTrack(apis, track.id, { format });
  return { videoId, track, trackCount: tracks.length, format, cues };
}
