"""Private Windows adapter for a prepared five-service source stop.

This adapter never starts the scheduler broker, pauses a watcher or announces a
quiet window. Those preparations must have real, bound receipts before --stop.
--verify-only is read-only. No source action occurs on import.
"""
import argparse
import copy
from collections import Counter
from contextlib import closing
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time
from urllib.request import Request, urlopen
import psutil

import migration_source_recovery as checks
import migration_source_recovery_executor as recovery
import migration_source_stop as transaction
import migration_closed_capture as capture


def identity_alive(row):
    try:return abs(psutil.Process(row['pid']).create_time()-row['started'])<.01
    except psutil.NoSuchProcess:return False


def exact_process(row):
    p=psutil.Process(row['pid'])
    if (abs(p.create_time()-row['started'])>=.01
            or checks.norm(p.exe())!=checks.norm(row['exe'])
            or p.cmdline()!=row['argv'] or checks.norm(p.cwd())!=checks.norm(row['cwd'])):
        raise RuntimeError('source_identity_or_execution_contract_changed')
    if 'home' in row:
        env=p.environ()
        if env.get('HERMES_HOME')!=row['home'] or env.get('PYTHONPATH')!=row.get('pythonpath'):
            raise RuntimeError('source_environment_changed')
    return p


def terminate_exact_tree(owner, children, *, wait_seconds=15):
    """Used only after all stop gates and ACK. Never terminate an unknown child."""
    p=exact_process(owner)
    actual={c.pid:c.create_time() for c in p.children(recursive=True)}
    expected={c['pid']:c['started'] for c in children}
    if (set(actual)!=set(expected)
            or any(abs(actual[pid]-expected[pid])>=.01 for pid in actual)):
        raise RuntimeError('recursive_source_child_inventory_changed')
    for child in children:exact_process(child)
    # Closing the parent releases MCP stdin first, allowing store clients to
    # finish their own exit. Already idle work and WAL are independently proven.
    p.terminate()
    try:p.wait(timeout=wait_seconds)
    except psutil.TimeoutExpired:raise RuntimeError('owned_source_parent_did_not_exit') from None
    remaining=[psutil.Process(c['pid']) for c in children if identity_alive(c)]
    _,alive=psutil.wait_procs(remaining,timeout=min(wait_seconds,3))
    by_pid={c['pid']:c for c in children}
    for child in alive:
        exact_process(by_pid[child.pid]).terminate()
    _,alive=psutil.wait_procs(alive,timeout=wait_seconds)
    if alive or identity_alive(owner) or any(identity_alive(c) for c in children):
        raise RuntimeError('owned_source_child_did_not_exit')


def validate_gateway_drain(owner,state,*,pending,cron,now=None):
    now=time.time() if now is None else now
    try:
        stamp=datetime.fromisoformat(state['updated_at'].replace('Z','+00:00'))
        if stamp.tzinfo is None or not 0<=now-stamp.timestamp()<=5:raise ValueError('stale_gateway_drain_heartbeat')
    except (KeyError,TypeError,AttributeError):raise ValueError('gateway_drain_heartbeat_missing') from None
    if (state.get('pid')!=owner['pid'] or state.get('start_time')!=round(owner['started']*100)
            or state.get('gateway_state')!='draining'
            or type(state.get('active_agents')) is not int or state['active_agents']!=0
            or type(pending) is not int or pending!=0 or type(cron) is not int or cron!=0):
        raise ValueError('gateway_accepted_work_not_drained')


def validate_hold_endpoint(endpoint,intake,phase_sha):
    pump=endpoint.get('forwarder',{});counts=endpoint.get('counts')
    if (endpoint.get('status')!='ok' or endpoint.get('role')!='durable_voice_intake'
            or pump.get('config_sha256')!=intake['config_sha256'] or pump.get('epoch')!=intake['epoch']
            or pump.get('phase_sha256')!=phase_sha or pump.get('authority') is not None
            or pump.get('thread_alive') is not True or pump.get('failed') is not False
            or not checks.number(pump.get('evaluation_age_seconds')) or not 0<=pump['evaluation_age_seconds']<=2
            or not isinstance(counts,dict) or any(type(n) is not int or n<0 for n in counts.values())
            or counts.get('dispatching',0)!=0 or counts.get('uncertain',0)!=0):
        raise ValueError('voice_endpoint_does_not_match_bound_hold')


def digest_file(p):
    h=hashlib.sha256()
    with Path(p).open('rb') as f:
        for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
    return h.hexdigest()


def write_new(path,value):
    raw=json.dumps(value,separators=(',',':')).encode()
    # Publish only after complete bytes have been fsynced. The destination is
    # immutable; a failed/repeated attempt cannot replace another receipt.
    import uuid
    p=Path(path);tmp=p.with_name(p.name+'.'+uuid.uuid4().hex+'.tmp')
    with tmp.open('xb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
    try:os.link(tmp,p)
    finally:tmp.unlink()
    return hashlib.sha256(raw).hexdigest()


class WindowsStopAdapter:
    def __init__(self,plan_path,plan_sha):
        self.plan_path=Path(plan_path).resolve();self.plan_sha=plan_sha
        if not self.plan_path.is_relative_to(checks.BASE.resolve()):raise ValueError('private_stop_plan_required')
        self.plan=recovery.read_bound(self.plan_path,plan_sha)
        if self.plan.get('schema')!='village-current-source-stop-plan/v1':raise ValueError('wrong_stop_plan_schema')
        self.control=Path(self.plan['control']).resolve()
        if self.control!=checks.CONTROL.resolve():raise ValueError('current_scheduler_control_required')
        if os.environ.get('HERMES_HOME')!=str(checks.BASE/'migration-controller-home') or os.environ.get('PYTHONPATH'):
            raise ValueError('isolated_controller_environment_required')
        self.intent=self.reference(self.plan['intent']);self.intent_sha=self.plan['intent']['sha256']
        if sorted(r.get('role') for r in self.intent['profiles'])!=sorted(checks.ROLES):raise ValueError('five_current_source_roles_required')
        self.owners={r['role']:r for r in self.intent['profiles']}
        if Path(self.plan['queue']).resolve()!=(Path(self.owners['bridge']['cwd'])/'queue').resolve():
            raise ValueError('current_source_queue_required')
        self.inputs={'scheduler_manifest':self.plan['scheduler_manifest']}
        self.inventory=None;self.closed=set();self.participant=None;self.last={};self.obligations=None
        self.verify_bindings()

    def bound_path(self,ref):
        original=Path(ref['path']).absolute();p=original.resolve()
        if checks.norm(str(original))!=checks.norm(str(p)):raise ValueError('private_binding_symlink_or_redirect')
        if not p.is_relative_to(checks.BASE.parent.resolve()):raise ValueError('reference_outside_migration_staging')
        if digest_file(p)!=ref['sha256']:raise ValueError('private_stop_binding_changed')
        return p

    def runtime_path(self,ref,kind):
        known={
            'injector':Path('C:/Village/runtimes/my-gas-project2-production/tools/kakao-dom-bridge/inject-watcher-cdp.py'),
            'node':Path('C:/Users/ssper/AppData/Local/Microsoft/WinGet/Packages/OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe/node-v24.18.0-win-x64/node.exe')}
        p=Path(ref['path']).absolute()
        if p.resolve()!=known[kind].resolve() or checks.norm(str(p))!=checks.norm(str(p.resolve())):
            raise ValueError('immutable_runtime_binding_substituted')
        if digest_file(p)!=ref['sha256']:raise ValueError('immutable_runtime_binding_changed')
        return p

    def reference(self,ref):return json.loads(self.bound_path(ref).read_text(encoding='utf-8-sig'))

    def verify_bindings(self):
        if recovery.read_bound(self.plan_path,self.plan_sha)!=self.plan:raise ValueError('stop_plan_changed')
        dependencies=self.plan['dependencies']
        required={Path(x.__file__).resolve() for x in (checks,recovery,transaction,capture)}|{Path(__file__).resolve()}
        if not required.issubset({Path(r['path']).resolve() for r in dependencies}):raise ValueError('stop_code_inventory_incomplete')
        for ref in dependencies:
            if digest_file(ref['path'])!=ref['sha256']:raise ValueError('stop_dependency_changed')
        for field in ('intent','scheduler_manifest','browser','watcher_pause','owned_drains','voice_intake','slack_quiet','entrypoints','bridge_environment'):
            self.reference(self.plan[field])
        for field in ('watcher_helper','guard_helper'):
            self.bound_path(self.plan[field])
        for field in ('injector','node'):self.runtime_path(self.plan[field],field)

    def assert_fence_lease(self):return recovery.WindowsAdapter.assert_fence_lease(self)

    def inspect_gateway(self,role):
        row=self.owners[role];home=Path(row['home']);state=json.loads((home/'gateway_state.json').read_text())
        # The reviewed source refreshes this aggregate on every one-second
        # drain tick, including API/cron work outside messaging-agent slots.
        before=state.get('updated_at');deadline=time.monotonic()+4
        while time.monotonic()<deadline:
            time.sleep(.15);state=json.loads((home/'gateway_state.json').read_text())
            if state.get('updated_at')!=before:break
        else:raise ValueError('gateway_drain_heartbeat_not_advancing')
        pending=len(list((home/'pending_messages').glob('*.json')))
        cron_path=home/'cron/executions.db'
        if cron_path.exists():
            with closing(sqlite3.connect(cron_path.as_uri()+'?mode=ro',uri=True,timeout=3)) as db:
                cron=db.execute("SELECT count(*) FROM executions WHERE status='running'").fetchone()[0]
        else:
            # The worker has no cron database in the observed source. Root does.
            if role=='root':raise ValueError('root_cron_database_missing')
            cron=0
        validate_gateway_drain(row,state,pending=pending,cron=cron)
        return dict(pid=row['pid'],started=row['started'],gateway_state='draining',active_agents=0,pending_messages=pending,running_cron=cron)

    def inspect_watcher(self):
        ref=self.plan['watcher_helper'];self.bound_path(ref)
        spec=importlib.util.spec_from_file_location('owned_stop_watcher',ref['path']);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        if Path(m.INJECTOR).resolve()!=Path(self.plan['injector']['path']).resolve():raise ValueError('source_cdp_helper_substituted')
        browser=self.reference(self.plan['browser'])
        row=m.operate(browser,'inspect',Path(self.plan['watcher_pause']['path']))
        r=row['readback']
        if (r.get('enabled') is not False or r.get('pauseOwnedByReceipt') is not True
                or r.get('deepRunning') is not False
                or not (r.get('extensionStatus')=='stopped'
                    or (r.get('extensionStatus') is None and r.get('extensionInactiveVerified') is True
                        and r.get('extensionRuntimeInventoryEmpty') is True))):
            raise ValueError('source_watcher_not_owned_and_paused')
        # Read the existing Playwright binding's callbacks without running it.
        spec=importlib.util.spec_from_file_location('owned_stop_cdp',m.INJECTOR);cdp=importlib.util.module_from_spec(spec);spec.loader.exec_module(cdp)
        pages=[p for p in cdp.load_pages(m.PORT) if p.get('id')==row['target']]
        if len(pages)!=1:raise ValueError('source_browser_target_changed')
        c=cdp.CDPWebSocket(pages[0]['webSocketDebuggerUrl']);c.connect()
        try:
            q=c.call('Runtime.evaluate',{'expression':"(()=>{const c=globalThis.__playwright__binding__controller__;const b=c?._bindings;const d=b instanceof Map?b.get('__villageRecoveryRelay_incidentgateway20261024'):null;return {present:!!d,removed:d?.removed,callbacks:d?.callbacks instanceof Map?d.callbacks.size:null};})()",'returnByValue':True})
            if q.get('error') or q.get('result',{}).get('exceptionDetails'):raise ValueError('source_browser_binding_unobservable')
            binding=q['result']['result']['value']
        finally:c.close()
        if binding!={'present':True,'removed':False,'callbacks':0}:raise ValueError('source_browser_relay_callbacks_remain')
        return row

    def inspect_quiet(self):
        quiet=self.reference(self.plan['slack_quiet']);owner=self.owners['root']
        if (quiet.get('schema')!='village-source-slack-quiet-start/v1'
                or not checks.same_identity(quiet.get('source'),owner)
                or quiet.get('operator_quiet_authorized') is not True
                or type(quiet.get('started_unix')) not in (int,float)
                or not 300<=time.time()-quiet['started_unix']<3600
                or type(quiet.get('messages_high_water')) is not int):raise ValueError('actual_slack_quiet_window_required')
        path=Path(owner['home'])/'state.db'
        with closing(sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=3)) as db:
            new=db.execute("SELECT count(*) FROM messages m JOIN sessions s ON s.id=m.session_id WHERE m.id>? AND m.role='user' AND s.source='slack'",(quiet['messages_high_water'],)).fetchone()[0]
        if new:raise ValueError('new_slack_input_during_quiet_window')
        return {'settled_seconds':time.time()-quiet['started_unix'],'new_input_observed':False,'quiet_start_sha256':self.plan['slack_quiet']['sha256']}

    def inspect_external(self):
        env=self.reference(self.plan['bridge_environment']);base=env.get('SUPABASE_URL','').rstrip('/');key=env.get('SUPABASE_SERVICE_ROLE_KEY')
        if base!='https://tedffwpijiylklfuzkua.supabase.co' or not key:raise ValueError('source_external_read_authority_missing')
        req=Request(base+'/rest/v1/rpc/read_work_orchestrator_health_v2',data=json.dumps({'p_now':datetime.now(timezone.utc).isoformat()}).encode(),method='POST',headers={'apikey':key,'Authorization':'Bearer '+key,'Content-Type':'application/json'})
        with urlopen(req,timeout=12) as r:health=json.load(r)
        leases=health.get('leases',{})
        for role in ('p0','digest','digest_cleanup','notice_cleanup'):
            for k in ('active_count','expired_count'):
                if type(leases.get(role,{}).get(k)) is not int or leases[role][k]!=0:raise ValueError('external_delivery_lease_outstanding')
        table=env.get('SUPABASE_FOLLOW_UP_TABLE','ai_follow_up_items')
        if not re.fullmatch('[a-z_][a-z0-9_]*',table):raise ValueError('legacy_action_table_changed')
        from urllib.parse import urlencode
        req=Request(base+'/rest/v1/'+table+'?'+urlencode({'select':'id','payload->slack_action->>status':'in.(pending,processing)'}),method='HEAD',headers={'apikey':key,'Authorization':'Bearer '+key,'Prefer':'count=exact'})
        with urlopen(req,timeout=12) as r:count=r.headers.get('Content-Range','').rsplit('/',1)[-1]
        if count!='0':raise ValueError('external_legacy_action_outstanding_or_unknown')
        return {'leases_zero':True,'legacy_pending_or_processing':0}

    def inspect_native(self):
        remote=checks.collect_remote();now=time.time()
        if (not checks.fresh(remote.get('observed_at'),now) or remote.get('host')!=checks.REMOTE_HOST
                or remote.get('candidate')!=checks.CANDIDATE or remote.get('inactive') is not True
                or remote.get('activation_absent') is not True or remote.get('domain_verified') is not True
                or remote.get('uid')!=501 or remote.get('errors')!=[]
                or remote.get('labels')!={x:'unloaded' for x in checks.FUTURE_LABELS}):raise ValueError('fresh_native_inactivity_required')
        return remote

    def inspect_voice(self):
        # Native time is used only by its pump. This checks HOLD, with no lease
        # renewal or request submission. Original public URLs must both buffer.
        intake=self.reference(self.plan['voice_intake'])
        script=r'''from pathlib import Path
from contextlib import closing
import hashlib,json,sqlite3,subprocess
from urllib.request import urlopen
C=Path('/Users/choijaehyeong/VillageMigration/20260930-windows/candidate');D=C/'state/voice-ingress-v1'
raw=(D/'config.json').read_bytes();cfg=json.loads(raw);praw=(D/'phase.json').read_bytes();phase=json.loads(praw)
with urlopen('http://127.0.0.1:18788/health',timeout=5) as r:front=json.load(r)
with closing(sqlite3.connect((D/'voice.sqlite3').as_uri()+'?mode=ro',uri=True)) as db:conflicts=db.execute('SELECT count(*) FROM conflicts').fetchone()[0]
q=subprocess.run(['/Applications/Tailscale.app/Contents/MacOS/Tailscale','serve','status','--json'],capture_output=True,text=True,timeout=10,check=True)
s=json.loads(q.stdout);host='mac-studio.tail7f97ff.ts.net:443'
print(json.dumps({'config_sha256':hashlib.sha256(raw).hexdigest(),'epoch':cfg['epoch'],'source':cfg['source'],'phase':phase,'phase_sha256':hashlib.sha256(praw).hexdigest(),'front':front,'conflicts':conflicts,'mac_route':s.get('Web',{}).get(host,{}).get('Handlers',{}).get('/watch/voice')=={'Proxy':'http://127.0.0.1:18788'} and s.get('AllowFunnel',{}).get(host) is True,'inactive':(C/'MIGRATION-INACTIVE').exists() and not (C/'ACTIVATION.json').exists()}))
'''
        run=subprocess.run(['C:/Windows/System32/OpenSSH/ssh.exe','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','-i',checks.SSH_KEY,checks.REMOTE_HOST,checks.CANDIDATE+'/venv-root/bin/python -'],input=script.encode(),capture_output=True,timeout=25,check=True)
        v=json.loads(run.stdout);front=v['front'];pump=front.get('forwarder',{});counts=front.get('counts',{})
        serve=json.loads(subprocess.check_output(['C:/Program Files/Tailscale/tailscale.exe','serve','status','--json'],text=True,timeout=10));host='ax2.tail7f97ff.ts.net:443'
        legacy=serve.get('Web',{}).get(host,{}).get('Handlers',{}).get('/watch/voice')=={'Proxy':'http://127.0.0.1:18788'} and serve.get('AllowFunnel',{}).get(host) is True
        with urlopen('http://127.0.0.1:18788/health',timeout=5) as r:local=json.load(r)
        validate_hold_endpoint(front,intake,v['phase_sha256'])
        validate_hold_endpoint(local,intake,v['phase_sha256'])
        if (v['config_sha256']!=intake['config_sha256'] or v['epoch']!=intake['epoch'] or v['source']!=intake['source']
                or v['phase'].get('mode')!='hold' or v['phase'].get('epoch')!=intake['epoch'] or v['phase'].get('source')!=intake['source']
                or v['mac_route'] is not True or not legacy or v['inactive'] is not True
                or front.get('status')!='ok' or front.get('role')!='durable_voice_intake'
                or local.get('role')!='durable_voice_intake' or v['conflicts']!=0
                or pump.get('authority') is not None or pump.get('thread_alive') is not True or pump.get('failed') is not False
                or pump.get('phase_sha256')!=v['phase_sha256'] or pump.get('config_sha256')!=intake['config_sha256']
                or not checks.number(pump.get('evaluation_age_seconds')) or not 0<=pump['evaluation_age_seconds']<=2
                or not isinstance(counts,dict) or any(type(n) is not int or n<0 for n in counts.values())
                or counts.get('dispatching',0)!=0 or counts.get('uncertain',0)!=0):raise ValueError('public_voice_not_safely_buffering')
        row=self.owners['voice'];result={'pid':row['pid'],'started':row['started'],'ingress_mode':'hold','ingress_dispatching':0,'ingress_epoch':intake['epoch']}
        if 'voice' not in self.closed:
            p=exact_process(row);state=json.loads((Path(row['cwd'])/'relay-state.json').read_text());receipts=dict(Counter(x.get('status') for x in state['requests'].values()))
            result.update(threads=p.num_threads(),non_listening_tcp_connections=sum(c.status!=psutil.CONN_LISTEN for c in p.net_connections(kind='tcp')),receipt_status_counts=receipts)
            if result['threads']!=1 or result['non_listening_tcp_connections']!=0 or any(k!='webhook_accepted' for k in receipts):raise ValueError('source_voice_requests_not_drained')
        return result

    def gate(self,stage):
        self.verify_bindings();recovery.WindowsAdapter.assert_fenced(self);remote=self.inspect_native()
        for role,row in self.owners.items():
            if role in self.closed:
                if identity_alive(row):raise ValueError('closed_source_reappeared')
                continue
            p=exact_process(row)
            if self.inventory is not None:
                current={c.pid:c.create_time() for c in p.children(recursive=True)};old={c['pid']:c['started'] for c in self.inventory[role]}
                if current!=old:raise ValueError('source_children_changed_after_inventory')
        drains=self.reference(self.plan['owned_drains'])
        if (drains.get('schema')!='village-owned-drains/v1' or drains.get('intent_sha256')!=self.intent_sha
                or sorted(x['role'] for x in drains['profiles'])!=['root','worker']):raise ValueError('owned_profile_drains_required')
        self.last={}
        for role in ('root','worker'):
            if role in self.closed:continue
            row=next(x for x in drains['profiles'] if x['role']==role)
            marker=Path(self.owners[role]['home'])/'.drain_request.json'
            if (Path(row['path']).resolve()!=marker.resolve() or row.get('created') is not True
                    or row.get('original_absent') is not True or not checks.same_identity(row.get('owner'),self.owners[role])
                    or digest_file(marker)!=row['sha256']):raise ValueError('owned_drain_marker_changed')
            data=json.loads(marker.read_text())
            if (data.get('migration_id')!=drains['migration_id'] or data.get('action')!='drain'
                    or data.get('principal')!='village-studio-migration:'+drains['migration_id']
                    or not checks.same_identity(data.get('owner'),self.owners[role])):raise ValueError('drain_not_owned_by_current_migration')
            self.last[role]=self.inspect_gateway(role)
        self.last['slack_quiet']=self.inspect_quiet();self.inspect_watcher();self.last['voice']=self.inspect_voice();self.inspect_external()
        guard=self.plan['guard_helper'];self.bound_path(guard)
        spec=importlib.util.spec_from_file_location('owned_stop_guard',guard['path']);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        # Source owners that remain alive are exempted; closed owners must not be
        # reconstructed from a stale pid. The guard's writer-stopped mode still
        # includes this controller and its ancestors and scans every entrypoint.
        live_intent={'profiles':[r for r in self.intent['profiles'] if r['role'] not in self.closed]}
        g=m.inventory(live_intent,self.reference(self.plan['entrypoints']))
        if g.get('drained') is not True:raise ValueError('detached_scheduled_writer_remains')
        if stage=='before_participant':
            with urlopen('http://127.0.0.1:8787/health',timeout=8) as r:h=json.load(r)
            q=h['gateway']['queue'];state=h['state']
            if any(type(q.get(k)) is not int or q[k]!=0 for k in ('ready','claimed','retry')) or state.get('activeWorkerRuns')!=0 or state.get('workerQueueLength')!=0:
                raise ValueError('bridge_accepted_queue_not_settled')
            self.bridge_before=h
        if self.obligations:
            actual={p.relative_to(Path(self.plan['queue'])).as_posix() for p in Path(self.plan['queue']).rglob('*') if p.is_file()}
            if actual!={r['path'] for r in self.obligations['files']}:raise ValueError('retained_queue_file_inventory_changed')
            for row in self.obligations['files']:
                if digest_file(Path(self.plan['queue'])/row['path'])!=row['sha256']:raise ValueError('retained_queue_changed_after_closure')
        # Reuse the existing near-candidate/descendant/store checks. The sole
        # projection is the intentionally closed bridge HTTP listener while its
        # exact process remains alive. No fabricated listener is introduced.
        inventory=self.inventory or {r:[] for r in checks.ROLES}
        receipt={'schema':1,'intent_sha256':self.intent_sha,'stopped_at':time.time(),
                 'reconciled_from_sha256':self.plan_sha,'stop_attempt_only':not self.closed,
                 'profiles':[{'role':r,'pid':o['pid'],'started':o['started'],'status':'stopped' if r in self.closed else 'unaffected',
                              'children_inventory_complete':True,'children':inventory[r]} for r,o in self.owners.items()]}
        snapshot=checks.collect_source(self.intent,receipt);projection=copy.deepcopy(self.intent)
        if stage!='before_participant' and 'bridge' not in self.closed:
            if any(c['port']==8787 for c in snapshot['listeners']):raise ValueError('bridge_http_listener_not_closed')
            next(r for r in projection['profiles'] if r['role']=='bridge')['ports']=[]
        # Retained queue verification may hash gigabytes. Its initial native
        # observation must not become stale authority for the final decision.
        remote=self.inspect_native()
        plan=checks.build_plan(projection,receipt,self.intent_sha,snapshot,remote,now=time.time(),activated=(self.control/'MAC_EVER_ACTIVATED').exists())
        if not plan['ready']:raise ValueError('source_stop_ownership_gate:'+','.join(plan['errors']))
        self.assert_fence_lease()

    def inventory_children(self):
        result={}
        for role,owner in self.owners.items():
            children=exact_process(owner).children(recursive=True);rows=[]
            for c in children:
                name=c.name().lower()
                if name not in ({'conhost.exe','gbrain.exe','bun.exe'} if role=='root' else {'conhost.exe'}):raise ValueError('active_or_unknown_source_child')
                rows.append({'pid':c.pid,'started':c.create_time(),'exe':c.exe(),'argv':c.cmdline(),'cwd':c.cwd()})
            result[role]=rows
        self.inventory=result;return result

    def persist(self,name,value):return write_new(self.control/name,value)
    def clock(self):return time.time()

    def start_bridge_participant(self):
        ref=self.plan['participant'];config=self.reference(ref);d=Path(ref['path']).parent
        if config['intent']!=self.plan['intent']:raise ValueError('bridge_participant_intent_changed')
        self.participant_config=config;self.participant_directory=d
        self.persist('bridge-before-close.json',self.bridge_before)
        for name in ('STARTED.json','STOP-ACK.json','RESULT.json','FAILED.json'):
            if (d/name).exists():raise ValueError('bridge_participant_attempt_already_used')
        log=(self.control/'bridge-participant.stdout.log').open('xb');err=(self.control/'bridge-participant.stderr.log').open('xb')
        env=dict(os.environ);env.pop('PYTHONPATH',None);env['HERMES_HOME']=str(checks.BASE/'migration-controller-home')
        try:
            self.participant=subprocess.Popen([self.plan['node']['path'],str(d/'migration_bridge_stop_cli.mjs'),'--config',ref['path'],'--config-sha',ref['sha256'],'--run'],env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=err,creationflags=subprocess.CREATE_NO_WINDOW)
            child=psutil.Process(self.participant.pid)
            self.persist('bridge-participant-owner.json',{'pid':child.pid,'started':child.create_time(),'exe':child.exe(),'argv':child.cmdline(),'cwd':child.cwd(),
                'home':env['HERMES_HOME'],'pythonpath':None})
        finally:log.close();err.close()

    def wait_file(self,name,timeout=90):
        end=time.monotonic()+timeout;p=self.participant_directory/name
        while time.monotonic()<end:
            if p.exists():return json.loads(p.read_text())
            if self.participant is None or (self.participant.poll() is not None if isinstance(self.participant,subprocess.Popen) else not self.participant.is_running()):
                raise RuntimeError('bridge_participant_exited_before_'+name)
            time.sleep(.1)
        raise TimeoutError('bridge_participant_timeout_'+name)

    def wait_bridge_ready(self):
        pointer=self.wait_file('READY.json');config=self.participant_config
        if pointer.get('controller_id')!=config['controller_id'] or pointer.get('intent_sha256')!=self.intent_sha:raise ValueError('bridge_ready_owner_changed')
        pin=pointer['sha256'];path=self.participant_directory/'observations'/(pin+'.json')
        value=recovery.read_bound(path,pin)
        if not 0<=time.time()*1000-value['observed_unix_ms']<=10000:raise ValueError('bridge_ready_stale')
        return {'sha256':pin,'evidence':value}

    def accepted_work(self,ready):
        queue=Path(self.plan['queue']);files=[]
        for path in sorted(queue.rglob('*')):
            if path.is_symlink():raise ValueError('queue_symlink')
            if path.is_file():files.append({'path':path.relative_to(queue).as_posix(),'sha256':digest_file(path),'bytes':path.stat().st_size})
        self.obligations={'schema':'village-preserved-source-obligations/v1','intent_sha256':self.intent_sha,'replay_authorized':False,'files':files}
        pin=self.persist('preserved-obligations.json',self.obligations)
        # Queue history can exceed a gigabyte. Refresh readiness after its
        # hashing, so the exact command still uses a fresh idle observation.
        current=self.wait_bridge_ready();ready.clear();ready.update(current)
        evidence=ready['evidence'];report=evidence['observation'];p=report['producer'];w=report['private_work'];n=report['native_promises'];h=report['http']
        if (evidence.get('intent_sha256')!=self.intent_sha or evidence.get('controller_id')!=self.participant_config['controller_id']
                or report.get('idle') is not True or h.get('http_closed') is not True or h.get('producer_fence_owned') is not True
                or p.get('mode')!='fenced' or p.get('producers_owned') is not True
                or any(type(p.get(k)) is not int or p[k]!=0 for k in ('pending_handlers','pending_producers','pending_tracked_work'))
                or w.get('idle') is not True or w.get('owner',{}).get('pid')!=self.owners['bridge']['pid']
                or n.get('complete') is not True or n.get('idle') is not True or n.get('counts',{}).get('pending')!=0):raise ValueError('actual_bridge_accepted_work_not_settled')
        rows={role:dict(pid=r['pid'],started=r['started']) for role,r in self.owners.items()}
        for role in ('root','worker'):rows[role].update(self.last[role])
        rows['voice'].update(self.last['voice']);rows['relay']['owned_producer_paused']=True
        rows['bridge'].update(drained=True,http_closed=True,preexisting_work_verified=True,pending_handlers=0,pending_tracked_work=0)
        proof={'schema':'village-current-accepted-work-closure/v1','intent_sha256':self.intent_sha,'owners':rows,
               'bridge_observation_sha256':ready['sha256'],'slack_quiet':self.last['slack_quiet'],
               'preserved_obligations':{'replay_authorized':False,'manifest_sha256':pin}}
        raw=json.dumps(proof,separators=(',',':')).encode();proof_sha=hashlib.sha256(raw).hexdigest()
        capture.validate_work_closure(proof,{'accepted_work_sha256':proof_sha,'intent_sha256':self.intent_sha},self.intent,proof_sha)
        return proof

    def command_bridge_stop(self,ready):
        c=self.participant_config
        write_new(self.participant_directory/'COMMAND.json',{'action':'stop','controller_id':c['controller_id'],'intent_sha256':self.intent_sha,'observation_sha256':ready['sha256']})

    def wait_bridge_ack(self,ready):
        ack=self.wait_file('STOP-ACK.json',15);c=self.participant_config
        if (ack.get('action')!='stop' or ack.get('controller_id')!=c['controller_id'] or ack.get('intent_sha256')!=self.intent_sha
                or ack.get('observation_sha256')!=ready['sha256'] or ack.get('source_pid')!=self.owners['bridge']['pid']
                or not 0<=time.time()*1000-ack.get('acknowledged_unix_ms',0)<=15000):raise ValueError('bridge_stop_ack_not_bound')

    def terminate_owned_tree(self,role,children):
        terminate_exact_tree(self.owners[role],children);self.closed.add(role)

    def classify_tree(self,role,children):
        states=[identity_alive(x) for x in [self.owners[role]]+children]
        return 'stopped' if not any(states) else 'unaffected' if all(states) else 'partial'

    def wait_bridge_exit(self,ready):
        r=self.wait_file('RESULT.json',20)
        if r.get('bridge_exit_observed') is not True or r.get('accepted_observation_sha256')!=ready['sha256'] or r.get('intent_sha256')!=self.intent_sha:
            raise ValueError('bridge_exit_observation_missing')

    def stop_request_present(self):return (self.control/'SOURCE_STOP_REQUESTED').exists()

    def abort_bridge_participant(self,*,reconciliation=False):
        if self.stop_request_present() and not reconciliation:raise ValueError('post_intent_abort_requires_reconciliation')
        if self.participant is None:
            ref=self.plan['participant'];self.participant_config=self.reference(ref);self.participant_directory=Path(ref['path']).parent
            owner=self.control/'bridge-participant-owner.json'
            if owner.exists():
                prior=json.loads(owner.read_text())
                if identity_alive(prior):self.participant=exact_process(prior)
        alive=self.participant is not None and (self.participant.poll() is None if isinstance(self.participant,subprocess.Popen) else self.participant.is_running())
        if alive:
            c=self.participant_config;p=self.participant_directory/'COMMAND.json'
            if p.exists():
                prior=json.loads(p.read_text())
                if prior.get('controller_id')!=c['controller_id'] or prior.get('intent_sha256')!=self.intent_sha:raise ValueError('foreign_participant_command')
            temp=p.with_name('abort-'+str(os.getpid())+'.json')
            write_new(temp,{'action':'abort','controller_id':c['controller_id'],'intent_sha256':self.intent_sha,'observation_sha256':None})
            os.replace(temp,p)
            result=self.wait_file('RESULT.json',30)
            if result.get('aborted') is not True:raise ValueError('bridge_abort_not_observed')
        else:
            ref=self.plan['participant'];d=Path(ref['path']).parent
            q=subprocess.run([self.plan['node']['path'],str(d/'migration_bridge_stop_cli.mjs'),'--config',ref['path'],'--config-sha',ref['sha256'],'--recover-http'],capture_output=True,text=True,timeout=45)
            if q.returncode:raise RuntimeError('owned_http_recovery_requires_inspection')
            result=json.loads(q.stdout)
            if result.get('http_recovered') is not True or result.get('producer_still_fenced') is not True:raise ValueError('owned_http_not_recovered')
        return result

    def reconcile_partial(self,*,publish=False):
        """Adjudicate a failed attempt only after its parent is independently gone."""
        owner=json.loads((self.control/'source-stop-controller-owner.json').read_text())
        if owner.get('plan_sha256')!=self.plan_sha:raise ValueError('source_stop_controller_plan_changed')
        if identity_alive(owner):raise ValueError('source_stop_controller_still_alive')
        self.verify_bindings();recovery.WindowsAdapter.assert_fenced(self);remote=self.inspect_native()
        path=self.control/'source-stop-partial-receipt.json';pin=digest_file(path);partial=json.loads(path.read_text())
        marker=json.loads((self.control/'SOURCE_STOP_REQUESTED').read_text())
        if (marker.get('intent_sha256')!=self.intent_sha or partial.get('intent_sha256')!=self.intent_sha
                or marker.get('accepted_work_sha256')!=partial.get('accepted_work_sha256')
                or marker.get('child_inventory_sha256')!=partial.get('child_inventory_sha256')
                or digest_file(self.control/'source-child-inventory.json')!=partial['child_inventory_sha256']
                or digest_file(self.control/'accepted-work-closure.json')!=partial['accepted_work_sha256']):
            raise ValueError('partial_stop_not_bound_to_actual_intent_and_inventory')
        self.inventory=json.loads((self.control/'source-child-inventory.json').read_text())
        for row in partial['profiles']:
            if row['children']!=self.inventory[row['role']]:raise ValueError('partial_stop_child_inventory_changed')
        # Reopening an acknowledged but never-stopped bridge is permitted only
        # after proving every original owner and captured child remains intact.
        if identity_alive(self.owners['bridge']):
            for role,row in self.owners.items():
                p=exact_process(row)
                if {c.pid:c.create_time() for c in p.children(recursive=True)}!={c['pid']:c['started'] for c in self.inventory[role]}:
                    raise ValueError('abort_requires_all_original_source_trees_intact')
            self.inspect_watcher();self.inspect_voice();self.inspect_external()
            if not publish:return {'ready':False,'requires_owned_http_abort':True,'process_changes':False}
            self.abort_bridge_participant(reconciliation=True)
        snapshot=checks.collect_source(self.intent,partial)
        remote=self.inspect_native()
        result=transaction.reconcile_receipt(self.intent,partial,pin,self.intent_sha,snapshot,remote,
            now=time.time(),activated=(self.control/'MAC_EVER_ACTIVATED').exists())
        if publish and result['ready']:
            self.persist('source-stop-receipt.json',result['receipt'])
        return result

    def verify_all_closed(self):
        if self.closed!=set(checks.ROLES):raise ValueError('five_source_roles_not_closed')
        self.gate('all_closed')
        receipt={'profiles':[{'role':r,'pid':o['pid'],'started':o['started'],'status':'stopped','children_inventory_complete':True,'children':self.inventory[r]} for r,o in self.owners.items()]}
        snapshot=checks.collect_source(self.intent,receipt)
        if snapshot['errors']:raise ValueError('final_source_process_readback_incomplete')
        for p in snapshot['processes']:
            if any(checks.same_contract(p,o) for o in self.owners.values()) or Path(p['exe']).name.lower() in ('gbrain.exe','bun.exe'):
                raise ValueError('source_or_store_writer_remains')


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--plan',required=True);parser.add_argument('--plan-sha',required=True)
    mode=parser.add_mutually_exclusive_group(required=True);mode.add_argument('--verify-only',action='store_true');mode.add_argument('--stop',action='store_true')
    mode.add_argument('--inspect-partial',action='store_true');mode.add_argument('--reconcile-partial',action='store_true')
    args=parser.parse_args()
    if os.name!='nt':raise ValueError('production_source_stop_requires_windows')
    a=WindowsStopAdapter(args.plan,args.plan_sha)
    if args.inspect_partial or args.reconcile_partial:
        print(json.dumps(a.reconcile_partial(publish=args.reconcile_partial)));return
    if args.verify_only:a.gate('before_participant');print(json.dumps({'prepared_stop_gates_verified':True,'source_stopped':False}));return
    if (a.control/'SOURCE_STOP_REQUESTED').exists():raise ValueError('source_stop_attempt_already_exists')
    p=psutil.Process()
    a.persist('source-stop-controller-owner.json',{'pid':p.pid,'started':p.create_time(),'exe':p.exe(),'argv':p.cmdline(),'cwd':p.cwd(),
        'home':os.environ.get('HERMES_HOME'),'pythonpath':os.environ.get('PYTHONPATH'),'plan_sha256':args.plan_sha})
    print(json.dumps(transaction.execute_stop(a)))


if __name__=='__main__':main()
