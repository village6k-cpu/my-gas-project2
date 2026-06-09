// 장비 카탈로그 (프로토타입 시드). 실제로는 목록/장비마스터/세트마스터에서 옴.
// 현장추가 드롭다운 + 카테고리(시각 구분/재고연동)의 소스.
import type { EquipmentItem } from "./types";

export type Category =
  | "바디"
  | "렌즈"
  | "세트"
  | "짐벌·리그"
  | "조명"
  | "음향"
  | "삼각대·서포트"
  | "모니터"
  | "배터리·미디어"
  | "케이블·라인"
  | "암·클램프"
  | "소품·기타";

export interface CatalogItem {
  name: string;
  category: Category;
}

const ACCESSORY = new Set<Category>(["배터리·미디어", "케이블·라인", "암·클램프", "소품·기타"]);

export function isAccessory(c?: string): boolean {
  return c ? ACCESSORY.has(c as Category) : false;
}

/** 행에 붙일 짧은 태그 */
export function shortCategory(c?: string): string {
  const map: Record<string, string> = {
    "배터리·미디어": "배터리·미디어",
    "케이블·라인": "라인",
    "암·클램프": "암·클램프",
    "소품·기타": "소품",
    "짐벌·리그": "짐벌·리그",
    "삼각대·서포트": "삼각대",
  };
  return map[c ?? ""] ?? c ?? "";
}

export const CATALOG: CatalogItem[] = [
  // 바디
  { name: "소니 A7S3 바디", category: "바디" },
  { name: "소니 A7M4 바디", category: "바디" },
  { name: "소니 A1 바디", category: "바디" },
  { name: "소니 FX3 바디", category: "바디" },
  { name: "소니 FX6 바디", category: "바디" },
  { name: "캐논 R5 바디", category: "바디" },
  // 렌즈
  { name: "소니 GM 24-70mm II", category: "렌즈" },
  { name: "소니 GM 70-200mm II", category: "렌즈" },
  { name: "소니 GM 16-35mm II", category: "렌즈" },
  { name: "소니 GM 50mm F1.2", category: "렌즈" },
  { name: "탐론 28-75mm G2", category: "렌즈" },
  // 세트
  { name: "소니 A7S3 바디세트", category: "세트" },
  { name: "소니 FX3 바디세트", category: "세트" },
  { name: "소니 FX6 바디세트", category: "세트" },
  // 짐벌·리그
  { name: "DJI RS3 Pro 짐벌", category: "짐벌·리그" },
  { name: "DJI RS4 Pro 짐벌", category: "짐벌·리그" },
  { name: "이지리그 베스트", category: "짐벌·리그" },
  // 조명
  { name: "아트리스트 LED P60c", category: "조명" },
  { name: "아푸투레 600d", category: "조명" },
  { name: "고독스 SL60", category: "조명" },
  // 음향
  { name: "DJI 마이크 2 세트", category: "음향" },
  { name: "로데 와이어리스 고 II", category: "음향" },
  { name: "젠하이저 MKE600", category: "음향" },
  // 삼각대·서포트
  { name: "맨프로토 삼각대 055", category: "삼각대·서포트" },
  { name: "자이언 삼각대", category: "삼각대·서포트" },
  { name: "카메라 슬라이더 80cm", category: "삼각대·서포트" },
  // 모니터
  { name: "아트리스트 5인치 모니터", category: "모니터" },
  { name: "스몰리그 7인치 모니터", category: "모니터" },
  // 배터리·미디어
  { name: "소니 NP-FZ100 배터리", category: "배터리·미디어" },
  { name: "V마운트 배터리", category: "배터리·미디어" },
  { name: "CFexpress 160GB", category: "배터리·미디어" },
  { name: "SD카드 128GB", category: "배터리·미디어" },
  // 케이블·라인
  { name: "SDI 연선 5m", category: "케이블·라인" },
  { name: "SDI 연선 10m", category: "케이블·라인" },
  { name: "중계선 20m", category: "케이블·라인" },
  { name: "BNC 라인 10m", category: "케이블·라인" },
  { name: "HDMI 케이블 2m", category: "케이블·라인" },
  { name: "전원 연장선 10m", category: "케이블·라인" },
  // 암·클램프
  { name: "매직암 11인치", category: "암·클램프" },
  { name: "슈퍼클램프", category: "암·클램프" },
  { name: "마운트 암", category: "암·클램프" },
  // 소품·기타
  { name: "CPL 필터", category: "소품·기타" },
  { name: "ND 필터 세트", category: "소품·기타" },
  { name: "클리닝 키트", category: "소품·기타" },
];

const BY_NAME = new Map(CATALOG.map((c) => [c.name, c.category]));
export function categoryOf(name: string): Category | undefined {
  return BY_NAME.get(name);
}

export function searchCatalog(q: string, limit = 7): CatalogItem[] {
  const k = q.trim().toLowerCase().replace(/\s+/g, "");
  if (!k) return CATALOG.slice(0, limit);
  return CATALOG.filter((c) => c.name.toLowerCase().replace(/\s+/g, "").includes(k)).slice(0, limit);
}

/** 세트 → 구성품 (현장에서 세트 통째 추가 시 자동 전개) */
export const SET_COMPOSITION: Record<string, { name: string; qty: number }[]> = {
  "소니 A7S3 바디세트": [
    { name: "소니 A7S3 바디", qty: 1 },
    { name: "소니 NP-FZ100 배터리", qty: 3 },
    { name: "CFexpress 160GB", qty: 2 },
  ],
  "소니 FX3 바디세트": [
    { name: "소니 FX3 바디", qty: 1 },
    { name: "소니 NP-FZ100 배터리", qty: 3 },
    { name: "CFexpress 160GB", qty: 2 },
  ],
  "소니 FX6 바디세트": [
    { name: "소니 FX6 바디", qty: 1 },
    { name: "V마운트 배터리", qty: 2 },
    { name: "CFexpress 160GB", qty: 2 },
  ],
};

/** 카테고리 표시 순서 (반납 화면 그룹핑) */
export const CATEGORY_ORDER: Category[] = [
  "세트",
  "바디",
  "렌즈",
  "짐벌·리그",
  "조명",
  "음향",
  "모니터",
  "삼각대·서포트",
  "암·클램프",
  "케이블·라인",
  "배터리·미디어",
  "소품·기타",
];

export function categoryRank(c?: string): number {
  const i = CATEGORY_ORDER.indexOf(c as Category);
  return i === -1 ? 99 : i;
}

// 거친 2분류 (직원 직관용). 세세한 카테고리는 정렬에만 사용.
// 카테고리명에 이 키워드가 들어가면 '장비'(메인), 아니면 '악세사리·라인'.
// 키워드 포함 방식 — "100볼 삼각대", "로닌/짐벌" 같은 변형도 잡음.
const GEAR_KEYWORDS = ["카메라", "바디", "렌즈", "짐벌", "로닌", "조명", "오디오", "음향", "모니터", "삼각대", "세트", "그립", "리그", "서포트", "슬라이더"];
export type Coarse = "장비" | "악세사리·라인";
export function coarseGroup(c?: string): Coarse {
  if (!c) return "악세사리·라인";
  return GEAR_KEYWORDS.some((k) => c.includes(k)) ? "장비" : "악세사리·라인";
}
export function coarseRank(c?: string): number {
  return coarseGroup(c) === "장비" ? 0 : 1;
}

/**
 * Supabase 읽기 시 카테고리 보정 + 세트 헤더 정규화.
 * 세트 묶음은 유지: 세트 대표행(세트명 있는 헤더)은 그룹 라벨, 단품(세트명 없는 헤더)은 항목, 구성품은 세트 밑.
 */
export function normalizeItems(items: EquipmentItem[]): EquipmentItem[] {
  return items.map((e) => {
    const category = e.category ?? categoryOf(e.name) ?? undefined;
    const isSetHeader = !!e.isSetHeader && !!e.setName; // 세트명 있는 헤더만 세트 라벨(단품 제외)
    return { ...e, isSetHeader, category };
  });
}

// 총 보유 수량(충돌 판정용). 실제론 장비마스터 E열. 프로토타입 기본값.
export function stockOf(category?: string): number {
  switch (category as Category) {
    case "배터리·미디어":
    case "케이블·라인":
      return 12;
    case "소품·기타":
      return 8;
    case "암·클램프":
      return 6;
    default:
      return 2; // 바디/렌즈/세트/짐벌/조명/음향/모니터/삼각대
  }
}
