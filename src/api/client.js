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
        // Preserve the HTTP status as structure, not just prose. diagnoseGoogleError
        // reads err.response.status ?? err.status; folding the code into the message
        // alone loses it, and a transient 5xx then classifies as UNEXPECTED
        // (recoverable: false) instead of API_UNAVAILABLE (retryable: true) —
        // stopping a caller permanently on a hiccup it should have retried.
        const body = await res.text().catch(() => '');
        let data;
        try { data = JSON.parse(body); } catch { data = body || undefined; }

        const err = new Error(`Failed to download report (${res.status} ${res.statusText})`);
        err.status = res.status;
        err.response = { status: res.status, data };
        throw err;
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
