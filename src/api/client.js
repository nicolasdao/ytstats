import { google } from 'googleapis';
import { mapGoogleError } from '../errors.js';

/**
 * Bundle the three YouTube API surfaces plus an authenticated CSV downloader.
 *
 * Every fetcher takes this bundle as its first argument, so tests hand in plain
 * objects and never touch the network.
 */
export function createApis(authClient) {
  return {
    youtube: google.youtube({ version: 'v3', auth: authClient }),
    analytics: google.youtubeAnalytics({ version: 'v2', auth: authClient }),
    reporting: google.youtubereporting({ version: 'v1', auth: authClient }),

    /** Reporting API report bodies are plain CSV behind an OAuth-protected URL. */
    async downloadCsv(url) {
      const token = await authClient.getAccessToken();
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token?.token ?? token}`,
          'Accept-Encoding': 'gzip',
        },
      });
      if (!res.ok) {
        throw new Error(`Failed to download report (${res.status} ${res.statusText})`);
      }
      return res.text();
    },
  };
}

/** Run an API call, converting Google's error shapes into typed YtStatsErrors. */
export async function call(fn) {
  try {
    return await fn();
  } catch (err) {
    throw mapGoogleError(err);
  }
}
