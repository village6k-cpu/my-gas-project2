"use client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "@/lib/data/authFetch";
import { ViewHeader } from "@/components/ViewHeader";

type Evidence = { source: string; item: string|null; link: string|null; body: string };
type Case = {case_key:string;trade_id:string|null;occurred_at:string;evidence_hash:string;evidence:Evidence[];next_trade_id:string|null;next_at:string|null;next_item:string|null};
type Review = {case_key:string;revision:number;evidence_hash:string;state:string;note:string;reviewed_at:string};
type Data = {cases:Case[];reviews:Review[]};
const filters=["최근 확인","처리 중","다음 반출","전체 근거","처리 이력","반복 품목"] as const;
const control="rounded-xl border border-line bg-paper px-3 py-2 text-sm";
const kst=(v:string)=>new Date(v).toLocaleString("ko-KR",{timeZone:"Asia/Seoul",month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});
function slackUrl(link:string|null){try{const u=new URL(link||"");return u.protocol==="https:"&&u.hostname.endsWith(".slack.com")?u.href:null}catch{return null}}
function title(c:Case){const structured=c.evidence.find(e=>e.source==="반납 검수");
  if(structured)return [structured.item,structured.body].join(" · ").slice(0,110);
  const body=c.evidence.map(e=>e.body).join("\n");
  const summary=body.split("동기화 요약 · ").at(-1)||body;
  return (summary.split("\n").find(s=>/파손|분실|미반납|고장|불량|누락|수리|미납|부족|미회수|미수금|미입금/.test(s))||summary).slice(0,140)}
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
  return <section className="mx-auto max-w-4xl pb-28"><ViewHeader title="사건·주의사항"><button className={control} disabled={busy} onClick={()=>load()}>새로고침</button></ViewHeader>
    <div className="space-y-4 px-4"><h1 className="text-2xl font-extrabold text-ink">사건·주의사항</h1>
    <div className="flex flex-wrap gap-2">{filters.map(f=><button key={f} className={control+(filter===f?" font-bold text-accent-700 ring-1 ring-accent-700":"")} onClick={()=>{setFilter(f);setSelected("");setNote("")}}>{f}</button>)}</div>
    <input className={control+" w-full"} aria-label="거래·품목·기록 검색" placeholder="거래번호, 장비명, 특이사항 검색" value={search} onChange={e=>setSearch(e.target.value)}/>
    {err&&<p role="alert" className="text-attention-fg">{err}</p>}{busy&&<p>기록 조회 중…</p>}
    {data&&filter==="반복 품목"?<div><p className="mb-3 text-sm">품목별 반납 검수에 수량이 명시된 서로 다른 거래를 집계합니다.</p>{[...repeated].filter(([,v])=>v.size>1).length===0&&<p>두 거래 이상에 기록된 품목이 없습니다.</p>}{[...repeated].filter(([,v])=>v.size>1).sort((a,b)=>b[1].size-a[1].size).map(([name,v])=><div key={name} className="border-b border-line py-3">{name} · {v.size}거래</div>)}</div>:data&&<>
    <p className="text-sm text-ink-mute">{filter==="최근 확인"?"최근 7일 기록과 재확인할 근거":filter==="다음 반출"?"기록에 나온 품목과 같은 이름의 다음 예약 · 실물 배정 확인 필요":filter==="전체 근거"?"전체 기간의 거래·스레드별 검토 후보":filter} · {cases.length}건</p>
    {cases.length===0&&<p>이 조건에 해당하는 기록이 없습니다.</p>}
    {cases.map(c=><article key={c.case_key} className="rounded-2xl border border-line bg-paper p-4"><button className="w-full text-left" onClick={()=>{setSelected(selected===c.case_key?"":c.case_key);setNote("")}}><span className="text-xs text-ink-mute">{kst(c.occurred_at)} · {c.trade_id||"Slack 스레드"} · {status(c)}</span><strong className="mt-1 block">{title(c)}</strong>{c.next_at&&<small>다음 예약 · {kst(c.next_at)} · {c.next_item}</small>}</button>
    {selected===c.case_key&&<div className="mt-3 space-y-3">{c.trade_id&&<a className="text-accent-700 underline" href={"/?tid="+encodeURIComponent(c.trade_id)}>거래 카드 열기</a>}
    {c.evidence.map((e,i)=><div key={i} className="border-t border-line pt-2"><b>{e.source} {e.item}</b><p className="whitespace-pre-wrap break-words text-sm">{e.body}</p>{slackUrl(e.link)&&<a className="text-accent-700 underline" href={slackUrl(e.link)!} target="_blank" rel="noreferrer">Slack 스레드</a>}</div>)}
    {c.next_trade_id&&<a className="block underline" href={"/?tid="+encodeURIComponent(c.next_trade_id)}>다음 예약 카드</a>}{byKey.get(c.case_key)?.map(r=><p key={r.revision} className="text-sm">{kst(r.reviewed_at)} · {r.state} · {r.note}</p>)}
    <textarea className={control+" w-full"} aria-label="처리 근거 또는 다음 조치" placeholder="처리 근거 또는 다음 조치" value={note} maxLength={2000} onChange={e=>setNote(e.target.value)}/><div className="flex flex-wrap gap-2">{["확인 필요","처리 중","해결","제외"].map(s=><button key={s} className={control} disabled={!note.trim()||saving} onClick={()=>save(c,s)}>{s}</button>)}</div></div>}</article>)}</>}
    </div></section>
}
