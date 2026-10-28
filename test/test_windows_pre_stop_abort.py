import copy
from pathlib import Path
import sys
import tempfile
import json
import hashlib
from types import SimpleNamespace
from unittest.mock import patch
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/windows'))
import migration_pre_stop_abort as m


class OriginalOwnerTests(unittest.TestCase):
    def setUp(self):
        self.intent={'profiles':[dict(role=r,pid=10+i,started=100+i,exe='C:/bin/python.exe',cwd='C:/'+r,
            argv=['python.exe',r+'.py'],home='C:/'+r,pythonpath=None,ports=[8000+i]) for i,r in enumerate(m.checks.ROLES)]}
        self.source={'observed_at':200,'errors':[],'processes':copy.deepcopy(self.intent['profiles']),
                     'listeners':[{'pid':r['pid'],'port':r['ports'][0]} for r in self.intent['profiles']]}
        self.remote=dict(observed_at=200,host=m.checks.REMOTE_HOST,candidate=m.checks.CANDIDATE,
            inactive=True,activation_absent=True,domain_verified=True,uid=501,errors=[],labels={x:'unloaded' for x in m.checks.FUTURE_LABELS})

    def verify(self,**kw):return m.validate_original_owners(self.intent,self.source,self.remote,now=201,**kw)

    def test_original_live_owners_are_observations_without_stop_receipts(self):
        row=self.verify()
        self.assertEqual(len(row['steps']),5);self.assertNotIn('stop_sha256',row)
        self.assertFalse(row['source_stop_authorized'])

    def test_reused_pid_changed_contract_duplicate_and_new_native_owner_block(self):
        for change in ('birth','contract','duplicate','native'):
            source=copy.deepcopy(self.source);remote=copy.deepcopy(self.remote)
            if change=='birth':source['processes'][0]['started']+=1
            if change=='contract':source['processes'][0]['pythonpath']='other'
            if change=='duplicate':source['processes'].append(dict(source['processes'][0],pid=999))
            if change=='native':remote['labels'][m.checks.FUTURE_LABELS[0]]='loaded'
            with self.subTest(change=change),self.assertRaises(ValueError):
                m.validate_original_owners(self.intent,source,remote,now=201)

    def test_only_initial_http_recovery_can_tolerate_a_closed_bridge_port(self):
        owner=self.intent['profiles'][0]
        self.source['listeners']=[r for r in self.source['listeners'] if r['pid']!=owner['pid']]
        with self.assertRaises(ValueError):self.verify()
        self.verify(allow_closed_bridge=True)
        self.source['listeners'].append({'port':owner['ports'][0],'pid':999})
        with self.assertRaises(ValueError):self.verify(allow_closed_bridge=True)

    def test_unreadable_or_stale_observation_blocks(self):
        self.source['errors']=['unreadable']
        with self.assertRaises(ValueError):self.verify()

    def test_keeper_contracts_omit_pid_but_must_match_original_execution(self):
        config={'contracts':{r['role']:{k:v for k,v in r.items() if k not in ('pid','started','ports')}
                             for r in self.intent['profiles'] if r['role'] in ('root','voice')}}
        m.validate_keeper_contracts(config,self.intent)
        config['contracts']['root']['home']='other'
        with self.assertRaises(ValueError):m.validate_keeper_contracts(config,self.intent)

    def test_changed_or_unowned_drain_bytes_are_retained(self):
        with tempfile.TemporaryDirectory() as temp:
            home=Path(temp);marker=home/'.drain_request.json';marker.write_text('{"action":"drain","principal":"operator"}')
            raw=marker.read_bytes();owner=dict(self.intent['profiles'][0],role='root',home=str(home))
            a=object.__new__(m.WindowsAbortAdapter);a.gate=lambda:None;a.intent={'profiles':[owner]}
            a.config={'migration_id':'ours','drain_plans':[{'role':'root','path':str(marker),'owner':owner,
                'original_absent':True,'sha256':hashlib.sha256(raw).hexdigest(),'body':json.loads(raw)}]}
            with self.assertRaises(ValueError):a.cancel_owned_drain('root')
            self.assertEqual(marker.read_bytes(),raw)
        self.source['errors']=[];self.remote['observed_at']=100
        with self.assertRaises(ValueError):self.verify()


class TraceAdapter:
    def __init__(self,fail=None):self.trace=[];self.fail=fail
    def call(self,n):
        self.trace.append(n)
        if n==self.fail:raise RuntimeError(n)
    def gate(self,**kw):self.call('initial_gate' if kw else 'gate')
    def reopen_owned_http(self):self.call('http')
    def cancel_owned_drain(self,role):self.call('cancel_'+role)
    def wait_original_gateways(self):self.call('gateways_running')
    def restore_original_producers(self):self.call('producers')
    def verify_backends(self):self.call('backends');return {'observed':True}
    def restore_voice_authority(self,proof):self.call('voice_restore')
    def verify_voice_ingress(self,proof):self.call('voice_readback')
    def resume_owned_watcher(self):self.call('watcher')
    def publish_ready(self,proof):self.call('publish');return {'ready_to_restore_tasks':True}


class AbortOrderTests(unittest.TestCase):
    def test_mismatched_participant_rejected_before_node_or_drain_mutation(self):
        binding=lambda name:{'path':name,'sha256':'a'*64}
        shared=('intent','scheduler_manifest','browser','participant','node','voice_intake','watcher_helper')
        source={k:binding(k) for k in shared}
        config=dict(source,source_plan=binding('source-plan'))
        config['participant']=binding('different-participant')
        def reload(a):a.config=config
        with patch.object(m.WindowsAbortAdapter,'reload',reload),\
             patch.object(m.WindowsAbortAdapter,'reference',return_value=(Path('intent'),{'profiles':[]})),\
             patch.object(m.runtime,'WindowsStopAdapter',return_value=SimpleNamespace(plan=source)),\
             patch.object(m.WindowsAbortAdapter,'node_action') as node,\
             patch.object(m.WindowsAbortAdapter,'cancel_owned_drain') as drain:
            with self.assertRaises(ValueError):m.WindowsAbortAdapter(m.checks.BASE/'synthetic-abort-config.json','a'*64)
            node.assert_not_called();drain.assert_not_called()

    def test_abort_never_fabricates_stop_and_voice_precedes_watcher(self):
        a=TraceAdapter();r=m.execute_abort(a)
        self.assertTrue(r['ready_to_restore_tasks'])
        self.assertLess(a.trace.index('http'),a.trace.index('cancel_worker'))
        self.assertLess(a.trace.index('gateways_running'),a.trace.index('producers'))
        self.assertLess(a.trace.index('voice_readback'),a.trace.index('watcher'))
        self.assertEqual(a.trace[-1],'publish')

    def test_failed_gate_or_restore_never_resumes_ingress_or_publishes_ready(self):
        for failure in ('initial_gate','http','cancel_root','producers','backends','voice_restore','voice_readback'):
            a=TraceAdapter(failure)
            with self.subTest(failure=failure),self.assertRaises(RuntimeError):m.execute_abort(a)
            self.assertNotIn('watcher',a.trace);self.assertNotIn('publish',a.trace)

    def test_failure_after_watcher_resume_has_no_task_restore_authority(self):
        a=TraceAdapter();base=a.verify_backends;count=0
        def changed():
            nonlocal count
            count+=1
            if count==2:raise RuntimeError('owner changed')
            return base()
        a.verify_backends=changed
        with self.assertRaises(RuntimeError):m.execute_abort(a)
        self.assertIn('watcher',a.trace);self.assertNotIn('publish',a.trace)


if __name__=='__main__':unittest.main()
