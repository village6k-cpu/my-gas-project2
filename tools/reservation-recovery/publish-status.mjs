import fs from 'node:fs';import path from 'node:path';import {pathToFileURL} from 'node:url';
const LABELS={collector_probe_unavailable:'카카오 수신 상태 확인이 지연되고 있습니다',collector_not_reading_full_list:'카카오 수신 감시가 전체 대화를 읽지 못하고 있습니다',kakao_login_or_browser_unavailable:'카카오 로그인 또는 감시 브라우저 확인이 필요합니다',bridge_unresponsive:'자동반영 수신 프로그램이 응답하지 않습니다',reservation_worker_disconnected:'예약 처리기가 연결되지 않았습니다',reservation_write_needs_readback:'일부 예약 변경의 저장 결과를 확인해야 합니다',undelivered_failure_notices:'처리 실패 뒤 담당자에게 전달되지 않은 확인 건이 남아 있습니다',pending_failure_notices:'처리 실패 알림 중 전달 확인이 안 된 건이 남아 있습니다',reconciliation_scan_incomplete:'최근 대화의 누락 대조 범위를 아직 끝까지 확인하지 못했습니다',durable_storage_failure:'수신 원문 저장소를 점검해야 합니다',unreconciled_intake_backlog:'수신 원문 중 처리 대기열에 넘기지 못한 건이 남아 있습니다'};
export function incidentCandidate(state){
 const at=new Date(state.first_seen_at*1000).toISOString(),observed=new Date(state.observed_at*1000).toISOString();
 const intake=state.intake_status||{},names=[...new Set((intake.reviewRequired||[]).map(r=>r.customer_name).filter(Boolean))];
 const facts=[...state.issues.map(x=>LABELS[x]||x),`재처리 대기 수신 기록 ${intake.actionablePending??'집계 중'}개 · 결과 대조 중인 수신 기록 ${intake.reviewRequiredCount??'집계 중'}개 (예약 누락 확정 수가 아닙니다)`,...(names.length?['대조 대상 예시: '+names.slice(0,12).join(', ')]:[])].join('\n');
 return {work_key:'reservation-recovery:active',source_event_keys:['reservation-recovery:'+at],room_key:'operations:reservation-recovery',work_type:'human_review',title:'예약 누락 위험 · 자동반영 복구 상태 확인',summary:facts,priority:'p0',state:'open',owner_id:null,actionable_at:at,due_at:null,snoozed_until:null,first_opened_at:at,last_activity_at:observed,automation_state:'needs_human',payload:{requires_human_action:true,recommended_action:'자동 복구가 진행 중입니다. 로그인 문제와 저장 결과 미확정 예약을 확인하세요. 단순 재시작으로 누락이 해소됐다고 처리하지 마세요.',owner_case_key:'reservation-recovery',owner_case_title:'예약 누락 위험 · 자동반영 복구',owner_request_summary:'고객 대화의 예약 추가·변경을 누락 없이 반영하고 중단 구간을 복구해야 합니다.',owner_problem_summary:facts.slice(0,1000),owner_next_action_summary:'복구 상태와 남은 예약 확인 건을 점검하세요. 저장 결과가 불확실한 예약을 중복 등록하지 마세요.',owner_task_key:'reservation-recovery',owner_case_context_status:'available'}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const root=process.argv[2],state=JSON.parse(fs.readFileSync(process.argv[3],'utf8'));
 const env=JSON.parse(fs.readFileSync(path.join(root,'control/bridge.env.json'),'utf8'));
 const {createWorkOrchestratorStore}=await import(pathToFileURL(path.join(root,'production-runtime/tools/work-orchestrator-v2/supabase-store.mjs')));
 const result=await createWorkOrchestratorStore({supabaseUrl:env.SUPABASE_URL,serviceRoleKey:env.SUPABASE_SERVICE_ROLE_KEY}).upsertWorkItem(incidentCandidate(state));
 if(!result?.row?.id)throw Error('Health incident was not persisted');console.log(JSON.stringify({id:result.row.id,applied:result.applied,created:result.created}));
}
