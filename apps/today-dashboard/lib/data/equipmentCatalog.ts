"use client";

import { useSyncExternalStore } from "react";
import { categoryOf, type CatalogItem, type Category } from "../domain/catalog";
import { gasFetch } from "./apiClient";

export interface EquipmentCatalogComponent {
  name: string;
  qty: number;
  alt?: string;
}

export interface EquipmentCatalogItem extends CatalogItem {
  components?: EquipmentCatalogComponent[];
  source: "sheet-master";
}

export interface EquipmentCatalogState {
  loading: boolean;
  ready: boolean;
  error: string | null;
  items: EquipmentCatalogItem[];
  names: string[];
  components: Record<string, EquipmentCatalogComponent[]>;
  /** 장비마스터 실재고 (장비명 → 수량) — 타임라인 재고충돌 판정용 */
  stocks: Record<string, number>;
}

interface RawCatalog {
  names?: unknown;
  components?: unknown;
  items?: unknown;
  stocks?: unknown;
}

const EMPTY_STATE: EquipmentCatalogState = {
  loading: false,
  ready: false,
  error: null,
  items: [],
  names: [],
  components: {},
  stocks: {},
};

let state = EMPTY_STATE;
let inflight: Promise<EquipmentCatalogState> | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((listener) => listener());
}

function normalizeName(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function searchKey(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function asComponents(value: unknown): Record<string, EquipmentCatalogComponent[]> {
  if (!value || typeof value !== "object") return {};
  const next: Record<string, EquipmentCatalogComponent[]> = {};
  Object.entries(value as Record<string, unknown>).forEach(([setName, rows]) => {
    if (!Array.isArray(rows)) return;
    const cleanSetName = normalizeName(setName);
    const components = rows
      .map((row) => {
        if (!row || typeof row !== "object") return null;
        const record = row as Record<string, unknown>;
        const name = normalizeName(record.name);
        if (!name) return null;
        const component: EquipmentCatalogComponent = {
          name,
          qty: Number(record.qty) > 0 ? Number(record.qty) : 1,
        };
        const alt = normalizeName(record.alt);
        if (alt) component.alt = alt;
        return component;
      })
      .filter((row): row is EquipmentCatalogComponent => !!row);
    if (cleanSetName && components.length > 0) next[cleanSetName] = components;
  });
  return next;
}

function inferCategory(name: string, isSet: boolean): Category {
  const known = categoryOf(name);
  if (known) return known;
  if (isSet) return "세트";
  if (/바디|카메라|FX\d|A7|A9|A1|R5|R6/i.test(name)) return "바디";
  if (/렌즈|mm|GM|탐론|시그마/i.test(name)) return "렌즈";
  if (/짐벌|로닌|RS\d|리그|이지리그/i.test(name)) return "짐벌·리그";
  if (/조명|라이트|LED|아푸처|아푸투어|아푸투레|난룩스|고독스|탱크|스카이패널/i.test(name)) return "조명";
  if (/마이크|오디오|믹서|젠하이저|로데|무선/i.test(name)) return "음향";
  if (/삼각대|스탠드|C스탠드|모노포드|그립|고보|실크/i.test(name)) return "삼각대·서포트";
  if (/모니터|스몰HD|아토모스/i.test(name)) return "모니터";
  if (/배터리|충전기|CFexpress|SD카드|메모리|미디어|NP-|V마운트/i.test(name)) return "배터리·미디어";
  if (/케이블|라인|BNC|SDI|HDMI|연장선/i.test(name)) return "케이블·라인";
  if (/암|클램프|매직암|슈퍼클램프|브라켓|어댑터/i.test(name)) return "암·클램프";
  return "소품·기타";
}

function buildItems(raw: RawCatalog): EquipmentCatalogState {
  const names = Array.isArray(raw.names)
    ? raw.names.map(normalizeName).filter(Boolean)
    : [];
  const components = asComponents(raw.components);
  const setNames = new Set(names);

  if (raw.items && typeof raw.items === "object") {
    Object.keys(raw.items as Record<string, unknown>).forEach((name) => {
      const clean = normalizeName(name);
      if (clean) setNames.add(clean);
    });
  }
  Object.keys(components).forEach((name) => {
    const clean = normalizeName(name);
    if (clean) setNames.add(clean);
  });

  const byName = new Map<string, EquipmentCatalogItem>();
  Array.from(setNames).forEach((name) => {
    const rowComponents = components[name] ?? [];
    byName.set(name, {
      name,
      category: inferCategory(name, true),
      components: rowComponents.length > 0 ? rowComponents : undefined,
      source: "sheet-master",
    });
  });

  Object.values(components).forEach((rows) => {
    rows.forEach((row) => {
      if (byName.has(row.name)) return;
      byName.set(row.name, {
        name: row.name,
        category: inferCategory(row.name, false),
        source: "sheet-master",
      });
    });
  });

  const items = Array.from(byName.values());
  const stocks: Record<string, number> = {};
  if (raw.stocks && typeof raw.stocks === "object") {
    Object.entries(raw.stocks as Record<string, unknown>).forEach(([name, qty]) => {
      const clean = normalizeName(name);
      const n = Number(qty);
      if (clean && Number.isFinite(n) && n > 0) stocks[clean] = n;
    });
  }
  return {
    loading: false,
    ready: true,
    error: null,
    items,
    names: Array.from(setNames),
    components,
    stocks,
  };
}

function readCatalogPayload(payload: unknown): RawCatalog {
  if (!payload || typeof payload !== "object") return {};
  const record = payload as Record<string, unknown>;
  const catalog = record.catalog && typeof record.catalog === "object" ? (record.catalog as Record<string, unknown>) : record;
  return {
    names: catalog.names,
    components: catalog.components,
    items: catalog.items,
    stocks: catalog.stocks,
  };
}

export async function loadEquipmentCatalog(): Promise<EquipmentCatalogState> {
  if (state.ready) return state;
  if (inflight) return inflight;

  state = { ...state, loading: true, error: null };
  emit();

  inflight = gasFetch("action=dashboardEquipmentCatalog")
    .then(async (response) => {
      if (!response.ok) throw new Error(`GAS ${response.status}`);
      const json = await response.json();
      state = buildItems(readCatalogPayload(json));
      emit();
      return state;
    })
    .catch((error) => {
      state = {
        ...EMPTY_STATE,
        ready: true,
        error: error instanceof Error ? error.message : String(error),
      };
      emit();
      return state;
    })
    .finally(() => {
      inflight = null;
    });

  return inflight;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  void loadEquipmentCatalog();
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  return state;
}

export function useEquipmentCatalog(): EquipmentCatalogState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function searchEquipmentCatalog(items: EquipmentCatalogItem[], q: string, limit = 7): EquipmentCatalogItem[] {
  const key = searchKey(q);
  if (!key) return items.slice(0, limit);
  return items.filter((item) => searchKey(item.name).includes(key)).slice(0, limit);
}

/** 장비마스터 실재고 조회 (카탈로그 로드 전이면 undefined → 호출부가 추정값 폴백) */
export function catalogStockOf(name: string): number | undefined {
  const clean = normalizeName(name);
  if (!clean) return undefined;
  return state.stocks[clean];
}
