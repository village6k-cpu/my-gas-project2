"use client";

import { useSyncExternalStore } from "react";
import { supabase } from "../supabase/client";

// 재고관리대장(village.equipment_ledger) 보유수량 조회 — 스케줄 화면 배지용.
// 세션당 1회 로드. 장비명/별칭을 정규화(trim·소문자·공백 축약)한 키로만 매칭하고,
// 확신 없는 매칭(이름 불일치·중복 키)은 아예 표시하지 않는다 — 틀린 숫자를 보여주지 않는 것이 원칙.
// 원장 테이블이 없거나(마이그레이션 전) 에러면 빈 조회표 → 배지 없이 조용히 동작.

export interface LedgerStock {
  stockTotal: number | null; // null = 미기록 (배지 표시 안 함)
  stockMaint: number;
}

interface StockState {
  ready: boolean;
  byName: Map<string, LedgerStock>;
}

const EMPTY_STATE: StockState = { ready: false, byName: new Map() };

let state = EMPTY_STATE;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

/** 배지 매칭용 정규화 — trim + 소문자 + 연속 공백 1칸 */
export function normalizeStockName(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function buildLookup(rows: any[]): Map<string, LedgerStock> {
  const map = new Map<string, LedgerStock>();
  const ambiguous = new Set<string>();
  const add = (rawName: unknown, info: LedgerStock) => {
    const key = normalizeStockName(rawName);
    if (!key) return;
    const cur = map.get(key);
    if (cur && (cur.stockTotal !== info.stockTotal || cur.stockMaint !== info.stockMaint)) {
      ambiguous.add(key); // 같은 이름이 서로 다른 수량을 가리킴 → 신뢰 불가
      return;
    }
    map.set(key, info);
  };
  for (const r of rows) {
    const info: LedgerStock = {
      stockTotal: r.stock_total ?? null,
      stockMaint: Number(r.stock_maint) || 0,
    };
    add(r.name, info);
    if (Array.isArray(r.aliases)) for (const a of r.aliases) add(a, info);
  }
  ambiguous.forEach((k) => map.delete(k));
  return map;
}

async function loadLedgerStocks(): Promise<void> {
  if (state.ready || inflight) return inflight ?? Promise.resolve();
  inflight = (async () => {
    if (!supabase) {
      state = { ready: true, byName: new Map() };
      emit();
      return;
    }
    try {
      const { data, error } = await supabase
        .from("equipment_ledger")
        .select("equipment_id,name,aliases,stock_total,stock_maint,state")
        .neq("state", "보관종료");
      if (error) throw error;
      state = { ready: true, byName: buildLookup(data ?? []) };
    } catch (e) {
      // 테이블 미생성(PGRST205/42P01) 포함 모든 에러 → 배지 없이 동작
      console.error("[equipmentStock] 원장 로드 실패", e);
      state = { ready: true, byName: new Map() };
    }
    emit();
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  void loadLedgerStocks();
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): StockState {
  return state;
}

/** 원장 보유수량 훅 — lookup(정규화 이름 → 수량). 미로드/에러/시드 모드면 빈 Map */
export function useLedgerStocks(): StockState {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** 확신 매칭만 반환 — 정확한 정규화 이름/별칭 일치 + 보유수량 기록이 있을 때만 */
export function ledgerStockFor(byName: Map<string, LedgerStock>, name: string): LedgerStock | null {
  const hit = byName.get(normalizeStockName(name));
  return hit && hit.stockTotal != null ? hit : null;
}
