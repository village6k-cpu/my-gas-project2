export interface GuideVideo {
  id: string;
  title: string;
  summary: string;
  equipmentNames: string[];
  keywords: string[];
  required: boolean;
  thumbnailUrl: string;
  publishedAt: string;
  position: number;
  watchUrl: string;
  embedUrl: string;
}

export function normalizeGuideText(value: unknown): string;
export function parseYouTubePlaylistItem(item: unknown): GuideVideo | null;
export function matchesGuideQuery(guide: GuideVideo, query: string): boolean;
export function guideMatchesEquipment(guide: GuideVideo, equipmentNames: string[]): boolean;
export function sortGuideVideos(guides: GuideVideo[]): GuideVideo[];
export function matchingGuides(guides: GuideVideo[], equipmentNames: string[]): GuideVideo[];
