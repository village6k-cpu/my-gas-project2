import "server-only";

import type { GuideVideo } from "@/lib/guides/core.mjs";
import { parseYouTubePlaylistItem, sortGuideVideos } from "@/lib/guides/core.mjs";

const YOUTUBE_PLAYLIST_ITEMS_URL = "https://www.googleapis.com/youtube/v3/playlistItems";
const GUIDE_CACHE_SECONDS = 300;
const MAX_PLAYLIST_PAGES = 10;

interface YouTubePlaylistResponse {
  items?: unknown[];
  nextPageToken?: string;
  error?: { message?: string };
}

export interface GuideVideoResult {
  configured: boolean;
  guides: GuideVideo[];
  refreshedAt: string;
}

function guideConfig() {
  return {
    apiKey: String(process.env.YOUTUBE_DATA_API_KEY ?? "").trim(),
    playlistId: String(process.env.YOUTUBE_GUIDES_PLAYLIST_ID ?? "").trim(),
  };
}

export async function getYouTubeGuideVideos(): Promise<GuideVideoResult> {
  const { apiKey, playlistId } = guideConfig();
  if (!apiKey || !playlistId) return { configured: false, guides: [], refreshedAt: new Date().toISOString() };

  const guides: GuideVideo[] = [];
  let pageToken = "";

  for (let page = 0; page < MAX_PLAYLIST_PAGES; page += 1) {
    const url = new URL(YOUTUBE_PLAYLIST_ITEMS_URL);
    url.searchParams.set("part", "snippet,contentDetails");
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("playlistId", playlistId);
    url.searchParams.set("key", apiKey);
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const response = await fetch(url, {
      next: { revalidate: GUIDE_CACHE_SECONDS },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => ({}))) as YouTubePlaylistResponse;
    if (!response.ok) throw new Error(body.error?.message || `YouTube 재생목록 조회 실패 (${response.status})`);

    for (const item of body.items ?? []) {
      const guide = parseYouTubePlaylistItem(item);
      if (guide) guides.push(guide);
    }
    pageToken = String(body.nextPageToken ?? "");
    if (!pageToken) break;
  }

  return { configured: true, guides: sortGuideVideos(guides), refreshedAt: new Date().toISOString() };
}
