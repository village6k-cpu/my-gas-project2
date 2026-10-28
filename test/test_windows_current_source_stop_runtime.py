import importlib
from pathlib import Path
import subprocess
import sys
import time
import unittest
from datetime import datetime,timezone
import psutil
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/windows'))
try:runtime=importlib.import_module('migration_source_stop_runtime')
except ImportError:runtime=None


class RuntimeTests(unittest.TestCase):
    def setUp(self):self.assertIsNotNone(runtime,'exact-owner source stop runtime required')
    def process(self,script='import time;time.sleep(60)'):
        # A Windows venv executable is a redirector and adds an interpreter
        # child. Use the actual native interpreter for this exact-owner fixture.
        p=subprocess.Popen([psutil.Process().exe(),'-c',script],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        def cleanup():
            if p.poll() is None:p.kill()
            p.wait(timeout=3)
        self.addCleanup(cleanup);time.sleep(.2)
        q=psutil.Process(p.pid)
        return p,dict(pid=p.pid,started=q.create_time(),exe=q.exe(),argv=q.cmdline(),cwd=q.cwd())
    def test_reused_or_wrong_birth_never_terminates_the_live_process(self):
        p,row=self.process();row['started']-=100
        with self.assertRaises(RuntimeError):runtime.terminate_exact_tree(row,[],wait_seconds=1)
        self.assertIsNone(p.poll())
    def test_unaccounted_child_blocks_termination_before_parent_or_child_is_touched(self):
        p,row=self.process('import subprocess,sys,time;subprocess.Popen([sys.executable,"-c","import time;time.sleep(60)"]);time.sleep(60)')
        deadline=time.monotonic()+5;children=[]
        while not children and time.monotonic()<deadline:
            children=psutil.Process(p.pid).children(recursive=True)
            if not children:time.sleep(.05)
        self.addCleanup(lambda:[c.kill() for c in children if c.is_running()])
        self.assertTrue(children)
        with self.assertRaises(RuntimeError):runtime.terminate_exact_tree(row,[],wait_seconds=1)
        self.assertIsNone(p.poll());self.assertTrue(all(c.is_running() for c in children))
    def test_exact_owned_idle_fixture_can_be_closed_and_confirmed_absent(self):
        p,row=self.process();runtime.terminate_exact_tree(row,[],wait_seconds=1)
        p.wait(timeout=2);self.assertFalse(runtime.identity_alive(row))
    def test_gateway_drain_refuses_pending_work_or_stale_drain_ownership(self):
        owner={'pid':123,'started':10.0}
        state={'pid':123,'start_time':1000,'gateway_state':'draining','active_agents':0,
               'updated_at':datetime.fromtimestamp(1000,timezone.utc).isoformat()}
        runtime.validate_gateway_drain(owner,state,pending=0,cron=0,now=1000)
        for change in ({'active_agents':True},{'gateway_state':'running'},{'pid':124}):
            with self.assertRaises(ValueError):runtime.validate_gateway_drain(owner,{**state,**change},pending=0,cron=0,now=1000)
        with self.assertRaises(ValueError):runtime.validate_gateway_drain(owner,state,pending=1,cron=0,now=1000)
        for stamp in (None,'2000-01-01T00:00:00+00:00','unparseable',datetime.fromtimestamp(1001,timezone.utc).isoformat()):
            with self.assertRaises(ValueError):runtime.validate_gateway_drain(owner,{**state,'updated_at':stamp},pending=0,cron=0,now=1000)
    def test_legacy_voice_health_must_match_the_same_evaluated_hold_authority(self):
        intake={'config_sha256':'a'*64,'epoch':'SYNTHETIC-EPOCH'};phase='b'*64
        endpoint={'role':'durable_voice_intake','status':'ok','counts':{'queued':3},'forwarder':{
            'config_sha256':'a'*64,'epoch':'SYNTHETIC-EPOCH','phase_sha256':phase,
            'authority':None,'thread_alive':True,'failed':False,'evaluation_age_seconds':.1}}
        runtime.validate_hold_endpoint(endpoint,intake,phase)
        for change in ({'config_sha256':'c'*64},{'epoch':'OLD'},{'authority':'windows'},
                       {'phase_sha256':'d'*64},{'thread_alive':False},{'failed':True},{'evaluation_age_seconds':10}):
            wrong={**endpoint,'forwarder':{**endpoint['forwarder'],**change}}
            with self.assertRaises(ValueError):runtime.validate_hold_endpoint(wrong,intake,phase)


if __name__=='__main__':unittest.main()
