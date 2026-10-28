"""Current preactivation recovery; no launches on import or --verify-only.

No queue/data rewind, normal-send bridge task or scheduler enable is supported.
The caller must supply hash-bound current stop and recovery input receipts.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from urllib.request import urlopen

import migration_source_recovery as checks

INCIDENT = Path('C:/Village/task-artifacts/20261022-reservation-incident/audit/incident-startup-fences-20261024')
PYTHON = 'C:/Users/ssper/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe'


class RecoveryError(RuntimeError): pass


def execute_recovery(adapter, *, resume_watcher=False):
    reusable = ('reuse_verified_replacement', 'preserve_unaffected')
    plan = adapter.gate()
    adapter.prepare_profile('worker')
    if next(x for x in plan['steps'] if x['role']=='worker')['method'] not in reusable:
        adapter.start_profile('worker')
    adapter.wait_owner('worker')
    plan = adapter.gate()
    if any(x['method'] not in reusable for x in plan['steps'] if x['role'] in ('bridge','relay')):
        adapter.start_guarded_pair()
    adapter.restore_preserved_bridge_producers()
    adapter.wait_guarded_pair()
    for role in ('root','voice'):
        plan = adapter.gate()
        adapter.prepare_profile(role)
        if next(x for x in plan['steps'] if x['role']==role)['method'] not in reusable:
            adapter.start_profile(role)
        adapter.wait_owner(role)
    adapter.gate()
    proof = adapter.verify_all()
    result = dict(schema=1, source_backends_ready=True, source_ready=False, ready_to_unfence=False,
                  task_states_restored=False, destination_activated=False)
    if resume_watcher:
        adapter.restore_voice_authority(proof)
        adapter.resume_watcher()
        adapter.gate()
        proof = adapter.verify_all()
        adapter.verify_voice_ingress(proof)
        adapter.publish(proof)
        result.update(source_ready=True,ready_to_unfence=True)
    return result


def sha(raw): return hashlib.sha256(raw).hexdigest()


def read_bound(path, digest):
    if not isinstance(digest,str) or not re.fullmatch('[a-f0-9]{64}',digest):
        raise RecoveryError('invalid_bound_hash')
    raw=Path(path).read_bytes()
    if sha(raw)!=digest:raise RecoveryError('bound_input_changed')
    return json.loads(raw.decode('utf-8-sig'))


def quote(value): return "'"+str(value).replace("'","''")+"'"


def validate_scheduler_fence(expected,actual):
    if (len(expected)!=21 or len(actual)!=21
            or len({r['name'] for r in expected})!=21
            or len({r['name'] for r in actual})!=21
            or {r['name'] for r in expected}!={r['name'] for r in actual}):
        raise RecoveryError('scheduler_owner_inventory_changed')
    by_name={r['name']:r for r in expected}
    for row in actual:
        old=by_name[row['name']]
        if (row.get('enabled') is not False or row.get('path')!='\\'
                or old.get('path')!='\\'
                or row.get('definitionSha256')!=old.get('definitionSha256')
                or not re.fullmatch('[a-f0-9]{64}',str(row.get('definitionSha256','')))):
            raise RecoveryError('scheduler_owner_enabled_or_definition_changed')


def powershell(script, *, timeout=30):
    result=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',
                           "$ErrorActionPreference='Stop';"+script],
                          capture_output=True,text=True,timeout=timeout)
    if result.returncode:raise RecoveryError('scoped_source_operation_failed')
    return result.stdout


def write_new(path, value):
    with Path(path).open('x',encoding='utf-8') as f:
        json.dump(value,f,separators=(',',':'));f.flush();os.fsync(f.fileno())


def validate_producer_dependencies(config,directory):
    directory=Path(directory).resolve()
    names={'migration_bridge_stop_cli.mjs','migration_bridge_stop_handoff.mjs',
        'migration_bridge_inspector_session.mjs','migration_bridge_producer_adapter.mjs',
        'migration_bridge_producer_fence.mjs','migration_bridge_http_adapter.mjs',
        'migration_bridge_http_closure.mjs','migration_bridge_work_probe.mjs','migration_bridge_promise_census.mjs'}
    refs=config.get('dependencies',[])
    if (not directory.is_relative_to(checks.BASE.resolve()) or len(refs)!=len(names)
            or {Path(r['path']).name for r in refs}!=names):
        raise RecoveryError('producer_dependency_inventory_changed')
    for row in refs:
        original=Path(row['path']).absolute();p=original.resolve()
        if (p.parent!=directory or checks.norm(str(original))!=checks.norm(str(p))
                or sha(p.read_bytes())!=row['sha256']):
            raise RecoveryError('producer_dependency_changed_before_import')


def validate_voice_ingress(evidence, expected, intake):
    if (evidence.get('schema')!='village-source-voice-dispatch-readback/v1'
            or evidence.get('config_sha256')!=intake['config_sha256']
            or evidence.get('epoch')!=intake['epoch']
            or evidence.get('origin_source')!=intake['source']
            or evidence.get('phase_mode')!='windows'
            or not checks.number(evidence.get('lease_age_native_seconds'))
            or not 0<=evidence['lease_age_native_seconds']<=15
            or evidence.get('native_activation_absent') is not True
            or evidence.get('native_closure_absent') is not True
            or evidence.get('mac_route_verified') is not True
            or evidence.get('legacy_route_verified') is not True
            or evidence.get('intake_healthy') is not True
            or evidence.get('relay_healthy') is not True):
        raise RecoveryError('public_voice_dispatch_not_restored')
    forwarder=evidence.get('forwarder')
    if (not isinstance(forwarder,dict)
            or forwarder.get('schema')!='village-voice-forwarder-runtime/v1'
            or forwarder.get('thread_alive') is not True or forwarder.get('failed') is not False
            or forwarder.get('authority')!='windows'
            or forwarder.get('config_sha256')!=intake['config_sha256']
            or forwarder.get('epoch')!=intake['epoch']
            or not checks.number(forwarder.get('evaluation_age_seconds'))
            or not 0<=forwarder['evaluation_age_seconds']<=2
            or not isinstance(evidence.get('phase_sha256'),str)
            or not re.fullmatch('[a-f0-9]{64}',evidence['phase_sha256'])
            or forwarder.get('phase_sha256')!=evidence['phase_sha256']):
        raise RecoveryError('live_voice_forwarder_not_verified')
    owners=evidence.get('effective_owners',{})
    if set(owners)!=set(expected) or any(not checks.same_identity(owners[r],expected[r]) for r in expected):
        raise RecoveryError('voice_dispatch_points_to_old_or_unknown_source')
    counts=evidence.get('counts')
    if (not isinstance(counts,dict) or set(counts)-{'queued','dispatching','uncertain','delivered'}
            or any(type(v) is not int or v<0 for v in counts.values())
            or counts.get('dispatching',0) or counts.get('uncertain',0)
            or type(evidence.get('conflicts')) is not int or evidence['conflicts']!=0):
        raise RecoveryError('voice_delivery_outcome_requires_inspection')
    return evidence


class WindowsAdapter:
    def __init__(self, control, inputs_sha, stop_sha):
        self.control=Path(control).resolve()
        if (self.control.parent!=checks.BASE.resolve()
                or not re.fullmatch(r'scheduler-fence-v\d+',self.control.name)):
            raise RecoveryError('wrong_protected_control_directory')
        self.inputs_sha,self.stop_sha=inputs_sha,stop_sha
        self.resumed=False
        self.reload()

    def reference(self, ref):
        path=Path(ref['path']).resolve()
        if not path.is_relative_to(checks.BASE.resolve()):
            raise RecoveryError('reference_outside_private_staging')
        return path,read_bound(path,ref['sha256'])

    def reload(self):
        if not (self.control/'SOURCE_STOP_REQUESTED').is_file():
            raise RecoveryError('actual_source_stop_required')
        if (self.control/'MAC_EVER_ACTIVATED').exists():
            raise RecoveryError('destination_activation_forbids_source_recovery')
        self.inputs=read_bound(self.control/'recovery-inputs.json',self.inputs_sha)
        if self.inputs.get('schema')!='village-current-recovery-inputs/v1' or self.inputs.get('stop_sha256')!=self.stop_sha:
            raise RecoveryError('wrong_recovery_input_contract')
        self.intent_path,self.intent=self.reference(self.inputs['intent'])
        self.receipt=read_bound(self.control/'source-stop-receipt.json',self.stop_sha)
        self.states=read_bound(self.control/'original-task-states.json',self.inputs['tasks_sha256'])
        self.manifest_path,self.manifest=self.reference(self.inputs['scheduler_manifest'])
        if len(self.states)!=21 or len({x['name'] for x in self.states})!=21:
            raise RecoveryError('incomplete_original_task_states')
        if {x['name'] for x in self.states}!={x['name'] for x in self.manifest['tasks']}:
            raise RecoveryError('task_inventory_mismatch')
        self.browser_path,self.browser=self.reference(self.inputs['browser'])
        self.pause_path,self.pause=self.reference(self.inputs['watcher_pause'])
        _path,self.drains=self.reference(self.inputs['owned_drains'])
        if (self.drains.get('schema')!='village-owned-drains/v1'
                or self.drains.get('intent_sha256')!=self.inputs['intent']['sha256']
                or not isinstance(self.drains.get('migration_id'),str) or not self.drains['migration_id']
                or sorted(x['role'] for x in self.drains['profiles'])!=['root','worker']):
            raise RecoveryError('owned_drain_inventory_required')
        self.envs={}
        for role in ('root','worker','voice'):
            ref=self.inputs['environments'][role]
            old=next(x for x in self.intent['profiles'] if x['role']==role)
            if not checks.same_identity(ref['source'],old):raise RecoveryError('environment_source_changed')
            _path,env=self.reference(ref)
            if (not isinstance(env,dict) or not all(isinstance(k,str) and isinstance(v,str)
                    and '=' not in k and '\0' not in k+v for k,v in env.items())
                    or env.get('HERMES_HOME')!=old['home'] or env.get('PYTHONPATH')!=old['pythonpath']):
                raise RecoveryError('captured_environment_contract_changed')
            self.envs[role]=env
        for binding in self.manifest['recoveryFiles']:
            if sha(Path(binding['path']).read_bytes())!=binding['sha256']:
                raise RecoveryError('guarded_runtime_dependency_changed')
        if sha(Path(__file__).read_bytes())!=self.inputs['executor_sha256']:
            raise RecoveryError('recovery_executor_changed')
        if sha(Path(checks.__file__).read_bytes())!=self.inputs['observation_sha256']:
            raise RecoveryError('recovery_observation_module_changed')

    def assert_fence_lease(self):
        broker=json.loads((self.control/'BROKER-STATE.json').read_text(encoding='utf-8-sig'))
        fence=json.loads((self.control/'SCHEDULER-FENCED.json').read_text(encoding='utf-8-sig'))
        if (broker.get('active') is not True or broker.get('fenced') is not True
                or not isinstance(broker.get('nonce'),str) or not broker['nonce']
                or broker.get('manifestSha256')!=self.inputs['scheduler_manifest']['sha256']
                or fence.get('nonce')!=broker['nonce'] or fence.get('manifestSha256')!=broker['manifestSha256']
                or fence.get('valid') is not True or fence.get('all21Disabled') is not True):
            raise RecoveryError('administrator_fence_owner_unavailable')
        from datetime import datetime,timezone
        stamp=datetime.fromisoformat(broker['at'].replace('Z','+00:00')).astimezone(timezone.utc).timestamp()
        if not 0<=time.time()-stamp<=15:raise RecoveryError('administrator_fence_lease_stale')

    def assert_fenced(self):
        self.assert_fence_lease()
        ref=self.inputs['scheduler_manifest']
        manifest=read_bound(ref['path'],ref['sha256'])
        # Read the same Task Scheduler authority directly. CIM cmdlets make
        # dozens of separate queries, and Windows may OMIT Enabled=true in XML.
        # Remove only that optional node, exactly as the reviewed broker hashes
        # definitions; separately require the actual COM Enabled value false.
        script="$rows=Get-Content -LiteralPath "+quote(self.control/'original-task-states.json')+" -Raw|ConvertFrom-Json;"
        script+="$service=New-Object -ComObject 'Schedule.Service';$service.Connect();$folder=$service.GetFolder('\\');$out=@();"
        script+="foreach($row in $rows){if($row.path -cne '\\'){throw 'Unexpected task folder'};$t=$folder.GetTask($row.name);[xml]$doc=$t.Xml;"
        script+="$node=$doc.SelectSingleNode(\"/*[local-name()='Task']/*[local-name()='Settings']/*[local-name()='Enabled']\");"
        script+="$settings=$doc.SelectSingleNode(\"/*[local-name()='Task']/*[local-name()='Settings']\");if($null -eq $settings){throw 'Missing task settings'};"
        script+="if($null -ne $node){[void]$settings.RemoveChild($node)};$h=[Security.Cryptography.SHA256]::Create();"
        script+="try{$pin=[BitConverter]::ToString($h.ComputeHash([Text.Encoding]::UTF8.GetBytes($doc.OuterXml))).Replace('-','').ToLowerInvariant()}finally{$h.Dispose()};"
        script+="$out+=@{name=[string]$row.name;path=[string]$row.path;enabled=[bool]$t.Enabled;definitionSha256=$pin}};$out|ConvertTo-Json -Compress -Depth 4"
        validate_scheduler_fence(manifest['tasks'],json.loads(powershell(script)))
        self.assert_fence_lease()

    def inspect_watcher(self):
        # This reviewed helper operates only on the captured browser/target and
        # the persisted pause token; it neither reloads nor cleans up timers.
        helper=self.inputs['watcher_helper']
        path=Path(helper['path']).resolve()
        if not path.is_relative_to(checks.BASE.parent.resolve()) or sha(path.read_bytes())!=helper['sha256']:
            raise RecoveryError('watcher_helper_changed')
        import importlib.util
        spec=importlib.util.spec_from_file_location('current_owned_watcher',path)
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        row=module.operate(self.browser,'inspect',self.pause_path)['readback']
        if (row.get('started') is not True or row.get('enabled') is not self.resumed
                or row.get('pausedByThisMigration') is not (not self.resumed)
                or (not self.resumed and (row.get('deepRunning') is not False
                                         or row.get('pauseOwnedByReceipt') is not True))):
            raise RecoveryError('owned_watcher_fence_changed')
        return module

    def gate(self):
        self.assert_helper_isolated()
        self.reload();self.assert_fenced();self.inspect_watcher()
        remote=checks.collect_remote();source=checks.collect_source(self.intent,self.receipt)
        plan=checks.build_plan(self.intent,self.receipt,self.inputs['intent']['sha256'],source,remote,
                              now=time.time(),activated=(self.control/'MAC_EVER_ACTIVATED').exists())
        if not plan['ready']:raise RecoveryError('current_recovery_observation_rejected')
        return plan

    def assert_helper_isolated(self):
        if (checks.norm(os.environ.get('HERMES_HOME'))!=checks.norm(str(self.control/'helper-home'))
                or os.environ.get('PYTHONPATH') not in (None,'')):
            raise RecoveryError('launch_controller_with_isolated_home_and_no_pythonpath')

    def prepare_profile(self,role):
        if role=='voice':return
        if role not in ('root','worker'):raise RecoveryError('unapproved_drain_cleanup')
        plan=self.gate()  # proves closed old owners, or exact preserved unaffected owners
        stopped=next(x for x in self.receipt['profiles'] if x['role']==role)
        old=next(x for x in self.intent['profiles'] if x['role']==role)
        if stopped['status']=='unaffected':
            current=next(x for x in plan['steps'] if x['role']==role)
            if current.get('method')!='preserve_unaffected' or not checks.same_identity(current,old):
                raise RecoveryError('exact_preserved_owner_required_for_drain_cancel')
        elif stopped['status']!='stopped':
            raise RecoveryError('old_owner_closure_required_for_drain_cleanup')
        row=next(x for x in self.drains['profiles'] if x['role']==role)
        marker=Path(old['home'])/'.drain_request.json'
        if (checks.norm(row['path'])!=checks.norm(str(marker)) or row.get('original_absent') is not True
                or not checks.same_identity(row.get('owner'),old)):
            raise RecoveryError('drain_cleanup_not_owned_by_this_migration')
        if row.get('created') is False:
            if marker.exists():raise RecoveryError('unowned_drain_marker_preserved')
            return
        if row.get('created') is not True:raise RecoveryError('unknown_drain_creation_state')
        removal=self.control/('drain-removal-'+role+'.json')
        expected={'intent_sha256':self.inputs['intent']['sha256'],'marker_sha256':row['sha256'],
                  'migration_id':self.drains['migration_id'],'path':str(marker),
                  'mode':'cancel_on_preserved_owner' if stopped['status']=='unaffected' else 'closed_owner_cleanup'}
        if removal.exists() and json.loads(removal.read_text())!=expected:
            raise RecoveryError('different_drain_removal_intent')
        if not marker.exists():
            if removal.exists():return
            raise RecoveryError('owned_drain_disappeared_without_removal_intent')
        raw=marker.read_bytes()
        if sha(raw)!=row['sha256']:raise RecoveryError('changed_drain_marker_preserved')
        data=json.loads(raw.decode('utf-8'))
        if (data.get('action')!='drain' or data.get('migration_id')!=self.drains['migration_id']
                or data.get('principal')!='village-studio-migration:'+self.drains['migration_id']
                or not checks.same_identity(data.get('owner'),old)):
            raise RecoveryError('unowned_drain_marker_preserved')
        if not removal.exists():write_new(removal,expected)
        self.gate()
        if marker.read_bytes()!=raw:raise RecoveryError('drain_changed_before_owned_removal')
        marker.unlink()  # only the exact hash-bound marker, never an operator's drain
        if marker.exists():raise RecoveryError('owned_drain_removal_not_observed')

    def begin(self):
        marker=self.control/'SOURCE_RECOVERY_STARTED'
        expected={'inputs_sha256':self.inputs_sha,'stop_sha256':self.stop_sha}
        if marker.exists():
            if json.loads(marker.read_text())!=expected:raise RecoveryError('different_recovery_attempt')
        else:write_new(marker,expected)

    def start_profile(self,role):
        if role not in ('root','worker','voice'):raise RecoveryError('unapproved_profile_start')
        plan=self.gate()
        step=next(x for x in plan['steps'] if x['role']==role)
        if step.get('method')!='known_scheduler_task' or step.get('task')!=checks.TASKS[role]:
            raise RecoveryError('profile_not_proven_absent')
        self.begin()
        # The journal predates the uncertain launch boundary. Never repeat a
        # failed/unknown Start-Process request automatically.
        write_new(self.control/('launch-'+role+'.json'),{'role':role,'inputs_sha256':self.inputs_sha,'at':time.time()})
        args=subprocess.list2cmdline([str(Path(__file__).resolve()),'--control',str(self.control),
            '--inputs-sha',self.inputs_sha,'--stop-sha',self.stop_sha,'--launch-child',role])
        script='$env:HERMES_HOME='+quote(self.control/'helper-home')+';'
        script+='Remove-Item Env:PYTHONPATH -ErrorAction SilentlyContinue;'
        script+='Start-Process -FilePath '+quote(PYTHON)+' -ArgumentList '+quote(args)+' -WindowStyle Hidden | Out-Null'
        powershell(script)

    def launch_child(self,role):
        if role not in ('root','worker','voice'):raise RecoveryError('unapproved_child_role')
        plan=self.gate()
        if next(x for x in plan['steps'] if x['role']==role)['method']!='known_scheduler_task':
            raise RecoveryError('child_role_not_absent')
        self.prepare_profile(role)
        journal=json.loads((self.control/('launch-'+role+'.json')).read_text())
        if journal.get('inputs_sha256')!=self.inputs_sha:raise RecoveryError('launch_journal_changed')
        self.begin()
        old=next(x for x in self.intent['profiles'] if x['role']==role)
        write_new(self.control/('launch-'+role+'-child-entered.json'),
                  {'inputs_sha256':self.inputs_sha,'at':time.time()})
        with (self.control/(role+'-recovery.stdout.log')).open('ab') as out, (self.control/(role+'-recovery.stderr.log')).open('ab') as err:
            child=subprocess.Popen(old['argv'],executable=old['exe'],cwd=old['cwd'],env=self.envs[role],
                                   stdin=subprocess.DEVNULL,stdout=out,stderr=err,
                                   creationflags=subprocess.CREATE_NO_WINDOW|subprocess.CREATE_NEW_PROCESS_GROUP)
        # The subsequent read-only planner discovers the actual service owner,
        # not the venv launcher/Start-Process PID.
        write_new(self.control/('launch-'+role+'-returned.json'),{'launcher_pid':child.pid,'at':time.time()})

    def start_guarded_pair(self):
        plan=self.gate()
        if not any(x['method']=='current_guarded_bridge_relay_recovery_required' for x in plan['steps']):
            raise RecoveryError('guarded_pair_not_proven_missing')
        self.wait_owner('worker');self.begin()
        write_new(self.control/'launch-guarded-pair.json',{'at':time.time(),'inputs_sha256':self.inputs_sha})
        result=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
            '-File',str(INCIDENT/'guarded-runtime.ps1')],capture_output=True,text=True,timeout=120)
        if result.returncode:raise RecoveryError('guarded_recovery_failed_preserve_started_processes')

    def wait_owner(self,role):
        deadline=time.monotonic()+90
        while time.monotonic()<deadline:
            try:
                plan=self.gate();step=next(x for x in plan['steps'] if x['role']==role)
                if step['method'] in ('reuse_verified_replacement','preserve_unaffected'):
                    if role=='root':
                        old=next(x for x in self.intent['profiles'] if x['role']==role)
                        state=json.loads((Path(old['home'])/'gateway_state.json').read_text(encoding='utf-8'))
                        if (state.get('pid')!=step['pid'] or state.get('start_time')!=round(step['started']*100)
                                or state.get('gateway_state')!='running'
                                or state.get('platforms',{}).get('slack',{}).get('state')!='connected'):
                            time.sleep(.5);continue
                    return step
            except (RecoveryError,OSError,ValueError,KeyError):pass
            time.sleep(.5)
        raise RecoveryError('source_owner_not_verified_leave_fenced')

    def wait_guarded_pair(self):
        self.wait_owner('bridge');self.wait_owner('relay')
        self.guard_healthy()

    def restore_preserved_bridge_producers(self):
        plan=self.gate()
        bridge=next(x for x in plan['steps'] if x['role']=='bridge')
        if bridge['method']!='preserve_unaffected':return {'required':False}
        if (self.receipt.get('stop_attempt_only') is not True
                or any(r['status']!='unaffected' for r in self.receipt['profiles'])
                or any(r['method']!='preserve_unaffected' for r in plan['steps'])):
            raise RecoveryError('all_original_owners_required_for_producer_abort')
        binding=self.inputs.get('bridge_producer_recovery')
        if not isinstance(binding,dict):raise RecoveryError('bound_producer_recovery_required')
        config_path,config=self.reference(binding)
        if (config.get('schema')!='village-current-bridge-stop-participant/v1'
                or config.get('intent')!=self.inputs['intent']):
            raise RecoveryError('producer_recovery_intent_changed')
        validate_producer_dependencies(config,config_path.parent)
        node=self.inputs.get('producer_node',{})
        expected=Path('C:/Users/ssper/AppData/Local/Microsoft/WinGet/Packages/OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe/node-v24.18.0-win-x64/node.exe')
        if (Path(node.get('path','')).resolve()!=expected.resolve()
                or sha(expected.read_bytes())!=node.get('sha256')):
            raise RecoveryError('producer_recovery_node_changed')
        # Every original backend is intact; remove only our two migration
        # drains before enabling the original producer functions and timers.
        for role in ('worker','root'):self.prepare_profile(role)
        for role in ('worker','root','bridge','relay','voice'):self.wait_owner(role)
        self.gate()
        journal=self.control/'preserved-producer-resume-request.json'
        completed=self.control/'preserved-producer-resumed.json'
        request={'intent_sha256':self.inputs['intent']['sha256'],'participant_sha256':binding['sha256'],
                 'stop_sha256':self.stop_sha}
        if completed.exists():
            row=json.loads(completed.read_text())
            if row.get('request')!=request or row.get('original_bindings_restored') is not True:
                raise RecoveryError('producer_resume_receipt_changed')
            return row
        if journal.exists():raise RecoveryError('uncertain_producer_resume_requires_inspection')
        write_new(journal,request)
        validate_producer_dependencies(config,config_path.parent)
        cli=(config_path.parent/'migration_bridge_stop_cli.mjs').as_uri()
        module=(config_path.parent/'migration_bridge_producer_adapter.mjs').as_uri()
        code=("const {loadParticipantConfiguration}=await import("+json.dumps(cli)+");"
              "const loaded=await loadParticipantConfiguration(process.argv[1],process.argv[2]);"
              "const {connectCurrentBridgeProducerFence}=await import("+json.dumps(module)+");"
              "const p=await connectCurrentBridgeProducerFence(loaded.url,loaded.expected,loaded.config.token);"
              "const before=await p.snapshot();if(before.mode!=='fenced'||before.producers_owned!==true)throw Error('Owned producer fence required');"
              "await p.resume();console.log(JSON.stringify({original_bindings_restored:true}));")
        result=subprocess.run([str(expected),'--input-type=module','-e',code,str(config_path),binding['sha256']],
                              capture_output=True,text=True,timeout=45)
        if result.returncode:raise RecoveryError('owned_producer_resume_failed_preserve_fences')
        if json.loads(result.stdout).get('original_bindings_restored') is not True:
            raise RecoveryError('producer_resume_readback_missing')
        self.gate()
        row={'request':request,'original_bindings_restored':True,'at':time.time()}
        write_new(completed,row)
        return row

    def guard_healthy(self):
        self.reload()
        r=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass',
            '-File',str(INCIDENT/'guarded-runtime.ps1'),'-CheckHealthy'],capture_output=True,text=True,timeout=30)
        if r.returncode:raise RecoveryError('guarded_readiness_failed')
        row=json.loads(r.stdout)
        if row.get('healthy') is not True or row.get('mutated') is not False:
            raise RecoveryError('guarded_readback_not_read_only_healthy')

    def verify_all(self):
        plan=self.gate();self.guard_healthy()
        if any(x['method'] not in ('reuse_verified_replacement','preserve_unaffected') for x in plan['steps']):
            raise RecoveryError('not_all_current_owners_present')
        for role,platform in (('root','slack'),('worker','kakao_village')):
            old=next(x for x in self.intent['profiles'] if x['role']==role)
            current=next(x for x in plan['steps'] if x['role']==role)
            state=json.loads((Path(old['home'])/'gateway_state.json').read_text(encoding='utf-8'))
            if (state.get('pid')!=current['pid'] or state.get('start_time')!=round(current['started']*100)
                    or state.get('gateway_state')!='running'
                    or state.get('platforms',{}).get(platform,{}).get('state')!='connected'):
                raise RecoveryError('recovered_gateway_platform_not_connected')
        with urlopen('http://127.0.0.1:8788/health',timeout=5) as response:
            if json.load(response).get('status')!='ok':raise RecoveryError('voice_not_ready')
        self.gate()
        return {'profiles':[{'role':x['role'],'pid':x['pid'],'start_time':round(x['started']*100),'state':'running'} for x in plan['steps']]}

    def resume_watcher(self):
        self.gate()
        module=self.inspect_watcher()
        proof=self.verify_all()
        # All slow scheduler/owner inspection precedes the final bounded voice
        # observation. Nothing else may renew/consume that lease before resume.
        self.verify_voice_ingress(proof)
        module.operate(self.browser,'resume',self.pause_path)
        self.resumed=True
        self.inspect_watcher()

    def restore_voice_authority(self,proof):
        """Start a newly bound controller only after real backend recovery.

        The private plan is prepared by the actual stop controller. An uncertain
        launch is never repeated; failure leaves the browser and tasks fenced.
        """
        self.gate()
        if self.verify_all()!=proof:raise RecoveryError('backend_owners_changed_before_voice_recovery')
        if 'voice_recovery' not in self.inputs:raise RecoveryError('bound_voice_recovery_plan_required')
        _,plan=self.reference(self.inputs['voice_recovery'])
        if plan.get('schema')!='village-current-voice-recovery-plan/v1':
            raise RecoveryError('bound_voice_recovery_plan_required')
        import migration_voice_source_lease as lease
        template_path,template=self.reference(plan['controller_template'])
        lease.validate_private_configuration(template,checks.BASE)
        if (template['intake_preparation']!=self.inputs['voice_intake']
                or plan.get('previous_controller_sha256')!=plan['controller_template']['sha256']):
            raise RecoveryError('original_intake_and_previous_controller_must_remain_bound')
        for role,contract in template['contracts'].items():
            original=next(x for x in self.intent['profiles'] if x['role']==role)
            if not checks.same_contract(original,contract):raise RecoveryError('voice_recovery_source_contract_changed')
        prior=template['prior_writers']+plan['prior_writers']
        if not plan['prior_writers'] or any(not checks.identity(p) for p in prior):
            raise RecoveryError('all_prior_voice_writer_identities_required')
        import psutil
        for old in prior:
            try:
                if abs(psutil.Process(old['pid']).create_time()-old['started'])<.01:
                    raise RecoveryError('previous_voice_writer_still_live')
            except psutil.NoSuchProcess:pass
        receipt=dict(schema='village-source-backends-recovered/v1',inputs_sha256=self.inputs_sha,
                     intent_sha256=self.inputs['intent']['sha256'],stop_sha256=self.stop_sha,
                     destination_ever_activated=False,profiles=proof['profiles'])
        encoded=json.dumps(receipt,sort_keys=True,separators=(',',':')).encode();backends_sha=sha(encoded)
        backends=self.control/('BACKENDS-RECOVERED-'+backends_sha+'.json')
        def exact_new(path,raw):
            if path.is_symlink():raise RecoveryError('linked_recovery_artifact')
            if path.exists():
                if path.read_bytes()!=raw:raise RecoveryError('recovery_artifact_changed')
            else:
                with path.open('xb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
        exact_new(backends,encoded)
        directory=self.control/('voice-source-recovery-'+backends_sha[:16])
        if directory.is_symlink():raise RecoveryError('linked_recovery_controller_directory')
        directory.mkdir(exist_ok=True,mode=0o700);(directory/'helper-home').mkdir(exist_ok=True,mode=0o700)
        (directory/'code').mkdir(exist_ok=True,mode=0o700)
        dependencies=[]
        for ref in template['dependencies']:
            source=Path(ref['path']).resolve()
            if (not source.is_relative_to(checks.BASE.resolve()) or source.name not in
                    ('migration_voice_source_lease.py','migration_source_recovery.py')
                    or sha(source.read_bytes())!=ref['sha256']):raise RecoveryError('voice_controller_code_changed')
            target=directory/'code'/source.name;exact_new(target,source.read_bytes())
            dependencies.append({'path':str(target),'sha256':ref['sha256']})
        if {Path(r['path']).name for r in dependencies}!={'migration_voice_source_lease.py','migration_source_recovery.py'}:
            raise RecoveryError('complete_voice_controller_code_required')
        def reference(path):return {'path':str(path),'sha256':sha(path.read_bytes())}
        config=json.loads(json.dumps(template))
        config.update(dependencies=dependencies,prior_writers=prior,native_phase_writer=plan['native_phase_writer'],
            previous_controller_sha256=plan['previous_controller_sha256'],
            historical_stop_marker=reference(self.control/'SOURCE_STOP_REQUESTED'),
            recovery_authorization={'inputs':reference(self.control/'recovery-inputs.json'),
                'stop':reference(self.control/'source-stop-receipt.json'),'backends':reference(backends)})
        lease.validate_private_configuration(config,checks.BASE)
        raw=json.dumps(config,sort_keys=True,separators=(',',':')).encode();config_sha=sha(raw)
        config_path=directory/'config.json';exact_new(config_path,raw)
        auth={'schema':'village-current-voice-recovery/v1','inputs_sha256':self.inputs_sha,
            'intent_sha256':self.inputs['intent']['sha256'],'stop_sha256':self.stop_sha,
            'backends_sha256':backends_sha,'intake_config_sha256':config['intake_config_sha256'],
            'epoch':config['epoch'],'origin_source':config['origin_source'],
            'previous_controller_sha256':plan['previous_controller_sha256'],
            'controller_config_sha256':config_sha,'closure_sha256':plan.get('closure_sha256')}
        payload={'authorization':auth,'helper':plan['native_phase_writer'],'labels':checks.FUTURE_LABELS}
        native=r'''from pathlib import Path
import base64,hashlib,importlib.util,json,os,subprocess
C=Path('/Users/choijaehyeong/VillageMigration/20260930-windows/candidate')
p=json.loads(base64.b64decode(PAYLOAD));ref=p['helper'];helper=Path(ref['path']).resolve()
assert helper.is_relative_to(C/'state/voice-ingress-v1') and hashlib.sha256(helper.read_bytes()).hexdigest()==ref['sha256']
spec=importlib.util.spec_from_file_location('bound_voice_recovery_phase',helper)
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
def inactive():
 if os.getuid()!=501:return False
 domain='gui/501'
 q=subprocess.run(['/bin/launchctl','print',domain],capture_output=True,text=True,timeout=3)
 if q.returncode:return False
 files=list((C/'refresh-20261027-v2/control/launchd').glob('*.plist'))
 if {x.stem for x in files}!=set(p['labels']):return False
 for label in p['labels']:
  q=subprocess.run(['/bin/launchctl','print',domain+'/'+label],capture_output=True,text=True,timeout=3)
  if q.returncode!=113 or q.stderr.strip()!='Bad request.\nCould not find service "'+label+'" in domain for user gui: 501':return False
 return True
print(json.dumps(m.recover_source_phase(C,p['authorization'],is_inactive=inactive)))
'''.replace('PAYLOAD',repr(base64.b64encode(json.dumps(payload).encode()).decode()))
        self.gate()
        if self.verify_all()!=proof:raise RecoveryError('backend_owners_changed_before_native_recovery')
        command=['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',
                 '-i',checks.SSH_KEY,checks.REMOTE_HOST,checks.CANDIDATE+'/venv-root/bin/python -']
        run=subprocess.run(command,input=native.encode(),capture_output=True,timeout=25)
        if run.returncode or json.loads(run.stdout).get('recovered') is not True:
            raise RecoveryError('owned_native_voice_closure_not_recovered')
        self.gate()
        if self.verify_all()!=proof:raise RecoveryError('backend_owners_changed_before_voice_controller_start')
        launch=directory/'LAUNCH-ATTEMPT.json'
        if not launch.exists():
            write_new(launch,{'config_sha256':config_sha,'inputs_sha256':self.inputs_sha,'at':time.time()})
            env=dict(os.environ);env['HERMES_HOME']=str(directory/'helper-home');env.pop('PYTHONPATH',None)
            with (directory/'stdout.log').open('ab') as out,(directory/'stderr.log').open('ab') as err:
                subprocess.Popen([PYTHON,str(directory/'code/migration_voice_source_lease.py'),
                    '--config',str(config_path),'--config-sha',config_sha,'--run'],cwd=directory,env=env,
                    stdin=subprocess.DEVNULL,stdout=out,stderr=err,
                    creationflags=subprocess.CREATE_NO_WINDOW|subprocess.CREATE_NEW_PROCESS_GROUP)
        elif read_bound(launch,sha(launch.read_bytes())).get('config_sha256')!=config_sha:
            raise RecoveryError('different_or_uncertain_voice_controller_launch')
        expected={r['role']:{'pid':r['pid'],'started':r['start_time']/100} for r in proof['profiles']
                  if r['role'] in ('root','voice')}
        deadline=time.monotonic()+30
        while time.monotonic()<deadline:
            path=directory/'STATUS.json'
            if path.is_file():
                status=json.loads(path.read_text(encoding='utf-8'))
                if (status.get('config_sha256')==config_sha and status.get('status')=='windows_lease_current'
                        and checks.number(status.get('at_windows')) and 0<=time.time()-status['at_windows']<=15
                        and all(checks.same_identity(status.get('effective_owners',{}).get(r),v) for r,v in expected.items())):
                    try:
                        owner=psutil.Process(status['pid']);env=owner.environ()
                        if (abs(owner.create_time()-status['started'])>=.01
                                or checks.norm(owner.cwd())!=checks.norm(str(directory))
                                or env.get('HERMES_HOME')!=str(directory/'helper-home') or env.get('PYTHONPATH')
                                or owner.cmdline()[1:]!=[str(directory/'code/migration_voice_source_lease.py'),
                                    '--config',str(config_path),'--config-sha',config_sha,'--run']):
                            raise RecoveryError('restored_voice_keeper_process_identity_changed')
                    except psutil.Error:
                        raise RecoveryError('restored_voice_keeper_process_not_live') from None
                    self.verify_voice_ingress(proof)
                    return
                if status.get('terminal') is True:break
            time.sleep(.5)
        raise RecoveryError('restored_voice_authority_not_observed_leave_fenced')

    def verify_voice_ingress(self,proof):
        # Read-only route/authority check. It never writes phase, renews a lease,
        # starts a forwarder or submits speech. Ordinary request/reply readback
        # remains separate from this readiness observation.
        plan=self.gate()
        profiles=[{'role':x['role'],'pid':x['pid'],'start_time':round(x['started']*100),'state':'running'} for x in plan['steps']]
        if proof['profiles']!=profiles:
            raise RecoveryError('backend_owners_changed_before_voice_readback')
        _,intake=self.reference(self.inputs['voice_intake'])
        if intake.get('schema')!='village-voice-intake-preparation/v1':
            raise RecoveryError('original_voice_epoch_binding_required')
        expected={x['role']:{'pid':x['pid'],'started':x['started']} for x in plan['steps']
                  if x['role'] in ('root','voice')}
        script=r'''from pathlib import Path
from contextlib import closing
import hashlib,json,sqlite3,subprocess,time
from urllib.request import urlopen
C=Path('/Users/choijaehyeong/VillageMigration/20260930-windows/candidate');D=C/'state/voice-ingress-v1'
raw=(D/'config.json').read_bytes();cfg=json.loads(raw)
def health(port):
 with urlopen('http://127.0.0.1:'+str(port)+'/health',timeout=5) as response:return json.load(response)
front=health(18788);relay=health(28788)
with closing(sqlite3.connect((D/'voice.sqlite3').as_uri()+'?mode=ro',uri=True)) as db:
 conflicts=db.execute('SELECT count(*) FROM conflicts').fetchone()[0]
run=subprocess.run(['/Applications/Tailscale.app/Contents/MacOS/Tailscale','serve','status','--json'],capture_output=True,text=True,timeout=10,check=True)
serve=json.loads(run.stdout);host='mac-studio.tail7f97ff.ts.net:443'
route=serve.get('Web',{}).get(host,{}).get('Handlers',{}).get('/watch/voice')=={'Proxy':'http://127.0.0.1:18788'} and serve.get('AllowFunnel',{}).get(host) is True
# Read back the phase actually evaluated by the running pump. A renewing source
# lease may race one sample, so retry reads only, never requests or phase writes.
for attempt in range(8):
 front=health(18788);phase_raw=(D/'phase.json').read_bytes();phase=json.loads(phase_raw)
 phase_sha=hashlib.sha256(phase_raw).hexdigest()
 if (front.get('forwarder') or {}).get('phase_sha256')==phase_sha:break
 if attempt<7:time.sleep(.25)
origin_ok=phase.get('schema')=='village-voice-phase/v1' and phase.get('source')==cfg.get('source') and phase.get('epoch')==cfg.get('epoch')
print(json.dumps({'schema':'village-source-voice-dispatch-readback/v1','config_sha256':hashlib.sha256(raw).hexdigest(),
 'epoch':cfg['epoch'],'origin_source':cfg['source'],'phase_mode':phase.get('mode') if origin_ok else None,
 'effective_owners':phase.get('effective_owners',phase.get('source')),
 'lease_age_native_seconds':time.time()-phase.get('verified_unix',0),
 'phase_sha256':phase_sha,'forwarder':front.get('forwarder'),
 'native_activation_absent':not (C/'ACTIVATION.json').exists(),'native_closure_absent':not (C/'SOURCE-CLOSED.json').exists(),
 'intake_healthy':front.get('status')=='ok' and front.get('role')=='durable_voice_intake',
 'relay_healthy':relay.get('status')=='ok','counts':front.get('counts'),'conflicts':conflicts,'mac_route_verified':route}))
'''
        command=['ssh','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=8',
                 '-i',checks.SSH_KEY,checks.REMOTE_HOST,checks.CANDIDATE+'/venv-root/bin/python -']
        run=subprocess.run(['C:/Program Files/Tailscale/tailscale.exe','serve','status','--json'],
                           capture_output=True,text=True,timeout=10,check=True)
        serve=json.loads(run.stdout);host='ax2.tail7f97ff.ts.net:443'
        legacy_route_verified=(serve.get('Web',{}).get(host,{}).get('Handlers',{}).get('/watch/voice')
            =={'Proxy':'http://127.0.0.1:18788'} and serve.get('AllowFunnel',{}).get(host) is True)
        with urlopen('http://127.0.0.1:18788/health',timeout=5) as response:
            local=json.load(response)
        if local.get('role')!='durable_voice_intake':raise RecoveryError('legacy_voice_tunnel_not_ready')
        fresh=self.gate()
        current={x['role']:{'pid':x['pid'],'started':x['started']} for x in fresh['steps'] if x['role'] in expected}
        if current!=expected:raise RecoveryError('voice_owners_changed_during_readback')
        # Native phase is sampled last, after potentially slow scheduler reads.
        # Include the entire RPC time conservatively in its15-second age bound.
        observed=time.monotonic()
        run=subprocess.run(command,input=script.encode(),capture_output=True,timeout=25)
        if run.returncode:raise RecoveryError('native_voice_dispatch_readback_failed')
        evidence=json.loads(run.stdout);evidence['legacy_route_verified']=legacy_route_verified
        evidence['lease_age_native_seconds']+=time.monotonic()-observed
        if isinstance(evidence.get('forwarder'),dict) and checks.number(evidence['forwarder'].get('evaluation_age_seconds')):
            evidence['forwarder']['evaluation_age_seconds']+=time.monotonic()-observed
        validate_voice_ingress(evidence,expected,intake)
        self.assert_fence_lease()
        return evidence

    def publish(self,proof):
        if not self.resumed:raise RecoveryError('watcher_not_resumed')
        fresh=self.verify_all()
        if fresh!=proof:raise RecoveryError('recovery_owners_changed_before_receipt')
        voice=self.verify_voice_ingress(fresh)
        broker=json.loads((self.control/'BROKER-STATE.json').read_text(encoding='utf-8-sig'))
        result={'schema':'village-source-recovery/v1','nonce':broker['nonce'],
                'stopReceiptSha256':self.stop_sha,'destinationEverActivated':False,
                'profiles':proof['profiles'],'voiceDispatchRestored':True,
                'voiceDispatchEffectiveOwners':voice['effective_owners'],'at_unix':time.time()}
        write_new(self.control/'SOURCE-RECOVERED.json',result)
        return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--control',type=Path,default=checks.CONTROL)
    parser.add_argument('--inputs-sha',required=True);parser.add_argument('--stop-sha',required=True)
    modes=parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--verify-only',action='store_true');modes.add_argument('--execute',action='store_true')
    modes.add_argument('--launch-child',choices=('root','worker','voice'))
    parser.add_argument('--resume-watcher',action='store_true')
    args=parser.parse_args()
    try:
        adapter=WindowsAdapter(args.control,args.inputs_sha,args.stop_sha)
        if args.verify_only:
            adapter.gate();result={'verified':True,'launched':False,'task_changes':False}
        elif args.launch_child:
            adapter.launch_child(args.launch_child);result={'launch_requested':True,'task_changes':False}
        else:result=execute_recovery(adapter,resume_watcher=args.resume_watcher)
        print(json.dumps(result));return 0
    except (RecoveryError,OSError,ValueError,KeyError,TypeError,StopIteration,subprocess.SubprocessError):
        print(json.dumps({'verified':False,'source_ready':False,'task_changes':False,
                          'error':'current_recovery_failed_leave_fenced'}));return 2


if __name__=='__main__':raise SystemExit(main())
