"""Five-owner stop ordering and failure receipts; no production processes."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import unittest

SCRIPTS=Path(__file__).resolve().parents[1]/'scripts/windows'
sys.path.insert(0,str(SCRIPTS))
try:
    import migration_source_stop as stop
except ImportError:
    stop=None


class Fake:
    def __init__(self):
        self.events=[];self.files={};self.fail=None;self.live=set(stop.ROLES)
        self.intent_sha='a'*64
        self.intent={'profiles':[dict(role=r,pid=100+i,started=10.0) for i,r in enumerate(stop.ROLES)]}
        self.inventory={r:[dict(pid=200+i,started=11.0)] for i,r in enumerate(stop.ROLES)}
    def gate(self,stage):
        self.events.append('gate:'+stage)
        if self.fail==stage:raise RuntimeError('Injected gate failure')
    def inventory_children(self):
        self.events.append('inventory');return copy.deepcopy(self.inventory)
    def persist(self,name,value):
        self.events.append('persist:'+name);self.files[name]=copy.deepcopy(value)
        return hashlib.sha256(json.dumps(value,separators=(',',':')).encode()).hexdigest()
    def start_bridge_participant(self):self.events.append('participant:start')
    def wait_bridge_ready(self):
        self.events.append('participant:ready');return {'sha256':'b'*64,'evidence':{'schema':'village-current-bridge-accepted-work-observation/v1'}}
    def accepted_work(self,ready):
        self.events.append('accepted_work');return {'intent_sha256':self.intent_sha,'observation_sha256':ready['sha256']}
    def command_bridge_stop(self,ready):self.events.append('participant:stop')
    def wait_bridge_ack(self,ready):self.events.append('participant:ack')
    def terminate_owned_tree(self,role,children):
        self.events.append('terminate:'+role)
        if self.fail==role:
            self.live.remove(role)
            raise RuntimeError('Injected partial tree failure')
        self.live.remove(role)
    def classify_tree(self,role,children):
        return 'unaffected' if role in self.live else 'stopped'
    def wait_bridge_exit(self,ready):self.events.append('participant:exit')
    def stop_request_present(self):return 'SOURCE_STOP_REQUESTED' in self.files
    def abort_bridge_participant(self):self.events.append('participant:abort')
    def verify_all_closed(self):self.events.append('closed')
    def clock(self):return 20.0


class StopTests(unittest.TestCase):
    def setUp(self):self.assertIsNotNone(stop,'operational source-stop coordinator required')
    def test_all_five_stop_only_after_durable_intent_and_ack(self):
        a=Fake();r=stop.execute_stop(a)
        self.assertTrue(r['source_closed']);self.assertEqual(len(r['profiles']),5)
        e=a.events
        self.assertLess(e.index('inventory'),e.index('persist:SOURCE_STOP_REQUESTED'))
        self.assertLess(e.index('persist:accepted-work-closure.json'),e.index('persist:SOURCE_STOP_REQUESTED'))
        self.assertLess(e.index('persist:SOURCE_STOP_REQUESTED'),e.index('participant:stop'))
        self.assertLess(e.index('participant:ack'),e.index('terminate:bridge'))
        self.assertLess(e.index('participant:exit'),e.index('terminate:relay'))
        self.assertLess(e.index('closed'),e.index('persist:source-stop-receipt.json'))
    def test_any_pre_stop_gate_failure_never_terminates_or_creates_stop_marker(self):
        for stage in ('before_participant','before_stop_intent'):
            with self.subTest(stage=stage):
                a=Fake();a.fail=stage
                with self.assertRaises(RuntimeError):stop.execute_stop(a)
                self.assertFalse(any(x.startswith('terminate:') for x in a.events))
                self.assertNotIn('SOURCE_STOP_REQUESTED',a.files)
                if stage=='before_stop_intent':self.assertIn('participant:abort',a.events)
    def test_partial_stop_persists_complete_before_stop_children_and_all_statuses(self):
        a=Fake();a.fail='worker'
        with self.assertRaises(RuntimeError):stop.execute_stop(a)
        r=a.files['source-stop-partial-receipt.json']
        self.assertFalse(r['source_closed']);self.assertEqual(len(r['profiles']),5)
        self.assertEqual({x['role']:x['status'] for x in r['profiles']},
                         {'bridge':'stopped','relay':'stopped','worker':'stopped','root':'unaffected','voice':'unaffected'})
        for row in r['profiles']:
            self.assertTrue(row['children_inventory_complete']);self.assertEqual(row['children'],a.inventory[row['role']])
        self.assertFalse(any(x=='terminate:root' for x in a.events))
    def test_a_post_intent_gate_failure_is_retained_as_a_stop_attempt_without_false_closure(self):
        a=Fake();a.fail='before_terminate:bridge'
        with self.assertRaises(RuntimeError):stop.execute_stop(a)
        self.assertIn('SOURCE_STOP_REQUESTED',a.files)
        r=a.files['source-stop-partial-receipt.json'];self.assertFalse(r['source_closed'])
        self.assertTrue(all(x['status']=='unaffected' for x in r['profiles']))
    def test_changed_or_incomplete_child_inventory_cannot_authorize_stop(self):
        for value in ({}, {'bridge':[]}, {r:[{'pid':0,'started':1}] for r in stop.ROLES}):
            a=Fake();a.inventory=value
            with self.assertRaises(ValueError):stop.execute_stop(a)
            self.assertNotIn('SOURCE_STOP_REQUESTED',a.files)
    def test_a_partially_closed_child_tree_is_never_reported_stopped_or_unaffected(self):
        a=Fake();a.fail='worker';prior=a.classify_tree
        a.classify_tree=lambda r,c:'partial' if r=='worker' else prior(r,c)
        with self.assertRaises(RuntimeError):stop.execute_stop(a)
        row=next(x for x in a.files['source-stop-partial-receipt.json']['profiles'] if x['role']=='worker')
        self.assertEqual(row['status'],'partial');self.assertFalse(a.files['source-stop-partial-receipt.json']['source_closed'])


class ReconciliationTests(unittest.TestCase):
    def fixture(self):
        from test_windows_current_source_recovery import SourceRecoveryTests
        f=SourceRecoveryTests();f.setUp();return f
    def test_partial_receipt_is_reconciled_only_after_every_old_parent_and_child_is_gone(self):
        f=self.fixture();old=copy.deepcopy(f.receipt);old['profiles'][0]['status']='partial'
        old['profiles'][0]['children']=[{'pid':90,'started':105}]
        result=stop.reconcile_receipt(f.intent,old,'c'*64,'a'*64,f.snapshot,f.remote,now=f.now,activated=False)
        self.assertTrue(result['ready'],result['errors']);self.assertEqual(result['receipt']['profiles'][0]['status'],'stopped')
        self.assertEqual(result['receipt']['reconciled_from_sha256'],'c'*64)
        f.snapshot['processes']=[dict(pid=90,started=105,exe='C:/runtime/bun.exe',argv=['C:/runtime/bun.exe'],cwd='C:/runtime',home=None,pythonpath=None,ancestors=[])]
        result=stop.reconcile_receipt(f.intent,old,'c'*64,'a'*64,f.snapshot,f.remote,now=f.now,activated=False)
        self.assertFalse(result['ready']);self.assertIsNone(result['receipt'])
    def test_no_process_stopped_can_use_only_fresh_reconciled_abort_receipt(self):
        f=self.fixture();old=copy.deepcopy(f.receipt)
        for row in old['profiles']:row['status']='unknown'
        f.snapshot['processes']=copy.deepcopy(f.intent['profiles'])
        f.snapshot['listeners']=[dict(port=p,pid=r['pid']) for r in f.intent['profiles'] for p in r['ports']]
        result=stop.reconcile_receipt(f.intent,old,'c'*64,'a'*64,f.snapshot,f.remote,now=f.now,activated=False)
        self.assertTrue(result['ready'],result['errors']);self.assertTrue(result['receipt']['stop_attempt_only'])
        self.assertFalse(result['receipt']['source_closed'])
        self.assertTrue(all(x['status']=='unaffected' for x in result['receipt']['profiles']))
        f.remote['activation_absent']=False
        self.assertFalse(stop.reconcile_receipt(f.intent,old,'c'*64,'a'*64,f.snapshot,f.remote,now=f.now,activated=False)['ready'])


if __name__=='__main__':unittest.main()
