import type { EquipmentItem, ReturnCount, Trade } from "./types";

// 용도와 실물 종류는 별개다. 이 목록은 확인된 규격만 합산한다.
// 단자 수만 같은 케이블을 호환품으로 추정하지 않는다.
export const PACKING_PARTS = [
  { id: "smallhd-9v", name: "스몰HD용 D탭 라인 (9V)" },
  { id: "teradek-2pin", name: "테라덱용 D탭 라인 (2핀)" },
  { id: "nucleus-m-7pin", name: "뉴클-M 모터용 D탭 라인 (7핀)" },
  { id: "CBL-003", name: "SDI 연선" },
] as const;

export interface PackingEntry {
  id: string;
  device: string;
  name: string;
  partId: string; // 확인된 공용 규격 ID 또는 해당 줄만의 private ID
  qty: number;
  checked: boolean;
  sourceId?: string;
}
export interface PackingManifest {
  version: number;
  phase: "draft" | "sealed";
  sources: { id: string; name: string; qty: number }[];
  entries: PackingEntry[];
  counts: Record<string, ReturnCount>;
  note: string;
  sealedAt?: string;
}
export type PackingCommand =
  | { action: "start" }
  | { action: "save"; entries: PackingEntry[]; note: string }
  | { action: "seal" }
  | { action: "revise" }
  | { action: "refresh" }
  | { action: "receive"; partId: string; count: ReturnCount };

const ACCESSORY = /라인|케이블|[dDＤｄ][\s-]*탭|디탭|SDI|HDMI|노가암|숏암|클램프|더미|기어링|플레이트|그립/i;
const CHOICE = /(?:\bor\b|또는|택\s*1|SDI\s*\/\s*HDMI|HDMI\s*\/\s*SDI)/i;
export function packingCandidates(t: Trade): EquipmentItem[] {
  return t.equipments.filter(e => e.isComponent && !e.isSetHeader && e.checkoutState !== "excluded" && !e.synthetic && ACCESSORY.test(e.name));
}
export function packingStarted(t: Trade): boolean {
  return !!t.packingDispatchedAt || t.setupDone || t.returnDone || t.contractStatus !== "예약" || t.equipments.some(e => (e.takenQty ?? 0) > 0);
}
export function packingSourceIds(p?: PackingManifest | null): Set<string> {
  return new Set(p?.sources.map(s => s.id) ?? []);
}
export function packingGroups(p?: PackingManifest | null) {
  const groups = new Map<string, { id: string; name: string; expected: number; entries: PackingEntry[]; count: ReturnCount }>();
  for (const e of p?.entries ?? []) {
    if (!e.qty) continue;
    let group = groups.get(e.partId);
    if (!group) {
      group = { id: e.partId, name: e.name, expected: 0, entries: [], count: p?.counts[e.partId] ?? { good: 0, damaged: 0, lost: 0 } };
      groups.set(e.partId, group);
    }
    group.expected += e.qty;
    group.entries.push(e);
  }
  return [...groups.values()];
}
export function packingBlockers(p?: PackingManifest | null) {
  return packingGroups(p).flatMap(g => {
    const accounted = g.count.good + g.count.damaged + g.count.lost;
    return accounted === g.expected ? [] : [{ scheduleId: `packing:${g.id}`, name: g.name, expected: g.expected, accounted, missing: Math.max(0, g.expected - accounted), over: Math.max(0, accounted - g.expected) }];
  });
}
function initialEntry(e: EquipmentItem): PackingEntry {
  const sdi = ["SDI 연선", "스몰HD용 SDI 연선", "테라덱용 SDI 연선", "여분 SDI 연선"].includes(e.name.trim());
  const known = PACKING_PARTS.find(p => p.name === e.name.trim());
  return {
    id: e.scheduleId, sourceId: e.scheduleId,
    device: e.name.includes("용 ") ? e.name.split("용 ")[0] : e.setName || "추가 구성품",
    name: sdi ? "SDI 연선" : e.name,
    partId: sdi ? "CBL-003" : known?.id ?? `private:${e.scheduleId}`,
    qty: e.qty, checked: false,
  };
}
function validText(value: unknown, label: string, max = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label}을 확인해주세요`);
  return value.trim();
}
export function transitionPacking(t: Trade, command: PackingCommand, now: string): PackingManifest {
  const prev = t.packing;
  if (t.returnDone || t.contractStatus === "반납완료" || t.contractStatus === "취소") throw new Error("마감·취소 거래의 구성품은 수정할 수 없습니다");
  if (command.action === "start") {
    if (prev || packingStarted(t)) throw new Error("이미 반출을 시작한 거래는 기존 검수 내역을 사용해주세요");
    const candidates = packingCandidates(t);
    if (!candidates.length) throw new Error("준비할 세트 구성품이 없습니다");
    return { version: 1, phase: "draft", sources: candidates.map(e => ({ id: e.scheduleId, name: e.name, qty: e.qty })), entries: candidates.map(initialEntry), counts: {}, note: "" };
  }
  if (!prev) throw new Error("구성품 준비를 먼저 시작해주세요");
  const next = structuredClone(prev);
  next.version += 1;
  if (command.action === "receive") {
    if (prev.phase !== "sealed") throw new Error("반출 구성품을 먼저 확정해주세요");
    const group = packingGroups(prev).find(g => g.id === command.partId);
    if (!group) throw new Error("반출 내역에 없는 품목입니다");
    const c = command.count;
    if (!c || ![c.good, c.damaged, c.lost].every(n => Number.isSafeInteger(n) && n >= 0) || c.good + c.damaged + c.lost > group.expected) throw new Error("반납 수량은 반출 수량을 초과할 수 없습니다");
    const memo = String(c.memo ?? "").trim();
    if (memo.length > 1000 || ((c.damaged > 0 || c.lost > 0) && !memo)) throw new Error("파손·분실 사유를 메모해주세요");
    next.counts[command.partId] = { good: c.good, damaged: c.damaged, lost: c.lost, memo };
    return next;
  }
  if (packingStarted(t)) throw new Error("반출을 시작한 구성품은 변경할 수 없습니다. 추가 반출은 현장 항목 추가로 기록해주세요");
  if (command.action === "revise") {
    if (Object.keys(prev.counts).length) throw new Error("반납 기록이 있어 준비 상태로 되돌릴 수 없습니다");
    next.phase = "draft";
    next.entries.forEach(e => { e.checked = false; });
    delete next.sealedAt;
    return next;
  }
  if (prev.phase !== "draft") throw new Error("구성 다시 준비를 누른 뒤 변경해주세요");
  if (command.action === "refresh") {
    const candidates = packingCandidates(t);
    const byId = new Map(candidates.map(e => [e.scheduleId, e]));
    const fresh = (e: EquipmentItem) => {
      const entry = initialEntry(e);
      if (entry.partId.startsWith("private:") && prev.entries.some(old => old.partId === entry.partId && old.name !== entry.name)) entry.partId += `:v${next.version}`;
      return entry;
    };
    next.entries = prev.entries.map(e => {
      if (!e.sourceId) return e;
      const current = byId.get(e.sourceId);
      const original = prev.sources.find(s => s.id === e.sourceId);
      if (!current) return { ...e, sourceId: undefined, qty: 0, checked: false };
      return current.name === original?.name && current.qty === original?.qty ? e : fresh(current);
    });
    for (const e of candidates) if (!next.entries.some(row => row.sourceId === e.scheduleId)) {
      const existing = next.entries.findIndex(row => row.id === e.scheduleId);
      if (existing >= 0) next.entries[existing] = fresh(e);
      else next.entries.push(fresh(e));
    }
    next.sources = candidates.map(e => ({ id: e.scheduleId, name: e.name, qty: e.qty }));
    return next;
  }
  if (command.action === "save") {
    if (!Array.isArray(command.entries) || !command.entries.length || command.entries.length > 200) throw new Error("구성품은 1~200줄로 입력해주세요");
    const seen = new Set<string>();
    next.entries = command.entries.map(raw => {
      const id = validText(raw.id, "구성품 ID");
      if (!/^[\w:-]+$/.test(id) || seen.has(id)) throw new Error("구성품 ID가 중복되거나 올바르지 않습니다");
      seen.add(id);
      if (!Number.isSafeInteger(raw.qty) || raw.qty < 0 || raw.qty > 99) throw new Error("수량은 0~99개로 입력해주세요");
      const part = PACKING_PARTS.find(p => p.id === raw.partId);
      const shared = prev.entries.find(e => e.partId === raw.partId && e.name === raw.name);
      const name = part ? part.name : validText(raw.name, "구성품 이름");
      const old = prev.entries.find(e => e.id === id);
      const sourceId = old?.sourceId; // 클라이언트가 예약 원본 연결을 바꿀 수 없다.
      const entry = { id, sourceId, device: validText(raw.device, "사용 장비"), name, partId: part?.id ?? shared?.partId ?? `private:${id}:v${next.version}`, qty: raw.qty, checked: raw.checked === true };
      if (entry.qty > 0 && entry.checked && CHOICE.test(name)) throw new Error("SDI/HDMI 등 선택 항목은 실제 종류로 교체한 뒤 확인해주세요");
      if (old && (old.name !== entry.name || old.qty !== entry.qty || old.device !== entry.device || old.partId !== entry.partId)) entry.checked = false;
      return entry;
    });
    // 원본 줄은 삭제 대신 0개(제외)로 남겨 누락과 의도적 제외를 구분한다.
    if (prev.entries.some(e => e.sourceId && !seen.has(e.id))) throw new Error("기본 구성품은 삭제 대신 제외(0개)로 기록해주세요");
    next.note = String(command.note ?? "").trim();
    if (next.note.length > 2000) throw new Error("메모는 2000자까지 입력해주세요");
    return next;
  }
  if (command.action !== "seal") throw new Error("지원하지 않는 구성품 작업입니다");
  for (const s of prev.sources) {
    const current = t.equipments.find(e => e.scheduleId === s.id);
    if (!current || current.checkoutState === "excluded" || current.name !== s.name || current.qty !== s.qty) throw new Error("예약 구성품이 변경되었습니다. 원본과 준비 목록을 확인해주세요");
  }
  if (next.entries.some(e => !e.checked || (e.qty > 0 && CHOICE.test(e.name)))) throw new Error("각 구성품의 실제 종류·수량과 제외 여부를 확인해주세요");
  next.phase = "sealed";
  next.sealedAt = now;
  return next;
}
