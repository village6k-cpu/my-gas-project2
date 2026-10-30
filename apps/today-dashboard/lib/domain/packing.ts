import type { EquipmentItem, ReturnCount, Trade } from "./types";

import { PACKING_PARTS, ACCESSORY, CHOICE, MONITOR_MODELS, canonicalPart, registeredPart, partKey, templateFor } from "./packingCatalog";
export { PACKING_PARTS, MONITOR_MODELS } from "./packingCatalog";

export interface PackingEntry {
  id: string;
  device: string;
  name: string;
  partId: string; // 확인된 공용 규격 ID 또는 해당 줄만의 private ID
  qty: number;
  checked: boolean;
  sourceId?: string;
  ownerId?: string;
  unresolved?: boolean;
  modelDefault?: boolean;
  custom?: boolean; // 이 예약의 해당 행에서만 집계하는 직접 입력 품목
}
export interface PackingManifest {
  version: number;
  schemaVersion?: 2;
  deviceModels?: Record<string, string>;
  phase: "draft" | "sealed";
  sources: { id: string; name: string; qty: number; device?: boolean }[];
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
  | { action: "model"; ownerId: string; model: string }
  | { action: "receive"; partId: string; count: ReturnCount };

/** 제외(0개)는 이미 의사결정이 끝난 품목이므로 준비 체크를 요구하지 않는다. */
export function packingEntryNeedsPreparation(e: PackingEntry): boolean {
  return e.qty > 0 && (!e.checked || !!e.unresolved || CHOICE.test(e.name));
}

/** 운영자 지정 필수 동봉품: 준비 중 누락·제외로 사라져도 확정 전에 검증한다. */
export function packingRequiredIssues(t: Trade): string[] {
  return packingDevices(t).filter(owner => /^아마란 F2[12]C$/i.test(owner.name)).flatMap(owner => {
    const part = registeredPart(`${owner.name}용 ㄱ자 클램프`);
    const rows = t.packing?.entries.filter(e => e.ownerId === owner.scheduleId && e.partId === part?.id) ?? [];
    const quantity = rows.reduce((n, e) => n + e.qty, 0);
    return quantity < owner.qty ? [`${owner.name}: ㄱ자 클램프 ${owner.qty}개 필수 (현재 ${quantity}개)`] : [];
  });
}

/** 준비 목록의 예약 스냅샷과 현재 유효 장비를 비교한다. 확정된 반출 기록은 재작성하지 않는다. */
export function packingReservationChanges(t: Trade): string[] {
  const p=t.packing;
  if (!p || p.phase !== "draft") return [];
  const current=[...packingCandidates(t), ...packingDevices(t)];
  const changes: string[]=[];
  for (const source of p.sources) {
    const row=current.find(e=>e.scheduleId===source.id);
    if (!row) changes.push(`${source.name} 제외됨`);
    else if (row.name!==source.name || row.qty!==source.qty) changes.push(`${source.name} 변경됨`);
  }
  for (const row of current) if (!p.sources.some(s=>s.id===row.scheduleId)) changes.push(`${row.name} 추가됨`);
  return changes;
}

/** 체크만 바꾼 요청은 화면에 먼저 반영한다. 구성 변경·확정은 서버 응답을 기다린다. */
export function optimisticPackingCheck(t: Trade, version: number, command: PackingCommand): PackingManifest | undefined {
  const p=t.packing;
  if (!p || p.version!==version || p.phase!=="draft" || command.action!=="save" || command.note!==p.note || command.entries.length!==p.entries.length) return;
  const withoutCheck=(e: PackingEntry)=>JSON.stringify({...e,checked:false});
  if (!command.entries.every((e,i)=>typeof e.checked==="boolean" && withoutCheck(e)===withoutCheck(p.entries[i]))) return;
  return transitionPacking(t,command,new Date().toISOString());
}

function componentTokens(name: string) {
  return name.replace(/SDI\s*\/\s*HDMI/gi, "SDI or HDMI").split(/\s*,\s*|\s+\/\s+/);
}
function componentMatches(setName: string, label: string) {
  const template = templateFor(setName);
  const choices = /^(SDI|HDMI)$/i.test(label) ? template.map(r => ({...r, name: r.name.replace(/SDI\s*(?:or|\/)\s*HDMI/i, label.toUpperCase())})) : template;
  return choices.filter(r => partKey(r.name) === partKey(label) || partKey(r.name).endsWith("용" + partKey(label)));
}
export function packingCandidates(t: Trade): EquipmentItem[] {
  return t.equipments.filter(e => e.isComponent && !e.isSetHeader && e.checkoutState !== "excluded" && !e.synthetic &&
    (ACCESSORY.test(e.name) || e.name.includes("용 ") || componentTokens(e.name).some(token =>
      componentMatches(e.setName ?? "", token.replace(/\s*[*×]\s*\d+\s*$/, "").trim()).some(r => ACCESSORY.test(r.name) || r.name.includes("용 ")))));
}
export function packingDevices(t: Trade) {
  const managed = new Set(packingCandidates(t).map(e => e.scheduleId));
  return t.equipments.filter(e => !managed.has(e.scheduleId) && e.checkoutState !== "excluded" && !e.synthetic)
    .map(e => ({...e, name: String(e.actualName || e.name).trim()}));
}
export function needsDeviceModel(e: EquipmentItem) { return e.name === "7인치 모니터"; }
export function packingAvailable(t: Trade) { return packingCandidates(t).length > 0 || packingDevices(t).some(e => needsDeviceModel(e) || templateFor(e.name).some(r => ACCESSORY.test(r.name))); }
export function packingStarted(t: Trade): boolean {
  return !!t.packingDispatchedAt || t.setupDone || t.returnDone || t.contractStatus !== "예약" || t.equipments.some(e => (e.takenQty ?? 0) > 0);
}
export function packingSourceIds(p?: PackingManifest | null): Set<string> {
  return new Set(p?.sources.filter(s=>!s.device).map(s => s.id) ?? []);
}
export function packingGroups(p?: PackingManifest | null) {
  const groups = new Map<string, { id: string; name: string; expected: number; entries: PackingEntry[]; count: ReturnCount }>();
  for (const e of p?.entries ?? []) {
    if (!e.qty || e.unresolved) continue;
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
function defaultOwner(t: Trade, source: EquipmentItem, name: string): EquipmentItem | undefined {
  const devices = packingDevices(t).filter(e => e.setName === source.setName);
  const monitors = devices.filter(e => needsDeviceModel(e) || /스몰HD|포트키|(?:티비로직|TVLogic).*?(?:F-?7|074|7인치)/i.test(e.name));
  if ((name === "노가암" || /스몰HD용/.test(name)) && monitors.length === 1) return monitors[0];
  // 운영자 확인: 카메라 풀세트는 일반 SDI→7인치, 롱라인→LVM의 공통 구성.
  if (/(풀세트|베이직세트)/.test(source.setName ?? "")) {
    if (/용 SDI 라인$/.test(name) && monitors.length === 1) return monitors[0];
    const lvms=devices.filter(e=>/LVM-|(?:TVLogic|티비로직)\s*17인치/i.test(e.name));
    if (/용 SDI 롱라인$/.test(name) && lvms.length === 1) return lvms[0];
  }
  const target = name.includes("용 ") ? name.split("용 ")[0] : "";
  const matched = target ? devices.filter(e => partKey(e.name).includes(partKey(target))) : [];
  if (matched.length === 1) return matched[0];
  return devices.find(e => e.isSetHeader) ?? devices[0];
}
function initialEntries(t: Trade, e: EquipmentItem): PackingEntry[] {
  // 이전 예약 묶음의 수량은 명시값 또는 확인된 마스터 대응 행으로만 분리한다.
  const tokens = componentTokens(e.name);
  const bundled = tokens.length > 1;
  // 과거 FX9/PYXIS 묶음의 '4'는 세트 개수가 아니다. 확인된 기본 묶음만 세트 수로 환산한다.
  const cameraBundle = /풀세트/.test(e.setName ?? "") && tokens.length === 3 &&
    tokens.every((v,i)=>v === ["SDI 롱라인","SDI 라인","노가암"][i]);
  const headers = cameraBundle ? t.equipments.filter(h=>h.isSetHeader && h.name===e.setName && h.checkoutState!=="excluded") : [];
  const multiplier = cameraBundle ? (headers.length===1 ? headers[0].qty : null) : e.qty;
  return tokens.map((token,index) => {
    const match = token.match(/^(.*?)\s*[*×]\s*(\d+)\s*$/);
    const label = (match?.[1] ?? token).trim();
    const matches = componentMatches(e.setName ?? "", label);
    const master = matches.length === 1 ? matches[0] : undefined;
    const name = master?.name ?? label;
    const quantity = match ? Number(match[2]) : bundled ? master?.qty : 1;
    const part = registeredPart(name);
    const owner = defaultOwner(t,e,name);
    const unresolved = !part || quantity == null || multiplier == null || CHOICE.test(name);
    return { id: bundled ? `${e.scheduleId}:${index}` : e.scheduleId, sourceId: e.scheduleId,
      ownerId: owner?.scheduleId, device: owner?.name ?? e.setName ?? "공용 구성품",
      name: part?.name ?? name, partId: part?.id ?? `unresolved:${e.scheduleId}:${index}`,
      qty: (quantity ?? 1) * (multiplier ?? 1), checked: false, unresolved };
  });
}
export function unassignedVideo(t: Trade, p: PackingManifest, ownerId: string): PackingEntry[] {
  const owner=packingDevices(t).find(e=>e.scheduleId===ownerId);
  if (!owner) return [];
  return p.entries.filter(e=>e.qty>0 && /SDI|HDMI/i.test(e.name) && e.sourceId &&
    t.equipments.find(s=>s.scheduleId===e.sourceId)?.setName===owner.setName &&
    (!e.ownerId || packingDevices(t).some(d=>d.scheduleId===e.ownerId && /세트|셋트|패키지/.test(d.name))));
}
function addDeviceDefaults(t: Trade, p: PackingManifest, owner: EquipmentItem, model: string) {
  const rows = templateFor(model).filter(r => ACCESSORY.test(r.name) || r.name.includes("용 "));
  rows.forEach((row,index) => {
    if (p.entries.some(e=>e.id===`default:${owner.scheduleId}:${index}`)) return;
    const part = registeredPart(row.name);
    if (t.equipments.some(e=>e.setName===owner.setName && e.checkoutState==="excluded" && (partKey(e.name)===partKey(row.name) || (part && registeredPart(e.name)?.id===part.id)))) return;
    // 기존에 이미 배분된 선·암을 다시 만들지 않는다. 미결 SDI/HDMI도 기존 영상선이 있으면 대체한다.
    const existing = p.entries.filter(e => e.ownerId === owner.scheduleId && e.qty > 0);
    const hasVideo = /SDI|HDMI/i.test(row.name) && (existing.some(e => /SDI|HDMI/i.test(e.name)) || unassignedVideo(t,p,owner.scheduleId).length>0);
    if (hasVideo || existing.some(e => e.partId === part?.id || e.name === row.name)) return;
    p.entries.push({ id: `default:${owner.scheduleId}:${index}`, ownerId: owner.scheduleId, device: model,
      name: part?.name ?? row.name, partId: part?.id ?? `unresolved:${owner.scheduleId}:${index}`,
      qty: row.qty * owner.qty, checked: false, unresolved: !part || CHOICE.test(row.name), modelDefault: true });
  });
}
function initialManifest(t: Trade, version: number, note = ""): PackingManifest {
  const candidates = packingCandidates(t);
  const p: PackingManifest = { schemaVersion: 2, deviceModels: {}, version, phase: "draft",
    sources: [...candidates.map(e => ({ id:e.scheduleId,name:e.name,qty:e.qty })), ...packingDevices(t).map(e=>({id:e.scheduleId,name:e.name,qty:e.qty,device:true}))], entries:candidates.flatMap(e => initialEntries(t,e)), counts:{}, note };
  for (const owner of packingDevices(t)) if (!needsDeviceModel(owner) && !/세트|셋트|패키지/.test(owner.name)) addDeviceDefaults(t,p,owner,owner.name);
  return p;
}
export function packingNeedsUpgrade(p?: PackingManifest) { return !!p && p.phase === "draft" && p.schemaVersion !== 2; }
function validText(value: unknown, label: string, max = 160): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label}을 확인해주세요`);
  return value.trim();
}
export function transitionPacking(t: Trade, command: PackingCommand, now: string): PackingManifest {
  const prev = t.packing;
  if (t.returnDone || t.contractStatus === "반납완료" || t.contractStatus === "취소") throw new Error("마감·취소 거래의 구성품은 수정할 수 없습니다");
  if (command.action === "start") {
    if (prev || packingStarted(t)) throw new Error("이미 반출을 시작한 거래는 기존 검수 내역을 사용해주세요");
    if (!packingAvailable(t)) throw new Error("준비할 세트 구성품이 없습니다");
    return initialManifest(t, 1);
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
    const fresh = initialManifest(t,next.version,prev.note);
    // 첫 버전의 묶음/자유입력을 표준 목록으로 바꿀 때 변경분은 무단 폐기하지 않는다.
    if (prev.schemaVersion !== 2) {
      const changed = prev.entries.filter(e => !e.sourceId || !prev.sources.some(s => s.id === e.sourceId && s.name === e.name && s.qty === e.qty));
      if (changed.length) throw new Error("기존 직접 변경 내역이 있습니다. 구성품 정리 전 담당자 확인이 필요합니다");
      return fresh;
    }
    fresh.deviceModels = { ...prev.deviceModels };
    const absorbedDefaults = new Set<string>();
    fresh.entries = fresh.entries.map(e => {
      const old=prev.entries.find(x=>x.id===e.id);
      const before=prev.sources.find(x=>x.id===e.sourceId), after=fresh.sources.find(x=>x.id===e.sourceId);
      if (old?.modelDefault && old.ownerId===e.ownerId) {
        const priorOwner=prev.sources.find(s=>s.device && s.id===old.ownerId);
        const nextOwner=fresh.sources.find(s=>s.device && s.id===e.ownerId);
        if (priorOwner && nextOwner && priorOwner.name===nextOwner.name && priorOwner.qty===nextOwner.qty) return old;
      }
      // 기존 묶음을 새로 인식하면 자동 생성했던 동일 구성품을 원본 행에 연결한다.
      // 직원의 확인/교체/수량 변경은 옮겨 담고, 자동 행을 다시 더하지 않는다.
      if (!old && before?.device && after && before.name===after.name && before.qty===after.qty) {
        const owner=packingDevices(t).find(d=>d.scheduleId===e.ownerId);
        const defaults=templateFor(prev.deviceModels?.[e.ownerId ?? ""] ?? owner?.name ?? "").filter(r=>ACCESSORY.test(r.name)||r.name.includes("용 "));
        const matching=defaults.flatMap((r,i)=>canonicalPart(r.name).id===e.partId ? [i] : []);
        const prior=matching.length===1 ? prev.entries.find(x=>x.modelDefault && !x.sourceId && x.id===`default:${e.ownerId}:${matching[0]}` && x.ownerId===e.ownerId && !absorbedDefaults.has(x.id)) : undefined;
        if (prior) {
          absorbedDefaults.add(prior.id);
          return {...prior,id:e.id,sourceId:e.sourceId,modelDefault:undefined};
        }
      }
      const legacyOvercount = old && before && !old.checked && before.name === "SDI 롱라인, SDI 라인, 노가암" &&
        old.partId === e.partId && old.qty === before.qty && old.qty !== e.qty;
      return old && before && after && before.name===after.name &&
        !legacyOvercount && (before.qty===after.qty || (old.partId===e.partId && old.qty===e.qty && old.ownerId===e.ownerId)) ? old : e;
    });
    for (const e of prev.entries) if (!absorbedDefaults.has(e.id) && !fresh.entries.some(x=>x.id===e.id)) {
      if (!e.sourceId && (!e.ownerId || packingDevices(t).some(d=>d.scheduleId===e.ownerId))) fresh.entries.push(e);
      else if (e.sourceId) fresh.entries.push({...e,qty:0,checked:false});
    }
    for (const [id,model] of Object.entries(fresh.deviceModels)) {
      const owner=packingDevices(t).find(e=>e.scheduleId===id);
      if (owner) { fresh.entries.filter(e=>e.ownerId===id).forEach(e=>{e.device=model;}); addDeviceDefaults(t,fresh,owner,model); }
      else delete fresh.deviceModels[id];
    }
    return fresh;
  }
  if (prev.schemaVersion !== 2) throw new Error("구성품 목록 업데이트를 먼저 눌러주세요");
  if (command.action === "model") {
    const owner=packingDevices(t).find(e=>e.scheduleId===command.ownerId && needsDeviceModel(e));
    if (!owner || !MONITOR_MODELS.includes(command.model)) throw new Error("등록된 실제 모니터 모델을 선택해주세요");
    if (prev.deviceModels?.[owner.scheduleId] === command.model) return next;
    if (next.entries.some(e=>e.ownerId===owner.scheduleId && !e.sourceId && !e.modelDefault)) throw new Error("직접 추가한 구성품을 확인한 뒤 모델을 변경해주세요");
    next.entries=next.entries.filter(e=>e.ownerId!==owner.scheduleId || !e.modelDefault);
    next.entries.filter(e=>e.ownerId===owner.scheduleId).forEach(e=>{e.device=command.model;e.checked=false;});
    next.deviceModels={...prev.deviceModels,[owner.scheduleId]:command.model};
    addDeviceDefaults(t,next,owner,command.model);
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
      const direct = raw.custom === true;
      const directName = direct ? validText(raw.name, "구성품 이름", 100) : "";
      if (direct && raw.partId !== `custom:${id}`) throw new Error("직접 입력 구성품 ID를 확인해주세요");
      if (direct && CHOICE.test(directName)) throw new Error("실제로 나가는 구성품 한 종류를 입력해주세요");
      const part = direct ? registeredPart(directName) : PACKING_PARTS.find(p => p.id === raw.partId);
      const old = prev.entries.find(e => e.id === id);
      const unchangedUnresolved = old?.unresolved && raw.partId === old.partId && raw.name === old.name;
      if (!part && !direct && !unchangedUnresolved) throw new Error("등록된 구성품을 선택해주세요. 이름 직접 입력은 합산할 수 없습니다");
      const ownerId = raw.ownerId ?? old?.ownerId;
      const owner = packingDevices(t).find(e=>e.scheduleId===ownerId);
      if (ownerId && !owner && !(raw.qty === 0 && old?.ownerId === ownerId)) throw new Error("사용 장비가 예약에서 변경되었습니다. 목록을 업데이트해주세요");
      const name = part?.name ?? (direct ? directName : old!.name);
      const device = owner ? prev.deviceModels?.[owner.scheduleId] ?? owner.name : old?.device ?? validText(raw.device,"사용 장비");
      const entry: PackingEntry = { id, sourceId: old?.sourceId, ownerId, device, name,
        partId: part?.id ?? (direct ? `custom:${id}` : old!.partId), qty: raw.qty, checked: raw.checked === true,
        unresolved: !part && !direct, modelDefault: old?.modelDefault, ...(direct && !part ? {custom:true} : {}) };
      if (entry.qty > 0 && entry.checked && entry.unresolved) throw new Error("등록된 실제 종류를 선택한 뒤 확인해주세요");
      if (old && (old.name !== entry.name || old.qty !== entry.qty || old.device !== entry.device || old.partId !== entry.partId || old.ownerId !== entry.ownerId)) entry.checked = false;
      return entry;
    });
    // 원본 줄은 삭제 대신 0개(제외)로 남겨 누락과 의도적 제외를 구분한다.
    if (prev.entries.some(e => e.sourceId && !seen.has(e.id))) throw new Error("기본 구성품은 삭제 대신 제외(0개)로 기록해주세요");
    next.note = String(command.note ?? "").trim();
    if (next.note.length > 2000) throw new Error("메모는 2000자까지 입력해주세요");
    return next;
  }
  if (command.action !== "seal") throw new Error("지원하지 않는 구성품 작업입니다");
  for (const e of next.entries) if (e.qty > 0 && e.ownerId && !packingDevices(t).some(owner=>owner.scheduleId===e.ownerId)) throw new Error("사용 장비가 변경되었습니다. 목록을 업데이트해주세요");
  if (packingCandidates(t).some(e=>!prev.sources.some(s=>s.id===e.scheduleId))) throw new Error("예약 구성품이 추가되었습니다. 목록을 업데이트해주세요");
  for (const s of prev.sources) {
    const current = (s.device ? packingDevices(t) : t.equipments).find(e => e.scheduleId === s.id);
    if (!current || current.checkoutState === "excluded" || current.name !== s.name || current.qty !== s.qty) throw new Error("예약 구성품이 변경되었습니다. 원본과 준비 목록을 확인해주세요");
  }
  for (const owner of packingDevices(t)) {
    if (needsDeviceModel(owner) && !prev.deviceModels?.[owner.scheduleId]) throw new Error("7인치 모니터의 실제 모델을 선택해주세요");
    const model=prev.deviceModels?.[owner.scheduleId] ?? owner.name;
    if (templateFor(model).some(r=>/SDI|HDMI/i.test(r.name)) && unassignedVideo(t,prev,owner.scheduleId).length>0 && !prev.entries.some(e=>e.ownerId===owner.scheduleId && /SDI|HDMI/i.test(e.name))) throw new Error("기존 영상선을 사용할 장비에 연결해주세요. 새 선을 중복 추가하지 않습니다");
  }
  const requiredIssues = packingRequiredIssues({...t, packing: next});
  if (requiredIssues.length) throw new Error(requiredIssues.join(" / "));
  if (next.entries.some(packingEntryNeedsPreparation)) throw new Error("각 구성품의 실제 종류·수량과 제외 여부를 확인해주세요");
  next.phase = "sealed";
  next.sealedAt = now;
  return next;
}
