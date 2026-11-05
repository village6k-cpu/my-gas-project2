"""Persistent health incidents and narrowly scoped idle-service recovery."""
import json
import time
from pathlib import Path
import subprocess
from urllib.request import Request, urlopen

def evaluate(report,health):
    issues=[];g=health.get('gateway',{})
    if report.get('auth_required') is True:issues.append('kakao_login_or_browser_unavailable')
    elif report.get('authenticated') is not True:issues.append('collector_probe_unavailable')
    elif report.get('watcher_ready') is not True:issues.append('collector_not_reading_full_list')
    if report.get('bridge_responding') is not True:issues.append('bridge_unresponsive')
    elif not g.get('consumer',{}).get('fresh') and not report.get('maintenance'):issues.append('reservation_worker_disconnected')
    if g.get('registered_reservation_change',{}).get('oldest_reserved_age_ms',0) and g['registered_reservation_change']['oldest_reserved_age_ms']>600000:issues.append('reservation_write_needs_readback')
    if g.get('unnotified_application_failures',0):issues.append('undelivered_failure_notices')
    if g.get('failure_notification_counts',{}).get('pending',0):issues.append('pending_failure_notices')
    coverage=report.get('coverage') or {}
    if not coverage.get('running') and not coverage.get('complete'):issues.append('reconciliation_scan_incomplete')
    intake=report.get('durable_intake') or {}
    if intake.get('error'):issues.append('durable_storage_failure')
    if intake.get('pending',0):issues.append('unreconciled_intake_backlog')
    return sorted(set(issues))

def stabilize(previous,observed):
    prior=previous.get('condition_state',{});result={};active=[]
    for key in set(prior)|set(observed):
        old=prior.get(key,{})
        if key in observed:
            bad=old.get('bad',0)+1;good=0;stable=old.get('active',False) or bad>=2
        else:
            bad=0;good=old.get('good',0)+1;stable=old.get('active',False) and good<3
        if stable:active.append(key)
        if stable or key in observed:result[key]={'bad':bad,'good':good,'active':stable}
    return sorted(active),result

def transition(previous,issues,now):
    same=previous.get('issues')==issues
    active=bool(issues)
    streak=(previous.get('streak',0)+1) if active and previous.get('issues') else 1
    due=active and streak>=2 and previous.get('last_notified_issues')!=issues and now-previous.get('last_notified_at',-900)>=900
    recovered=not active and bool(previous.get('notified_active'))
    return {**previous,'issues':issues,'streak':streak,'first_seen_at':previous.get('first_seen_at',now) if active and previous.get('issues') else now,'observed_at':now,'notification_due':due or recovered,'notification_kind':'incident' if active else 'recovered','notified_active':previous.get('notified_active',False)}

def can_restart_worker(gateway,worker):
    return gateway.get('consumer',{}).get('fresh') is False and worker.get('owner_verified') is True and worker.get('active_agents')==0 and worker.get('gateway_state')=='running'

def load(path):
    try:return json.loads(path.read_text())
    except (OSError,ValueError):return {}

def atomic(path,data):
    tmp=path.with_suffix('.tmp');tmp.write_text(json.dumps(data,ensure_ascii=False));tmp.chmod(0o600);tmp.replace(path)

def maintain_health(root,report,health):
    control=load(root/'control/reservation-recovery-control.json');drain=load(root/'hermes-root/profiles/kakaoworker/.drain_request.json')
    report['maintenance']=bool(control.get('maintenanceOwner') and drain.get('principal')=='codex-reservation-recovery:'+control['maintenanceOwner'])
    path=root/'state/reservation-recovery.json';now=time.time();report['durable_intake']=load(root/'production-runtime/tools/kakao-dom-bridge/queue/durable-intake-status.json');previous=load(path);raw=evaluate(report,health);stable,conditions=stabilize(previous,raw);state=transition(previous,stable,now);state.update(condition_state=conditions,observed_issues=raw)
    worker=load(root/'hermes-root/profiles/kakaoworker/gateway_state.json')
    from supervisor import gateway_owned
    worker['owner_verified']=gateway_owned(worker,root/'hermes-root/profiles/kakaoworker',root/'hermes-worker-code')
    if state['streak']>=3 and can_restart_worker(health.get('gateway',{}),worker) and now-state.get('last_worker_restart',0)>600:
        result=subprocess.run(['launchctl','kickstart','-k',f'gui/{__import__("os").getuid()}/com.village.migrated.worker'],capture_output=True,timeout=15)
        state['last_worker_restart']=now;state['worker_restart_ok']=result.returncode==0
    state['intake_status']=report['durable_intake'];state['coverage_status']=report.get('coverage')
    if state['issues'] and state['streak']>=2 and (state.get('published_issues')!=state['issues'] or now-state.get('dashboard_published_at',0)>=300):
        try:
            pending=root/'state/reservation-recovery-publish.json';atomic(pending,state)
            manifest=load(root/'control/runtime.json');node=manifest['services']['bridge']['argv'][0]
            published=subprocess.run([node,str(root/'control/reservation-recovery/publish-status.mjs'),str(root),str(pending)],capture_output=True,text=True,timeout=15)
            if published.returncode==0:state.update(published_issues=state['issues'],dashboard_published_at=now,dashboard_item=json.loads(published.stdout).get('id'))
            else:state['dashboard_publish_failed_at']=now
        except (OSError,ValueError,KeyError,subprocess.TimeoutExpired):state['dashboard_publish_failed_at']=now
    notification=load(root/'control/reservation-recovery-notifications.json')
    if state['notification_due'] and notification.get('channel'):
        env=load(root/'control/bridge.env.json');text=('🚨 헤이빌리 자동반영 복구 필요\n'+'\n'.join('- '+{'collector_probe_unavailable':'카카오 수신 상태 확인 지연','collector_not_reading_full_list':'카카오 대화 수신 중단','kakao_login_or_browser_unavailable':'카카오 로그인 또는 브라우저 확인 필요','bridge_unresponsive':'수신 프로그램 응답 지연','reservation_worker_disconnected':'예약 처리기 연결 끊김','reservation_write_needs_readback':'저장 결과 확인이 필요한 예약 기록','undelivered_failure_notices':'담당자에게 전달되지 않은 실패 확인 기록','pending_failure_notices':'전달 확인이 필요한 실패 알림','reconciliation_scan_incomplete':'최근 대화의 누락 대조 미완료','durable_storage_failure':'수신 원문 저장소 오류','unreconciled_intake_backlog':'안전하게 저장된 대화의 처리 대기'}.get(x,x) for x in state['issues'])+'\n자동 감시·재시도 중입니다. 예약 저장이 불확실한 작업은 중복 실행하지 않고 확인 대상으로 보존합니다.') if state['issues'] else '✅ 헤이빌리 자동반영 장애 감시에서 활성 장애가 해소되었습니다. 개별 예약 누락은 별도 대조 결과로 확인합니다.'
        operational={'collector_probe_unavailable','collector_not_reading_full_list','kakao_login_or_browser_unavailable','bridge_unresponsive','reservation_worker_disconnected','durable_storage_failure'}
        if state['issues'] and not operational.intersection(state['issues']):
            text=text.replace('🚨 헤이빌리 자동반영 복구 필요','📋 헤이빌리 자동반영 대조 현황\n현재 카카오 수신·예약 처리기는 연결되어 있습니다. 아래는 남아 있는 대조 작업입니다.')
        body=json.dumps({'channel':notification['channel'],'text':text+'\n확인: https://today-dashboard-ten.vercel.app/follow-ups','client_msg_id':str(__import__('uuid').uuid5(__import__('uuid').NAMESPACE_URL,str(state['first_seen_at'])+json.dumps(state['issues'])))}).encode()
        try:
            request=Request('https://slack.com/api/chat.postMessage',data=body,headers={'Authorization':'Bearer '+env['SLACK_BOT_TOKEN'],'Content-Type':'application/json'})
            with urlopen(request,timeout=8) as response:sent=json.load(response)
            if sent.get('ok'):
                state.update(last_notified_at=now,notified_active=bool(state['issues']),notification_due=False,last_notified_issues=state['issues'],slack_ts=sent.get('ts'))
        except (OSError,ValueError):state['notification_failed_at']=now
    atomic(path,state)
    return {k:v for k,v in state.items() if k not in ('slack_ts',)}
