"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { authFetch } from "@/lib/data/authFetch";
import { ChevronRight, Refresh, Search } from "@/components/icons";
import { ViewHeader } from "@/components/ViewHeader";

type Evidence = { source: string; item: string|null; link: string|null; body: string };
type Case = {case_key:string;trade_id:string|null;occurred_at:string;evidence_hash:string;evidence:Evidence[];next_trade_id:string|null;next_at:string|null;next_item:string|null};
type Review = {case_key:string;revision:number;evidence_hash:string;state:string;note:string;reviewed_at:string};
type Data = {cases:Case[];reviews:Review[]};
const filters=["최근 확인","처리 중","다음 반출","전체 근거","처리 이력","반복 품목"] as const;
const control="rounded-xl border border-line bg-paper px-3 py-2 text-sm";
const kst=(v:string)=>new Date(v).toLocaleString("ko-KR",{timeZone:"Asia/Seoul",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
function slackUrl(link:string|null){try{const u=new URL(link||"");return u.protocol==="https:"&&u.hostname.endsWith(".slack.com")?u.href:null}catch{return null}}
function headline(c: Case) {
  const inspection = c.evidence.find(e => e.source === "반납 검수");
  if (inspection) {
    const counts = inspection.body.split(" · ").filter(line => /^(분실|파손|미반납 보고) [1-9][0-9]*$/.test(line));
    if (counts.length) return [inspection.item, ...counts].filter(Boolean).join(" · ");
  }
  const excerpt = c.evidence.find(e => e.source === "품목 특이사항")?.body
    || c.evidence.find(e => e.source === "거래 특이사항")?.body
    || c.evidence.map(e => e.body).join("\n").split("동기화 요약 · ").at(-1) || "";
  const lines = excerpt.split(/\n/).map(s => s.replace(/^[•*\s]+/, "").trim()).filter(Boolean);
  const description = lines.find(s => /파손|분실|미반납|고장|불량|누락|수리|미납|부족|미회수|미수금|미입금/.test(s)) || lines[0] || "특이사항 확인";
  const item = c.evidence.find(e => e.source === "품목 특이사항")?.item;
  return item && !description.includes(item) ? item + " · " + description : description;
}
const badge = "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-bold";
function stateTone(value:string) {
  if (value === "해결") return "bg-checkin-bg text-checkin-fg";
  if (value === "처리 중") return "bg-checkout-bg text-checkout-fg";
  if (value === "확인 필요" || value === "새 근거 확인") return "bg-attention-bg text-attention-fg";
  return "bg-paper text-ink-soft";
}
export function IncidentView({active=true}:{active?:boolean}){
  const [data,setData]=useState<Data|null>(null),[err,setErr]=useState(""),[busy,setBusy]=useState(false);
  const [filter,setFilter]=useState<typeof filters[number]>("최근 확인"),[search,setSearch]=useState(""),[selected,setSelected]=useState(""),[note,setNote]=useState(""),[saving,setSaving]=useState(false);
  const load=useCallback(async(signal?:AbortSignal)=>{setBusy(true);try{const res=await authFetch("/api/incidents",{cache:"no-store",signal});const body=await res.json();if(!res.ok)throw Error(body.error||"조회 실패");if(!signal?.aborted){setData(body);setErr("")}}catch(e){if(!signal?.aborted)setErr(e instanceof Error?e.message:"조회 실패")}finally{if(!signal?.aborted)setBusy(false)}},[]);
  useEffect(()=>{if(!active)return;const controller=new AbortController();void load(controller.signal);return ()=>controller.abort()},[active,load]);
  const byKey=useMemo(()=>{const m=new Map<string,Review[]>();for(const r of data?.reviews||[]){const a=m.get(r.case_key)||[];a.push(r);m.set(r.case_key,a)}return m},[data]);
  const last=(c:Case)=>byKey.get(c.case_key)?.at(-1);
  const status=(c:Case)=>{const r=last(c);return !r?"검토 전":r.evidence_hash===c.evidence_hash?r.state:"새 근거 확인"};
  const open=(c:Case)=>!["해결","제외"].includes(status(c));
  const recent=Date.now()-7*86400000;
  const cases=(data?.cases||[]).filter(c=>{
    if(search&&![c.trade_id,...c.evidence.flatMap(x=>[x.item,x.body])].join(" ").toLowerCase().includes(search.trim().toLowerCase()))return false;
    if(filter==="최근 확인")return open(c)&&(Date.parse(c.occurred_at)>=recent||status(c)==="새 근거 확인"||status(c)==="확인 필요");
    if(filter==="다음 반출")return open(c)&&!!c.next_at;
    if(filter==="처리 중")return status(c)==="처리 중";
    if(filter==="처리 이력")return !!last(c);
    return true}).sort((a,b)=>filter==="다음 반출"?String(a.next_at).localeCompare(String(b.next_at)):b.occurred_at.localeCompare(a.occurred_at));
  const repeated=new Map<string,Set<string>>();for(const c of cases){for(const e of c.evidence){if(e.source!=="반납 검수"||!e.item)continue;for(const kind of ["분실","파손","미반납 보고"]){if(!e.body.split(" · ").some(v=>v.startsWith(kind+" ")&&/^\d+$/.test(v.slice(kind.length+1))))continue;const key=e.item+" · "+kind;const set=repeated.get(key)||new Set();set.add(c.case_key);repeated.set(key,set)}}}
  async function save(c:Case,state:string){if(!note.trim()||saving)return;setSaving(true);try{const res=await authFetch("/api/incidents",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key:c.case_key,hash:c.evidence_hash,revision:last(c)?.revision??0,state,note})});const body=await res.json();if(!res.ok)throw Error(body.error||"저장 실패");setNote("");await load()}catch(e){setErr(e instanceof Error?e.message:"저장 실패")}finally{setSaving(false)}}
  const [wide, setWide] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1440px)");
    const update = () => setWide(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  const current = cases.find(c => c.case_key === selected);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    if (active && !wide && current && el && !el.open) el.showModal();
    else if ((wide || !active || !current) && el?.open) el.close();
  }, [active, current, wide]);
  const repeats = [...repeated].filter(([,v]) => v.size > 1).sort((a,b) => b[1].size-a[1].size);
  const count = filter === "반복 품목" ? repeats.length : cases.length;
  const detail = current && <>
          <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-white px-4 py-3">
            <span className={badge+" "+stateTone(status(current))}>{status(current)}</span>
            <button autoFocus={!wide} aria-label="사건 상세 닫기" className={control+" tap font-bold"} onClick={()=>setSelected("")}>닫기</button>
          </div>
          <div className="space-y-5 p-4 pb-8 sm:p-5">
            <div><p className="text-sm text-ink-mute">{kst(current.occurred_at)} · {current.trade_id||"거래 미연결"}</p>
              <h2 id="incident-detail-title" className="mt-1 break-words text-xl font-extrabold leading-snug">{headline(current)}</h2></div>
            <div className="flex flex-wrap gap-2">
              {current.trade_id&&<a className={control+" font-bold text-brand-700"} href={"/?tid="+encodeURIComponent(current.trade_id)}>거래 카드 열기</a>}
              {current.next_trade_id&&<a className={control+" font-bold text-checkout-fg"} href={"/?tid="+encodeURIComponent(current.next_trade_id)}>다음 예약 카드</a>}
            </div>
            <section><h3 className="mb-2 font-extrabold">처리 기록</h3>
              {byKey.get(current.case_key)?.map(r=><div key={r.revision} className="mb-2 border-l-2 border-line pl-3"><small>{kst(r.reviewed_at)} · {r.state}</small><p className="whitespace-pre-wrap break-words">{r.note}</p></div>)}
              <textarea className={control+" min-h-20 w-full bg-white"} aria-label="처리 근거 또는 다음 조치" placeholder="처리 근거 또는 다음 조치" value={note} maxLength={2000} onChange={e=>setNote(e.target.value)}/>
              <div className="mt-2 flex flex-wrap gap-2">{["확인 필요","처리 중","해결","제외"].map(s=><button key={s} className={control+" tap font-bold disabled:opacity-50"} disabled={!note.trim()||saving} onClick={()=>save(current,s)}>{s}</button>)}</div>
              {err&&<p role="alert" className="mt-2 text-attention-fg">{err}</p>}
            </section>
            <section><h3 className="mb-2 font-extrabold">원본 근거 <span className="text-ink-mute">{current.evidence.length}</span></h3>
              {current.evidence.map((e,i)=><details key={i} className="border-t border-line py-3">
                <summary className="cursor-pointer break-words text-sm font-bold">{e.source}{e.item?" · "+e.item:""}</summary>
                <p className="my-2 whitespace-pre-wrap break-words rounded-lg bg-paper p-3 text-[15px] leading-relaxed">{e.body}</p>
                {slackUrl(e.link)&&<a className="font-bold text-brand-700 underline" href={slackUrl(e.link)!} target="_blank" rel="noreferrer">Slack 스레드 열기</a>}
              </details>)}
            </section>
          </div>
        </>;
  return (
    <section className="flex min-h-screen min-w-0 flex-col bg-paper">
      <header className="safe-top sticky top-0 z-30 border-b border-line/70 bg-paper/95 backdrop-blur-md">
        <ViewHeader title="사건·주의사항">
          <button aria-label="새로고침" disabled={busy} onClick={()=>load()} className="tap flex h-9 w-9 items-center justify-center rounded-full bg-white text-ink-soft ring-1 ring-line/70">
            <Refresh className={"h-4 w-4 "+(busy?"animate-spin":"")} />
          </button>
        </ViewHeader>
        <div className="overflow-x-auto px-3 pb-2">
          <div role="group" aria-label="사건 보기" className="flex w-max gap-1.5 p-px">
            {filters.map(f => <button key={f} aria-pressed={filter === f}
              className={"tap rounded-full px-3 py-2 text-[13px] font-extrabold "+(filter===f?"bg-ink text-white":"bg-white text-ink-soft ring-1 ring-line/70")}
              onClick={()=>{setFilter(f);setSelected("");setNote("")}}>{f}</button>)}
          </div>
        </div>
      </header>
      <div className="min-w-0 space-y-3 px-3 pb-24 pt-4 lg:px-4">
        <div className="flex items-baseline justify-between gap-3 px-1">
          <h1 className="text-[19px] font-extrabold tracking-tight text-ink">사건·주의사항</h1>
          {data && <span className="text-sm font-bold tabular-nums text-ink-soft">{count}{filter==="반복 품목"?"개 품목":"건"}</span>}
        </div>
        <label className="flex items-center gap-2 rounded-xl border border-line bg-white px-3 focus-within:ring-2 focus-within:ring-accent-600">
          <Search className="h-4 w-4 shrink-0 text-ink-mute"/>
          <input className="min-w-0 flex-1 bg-transparent py-2.5 text-[15px] text-ink outline-none" aria-label="거래·품목·기록 검색" placeholder="거래번호, 장비명, 특이사항 검색" value={search} onChange={e=>setSearch(e.target.value)}/>
        </label>
        {err && !current && <p role="alert" className="rounded-xl bg-attention-bg p-3 text-sm font-bold text-attention-fg">{err}</p>}
        {busy && !data && <p role="status" className="rounded-xl bg-white p-6 text-center font-semibold text-ink-soft">기록 조회 중…</p>}
        {data && <p className="px-1 text-[13px] leading-relaxed text-ink-mute">
          {filter==="최근 확인"?"최근 7일 기록과 다시 확인할 사건":filter==="다음 반출"?"같은 품목의 다음 예약 순서입니다. 실물 배정은 거래 카드에서 확인하세요.":filter==="반복 품목"?"반납 검수에서 같은 문제가 두 거래 이상 기록된 품목":filter==="전체 근거"?"전체 기간의 거래·스레드별 기록":filter}
        </p>}
        {data && !count && <p className="rounded-xl2 border border-dashed border-line bg-white p-8 text-center text-sm font-bold text-ink-soft">이 조건에 해당하는 기록이 없습니다.</p>}
        <div className={wide && cases.length > 0 && filter !== "반복 품목" ? "grid grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)] items-start gap-4" : ""}>
          <div className="min-w-0 space-y-2.5">
        {data && filter==="반복 품목" ? repeats.map(([name,v]) => <div key={name} className="flex justify-between gap-3 rounded-xl bg-white p-4 shadow-sm ring-1 ring-line/70"><strong>{name}</strong><span className="shrink-0 text-sm font-bold">{v.size}거래</span></div>) :
          cases.map(c => <button type="button" key={c.case_key} aria-haspopup={wide ? undefined : "dialog"} onClick={()=>{setSelected(c.case_key);setNote("")}}
            className={"tap block w-full rounded-xl border bg-white p-3.5 text-left shadow-sm hover:border-brand-300 focus-visible:ring-2 focus-visible:ring-brand-600 "+(wide && selected===c.case_key ? "border-brand-500 ring-1 ring-brand-500" : "border-line/80")}>
            <div className="flex items-center justify-between gap-2"><span className={badge+" "+stateTone(status(c))}>{status(c)}</span>
              <span className="text-[13px] font-medium tabular-nums text-ink-mute">{kst(c.occurred_at)}</span></div>
            <div className="mt-2 flex items-start justify-between gap-2"><strong className="line-clamp-2 break-words text-[17px] font-extrabold leading-snug text-ink">{headline(c)}</strong><ChevronRight className="mt-1 h-4 w-4 shrink-0 text-ink-mute"/></div>
            {c.next_at && <p className="mt-2 rounded-lg bg-checkout-bg px-2.5 py-1.5 text-[13px] leading-relaxed text-checkout-fg"><b>다음 반출</b>　{kst(c.next_at)} · {c.next_item}</p>}
            <p className="mt-2 break-words text-[13px] text-ink-mute">{c.trade_id||"거래 미연결"} · {[...new Set(c.evidence.map(e=>e.source))].join(" · ")}</p>
          </button>)}
          </div>
          {wide && cases.length > 0 && filter !== "반복 품목" && <aside aria-label="선택한 사건 상세" className="sticky top-28 max-h-[calc(100dvh-8rem)] min-w-0 overflow-y-auto rounded-xl border border-line bg-white">
            {detail || <p className="p-6 text-center text-sm font-semibold text-ink-mute">목록에서 사건을 선택하면 원본과 처리 기록을 볼 수 있습니다.</p>}
          </aside>}
        </div>
      </div>
      <dialog ref={dialog} onClose={()=>{if(!wide)setSelected("")}} aria-labelledby="incident-detail-title"
        className="fixed inset-x-0 bottom-0 top-auto m-0 max-h-[88dvh] w-full max-w-none overflow-y-auto rounded-t-2xl bg-white text-ink shadow-pop backdrop:bg-black/40 sm:inset-0 sm:m-auto sm:max-w-xl sm:rounded-2xl">
        {!wide && detail}

      </dialog>
    </section>
  );
}
