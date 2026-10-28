"""Undo only this migration's admission fences before any SourceStop intent.

All five ORIGINAL backends must remain alive with exact execution contracts.
This path never launches/stops a business service or fabricates a stop receipt.
The separately prepared bounded voice lease controller may be started once.
"""
import argparse
from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import time

import psutil
import migration_source_recovery as checks
import migration_source_recovery_executor as recovery
import migration_source_stop_runtime as runtime


def validate_original_owners(intent,source,remote,*,now,allow_closed_bridge=False):
    if (source.get('errors')!=[] or not checks.fresh(source.get('observed_at'),now)
            or not checks.fresh(remote.get('observed_at'),now)
            or remote.get('host')!=checks.REMOTE_HOST or remote.get('candidate')!=checks.CANDIDATE
            or remote.get('inactive') is not True or remote.get('activation_absent') is not True
            or remote.get('domain_verified') is not True or remote.get('uid')!=501
            or remote.get('errors')!=[] or remote.get('labels')!={x:'unloaded' for x in checks.FUTURE_LABELS}
            or sorted(x['role'] for x in intent['profiles'])!=sorted(checks.ROLES)):
        raise ValueError('fresh_original_source_and_native_inactivity_required')
    processes=source['processes'];steps=[]
    if len({p['pid'] for p in processes})!=len(processes) or any(not checks.identity(p) for p in processes):
        raise ValueError('invalid_process_observation')
    verified_owners=[p for p in processes if any(checks.same_contract(p,o) for o in intent['profiles'])]
    for old in intent['profiles']:
        matches=[p for p in processes if checks.same_contract(p,old)]
        if len(matches)!=1 or not checks.same_identity(matches[0],old):
            raise ValueError('all_five_original_owners_required')
        for p in processes:
            near=(p.get('argv')==old['argv'] or (checks.norm(p.get('exe'))==checks.norm(old['exe'])
                and p.get('home')==old['home'] and (checks.same_entrypoint(p,old)
                    or not checks.owned_descendant(p,old))
                and not checks.distinct_owned_helper(p,verified_owners,intent['profiles'])
                and not any(checks.same_contract(p,r) for r in intent['profiles'])))
            if near and not checks.same_contract(p,old):raise ValueError('near_candidate_execution_contract_changed')
        for port in old['ports']:
            owners={p['pid'] for p in source['listeners'] if p['port']==port}
            if owners!={old['pid']} and not (allow_closed_bridge and old['role']=='bridge' and not owners):
                raise ValueError('original_listener_owner_not_verified')
        steps.append({'role':old['role'],'pid':old['pid'],'started':old['started']})
    for p in processes:
        if Path(p.get('exe','').replace('\\','/')).name.lower() in ('bun.exe','gbrain.exe'):
            if not any(checks.owned_descendant(p,o) for o in intent['profiles']):
                raise ValueError('detached_store_interpreter_requires_inspection')
    return {'steps':steps,'source_stop_authorized':False}


def execute_abort(adapter):
    adapter.gate(allow_closed_bridge=True)
    adapter.reopen_owned_http()
    adapter.gate()
    for role in ('worker','root'):
        adapter.cancel_owned_drain(role)
    adapter.wait_original_gateways()
    adapter.restore_original_producers()
    proof=adapter.verify_backends()
    adapter.restore_voice_authority(proof)
    adapter.verify_voice_ingress(proof)
    adapter.resume_owned_watcher()
    proof=adapter.verify_backends()
    adapter.verify_voice_ingress(proof)
    return adapter.publish_ready(proof)


def validate_keeper_contracts(config,intent):
    # Keeper contracts intentionally describe execution, without a stale PID.
    # The abort gate separately requires the five exact original identities.
    if set(config.get('contracts',{}))!={'root','voice'}:
        raise ValueError('original_voice_execution_contracts_required')
    for role,contract in config['contracts'].items():
        old=next(r for r in intent['profiles'] if r['role']==role)
        if not checks.same_contract(contract,old):
            raise ValueError('voice_keeper_original_execution_contract_changed')


class WindowsAbortAdapter:
    assert_fence_lease=recovery.WindowsAdapter.assert_fence_lease
    assert_fenced=recovery.WindowsAdapter.assert_fenced
    verify_voice_ingress=recovery.WindowsAdapter.verify_voice_ingress
    guard_healthy=recovery.WindowsAdapter.guard_healthy

    def __init__(self,config_path,config_sha):
        self.config_path=Path(config_path).resolve();self.config_sha=config_sha
        if not self.config_path.is_relative_to(checks.BASE.resolve()):raise ValueError('private_abort_plan_required')
        self.control=checks.CONTROL.resolve();self.reload()
        self.intent_path,self.intent=self.reference(self.config['intent'])
        self.inputs={'scheduler_manifest':self.config['scheduler_manifest'],'voice_intake':self.config['voice_intake']}
        self.source=runtime.WindowsStopAdapter(self.config['source_plan']['path'],self.config['source_plan']['sha256'])
        self.validate_shared_bindings()
        self.pause_path=self.control/'WATCHER-PAUSED.json';self.resumed=False

    def validate_shared_bindings(self):
        for field in ('intent','scheduler_manifest','browser','participant','node','voice_intake','watcher_helper'):
            if self.source.plan[field]!=self.config[field]:
                raise ValueError('abort_binding_differs_from_original_source_plan:'+field)
        _,participant=self.reference(self.config['participant'])
        if participant.get('intent')!=self.config['intent']:
            raise ValueError('abort_participant_intent_changed')
        _,keeper=self.reference(self.config['voice_keeper'])
        if keeper.get('intake_preparation')!=self.config['voice_intake']:
            raise ValueError('abort_voice_keeper_intake_changed')
        validate_keeper_contracts(keeper,self.intent)

    def reference(self,binding):
        path=Path(binding['path']).resolve()
        if not path.is_relative_to(checks.BASE.parent.resolve()):raise ValueError('private_abort_reference_required')
        return path,recovery.read_bound(path,binding['sha256'])

    def reload(self):
        if any((self.control/n).exists() for n in ('SOURCE_STOP_REQUESTED','MAC_EVER_ACTIVATED','SOURCE_RECOVERY_STARTED')):
            raise ValueError('pre_stop_abort_forbidden_after_stop_or_activation')
        self.config=recovery.read_bound(self.config_path,self.config_sha)
        if self.config.get('schema')!='village-current-pre-stop-abort-plan/v1':raise ValueError('wrong_abort_plan_schema')
        if os.environ.get('HERMES_HOME')!=str(checks.BASE/'migration-controller-home') or os.environ.get('PYTHONPATH'):
            raise ValueError('isolated_abort_controller_environment_required')
        for binding in self.config['dependencies']:
            path=Path(binding['path']).resolve()
            if not path.is_relative_to(checks.BASE.resolve()) or runtime.digest_file(path)!=binding['sha256']:
                raise ValueError('abort_dependency_changed')
        if not any(Path(r['path']).resolve()==Path(__file__).resolve() for r in self.config['dependencies']):
            raise ValueError('abort_executor_binding_required')
        owner=self.control/'source-stop-controller-owner.json'
        if owner.exists():
            old=json.loads(owner.read_text())
            if runtime.identity_alive(old) and old['pid']!=os.getpid():
                raise ValueError('source_stop_controller_still_running')

    def gate(self,*,allow_closed_bridge=False):
        self.reload();self.source.verify_bindings();self.validate_shared_bindings();self.assert_fenced()
        remote=self.source.inspect_native()
        # collect_source uses this argument solely as a child-PID read hint.
        # No stop schema/status or synthetic authority is supplied or persisted.
        hint={'profiles':[{'children':[{'pid':c.pid} for c in runtime.exact_process(p).children(recursive=True)]}
                          for p in self.intent['profiles']]}
        source=checks.collect_source(self.intent,hint)
        return validate_original_owners(self.intent,source,remote,now=time.time(),allow_closed_bridge=allow_closed_bridge)

    def node_action(self,action):
        binding=self.config['participant'];path,participant=self.reference(binding)
        recovery.validate_producer_dependencies(participant,path.parent)
        node=self.config['node']
        self.source.runtime_path(node,'node')
        cli=(path.parent/'migration_bridge_stop_cli.mjs').as_uri()
        inspector=(path.parent/'migration_bridge_inspector_session.mjs').as_uri()
        producer=(path.parent/'migration_bridge_producer_adapter.mjs').as_uri()
        code=("const {loadParticipantConfiguration,recoverOwnedHttpSession}=await import("+json.dumps(cli)+");"
            "const l=await loadParticipantConfiguration(process.argv[1],process.argv[2]);"
            "const {withVerifiedBridgeInspector}=await import("+json.dumps(inspector)+");"
            "async function inspect(){return withVerifiedBridgeInspector(l.url,l.expected,async({client})=>{"
            "const r=await client.command('Runtime.evaluate',{expression:'({producer:Object.hasOwn(globalThis,\"__villageCurrentMigrationBridgeProducerFence\"),http:Object.hasOwn(globalThis,\"__villageCurrentMigrationBridgeHttpClosure\")})',returnByValue:true,throwOnSideEffect:true});"
            "if(r.exceptionDetails||!r.result?.value)throw Error('Fence state unavailable');return r.result.value;});}"
            "const action=process.argv[3];let out;"
            "if(action==='inspect')out=await inspect();"
            "else if(action==='http')out=await recoverOwnedHttpSession(l);"
            "else if(action==='resume'){const {connectCurrentBridgeProducerFence}=await import("+json.dumps(producer)+");"
            "const p=await connectCurrentBridgeProducerFence(l.url,l.expected,l.config.token);await p.resume();"
            "out=await inspect();if(out.producer||out.http)throw Error('Original producer binding disposal not verified');"
            "out.original_bindings_restored=true;}else throw Error('Unsupported abort action');console.log(JSON.stringify(out));")
        result=subprocess.run([node['path'],'--input-type=module','-e',code,str(path),binding['sha256'],action],
                              capture_output=True,text=True,timeout=45)
        if result.returncode:raise ValueError('owned_bridge_abort_operation_failed_preserve_fences')
        return json.loads(result.stdout)

    def reopen_owned_http(self):
        state=self.node_action('inspect')
        if state.get('http'):
            self.source.abort_bridge_participant()
        elif (Path(self.config['participant']['path']).parent/'STARTED.json').exists():
            # A participant can still own a verification hold before HTTP close.
            self.source.abort_bridge_participant()
        self.gate()

    def cancel_owned_drain(self,role):
        self.gate()
        owner=next(r for r in self.intent['profiles'] if r['role']==role)
        row=next(r for r in self.config['drain_plans'] if r['role']==role)
        marker=Path(owner['home'])/'.drain_request.json'
        if (checks.norm(row['path'])!=checks.norm(str(marker)) or row.get('original_absent') is not True
                or not checks.same_identity(row.get('owner'),owner)):
            raise ValueError('unowned_drain_cleanup_forbidden')
        if not marker.exists():return
        raw=marker.read_bytes();body=json.loads(raw.decode('utf-8'))
        if (hashlib.sha256(raw).hexdigest()!=row['sha256'] or body!=row['body']
                or body.get('migration_id')!=self.config['migration_id'] or body.get('action')!='drain'
                or body.get('principal')!='village-studio-migration:'+self.config['migration_id']
                or not checks.same_identity(body.get('owner'),owner)):
            raise ValueError('changed_or_unowned_drain_preserved')
        intent=self.control/('pre-stop-drain-removal-'+role+'.json')
        if not intent.exists():runtime.write_new(intent,{'config_sha256':self.config_sha,'marker_sha256':row['sha256']})
        self.gate();runtime.exact_process(owner)
        if marker.read_bytes()!=raw:raise ValueError('drain_changed_before_removal')
        marker.unlink()

    def wait_original_gateways(self):
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            self.gate();ready=True
            for role,platform in (('root','slack'),('worker','kakao_village')):
                owner=next(r for r in self.intent['profiles'] if r['role']==role)
                state=json.loads((Path(owner['home'])/'gateway_state.json').read_text(encoding='utf-8'))
                ready=ready and state.get('pid')==owner['pid'] and state.get('start_time')==round(owner['started']*100) and state.get('gateway_state')=='running' and state.get('platforms',{}).get(platform,{}).get('state')=='connected'
            if ready:return
            time.sleep(.5)
        raise ValueError('original_gateway_running_state_not_verified')

    def restore_original_producers(self):
        self.gate();state=self.node_action('inspect')
        if state.get('http'):raise ValueError('owned_http_must_be_reopened_first')
        if not state.get('producer'):return
        journal=self.control/'pre-stop-producer-resume-request.json'
        if journal.exists():raise ValueError('uncertain_pre_stop_producer_resume_requires_inspection')
        runtime.write_new(journal,{'config_sha256':self.config_sha})
        self.gate();result=self.node_action('resume')
        if result.get('original_bindings_restored') is not True:raise ValueError('original_producer_readback_missing')
        runtime.write_new(self.control/'pre-stop-producer-resumed.json',result)

    def verify_backends(self):
        self.wait_original_gateways();self.guard_healthy();plan=self.gate()
        with runtime.urlopen('http://127.0.0.1:8788/health',timeout=5) as response:
            if json.load(response).get('status')!='ok':raise ValueError('original_voice_backend_not_ready')
        return {'profiles':[{'role':x['role'],'pid':x['pid'],'start_time':round(x['started']*100),'state':'running'} for x in plan['steps']]}

    def restore_voice_authority(self,proof):
        self.gate()
        if self.verify_backends()!=proof:raise ValueError('original_owners_changed_before_voice_restore')
        binding=self.config['voice_keeper'];config_path,config=self.reference(binding)
        import migration_voice_source_lease as lease
        lease.validate_private_configuration(config,checks.BASE)
        if config['intake_preparation']!=self.config['voice_intake']:raise ValueError('original_voice_epoch_changed')
        validate_keeper_contracts(config,self.intent)
        for dep in config['dependencies']:
            if runtime.digest_file(dep['path'])!=dep['sha256']:raise ValueError('voice_keeper_dependency_changed')
        keeper=Path(config['directory']) if 'directory' in config else config_path.parent
        journal=self.control/'pre-stop-voice-keeper-launch.json'
        if journal.exists() or (keeper/'STOP').exists():raise ValueError('voice_keeper_launch_must_not_be_repeated')
        runtime.write_new(journal,{'config_sha256':binding['sha256'],'at':time.time()})
        env=dict(os.environ);env.pop('PYTHONPATH',None);env['HERMES_HOME']=str(keeper/'helper-home')
        code=next(Path(r['path']) for r in config['dependencies'] if Path(r['path']).name=='migration_voice_source_lease.py')
        with (self.control/'pre-stop-voice-keeper.stdout.log').open('xb') as out,(self.control/'pre-stop-voice-keeper.stderr.log').open('xb') as err:
            child=subprocess.Popen([recovery.PYTHON,str(code),'--config',str(config_path),'--config-sha',binding['sha256'],'--run'],
                env=env,stdin=subprocess.DEVNULL,stdout=out,stderr=err,creationflags=subprocess.CREATE_NO_WINDOW|subprocess.CREATE_NEW_PROCESS_GROUP)
        runtime.write_new(self.control/'pre-stop-voice-keeper-returned.json',{'pid':child.pid,'started':psutil.Process(child.pid).create_time()})
        self.route_voice_to_intake()
        deadline=time.monotonic()+45
        while time.monotonic()<deadline:
            if child.poll() is not None:raise ValueError('source_voice_keeper_exited_preserve_fences')
            try:self.verify_voice_ingress(proof);return
            except (ValueError,recovery.RecoveryError,OSError):time.sleep(.5)
        raise ValueError('original_voice_authority_not_verified')

    def route_voice_to_intake(self):
        self.gate()
        code=r'''from copy import deepcopy
import json,subprocess
CLI='/Applications/Tailscale.app/Contents/MacOS/Tailscale';host='mac-studio.tail7f97ff.ts.net:443'
def read():return json.loads(subprocess.check_output([CLI,'serve','status','--json'],text=True,timeout=10))
before=read();old=before['Web'][host]['Handlers']['/watch/voice'];assert old in ({'Proxy':'http://127.0.0.1:28788'},{'Proxy':'http://127.0.0.1:18788'}) and before['AllowFunnel'][host] is True
expected=deepcopy(before);expected['Web'][host]['Handlers']['/watch/voice']={'Proxy':'http://127.0.0.1:18788'}
if before!=expected:subprocess.run([CLI,'funnel','--bg','--https=443','--set-path=/watch/voice','http://127.0.0.1:18788'],capture_output=True,timeout=20,check=True)
assert read()==expected;print(json.dumps({'mac_voice_route_verified':True}))
'''
        ssh=['C:/Windows/System32/OpenSSH/ssh.exe','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8','-i',checks.SSH_KEY,checks.REMOTE_HOST,checks.CANDIDATE+'/venv-root/bin/python -']
        subprocess.run(ssh,input=code.encode(),capture_output=True,timeout=35,check=True)
        self.gate();cli='C:/Program Files/Tailscale/tailscale.exe';host='ax2.tail7f97ff.ts.net:443'
        def read():return json.loads(subprocess.check_output([cli,'serve','status','--json'],text=True,timeout=10))
        before=read();old=before['Web'][host]['Handlers']['/watch/voice']
        if old not in ({'Proxy':'http://127.0.0.1:8788'},{'Proxy':'http://127.0.0.1:18788'}) or before['AllowFunnel'][host] is not True:
            raise ValueError('unknown_original_voice_route_preserved')
        expected=deepcopy(before);expected['Web'][host]['Handlers']['/watch/voice']={'Proxy':'http://127.0.0.1:18788'}
        if before!=expected:subprocess.run([cli,'funnel','--bg','--https=443','--set-path=/watch/voice','http://127.0.0.1:18788'],capture_output=True,timeout=20,check=True)
        if read()!=expected:raise ValueError('unrelated_voice_route_configuration_changed')

    def watcher(self,mode):
        self.gate();binding=self.config['watcher_helper'];path=Path(binding['path']).resolve()
        if not path.is_relative_to(checks.BASE.parent.resolve()) or runtime.digest_file(path)!=binding['sha256']:
            raise ValueError('owned_watcher_helper_changed')
        spec=importlib.util.spec_from_file_location('pre_stop_owned_watcher',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        _,browser=self.reference(self.config['browser'])
        return m.operate(browser,mode,self.pause_path)

    def resume_owned_watcher(self):
        if self.pause_path.exists():self.watcher('resume')
        row=self.watcher('inspect')['readback']
        if row.get('enabled') is not True or row.get('pausedByThisMigration') is not False:
            raise ValueError('original_watcher_not_resumed')
        self.resumed=True

    def publish_ready(self,proof):
        if not self.resumed or self.verify_backends()!=proof:raise ValueError('original_backend_readiness_changed')
        self.verify_voice_ingress(proof);self.watcher('inspect');self.gate()
        result={'schema':'village-pre-stop-abort-ready/v1','config_sha256':self.config_sha,
                'profiles':proof['profiles'],'ready_to_restore_tasks':True,'source_stopped':False,'at':time.time()}
        runtime.write_new(self.control/'PRE-STOP-ABORT-READY.json',result)
        if self.pause_path.exists():self.pause_path.rename(self.control/'WATCHER-PAUSED-RESUMED.json')
        return result


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--config',required=True);p.add_argument('--config-sha',required=True)
    p.add_argument('--execute',action='store_true');args=p.parse_args()
    a=WindowsAbortAdapter(args.config,args.config_sha)
    if not args.execute:
        if not a.control.exists():
            print(json.dumps({'prepared':True,'source_changed':False,'operational_fence_present':False}));return
        a.gate(allow_closed_bridge=True);print(json.dumps({'original_owners_verified':True,'source_changed':False}));return
    print(json.dumps(execute_abort(a)))


if __name__=='__main__':main()
