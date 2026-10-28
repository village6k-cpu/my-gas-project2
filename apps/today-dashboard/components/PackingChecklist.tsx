"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { Phase, ReturnCount, Trade } from "@/lib/domain/types";
import { PACKING_PARTS, MONITOR_MODELS, packingAvailable, packingDevices, unassignedVideo, needsDeviceModel, packingNeedsUpgrade, packingGroups, packingStarted, type PackingCommand, type PackingEntry } from "@/lib/domain/packing";
import { templateFor } from "@/lib/domain/packingCatalog";
import { savePacking } from "@/lib/data/store";

type PackingContextValue = { trade: Trade; busy: boolean; update: (e: PackingEntry, patch: Partial<PackingEntry>) => Promise<boolean>; open: (e: PackingEntry) => void; run: (command: PackingCommand, version?: number) => Promise<boolean> };
const PackingContext = createContext<PackingContextValue | null>(null);
const button = "tap rounded-lg px-3 py-2 text-sm font-bold ring-1 ring-line disabled:opacity-40";

export function PackingChecklist({ trade, phase, onCommand, children }: { trade: Trade; phase: Phase; onCommand?: (version: number, command: PackingCommand) => Promise<void>; children?: ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<PackingEntry | null>(null);
  const [editingVersion, setEditingVersion] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const [noteVersion, setNoteVersion] = useState(0);
  const p = trade.packing;
  const run = async (command: PackingCommand, version = p?.version ?? 0) => {
    if (busy) return false;
    setBusy(true); setError("");
    try { if (onCommand) await onCommand(version, command); else await savePacking(trade.tradeId, version, command); return true; }
    catch (e) { setError(e instanceof Error ? e.message : "저장 실패. 다시 확인해주세요"); return false; }
    finally { setBusy(false); }
  };
  const save = (entries: PackingEntry[], version = p?.version ?? 0) => run({ action: "save", entries, note: p?.note ?? "" }, version);
  const openEditor = (entry: PackingEntry) => { setEditing(entry); setEditingVersion(p?.version ?? 0); };
  const update = (e: PackingEntry, patch: Partial<PackingEntry>) => save(p!.entries.map(row => row.id === e.id ? { ...row, ...patch } : row));
  if (!p && (phase === "checkin" || packingStarted(trade) || !packingAvailable(trade))) return <>{children}</>;
  const groups = packingGroups(p);
  const unresolvedQty = p?.entries.filter(e=>e.unresolved).reduce((n,e)=>n+e.qty,0) ?? 0;
  const total = groups.reduce((n, g) => n + g.expected, 0);
  const missing = groups.reduce((n, g) => n + g.expected - g.count.good - g.count.damaged - g.count.lost, 0);
  const devices = packingDevices(trade);
  const context = { trade, busy, update, open: openEditor, run };
  return <PackingContext.Provider value={context}><section aria-label="구성품 검수" className="mb-3">
    <div className="flex flex-wrap items-center justify-between gap-2 bg-brand-50 px-3 py-3">
      <div><h3 className="text-sm font-extrabold text-brand-700">구성품 검수</h3>
        <p className="mt-1 text-xs text-ink-mute">{p ? `${p.phase === "sealed" ? "확정된 반출" : "반출 준비"} · ${total}개${unresolvedQty ? ` · 종류 미선택 ${unresolvedQty}개` : ""}${phase === "checkin" ? ` · 미반납 ${missing}개` : ""}` : "실제 챙기는 종류와 개수를 장비별로 기록합니다."}</p></div>
      {!p && <button className={`${button} bg-brand-600 text-white`} disabled={busy} onClick={() => run({ action: "start" })}>구성품 준비 시작</button>}
    </div>
    <div aria-live="polite">{error && <p role="alert" className="m-3 rounded-lg bg-attention-bg p-2 text-sm font-bold text-attention-fg">{error}</p>}</div>
    {!p && children}
    {p && <fieldset disabled={busy} className="min-w-0 disabled:opacity-60">
      {phase === "checkout" ? <>
        {packingNeedsUpgrade(p) ? <div className="my-3 rounded-lg bg-warn-bg p-3 text-sm"><p>이전 묶음 목록을 장비별 표준 구성품으로 업데이트해야 합니다.</p><button className={`${button} mt-2 bg-white`} onClick={() => run({ action: "refresh" })}>구성품 목록 업데이트</button></div> : null}
        {children ?? devices.map(device => <div key={device.scheduleId} className="my-3 rounded-xl border border-line p-3"><h4 className="font-extrabold">{p.deviceModels?.[device.scheduleId] ?? device.name}</h4><PackingDevice ownerId={device.scheduleId} /></div>)}
        {p.entries.some(e => !e.ownerId) && !packingNeedsUpgrade(p) && <PackingDevice />}
        <details className="m-3 rounded-lg bg-paper p-3"><summary className="cursor-pointer text-sm font-bold">실물별 총수량 · {total}개{unresolvedQty > 0 ? ` + 종류 미선택 ${unresolvedQty}개` : ""}</summary>
          {groups.map(g => <div key={g.id} className="mt-2 text-sm"><strong>{g.name} ×{g.expected}</strong><div className="text-xs text-ink-mute">{g.entries.map(e => `${e.device} ${e.qty}`).join(" + ")}</div></div>)}
        </details>
        <div className="m-3 space-y-2">
          {p.phase === "draft" ? <><label className="block text-xs font-bold text-ink-mute">인계 메모 (수량은 위 목록으로 확인)</label>
            <textarea value={note ?? p.note} onChange={e => { if (note === null) setNoteVersion(p.version); setNote(e.target.value); }} maxLength={2000} className="w-full rounded-lg border border-line p-2 text-sm" placeholder="예: 고객 요청으로 D탭 라인 대신 더미 사용" />
            {note !== null && <><button className={button} onClick={async () => { if (await run({ action: "save", entries: p.entries, note }, noteVersion)) setNote(null); }}>메모 저장</button><button className={button} onClick={() => setNote(null)}>입력 취소</button></>}
            <details className="text-xs text-ink-mute"><summary>예약 장비가 변경됐나요?</summary><button className={button} onClick={() => run({ action: "refresh" })}>예약 변경 내용 불러오기</button></details>
            <button className={`${button} w-full bg-brand-600 text-white`} disabled={packingNeedsUpgrade(p) || p.entries.some(e => !e.checked || (e.qty > 0 && e.unresolved)) || devices.some(e => needsDeviceModel(e) && !p.deviceModels?.[e.scheduleId]) || note !== null} onClick={() => run({ action: "seal" })}>이 구성으로 반출 준비 확정</button>
          </> : <><p className="rounded-lg bg-checkin-bg p-3 text-sm font-bold text-checkin-fg">✓ 반출 구성품 확정 · 반납 때 이 수량과 대조합니다.</p>
            {p.note && <p className="whitespace-pre-wrap text-sm text-ink-soft">반출 메모: {p.note}</p>}
            {!packingStarted(trade) && <button className={button} onClick={() => run({ action: "revise" })}>구성 다시 준비</button>}</>}
        </div>
      </> : <div className="p-3">
        {p.phase !== "sealed" ? <p className="text-sm font-bold text-attention-fg">반출 탭에서 실제 구성품을 먼저 확정해주세요.</p> : <>
          <p className="mb-3 text-xs text-ink-mute">같은 실물은 한 번만 셉니다. 일부만 받았으면 받은 수량만 저장하세요.</p>
          {groups.map(g => <PackingReturnRow key={g.id} version={p.version} group={g} locked={trade.returnDone} onSave={(count, version) => run({ action: "receive", partId: g.id, count }, version)} />)}
          {p.note && <p className="mt-2 whitespace-pre-wrap rounded-lg bg-warn-bg p-2 text-sm">반출 메모: {p.note}</p>}
        </>}
      </div>}
      {p.sources.some(s => trade.equipments.find(e => e.scheduleId === s.id)?.memoCheckout) && <details className="m-3 rounded-lg bg-warn-bg p-2 text-xs"><summary>기존 반출 메모 확인</summary>{p.sources.map(s => {
        const memo = trade.equipments.find(e => e.scheduleId === s.id)?.memoCheckout;
        return memo ? <p key={s.id} className="mt-2 whitespace-pre-wrap">{s.name}: {memo}</p> : null;
      })}</details>}
    </fieldset>}
    {phase === "checkin" && children}
    {editing && p && <PackingEditor key={editing.id} entry={editing} entries={p.entries} devices={devices.map(e=>({id:e.scheduleId,name:p.deviceModels?.[e.scheduleId] ?? e.name}))} busy={busy} error={error} onClose={() => setEditing(null)} onSave={async (entry, add) => {
      const exists = p.entries.some(e => e.id === entry.id);
      let updated = entry;
      if (add && exists) { const id = crypto.randomUUID(); updated = { ...entry, id, sourceId: undefined }; }
      const entries = add || !exists ? [...p.entries, updated] : p.entries.map(e => e.id === entry.id ? updated : e);
      if (await save(entries, editingVersion)) setEditing(null);
    }} />}
    {busy && <p className="px-3 pb-2 text-xs text-brand-700" role="status">저장 중…</p>}
  </section></PackingContext.Provider>;
}

/** 기존 본체 행 바로 아래에 삽입한다. 별도 장비 목록을 만들지 않는다. */
export function PackingDevice({ ownerId, common = false }: { ownerId?: string; common?: boolean }) {
  const ctx = useContext(PackingContext);
  if (!ctx?.trade.packing) return null;
  const { trade, busy, update, open, run } = ctx;
  const p=trade.packing!;
  if (packingNeedsUpgrade(p)) return null;
  const owner=packingDevices(trade).find(e=>e.scheduleId===ownerId);
  const entries=p.entries.filter(e=>e.ownerId===ownerId);
  const modelNeeded=!!owner && needsDeviceModel(owner);
  const device=p.deviceModels?.[ownerId ?? ""] ?? owner?.name ?? "공용 구성품";
  const existingVideo = ownerId && templateFor(device).some(r=>/SDI|HDMI/i.test(r.name)) && !entries.some(e=>/SDI|HDMI/i.test(e.name)) ? unassignedVideo(trade,p,ownerId) : [];
  if (!entries.length && !modelNeeded && !existingVideo.length) return null;
  return <div className="my-2 ml-8 rounded-r-lg border-l-2 border-brand-200 bg-white px-3 py-2" data-packing-owner={ownerId}>
    {common && <p className="mb-2 text-xs font-bold text-ink-mute">공용·여분 구성품</p>}
    {modelNeeded && <label className="mb-2 block text-xs font-bold">실제 모니터 모델
      <select aria-label="실제 모니터 모델" disabled={busy || p.phase !== "draft" || packingStarted(trade)} value={p.deviceModels?.[ownerId!] ?? ""} onChange={e => run({action:"model",ownerId:ownerId!,model:e.target.value})} className="mt-1 w-full rounded-lg border border-line bg-white p-2 text-sm">
        <option value="" disabled>실제로 나가는 모델 선택</option>{MONITOR_MODELS.map(name=><option key={name}>{name}</option>)}
      </select></label>}
    {(!modelNeeded || p.deviceModels?.[ownerId!]) && existingVideo.length>0 && <label className="mb-2 block rounded-lg bg-warn-bg p-2 text-xs font-bold">기존 영상선 연결 (추가 수량 없음)
      <select aria-label="기존 영상선 연결" value="" disabled={busy || p.phase!=="draft"} onChange={event=>{const row=existingVideo.find(e=>e.id===event.target.value);if(row) update(row,{ownerId,device,checked:false});}} className="mt-1 w-full rounded border border-line bg-white p-2 text-sm"><option value="" disabled>이 장비에 연결할 선 선택</option>{existingVideo.map(e=><option key={e.id} value={e.id}>{e.name} ×{e.qty}</option>)}</select>
    </label>}
    {entries.map(e=><div key={e.id} className="border-b border-line/50 py-2 last:border-0">
      <div className="flex items-start gap-2"><button aria-label={`${e.name} 준비 확인`} aria-pressed={e.checked} disabled={busy || p.phase !== "draft" || (e.qty>0 && e.unresolved) || (modelNeeded && !p.deviceModels?.[ownerId!])} onClick={()=>update(e,{checked:!e.checked})} className={`tap h-6 w-6 shrink-0 rounded border-2 text-sm ${e.checked ? "border-brand-600 bg-brand-600 text-white" : "border-line"}`}>{e.checked ? "✓" : ""}</button>
        <span className={`min-w-0 flex-1 break-words text-sm ${e.qty===0 ? "line-through text-ink-faint" : ""}`}>{e.name}{e.unresolved && e.qty>0 && <span className="ml-1 text-xs font-bold text-attention-fg">종류 선택 필요</span>}</span><strong className="text-sm">{e.qty ? `×${e.qty}` : "제외"}</strong></div>
      {p.phase === "draft" && <div className="mt-1 flex flex-wrap gap-1 pl-8"><button className={`${button} text-brand-700`} onClick={()=>open(e)}>교체·수량</button><button className={`${button} text-ink-mute`} onClick={()=>update(e,{qty:e.qty?0:1,checked:false})}>{e.qty ? "제외" : "포함"}</button></div>}
    </div>)}
    {p.phase === "draft" && <button className="tap mt-2 text-xs font-bold text-brand-700" disabled={busy || (modelNeeded && !p.deviceModels?.[ownerId!])} onClick={()=>{const id=crypto.randomUUID();open({id,ownerId,device,name:"",partId:"",qty:1,checked:false});}}>+ 구성품 추가</button>}
  </div>;
}

function PackingEditor({ entry, entries, devices, busy, error, onClose, onSave }: { entry: PackingEntry; entries: PackingEntry[]; devices: {id:string;name:string}[]; busy: boolean; error: string; onClose: () => void; onSave: (entry: PackingEntry, add: boolean) => void }) {
  const [draft, setDraft] = useState(entry);
  const [mode, setMode] = useState<"replace" | "add">("replace");
  const [query,setQuery]=useState("");
  const exists = entries.some(e => e.id === entry.id);
  const normalized=(s:string)=>s.toLowerCase().replace(/\s/g,"");
  const relevant=(name:string)=>normalized(name).includes(normalized(draft.device).split("용")[0]) || (/스몰HD/.test(draft.device)&&/스몰HD/.test(name)) || (/테라덱/.test(draft.device)&&/테라덱/.test(name)) || name==="노가암" || name==="SDI 연선";
  const options=PACKING_PARTS.filter(p=>query ? normalized(p.name).includes(normalized(query)) : relevant(p.name) || p.id===draft.partId).sort((a,b)=>Number(relevant(b.name))-Number(relevant(a.name)) || a.name.localeCompare(b.name,"ko"));
  const selected=PACKING_PARTS.find(p=>p.id===draft.partId);
  return <div role="dialog" aria-modal="true" aria-label="구성품 선택" className="fixed inset-0 z-[100] flex items-center justify-center overflow-y-auto bg-black/40 p-4" onKeyDown={e => { if (e.key === "Escape" && !busy) onClose(); }}>
    <form className="max-h-[90dvh] w-full max-w-md space-y-3 overflow-y-auto rounded-2xl bg-white p-4 shadow-xl" onSubmit={e => { e.preventDefault(); if(selected) onSave({ ...draft, name:selected.name, checked: false }, mode === "add"); }}>
      <h3 className="font-extrabold">{draft.device} 구성품</h3>
      {error && <p role="alert" className="text-sm font-bold text-attention-fg">{error}</p>}
      <label className="block text-sm">사용 장비<select value={draft.ownerId ?? ""} onChange={e=>{const owner=devices.find(d=>d.id===e.target.value);setDraft({...draft,ownerId:owner?.id,device:owner?.name??draft.device});}} className="mt-1 w-full rounded-lg border p-2"><option value="" disabled>장비 선택</option>{devices.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
      <label className="block text-sm">등록 구성품 검색<input autoFocus value={query} onChange={e=>setQuery(e.target.value)} placeholder="다른 등록 품목도 검색할 수 있습니다" className="mt-1 w-full rounded-lg border p-2" /></label>
      <div role="listbox" aria-label="등록 구성품" className="max-h-44 overflow-y-auto rounded-lg border border-line">{options.map(p=><button type="button" role="option" aria-selected={draft.partId===p.id} key={p.id} onClick={()=>setDraft({...draft,name:p.name,partId:p.id})} className={`block w-full border-b border-line/40 px-3 py-2 text-left text-sm ${draft.partId===p.id ? "bg-brand-50 font-bold text-brand-700" : ""}`}>{p.name}</button>)}{!options.length&&<p className="p-3 text-sm">등록된 구성품이 없습니다. 담당자에게 품목 등록을 요청해주세요.</p>}</div>
      <p className="text-sm font-bold">선택: {selected?.name ?? "구성품을 선택해주세요"}</p>
      <p className="text-xs text-ink-mute">같은 등록 품목을 고르면 장비가 달라도 합산됩니다. 검색어는 품목 이름으로 저장되지 않습니다.</p>
      <label className="block text-sm">수량<input required type="number" min={1} max={99} value={draft.qty || ""} onChange={e => setDraft({ ...draft, qty: Number(e.target.value) })} className="ml-3 w-20 rounded-lg border p-2" /></label>
      {exists && <div className="flex flex-wrap gap-3 text-sm"><label><input type="radio" checked={mode === "replace"} onChange={() => setMode("replace")} /> 기존 {entry.qty}개 교체</label><label><input type="radio" checked={mode === "add"} onChange={() => setMode("add")} /> 기존 유지하고 추가</label></div>}
      <div className="flex justify-end gap-2"><button type="button" disabled={busy} className={button} onClick={onClose}>취소</button><button disabled={busy || !selected} className={`${button} bg-brand-600 text-white`}>{mode === "add" || !exists ? "추가 저장" : "교체 저장"}</button></div>
    </form>
  </div>;
}

function PackingReturnRow({ group: g, version, locked, onSave }: { group: ReturnType<typeof packingGroups>[number]; version: number; locked: boolean; onSave: (count: ReturnCount, version: number) => Promise<boolean> }) {
  const [draft, setDraft] = useState<ReturnCount | null>(null);
  const [base, setBase] = useState("");
  const count = draft ?? g.count;
  const change = (patch: Partial<ReturnCount>) => {
    if (!draft) setBase(JSON.stringify(g.count));
    setDraft({ ...count, ...patch });
  };
  const conflict = draft !== null && base !== JSON.stringify(g.count);
  const [expanded, setExpanded] = useState(false);
  const accounted = g.count.good + g.count.damaged + g.count.lost;
  const complete = accounted === g.expected;
  const dirty = draft !== null;
  return <div className="mb-2 rounded-xl border border-line p-3">
    <div className="flex items-start justify-between gap-2"><div className="min-w-0"><h4 className="break-words text-sm font-bold">{g.name}</h4><p className="mt-1 text-xs text-ink-mute">{g.entries.map(e => `${e.device} ${e.qty}`).join(" + ")}</p></div><span className={`shrink-0 text-sm font-bold ${complete ? "text-checkin-fg" : "text-attention-fg"}`}>{accounted}/{g.expected}</span></div>
    {complete ? <p className="mt-2 text-xs text-checkin-fg">{g.count.lost ? `분실 ${g.count.lost}개 기록` : "수량 확인됨"}{g.count.damaged ? ` · 파손 ${g.count.damaged}개` : ""}</p> : <p className="mt-2 text-xs font-bold text-attention-fg">미반납 {g.expected - accounted}개</p>}
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <button disabled={locked} className={button} onClick={() => setExpanded(!expanded)}>수량 입력</button>
      {!complete && <button disabled={locked || dirty} className={`${button} text-checkin-fg`} onClick={() => onSave({ ...g.count, good: g.expected - g.count.damaged - g.count.lost }, version)}>모두 받음</button>}
    </div>
    {expanded && <div className="mt-3 space-y-2">
      <div className="flex flex-wrap gap-3">{([['good','정상'],['damaged','파손'],['lost','분실']] as const).map(([key,label]) => <label key={key} className="text-xs">{label}<input disabled={locked} type="number" min={0} max={g.expected} value={count[key]} onChange={e => change({ [key]: Number(e.target.value) })} className="ml-1 w-16 rounded border p-2 text-sm" /></label>)}</div>
      <input disabled={locked} value={count.memo ?? ""} onChange={e => change({ memo: e.target.value })} maxLength={1000} placeholder="파손·분실 사유 / 반납 메모" className="w-full rounded border p-2 text-sm" />
      {conflict && <p role="alert" className="text-xs font-bold text-attention-fg">다른 직원이 이 품목을 수정했습니다. 최신 수량 {g.count.good}개를 확인해주세요.</p>}
      <button disabled={locked || !dirty || conflict} className={`${button} bg-checkin-fg text-white`} onClick={async () => { if (await onSave(count, version)) setDraft(null); }}>받은 수량 저장</button>
      {dirty && <button className={button} onClick={() => setDraft(null)}>입력 취소 · 최신 수량 보기</button>}
    </div>}
    {g.count.memo && <p className="mt-2 break-words text-xs text-ink-soft">반납 메모: {g.count.memo}</p>}
  </div>;
}
