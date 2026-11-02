import {createHash} from 'node:crypto';
import {createWorkOrchestratorStore} from '../work-orchestrator-v2/supabase-store.mjs';
// One visible review case, never one task per telemetry error. Candidate != confirmed omission.
export function reviewCase(report,now){
  const current=new Map();for(const r of report.rooms){const old=current.get(r.room);if(!old||Date.parse(r.sourceAt)>Date.parse(old.sourceAt))current.set(r.room,r);}
  const findings=report.findings.filter(f=>f.kind==='ingress_without_capture'||f.future&&f.priority==='urgent');
  if(!findings.length)return null;
  const rows=findings.map(f=>({name:f.name,kind:f.kind,tradeIds:f.tradeIds||[],desiredPeriod:f.desiredPeriod||null,missing:f.missing||[]})).sort((a,b)=>(a.kind==='ingress_without_capture')-(b.kind==='ingress_without_capture')||a.name.localeCompare(b.name));
  const fingerprint=createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0,24);
  const kinds={approved_period_mismatch:'승인 일정과 불일치',approved_booking_missing:'같은 일정 예약 조회 안 됨',approved_equipment_mismatch:'장비명·수량 대조 필요',duplicate_candidate:'같은 기간 중복 후보',ingress_without_capture:'감지 기록은 있으나 본문 수집 확인 안 됨'};
  const summary=rows.map(f=>`${f.name}: ${kinds[f.kind]||'원장 대조 필요'}${f.tradeIds.length?' · '+f.tradeIds.join(', '):''}${f.desiredPeriod?' · '+f.desiredPeriod.start.slice(0,16).replace('T',' '):''}`).join('\n').slice(0,1800);
  return {fingerprint,candidate:{work_key:'reservation-reconciliation:current-review',source_event_keys:['reservation-reconciliation:'+fingerprint],room_key:'reservation-reconciliation:current',title:`예약 자동 대조 · ${rows.length}건 검토 필요`,summary,
    work_type:'reservation_review',priority:'p0',state:'open',owner_id:null,actionable_at:now,due_at:now,snoozed_until:null,first_opened_at:now,last_activity_at:now,automation_state:'needs_human',
    payload:{requires_human_action:true,action_family:'reservation_reconciliation',business_key:fingerprint,follow_up_route:'schedule',follow_up_task_key:'reservation-reconciliation:'+fingerprint,
      owner_case_key:'reservation-reconciliation:current',owner_case_title:'예약 자동 대조',owner_request_summary:'고객 대화의 승인 일정·장비와 현재 예약이 일치하는지 확인',owner_problem_summary:'저장된 대화에서 현재 예약과 일치 검증이 끝나지 않은 후보가 있습니다. 후보 수는 누락 확정 건수가 아닙니다.',owner_next_action_summary:'최신 대화와 실제 원장을 확인하고, 반영된 건은 중복 등록하지 말고 미반영 변경과 공급 문제를 처리하세요.',recommended_action:'최신 대화·예약 원장을 대조하세요. 재고 부족·모델 변경·동명이인은 확인 후 처리하며 실제 수납·결과 확인 없이 중복 등록하지 마세요.',alert_level:'p0',alert_reason:'향후 예약에 승인 내용과 현재 원장의 불일치 검토 후보가 있습니다.'}}};
}
export async function publishReview({report,env,now,lastFingerprint,fetchImpl=fetch,store=null}){
  const plan=reviewCase(report,now);if(!plan)return {status:'no_current_candidates',fingerprint:lastFingerprint};
  const headers={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY};
  if(plan.fingerprint===lastFingerprint){
    const u=new URL(env.SUPABASE_URL+'/rest/v1/work_items_v2');u.searchParams.set('work_key','eq.'+plan.candidate.work_key);u.searchParams.set('select','id,state,payload');
    const r=await fetchImpl(u,{headers,signal:AbortSignal.timeout(30000)});const rows=await r.json();if(!r.ok||!Array.isArray(rows))throw Error('review_visibility_readback_failed');
    if(rows.length===1&&['open','in_progress','snoozed'].includes(rows[0].state)&&rows[0].payload?.business_key===plan.fingerprint&&rows[0].payload?.owner_triage==='critical')return {status:'unchanged',fingerprint:lastFingerprint,id:rows[0].id};
  }
  const workStore=store||createWorkOrchestratorStore({supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY,fetchImpl});
  const result=await workStore.upsertWorkItem(plan.candidate);const row=result.row;if(!row?.id||!Number.isSafeInteger(row.version))throw Error('review_work_readback_missing');
  const reopen=!['open','in_progress','snoozed'].includes(row.state);
  const payload={...row.payload,...plan.candidate.payload,owner_triage:'critical',owner_triage_kind:'schedule_reconciliation',owner_triage_reason:'향후 예약의 승인 내용과 원장 불일치를 확인해야 합니다.',owner_triage_verified_at:now};
  const url=new URL(env.SUPABASE_URL+'/rest/v1/work_items_v2');url.searchParams.set('id','eq.'+row.id);url.searchParams.set('version','eq.'+row.version);url.searchParams.set('select','id,payload,state');
  const r=await fetchImpl(url,{method:'PATCH',headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({payload,...(reopen?{state:'open',title:plan.candidate.title,summary:plan.candidate.summary,priority:plan.candidate.priority,automation_state:'needs_human',resolved_at:null,resolved_by:null,resolution_kind:null,resolution_evidence:{},last_activity_at:now,due_at:now,source_event_keys:[...new Set([...(row.source_event_keys||[]),...plan.candidate.source_event_keys])].slice(-100)}:{})}),signal:AbortSignal.timeout(30000)});
  const saved=await r.json();if(!r.ok||saved.length!==1||saved[0].payload?.owner_triage!=='critical'||!['open','in_progress','snoozed'].includes(saved[0].state))throw Error('critical_review_readback_failed');
  return {status:'published',fingerprint:plan.fingerprint,id:row.id};
}
