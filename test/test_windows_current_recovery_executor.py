"""No production starts: current guarded recovery ordering and failure fences."""
from pathlib import Path
import sys
import json
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts/windows'))
from migration_source_recovery_executor import execute_recovery, RecoveryError, WindowsAdapter, read_bound, sha


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
    def verify_all(self):
        self.events.append('all-ready')
        if self.live != {'root','worker','bridge','relay','voice'}:raise RecoveryError('incomplete')
        return {'profiles':sorted(self.live)}
    def resume_watcher(self):self.events.append('resume')
    def publish(self,proof):self.events.append('receipt');return proof


class CurrentExecutorTests(unittest.TestCase):
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


if __name__=='__main__':unittest.main()
