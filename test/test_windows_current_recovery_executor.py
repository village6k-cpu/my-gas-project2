"""No production starts: current guarded recovery ordering and failure fences."""
from pathlib import Path
import sys
import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
from datetime import datetime,timezone
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts/windows'))
from migration_source_recovery_executor import execute_recovery, RecoveryError, WindowsAdapter, read_bound, sha
from migration_source_recovery_executor import validate_voice_ingress


class Adapter:
    def __init__(self):
        self.events=[];self.live=set();self.fail_at=None;self.count=0
    def gate(self):
        self.count+=1;self.events.append('gate')
        if self.count==self.fail_at:raise RecoveryError('fixture revoked')
        return {'steps':[{'role':role,'method':'reuse_verified_replacement' if role in self.live else
                         ('current_guarded_bridge_relay_recovery_required' if role in ('bridge','relay') else 'known_scheduler_task')}
                         for role in ('root','worker','bridge','relay','voice')]}
    def start_profile(self,role):self.events.append('start:'+role);self.live.add(role)
    def prepare_profile(self,role):self.events.append('prepare:'+role)
    def wait_owner(self,role):
        self.events.append('owner:'+role)
        if role not in self.live:raise RecoveryError('owner absent')
    def start_guarded_pair(self):
        if 'worker' not in self.live:raise RecoveryError('worker must precede guarded health')
        self.events.append('guarded');self.live.update(('bridge','relay'))
    def wait_guarded_pair(self):self.events.append('guarded-ready')
    def restore_preserved_bridge_producers(self):self.events.append('preserved-producers')
    def verify_all(self):
        self.events.append('all-ready')
        if self.live != {'root','worker','bridge','relay','voice'}:raise RecoveryError('incomplete')
        return {'profiles':sorted(self.live)}
    def resume_watcher(self):
        self.verify_voice_ingress(self.verify_all());self.events.append('resume')
    def publish(self,proof):self.events.append('receipt');return proof
    def verify_voice_ingress(self,proof):self.events.append('voice-ingress-ready')
    def restore_voice_authority(self,proof):self.events.append('restore-voice-authority')


class CurrentExecutorTests(unittest.TestCase):
    def test_preserved_producers_are_recovered_before_guard_readiness_and_watcher(self):
        a=Adapter();execute_recovery(a,resume_watcher=True)
        self.assertLess(a.events.index('preserved-producers'),a.events.index('guarded-ready'))
        self.assertLess(a.events.index('preserved-producers'),a.events.index('resume'))

    def test_failed_producer_recovery_never_restores_watcher_or_publishes_ready(self):
        a=Adapter()
        def fail():raise RecoveryError('owned producer recovery not proven')
        a.restore_preserved_bridge_producers=fail
        with self.assertRaises(RecoveryError):execute_recovery(a,resume_watcher=True)
        self.assertNotIn('resume',a.events);self.assertNotIn('receipt',a.events)

    def test_preserved_bridge_requires_explicit_bound_recovery_input(self):
        a=WindowsAdapter.__new__(WindowsAdapter);a.inputs={}
        a.receipt={'stop_attempt_only':True,'profiles':[{'role':r,'status':'unaffected'} for r in ('root','worker','bridge','relay','voice')]}
        a.gate=lambda:{'steps':[{'role':r,'method':'preserve_unaffected'} for r in ('root','worker','bridge','relay','voice')]}
        with self.assertRaisesRegex(RecoveryError,'bound_producer_recovery_required'):
            a.restore_preserved_bridge_producers()

    def test_changed_cli_is_rejected_before_node_launch_or_any_drain_removal(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve();intent={'path':'fixture-intent','sha256':'a'*64}
            config={'schema':'village-current-bridge-stop-participant/v1','intent':intent,'dependencies':[]}
            for name in ('migration_bridge_stop_cli.mjs','migration_bridge_stop_handoff.mjs',
                    'migration_bridge_inspector_session.mjs','migration_bridge_producer_adapter.mjs',
                    'migration_bridge_producer_fence.mjs','migration_bridge_http_adapter.mjs',
                    'migration_bridge_http_closure.mjs','migration_bridge_work_probe.mjs','migration_bridge_promise_census.mjs'):
                p=root/name;p.write_bytes(b'// SYNTHETIC only')
                config['dependencies'].append({'path':str(p),'sha256':sha(p.read_bytes())})
            (root/'migration_bridge_stop_cli.mjs').write_bytes(b'throw Error("changed CLI must never execute")')
            a=WindowsAdapter.__new__(WindowsAdapter)
            a.inputs={'intent':intent,'bridge_producer_recovery':{'path':'bound','sha256':'b'*64}}
            a.receipt={'stop_attempt_only':True,'profiles':[{'role':r,'status':'unaffected'} for r in ('root','worker','bridge','relay','voice')]}
            a.gate=lambda:{'steps':[{'role':r,'method':'preserve_unaffected'} for r in ('root','worker','bridge','relay','voice')]}
            a.reference=lambda _: (root/'config.json',config)
            a.prepare_profile=lambda _:self.fail('drain was removed before dependency check')
            with patch('migration_source_recovery_executor.checks.BASE',root),patch('migration_source_recovery_executor.subprocess.run') as launch:
                with self.assertRaisesRegex(RecoveryError,'dependency_changed_before_import'):
                    a.restore_preserved_bridge_producers()
                launch.assert_not_called()

    def test_missing_bound_voice_recovery_plan_cannot_launch_a_keeper(self):
        a=WindowsAdapter.__new__(WindowsAdapter);a.inputs={}
        a.gate=lambda:None;a.verify_all=lambda:{'profiles':[]}
        with patch('migration_source_recovery_executor.subprocess.Popen') as launch:
            with self.assertRaisesRegex(RecoveryError,'bound_voice_recovery_plan_required'):
                a.restore_voice_authority({'profiles':[]})
            launch.assert_not_called()

    def test_voice_authority_is_restored_after_all_backends_and_before_watcher(self):
        a=Adapter();execute_recovery(a,resume_watcher=True)
        self.assertLess(a.events.index('all-ready'),a.events.index('restore-voice-authority'))
        self.assertLess(a.events.index('restore-voice-authority'),a.events.index('resume'))

    def test_failed_voice_authority_restore_keeps_watcher_and_receipt_fenced(self):
        a=Adapter()
        def fail(_):raise RecoveryError('native closure belongs to another stop')
        a.restore_voice_authority=fail
        with self.assertRaises(RecoveryError):execute_recovery(a,resume_watcher=True)
        self.assertNotIn('resume',a.events);self.assertNotIn('receipt',a.events)

    def test_authority_revoked_by_slow_resume_gate_cannot_resume_watcher(self):
        a=WindowsAdapter.__new__(WindowsAdapter);a.resumed=False
        a.browser={};a.pause_path=Path('fixture-pause')
        permitted=[True];mutations=[]
        def slow_gate():permitted[0]=False
        def verify(_):
            if not permitted[0]:raise RecoveryError('voice authority expired during gate')
        a.gate=slow_gate
        a.verify_all=lambda:{}
        a.inspect_watcher=lambda:SimpleNamespace(operate=lambda *args:mutations.append(args))
        a.verify_voice_ingress=verify
        with self.assertRaises(RecoveryError):a.resume_watcher()
        self.assertEqual(mutations,[]);self.assertFalse(a.resumed)

    def fence_fixture(self,directory):
        a=WindowsAdapter.__new__(WindowsAdapter);a.control=Path(directory)
        tasks=[{'name':'task-'+str(i),'path':'\\','definitionSha256':str(i).zfill(64)} for i in range(21)]
        manifest=a.control/'manifest.json';manifest.write_text(json.dumps({'tasks':tasks}))
        import hashlib
        pin=hashlib.sha256(manifest.read_bytes()).hexdigest()
        a.inputs={'scheduler_manifest':{'path':str(manifest),'sha256':pin}}
        state={'active':True,'fenced':True,'nonce':'fixture-nonce',
               'manifestSha256':pin,'at':datetime.now(timezone.utc).isoformat()}
        (a.control/'BROKER-STATE.json').write_text(json.dumps(state))
        fence={'valid':True,'all21Disabled':True,'nonce':'fixture-nonce','manifestSha256':pin}
        (a.control/'SCHEDULER-FENCED.json').write_text(json.dumps(fence))
        return a,state,fence

    def test_lease_revocation_during_definition_read_is_rechecked(self):
        with tempfile.TemporaryDirectory() as directory:
            a,state,_=self.fence_fixture(directory)
            def revoke(_):
                state['active']=False
                (a.control/'BROKER-STATE.json').write_text(json.dumps(state))
                tasks=json.loads(Path(a.inputs['scheduler_manifest']['path']).read_text())['tasks']
                return json.dumps([dict(row,enabled=False) for row in tasks])
            with patch('migration_source_recovery_executor.powershell',side_effect=revoke):
                with self.assertRaises(RecoveryError):a.assert_fenced()

    def test_rejected_fence_cannot_be_reused_even_while_broker_active(self):
        with tempfile.TemporaryDirectory() as directory:
            a,_,fence=self.fence_fixture(directory)
            fence['valid']=False
            (a.control/'SCHEDULER-FENCED.json').write_text(json.dumps(fence))
            with patch('migration_source_recovery_executor.powershell',return_value='') as task_read:
                with self.assertRaises(RecoveryError):a.assert_fenced()
                task_read.assert_not_called()

    def test_backend_only_recovery_is_not_full_source_recovery(self):
        a=Adapter();result=execute_recovery(a)
        self.assertTrue(result['source_backends_ready'])
        self.assertFalse(result['source_ready'])
        self.assertNotIn('receipt',a.events)

    def test_held_public_voice_prevents_watcher_resume_and_recovery_receipt(self):
        a=Adapter()
        def held(_):raise RecoveryError('native voice dispatch remains held')
        a.verify_voice_ingress=held
        with self.assertRaises(RecoveryError):execute_recovery(a,resume_watcher=True)
        self.assertNotIn('resume',a.events);self.assertNotIn('receipt',a.events)

    def test_worker_precedes_guarded_pair_then_root_and_voice(self):
        a=Adapter();r=execute_recovery(a,resume_watcher=True)
        self.assertEqual([x for x in a.events if x.startswith('start:') or x=='guarded'],
                         ['start:worker','guarded','start:root','start:voice'])
        self.assertEqual(a.events[-1],'receipt')
        self.assertLess(a.events.index('all-ready'),a.events.index('resume'))
        self.assertFalse(r['task_states_restored'])
        self.assertTrue(r['ready_to_unfence'])
    def test_authority_revocation_stops_before_next_start_and_keeps_watcher_paused(self):
        a=Adapter();a.fail_at=2
        with self.assertRaises(RecoveryError):execute_recovery(a,resume_watcher=True)
        self.assertNotIn('resume',a.events);self.assertNotIn('receipt',a.events)
        self.assertNotIn('guarded',a.events)
    def test_verified_replacements_and_unaffected_roles_are_not_restarted(self):
        a=Adapter();a.live={'root','worker','bridge','relay','voice'}
        result=execute_recovery(a)
        self.assertFalse(any(x.startswith('start:') or x=='guarded' for x in a.events))
        self.assertFalse(result['ready_to_unfence'])
        self.assertNotIn('receipt',a.events)


    def test_guarded_failure_cannot_advance_to_root_or_unfence(self):
        a=Adapter()
        def reject():raise RecoveryError('fixture guarded contract failed')
        a.wait_guarded_pair=reject
        with self.assertRaises(RecoveryError):execute_recovery(a,resume_watcher=True)
        self.assertNotIn('start:root',a.events);self.assertNotIn('resume',a.events)
    def test_partial_pair_uses_guarded_procedure_once_and_never_normal_start_task(self):
        a=Adapter();a.live={'worker','bridge'}
        execute_recovery(a)
        self.assertEqual(a.events.count('guarded'),1)
        self.assertFalse(any('Production-Start' in x for x in a.events))

    def test_child_start_has_an_exclusive_durable_attempt_fence(self):
        with tempfile.TemporaryDirectory() as directory:
            a=WindowsAdapter.__new__(WindowsAdapter)
            a.control=Path(directory);a.inputs_sha='a'*64
            a.intent={'profiles':[{'role':'root','argv':['fixture-only'], 'exe':'fixture-only','cwd':directory}]}
            a.envs={'root':{}}
            a.gate=lambda:{'steps':[{'role':'root','method':'known_scheduler_task'}]}
            a.prepare_profile=lambda role:None
            a.begin=lambda:None
            (a.control/'launch-root.json').write_text(json.dumps({'inputs_sha256':a.inputs_sha}))
            with patch('migration_source_recovery_executor.subprocess.Popen',return_value=SimpleNamespace(pid=999)) as launch, \
                 patch('migration_source_recovery_executor.subprocess.CREATE_NO_WINDOW',0,create=True), \
                 patch('migration_source_recovery_executor.subprocess.CREATE_NEW_PROCESS_GROUP',0,create=True):
                a.launch_child('root')
                with self.assertRaises((RecoveryError,FileExistsError)):a.launch_child('root')
                self.assertEqual(launch.call_count,1)

    def test_changed_private_bound_input_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'fixture.json';raw=b'{"fixture":1}';path.write_bytes(raw)
            self.assertEqual(read_bound(path,sha(raw)),{'fixture':1})
            path.write_bytes(b'{"fixture":2}')
            with self.assertRaisesRegex(RecoveryError,'bound_input_changed'):read_bound(path,sha(raw))

    def test_unapproved_child_role_never_starts_a_process(self):
        a=WindowsAdapter.__new__(WindowsAdapter)
        with patch('migration_source_recovery_executor.subprocess.Popen') as launch:
            with self.assertRaises(RecoveryError):a.launch_child('bridge')
            launch.assert_not_called()

    def test_production_home_or_pythonpath_is_rejected_for_helpers(self):
        with tempfile.TemporaryDirectory() as directory:
            a=WindowsAdapter.__new__(WindowsAdapter);a.control=Path(directory)
            with patch.dict(os.environ,{'HERMES_HOME':'fixture-production','PYTHONPATH':'fixture-code'},clear=True):
                with self.assertRaises(RecoveryError):a.assert_helper_isolated()
            with patch.dict(os.environ,{'HERMES_HOME':str(a.control/'helper-home')},clear=True):
                a.assert_helper_isolated()
                os.environ['PYTHONPATH']='fixture-production-code'
                with self.assertRaises(RecoveryError):a.assert_helper_isolated()

    def test_only_hash_bound_owned_drain_is_removed_after_old_owner_closure(self):
        with tempfile.TemporaryDirectory() as directory:
            a=WindowsAdapter.__new__(WindowsAdapter);a.control=Path(directory)
            home=Path(directory)/'fixture-profile';home.mkdir()
            marker=home/'.drain_request.json'
            body={'action':'drain','principal':'village-studio-migration:fixture',
                  'migration_id':'fixture','owner':{'pid':12,'started':34.5}}
            raw=json.dumps(body).encode();marker.write_bytes(raw)
            old={'role':'root','pid':12,'started':34.5,'home':str(home)}
            a.intent={'profiles':[old]};a.receipt={'profiles':[dict(old,status='stopped')]}
            a.inputs={'intent':{'sha256':'a'*64}}
            a.drains={'migration_id':'fixture','intent_sha256':'a'*64,
                      'profiles':[{'role':'root','path':str(marker),'created':True,'original_absent':True,
                                   'sha256':sha(raw),'owner':{'pid':12,'started':34.5}}]}
            a.gate=lambda:{'steps':[{'role':'root','method':'known_scheduler_task'}]}
            a.prepare_profile('root');self.assertFalse(marker.exists())
            a.prepare_profile('root')  # interrupted caller can observe its exact removal intent.
            marker.write_bytes(b'{"other":"operator drain"}')
            with self.assertRaises(RecoveryError):a.prepare_profile('root')
            self.assertTrue(marker.exists())

    def test_preserved_exact_old_owner_can_cancel_its_own_migration_drain(self):
        with tempfile.TemporaryDirectory() as directory:
            a=WindowsAdapter.__new__(WindowsAdapter);a.control=Path(directory)
            home=Path(directory)/'fixture-profile';home.mkdir();marker=home/'.drain_request.json'
            old={'role':'root','pid':12,'started':34.5,'home':str(home)}
            raw=json.dumps({'action':'drain','principal':'village-studio-migration:fixture',
                            'migration_id':'fixture','owner':{'pid':12,'started':34.5}}).encode()
            marker.write_bytes(raw)
            a.intent={'profiles':[old]};a.receipt={'profiles':[dict(old,status='unaffected')]}
            a.inputs={'intent':{'sha256':'a'*64}}
            a.drains={'migration_id':'fixture','intent_sha256':'a'*64,
                      'profiles':[{'role':'root','path':str(marker),'created':True,'original_absent':True,
                                   'sha256':sha(raw),'owner':{'pid':12,'started':34.5}}]}
            a.gate=lambda:{'steps':[dict(old,method='preserve_unaffected')]}
            a.prepare_profile('root');self.assertFalse(marker.exists())

    def test_unaffected_old_owner_drain_cannot_be_cleared(self):
        with tempfile.TemporaryDirectory() as directory:
            a=WindowsAdapter.__new__(WindowsAdapter);a.control=Path(directory)
            a.gate=lambda:{'steps':[{'role':'root','method':'preserve_unaffected'}]}
            a.receipt={'profiles':[{'role':'root','status':'unaffected'}]}
            a.intent={'profiles':[{'role':'root','home':directory}]}
            a.drains={'profiles':[]};a.inputs={}
            with self.assertRaises(RecoveryError):a.prepare_profile('root')


class VoiceDispatchReadbackTests(unittest.TestCase):
    def setUp(self):
        self.owners={'root':{'pid':10,'started':100.1},'voice':{'pid':11,'started':100.2}}
        self.intake={'epoch':'fixture-epoch','source':self.owners,'config_sha256':'a'*64}
        self.row={'schema':'village-source-voice-dispatch-readback/v1','config_sha256':'a'*64,
            'epoch':'fixture-epoch','origin_source':self.owners,'effective_owners':self.owners,
            'phase_mode':'windows','lease_age_native_seconds':2.0,'native_activation_absent':True,
            'native_closure_absent':True,'mac_route_verified':True,'legacy_route_verified':True,
            'intake_healthy':True,'relay_healthy':True,'counts':{},'conflicts':0,
            'forwarder':{'schema':'village-voice-forwarder-runtime/v1','thread_alive':True,
                'failed':False,'config_sha256':'a'*64,'epoch':'fixture-epoch',
                'authority':'windows','evaluation_age_seconds':.1,'phase_sha256':'b'*64},
            'phase_sha256':'b'*64}

    def test_healthy_http_and_phase_do_not_prove_live_forwarding_consumer(self):
        original=dict(self.row['forwarder'])
        for key,value in (('thread_alive',False),('failed',True),('authority',None),
             ('evaluation_age_seconds',3),('evaluation_age_seconds',float('nan')),
             ('phase_sha256','c'*64),('config_sha256','c'*64),('epoch','wrong')):
            self.row['forwarder']=dict(original);self.row['forwarder'][key]=value
            with self.subTest(key=key):
                with self.assertRaises(RecoveryError):validate_voice_ingress(self.row,self.owners,self.intake)
        self.row['forwarder']=None
        with self.assertRaises(RecoveryError):validate_voice_ingress(self.row,self.owners,self.intake)

    def test_original_or_proven_replacement_identity_must_match_dispatch(self):
        validate_voice_ingress(self.row,self.owners,self.intake)
        changed={'root':{'pid':20,'started':200.1},'voice':self.owners['voice']}
        with self.assertRaisesRegex(RecoveryError,'old_or_unknown_source'):
            validate_voice_ingress(self.row,changed,self.intake)
        self.row['effective_owners']=changed
        validate_voice_ingress(self.row,changed,self.intake)

    def test_held_stale_activated_or_wrong_route_is_not_ready(self):
        original=dict(self.row)
        for key,value in (('phase_mode','hold'),('lease_age_native_seconds',16),
             ('lease_age_native_seconds',float('nan')),('native_activation_absent',False),
             ('native_closure_absent',False),('mac_route_verified',False),
             ('legacy_route_verified',False),('relay_healthy',False),('epoch','wrong')):
            self.row=dict(original);self.row[key]=value
            with self.subTest(key=key,value=value):
                with self.assertRaises(RecoveryError):validate_voice_ingress(self.row,self.owners,self.intake)

    def test_uncertain_delivery_conflicts_or_unknown_states_block(self):
        for counts,conflicts in (({'uncertain':1},0),({'dispatching':1},0),({},1),
                                ({'unknown':1},0),({'queued':False},0)):
            self.row.update(counts=counts,conflicts=conflicts)
            with self.assertRaises(RecoveryError):validate_voice_ingress(self.row,self.owners,self.intake)


if __name__=='__main__':unittest.main()
