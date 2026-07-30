import test from "node:test";
import assert from "node:assert/strict";
import {
  guideMatchesEquipment,
  matchesGuideQuery,
  matchingGuides,
  parseYouTubePlaylistItem,
} from "../lib/guides/core.mjs";

function playlistItem({ id, title, description, position = 0 }) {
  return {
    snippet: {
      title,
      description,
      position,
      publishedAt: "2026-07-30T00:00:00Z",
      resourceId: { videoId: id },
      thumbnails: { high: { url: `https://i.ytimg.com/vi/${id}/hqdefault.jpg` } },
    },
    contentDetails: { videoId: id },
  };
}

test("YouTube 제목과 설명에서 필수 여부·장비·검색어·주의문을 읽는다", () => {
  const guide = parseYouTubePlaylistItem(playlistItem({
    id: "mbt16",
    title: "[필수] 틸타 MB-T16 | 조임쇠를 세게 조이지 마세요",
    description: "장비: 틸타 MB-T16, 미라지 매트박스\n검색어: 조임쇠, 헛돎, 야마\n주의: 필요 이상으로 조이면 내부 나사산이 파손됩니다.",
  }));
  assert.ok(guide);
  assert.equal(guide.required, true);
  assert.deepEqual(guide.equipmentNames, ["틸타 MB-T16", "미라지 매트박스"]);
  assert.equal(guide.summary, "필요 이상으로 조이면 내부 나사산이 파손됩니다.");
  assert.equal(matchesGuideQuery(guide, "매트박스 야마"), true);
  assert.equal(matchesGuideQuery(guide, "배터리"), false);
});

test("예약 장비명과 명시된 가이드 장비명을 공백·기호 차이와 무관하게 연결한다", () => {
  const guide = parseYouTubePlaylistItem(playlistItem({
    id: "ulanzi",
    title: "[필수] 울란지 비디오패스트 | 플레이트 방향",
    description: "장비: 울란지 비디오패스트\n검색어: 플레이트, 거꾸로, 고정\n주의: 플레이트를 반대 방향으로 끼워야 잠깁니다.",
  }));
  assert.ok(guide);
  assert.equal(guideMatchesEquipment(guide, ["울란지 비디오 패스트 세트"]), true);
  assert.equal(guideMatchesEquipment(guide, ["소니 FX3 바디"]), false);
});

test("조명류 공통 영상은 조명 장비에만 연결하고 필수 영상을 먼저 정렬한다", () => {
  const lighting = parseYouTubePlaylistItem(playlistItem({
    id: "lighting",
    title: "[분실주의] 조명류 | 나비나사를 꼭 확인하세요",
    description: "장비: 조명류\n검색어: 나비나사, 분실\n주의: 반납 전에 조명 나비나사를 확인해주세요.",
    position: 2,
  }));
  const optional = parseYouTubePlaylistItem(playlistItem({
    id: "optional",
    title: "아푸처 600d | 기본 전원 연결",
    description: "장비: 아푸처 600d\n요약: 전원 연결 순서를 확인합니다.",
    position: 0,
  }));
  assert.ok(lighting && optional);
  assert.equal(guideMatchesEquipment(lighting, ["아푸투레 600d 조명"]), true);
  assert.equal(guideMatchesEquipment(lighting, ["소니 A7S3 바디"]), false);
  assert.deepEqual(matchingGuides([optional, lighting], ["아푸투레 600d 조명"]).map((guide) => guide.id), ["lighting", "optional"]);
});

test("삭제·비공개 재생목록 항목은 고객 목록에서 제외한다", () => {
  assert.equal(parseYouTubePlaylistItem(playlistItem({ id: "gone", title: "Private video", description: "" })), null);
  assert.equal(parseYouTubePlaylistItem(playlistItem({ id: "gone", title: "Deleted video", description: "" })), null);
});
