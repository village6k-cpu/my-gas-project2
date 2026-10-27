import importlib.util
import copy
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

P = Path(__file__).resolve().parents[1] / 'scripts/windows/migration_closed_capture.py'
spec = importlib.util.spec_from_file_location('current_closed_capture', P)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class Gate:
    def __init__(self, fail_at=None): self.calls = 0; self.fail_at = fail_at
    def __call__(self):
        self.calls += 1
        if self.calls == self.fail_at: raise RuntimeError('source resumed')
        return {'intent_sha256': 'a'*64, 'stop_sha256': 'b'*64,
                'all_five_owners_absent': True, 'scheduled_writers_absent': True}


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.roots = []
        for name in m.NAMES:
            p = self.base / name; p.mkdir(); (p/'payload').write_bytes(b'original')
            self.roots.append({'name': name, 'source': str(p), 'excluded': []})
        self.dest = self.base / 'closed'
        self.copies = []

    def copy(self, source, target, *, excluded):
        self.copies.append(source); target.mkdir()
        return {'copy_verified': True, 'files': [{'path': 'payload', 'bytes': 8,
                'sha256': 'c'*64}], 'directories': ['.'], 'bytes': 8}

    def run_capture(self, gate=None, copy=None, roots=None):
        return m.capture(roots or self.roots, self.dest, gate or Gate(),
                         copy or self.copy, required_bytes=48, free_bytes=2*1024**3)

    def test_no_copy_until_closed_gate_passes(self):
        with self.assertRaises(RuntimeError): self.run_capture(Gate(1))
        self.assertEqual(self.copies, []); self.assertFalse(self.dest.exists())

    def test_each_root_rechecks_closure_and_final_verified_requires_all(self):
        gate = Gate(); result = self.run_capture(gate)
        self.assertTrue(result['copy_complete']); self.assertEqual(len(self.copies), 6)
        self.assertEqual(gate.calls, 7)
        self.assertTrue((self.dest/'VERIFIED.json').is_file())

    def test_resumed_source_leaves_partial_without_verified(self):
        with self.assertRaises(RuntimeError): self.run_capture(Gate(3))
        self.assertEqual(len(self.copies), 2)
        self.assertFalse((self.dest/'VERIFIED.json').exists())
        self.assertTrue((self.dest/'PARTIAL.json').is_file())

    def test_changed_stop_binding_never_gets_verified(self):
        gate = Gate()
        def changed():
            row = gate()
            if gate.calls > 1: row['stop_sha256'] = 'd'*64
            return row
        with self.assertRaises(ValueError): self.run_capture(changed)
        self.assertFalse((self.dest/'VERIFIED.json').exists())

    def test_five_role_false_blocks_even_if_gate_returns(self):
        def incomplete(): return {'all_five_owners_absent': False}
        with self.assertRaises(ValueError): self.run_capture(incomplete)
        self.assertEqual(self.copies, [])

    def test_missing_duplicate_or_overlapping_roots_block(self):
        cases = [self.roots[:-1], self.roots[:-1]+[self.roots[0]],
                 [dict(r, source=self.roots[0]['source']) if i==1 else r
                  for i,r in enumerate(self.roots)]]
        for roots in cases:
            with self.subTest(roots=roots):
                with self.assertRaises(ValueError): self.run_capture(roots=roots)
        self.assertEqual(self.copies, [])

    def test_insufficient_space_and_existing_destination_do_not_copy(self):
        with self.assertRaises(ValueError):
            m.capture(self.roots,self.dest,Gate(),self.copy,required_bytes=48,free_bytes=48)
        self.dest.mkdir()
        with self.assertRaises(FileExistsError): self.run_capture()
        self.assertEqual(self.copies, [])

    def test_copy_without_exact_file_manifest_is_rejected(self):
        with self.assertRaises(ValueError):
            self.run_capture(copy=lambda *a, **k: {'copy_verified': True})
        self.assertFalse((self.dest/'VERIFIED.json').exists())

    def test_final_marker_fsync_failure_never_publishes_verified(self):
        original=m.os.fsync
        calls=0
        def injected(fd):
            nonlocal calls
            calls+=1
            if calls==7: raise OSError('final marker disk flush failed')
            return original(fd)
        with patch.object(m.os,'fsync',side_effect=injected):
            with self.assertRaises(OSError): self.run_capture()
        self.assertFalse((self.dest/'VERIFIED.json').exists())
        self.assertTrue((self.dest/'PARTIAL.json').is_file())

    def test_final_marker_write_and_flush_failures_do_not_publish(self):
        original=m.Path.open
        for stage in ('write','flush'):
            self.dest=self.base/('fault-'+stage)
            class Fault:
                def __init__(self,f): self.f=f
                def __enter__(self): self.f.__enter__(); return self
                def __exit__(self,*args): return self.f.__exit__(*args)
                def write(self,value):
                    result=self.f.write(value)
                    if stage=='write': raise OSError('marker write failed')
                    return result
                def flush(self):
                    self.f.flush()
                    if stage=='flush': raise OSError('marker flush failed')
                def fileno(self): return self.f.fileno()
            def opened(path,*args,**kw):
                f=original(path,*args,**kw)
                return Fault(f) if path.name=='VERIFIED.json.pending' else f
            with patch.object(m.Path,'open',opened):
                with self.assertRaises(OSError): self.run_capture()
            self.assertFalse((self.dest/'VERIFIED.json').exists())
            self.assertTrue((self.dest/'PARTIAL.json').is_file())

    def test_queue_gbrain_wal_learning_or_receipt_exclusions_block(self):
        for name,excluded in (('gbrain-db','pg_wal'),('bridge-queue','hermes-gateway'),
                              ('root-profile','memory'),('worker-profile','state.db-wal'),
                              ('root-profile','watch-voice-relay/relay-state.json'),
                              ('inventory-stock-alerts','state.json')):
            with self.subTest(name=name,excluded=excluded):
                self.dest=self.base/('closed-'+name+'-'+str(len(excluded)))
                roots=copy.deepcopy(self.roots)
                next(x for x in roots if x['name']==name)['excluded']=[excluded]
                with self.assertRaises(ValueError): self.run_capture(roots=roots)
                self.assertFalse(self.dest.exists())


class AcceptedWorkTests(unittest.TestCase):
    def setUp(self):
        self.intent = {'profiles':[{'role':r,'pid':i+10,'started':1000.1+i}
                       for i,r in enumerate(('root','worker','bridge','relay','voice'))]}
        rows = {r['role']:dict(pid=r['pid'],started=r['started']) for r in self.intent['profiles']}
        for role in ('root','worker'):
            rows[role].update(gateway_state='draining',active_agents=0,pending_messages=0,running_cron=0)
        rows['bridge'].update(drained=True,http_closed=True,preexisting_work_verified=True,
                              pending_handlers=0,pending_tracked_work=0)
        rows['relay']['owned_producer_paused']=True
        rows['voice'].update(threads=1,non_listening_tcp_connections=0,ingress_mode='hold',
                            ingress_dispatching=0,ingress_epoch='epoch',
                            receipt_status_counts={'webhook_accepted':2})
        self.proof={'schema':'village-current-accepted-work-closure/v1',
                    'intent_sha256':'a'*64,'owners':rows,
                    'slack_quiet':{'settled_seconds':301,'new_input_observed':False},
                    'preserved_obligations':{'replay_authorized':False,'manifest_sha256':'c'*64}}
        self.stop={'intent_sha256':'a'*64,'accepted_work_sha256':'b'*64}

    def check(self): m.validate_work_closure(self.proof,self.stop,self.intent,'b'*64)

    def test_terminal_uncertain_obligations_can_be_preserved_but_never_replayed(self):
        self.check()
        self.proof['preserved_obligations']['replay_authorized']=True
        with self.assertRaises(ValueError): self.check()

    def test_real_five_owner_and_stop_binding_required(self):
        original=copy.deepcopy(self.proof)
        for mutate in (lambda: self.proof['owners'].pop('relay'),
                       lambda: self.proof['owners']['root'].update(pid=9000),
                       lambda: self.proof.update(intent_sha256='d'*64),
                       lambda: self.stop.update(accepted_work_sha256='e'*64)):
            self.proof=copy.deepcopy(original);self.stop['accepted_work_sha256']='b'*64
            mutate()
            with self.assertRaises(ValueError): self.check()

    def test_unknown_or_active_work_does_not_pass(self):
        original=copy.deepcopy(self.proof)
        for role,key,value in (('root','active_agents',1),('worker','pending_messages',1),
             ('root','running_cron',1),('root','active_agents',False),
             ('bridge','preexisting_work_verified',False),('bridge','http_closed',False),
             ('bridge','pending_handlers',1),('voice','ingress_mode','windows'),
             ('voice','ingress_dispatching',1),('relay','owned_producer_paused',False)):
            with self.subTest(role=role,key=key):
                self.proof=copy.deepcopy(original);self.proof['owners'][role][key]=value
                with self.assertRaises(ValueError): self.check()

    def test_short_quiet_window_and_unknown_receipts_block(self):
        self.proof['slack_quiet']['settled_seconds']=299
        with self.assertRaises(ValueError): self.check()
        self.proof['slack_quiet']['settled_seconds']=301
        self.proof['owners']['voice']['receipt_status_counts']['parent_posted']=1
        with self.assertRaises(ValueError): self.check()

    def test_nan_owner_birth_does_not_bypass_identity(self):
        self.proof['owners']['bridge']['started']=float('nan')
        with self.assertRaises(ValueError): self.check()


if __name__ == '__main__': unittest.main()
