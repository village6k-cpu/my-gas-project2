const REQUIRED_BADGE_RE = /\[(?:필수|파손\s*주의|분실\s*주의|주의)\]/gi;
const META_LINE_RE = /^\s*(장비|대상|적용\s*장비|검색어|키워드|주의|요약|핵심|중요도|위험)\s*[:：]\s*(.+?)\s*$/i;
const LIGHTING_RE = /(조명|라이트|led|아푸처|아푸투어|아푸투레|amaran|난룩스|nanlux|난라이트|nanlite|고독스|godox|스카이패널|skypanel)/i;

export function normalizeGuideText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/아푸투레|아푸투어|aputure/g, "아푸처")
    .replace(/[^0-9a-z가-힣]+/g, "");
}

function splitValues(value) {
  return String(value ?? "")
    .split(/[,，/|]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function metadataLines(description) {
  return String(description ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = META_LINE_RE.exec(line);
      return match ? { label: match[1].replace(/\s+/g, ""), value: match[2].trim() } : { label: "", value: line };
    });
}

function valuesFor(lines, labels) {
  const wanted = new Set(labels);
  return lines.filter((line) => wanted.has(line.label)).flatMap((line) => splitValues(line.value));
}

function pickThumbnail(thumbnails) {
  for (const key of ["maxres", "standard", "high", "medium", "default"]) {
    const url = thumbnails?.[key]?.url;
    if (typeof url === "string" && url) return url;
  }
  return "";
}

function cleanTitle(value) {
  return String(value ?? "").replace(REQUIRED_BADGE_RE, "").replace(/\s+/g, " ").trim();
}

export function parseYouTubePlaylistItem(item) {
  const snippet = item?.snippet ?? {};
  const videoId = String(item?.contentDetails?.videoId ?? snippet?.resourceId?.videoId ?? "").trim();
  const rawTitle = String(snippet?.title ?? "").trim();
  if (!videoId || !rawTitle || /^(private|deleted) video$/i.test(rawTitle)) return null;

  const description = String(snippet?.description ?? "");
  const lines = metadataLines(description);
  const displayTitle = cleanTitle(rawTitle);
  const titleLead = cleanTitle(displayTitle.split("|")[0]);
  const explicitEquipment = valuesFor(lines, ["장비", "대상", "적용장비"]);
  const equipmentNames = explicitEquipment.length > 0 ? explicitEquipment : titleLead ? [titleLead] : [];
  const keywords = valuesFor(lines, ["검색어", "키워드"]);
  const summaryValues = valuesFor(lines, ["주의", "요약", "핵심"]);
  const plainSummary = lines.find((line) => !line.label && !/^https?:\/\//i.test(line.value))?.value ?? "";
  const titleSummary = displayTitle.includes("|") ? displayTitle.split("|").slice(1).join("|").trim() : "";
  const summary = summaryValues[0] || plainSummary || titleSummary;
  const riskText = valuesFor(lines, ["중요도", "위험"]).join(" ");
  const required = REQUIRED_BADGE_RE.test(rawTitle) || /(필수|높음|고장|파손|분실)/.test(riskText);
  REQUIRED_BADGE_RE.lastIndex = 0;

  return {
    id: videoId,
    title: displayTitle,
    summary,
    equipmentNames,
    keywords,
    required,
    thumbnailUrl: pickThumbnail(snippet?.thumbnails),
    publishedAt: String(snippet?.publishedAt ?? ""),
    position: Number.isFinite(Number(snippet?.position)) ? Number(snippet.position) : 9999,
    watchUrl: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
    embedUrl: `https://www.youtube-nocookie.com/embed/${encodeURIComponent(videoId)}?rel=0`,
  };
}

export function matchesGuideQuery(guide, query) {
  const tokens = String(query ?? "")
    .split(/[\s,，/]+/)
    .map(normalizeGuideText)
    .filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = normalizeGuideText([
    guide?.title,
    guide?.summary,
    ...(guide?.equipmentNames ?? []),
    ...(guide?.keywords ?? []),
  ].join(" "));
  return tokens.every((token) => haystack.includes(token));
}

function isLightingCategory(value) {
  const normalized = normalizeGuideText(value);
  return normalized === "조명" || normalized === "조명류" || normalized === "라이트" || normalized === "라이트류";
}

export function guideMatchesEquipment(guide, equipmentNames) {
  const items = (equipmentNames ?? []).map((name) => String(name ?? "").trim()).filter(Boolean);
  if (items.length === 0) return false;

  for (const target of guide?.equipmentNames ?? []) {
    const targetKey = normalizeGuideText(target);
    if (!targetKey) continue;
    for (const item of items) {
      const itemKey = normalizeGuideText(item);
      if (!itemKey) continue;
      if (targetKey.length >= 2 && (itemKey.includes(targetKey) || targetKey.includes(itemKey))) return true;
      if (isLightingCategory(target) && LIGHTING_RE.test(item)) return true;
    }
  }
  return false;
}

export function sortGuideVideos(guides) {
  return [...(guides ?? [])].sort((a, b) => {
    if (Boolean(a?.required) !== Boolean(b?.required)) return a?.required ? -1 : 1;
    return Number(a?.position ?? 9999) - Number(b?.position ?? 9999);
  });
}

export function matchingGuides(guides, equipmentNames) {
  return sortGuideVideos((guides ?? []).filter((guide) => guideMatchesEquipment(guide, equipmentNames)));
}
