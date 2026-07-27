import { call } from './client.js';
import { normalizeChannel, normalizeVideo } from './transforms.js';

const BATCH_SIZE = 50;

/** The authenticated user's channel, or null when the account owns none. */
export async function fetchChannel(apis) {
  const res = await call(() =>
    apis.youtube.channels.list({
      part: 'snippet,contentDetails,statistics,status,topicDetails',
      mine: true,
    }),
  );
  const channel = res.data.items?.[0];
  return channel ? normalizeChannel(channel) : null;
}

/**
 * Every video id on the channel, via the uploads playlist.
 *
 * playlistItems.list costs 1 quota unit per page of 50; search.list would cost
 * 100 per call. Do not swap this for search.
 */
export async function fetchAllVideoIds(apis, uploadsPlaylistId) {
  if (!uploadsPlaylistId) return [];

  const ids = [];
  let pageToken;

  do {
    const res = await call(() =>
      apis.youtube.playlistItems.list({
        part: 'contentDetails',
        playlistId: uploadsPlaylistId,
        maxResults: BATCH_SIZE,
        pageToken,
      }),
    );
    for (const item of res.data.items ?? []) {
      const id = item.contentDetails?.videoId;
      if (id) ids.push(id);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return ids;
}

/** Full video resources for the given ids, batched 50 at a time (1 unit per batch). */
export async function fetchVideos(apis, videoIds) {
  if (!videoIds?.length) return [];

  const videos = [];
  for (let i = 0; i < videoIds.length; i += BATCH_SIZE) {
    const batch = videoIds.slice(i, i + BATCH_SIZE);
    const res = await call(() =>
      apis.youtube.videos.list({
        part: 'snippet,contentDetails,statistics,status,liveStreamingDetails,topicDetails',
        id: batch.join(','),
      }),
    );
    videos.push(...(res.data.items ?? []).map(normalizeVideo));
  }
  return videos;
}
