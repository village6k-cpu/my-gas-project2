"""Synthetic authority transactions; never bootstrap an actual service."""
import base64
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]/'scripts/macos'))
import migration_native_cutover as m


class Adapter:
    def __init__(self):self.events=[];self.absent=True;self.fail=None;self.browser=True
    def preactivation(self,*,require_browser=True):
        self.events.append('preactivation')
        if not self.absent:raise ValueError('synthetic_owner_present')
        if require_browser and not self.browser:raise ValueError('synthetic_browser_missing')
    @contextmanager
    def hold_all_service_locks(self):
        self.events.append('service-locks')
        if not self.absent:raise ValueError('synthetic_lock_owned')
        yield
    def final_source_closed(self):self.events.append('source-closed')
    def handoff_chrome(self):self.events.append('chrome-handoff')
    def bootstrap(self, name):
        self.events.append('bootstrap:'+name);self.absent=False
        if self.fail==name:raise RuntimeError('uncertain_synthetic_bootstrap')
    def core_ready(self):self.events.append('core-ready')
    def all_ready(self):self.events.append('all-ready');return {'verified':True}


class CutoverTests(unittest.TestCase):
    def test_service_set_matches_verified_current_runtime_manifest_names(self):
        self.assertEqual(set(m.SERVICES),{'root','worker','bridge','voice','relay','chrome','watcher',
          'inventory-brief','ledger-sheet-sync','preflight','return-issues','setmaster-reconcile',
          'tax-tracks-sync','weekly-brain-card','corrections-nightly','inventory-stock-relay'})

    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve();self.state=self.root/'state/voice-ingress-v1'
        self.state.mkdir(parents=True);self.d=self.root/'state/cutover-actual-v1'
        self.d.mkdir();(self.root/'MIGRATION-INACTIVE').write_bytes(b'SYNTHETIC-INACTIVE')
        self.source={'root':{'pid':1,'started':1.1},'voice':{'pid':2,'started':2.2}}
        cfg={'epoch':'SYNTHETIC','source':self.source};m.write_new(self.state/'config.json',cfg)
        m.write_new(self.state/'phase.json',dict(cfg,schema='village-voice-phase/v1',mode='hold',controller_config_sha256='f'*64))
        manifest=self.root/'control/runtime.json';manifest.parent.mkdir()
        m.write_new(manifest,{'schema':'village-macos-runtime/v1','services':{name:{} for name in m.SERVICES}})
        self.plan={'schema':'village-native-cutover-plan/v1','candidate':str(self.root),'epoch':'SYNTHETIC',
          'source':self.source,'intent_sha256':'a'*64,'stop_sha256':'b'*64,
          'inactive_sha256':m.digest(self.root/'MIGRATION-INACTIVE'),
          'intake_config':m.reference(self.state/'config.json'),'manifest':m.reference(manifest),
          'previous_phase':m.reference(self.state/'phase.json'),'gates':{}}
        for name in m.GATES:
            p=self.d/(name+'.json');m.write_new(p,{'schema':'village-native-cutover-gate/v1','gate':name,
             'passed':True,'intent_sha256':'a'*64,'stop_sha256':'b'*64,'evidence':[]})
            self.plan['gates'][name]=m.reference(p)
        m.write_new(self.d/'PLAN.json',self.plan)
        self.a=Adapter();self.c=m.Cutover(self.root,self.d/'PLAN.json',m.digest(self.d/'PLAN.json'),self.a)

    def test_missing_or_changed_gate_cannot_publish_authority(self):
        (self.d/(m.GATES[0]+'.json')).write_text('{}')
        with self.assertRaises(ValueError):self.c.prepare()
        self.assertFalse((self.root/'ACTIVATION.json').exists())
        self.assertTrue((self.root/'MIGRATION-INACTIVE').exists())

    def test_permission_is_recoverable_before_any_bootstrap(self):
        self.c.prepare()
        self.assertFalse((self.root/'MIGRATION-INACTIVE').exists())
        self.assertTrue((self.root/'SOURCE-CLOSED.json').exists())
        result=self.c.revoke()
        self.assertTrue(result['revoked']);self.assertFalse((self.root/'ACTIVATION.json').exists())
        self.assertFalse((self.root/'SOURCE-CLOSED.json').exists())
        self.assertEqual((self.root/'MIGRATION-INACTIVE').read_bytes(),b'SYNTHETIC-INACTIVE')
        self.assertEqual(self.c.revoke(),result)

    def test_partial_publication_recovery_preserves_unrelated_artifact(self):
        self.c.prepare();(self.root/'ACTIVATION.json').write_bytes(b'UNOWNED')
        with self.assertRaises(ValueError):self.c.revoke()
        self.assertEqual((self.root/'ACTIVATION.json').read_bytes(),b'UNOWNED')
        self.assertFalse((self.root/'MIGRATION-INACTIVE').exists())

    def test_partial_permission_before_activation_can_be_revoked(self):
        self.c.prepare();raw=(self.root/'ACTIVATION.json').read_bytes()
        (self.root/'ACTIVATION.json').unlink();(self.root/'MIGRATION-INACTIVE').write_bytes(b'SYNTHETIC-INACTIVE')
        self.assertTrue(self.c.revoke()['revoked'])
        self.assertTrue((self.root/'MIGRATION-INACTIVE').exists())

    def test_interrupted_authority_publication_never_exposes_partial_final_file(self):
        real=m.os.link
        def interrupted(source,target):
            if Path(target).name=='ACTIVATION.json':raise OSError('synthetic_publication_interruption')
            return real(source,target)
        with patch.object(m.os,'link',side_effect=interrupted):
            with self.assertRaises(OSError):self.c.prepare()
        self.assertFalse((self.root/'ACTIVATION.json').exists())
        self.assertTrue((self.root/'SOURCE-CLOSED.json').exists())
        self.assertTrue(list(self.root.glob('.ACTIVATION.json.publishing-*')))
        self.assertTrue(self.c.revoke()['revoked'])

    def test_any_bootstrap_request_permanently_blocks_blind_source_rollback(self):
        self.c.prepare();self.a.fail='root'
        with self.assertRaises(RuntimeError):self.c.start()
        self.assertTrue((self.d/'BOOTSTRAP-REQUESTED.json').exists())
        with self.assertRaises(ValueError):self.c.revoke()
        with self.assertRaises(ValueError):self.c.start()
        self.assertEqual(self.a.events.count('bootstrap:root'),1)

    def test_live_owner_blocks_revocation_even_without_bootstrap_journal(self):
        self.c.prepare();self.a.absent=False
        with self.assertRaises(ValueError):self.c.revoke()
        self.assertTrue((self.root/'ACTIVATION.json').exists())

    def test_missing_validation_browser_is_checked_before_irreversible_request(self):
        self.c.prepare();self.a.browser=False
        with self.assertRaises(ValueError):self.c.start()
        self.assertFalse((self.d/'BOOTSTRAP-REQUESTED.json').exists())
        self.assertTrue(self.c.revoke()['revoked'])

    def test_mac_voice_phase_follows_core_readiness_and_all_labels_once(self):
        self.c.prepare();result=self.c.start()
        self.assertTrue(result['started'])
        phase=json.loads((self.state/'phase.json').read_text());self.assertEqual(phase['mode'],'mac')
        self.assertEqual(phase['source_closed_sha256'],m.digest(self.root/'SOURCE-CLOSED.json'))
        loaded=[x.split(':',1)[1] for x in self.a.events if x.startswith('bootstrap:')]
        self.assertEqual(loaded,list(m.CORE)+list(m.AFTER_CORE))
        self.assertEqual(set(loaded),set(m.SERVICES))
        self.assertLess(self.a.events.index('core-ready'),self.a.events.index('bootstrap:watcher'))

    def test_failed_core_readiness_never_authorizes_voice_dispatch(self):
        self.c.prepare()
        def fail():raise RuntimeError('synthetic_core_unhealthy')
        self.a.core_ready=fail
        with self.assertRaises(RuntimeError):self.c.start()
        self.assertEqual(json.loads((self.state/'phase.json').read_text())['mode'],'hold')

    def test_wrong_intent_gate_and_phase_drift_are_rejected(self):
        p=self.d/(m.GATES[0]+'.json');doc=json.loads(p.read_text());doc['intent_sha256']='c'*64
        p.write_bytes(m.encode(doc));self.plan['gates'][m.GATES[0]]=m.reference(p)
        (self.d/'PLAN.json').write_bytes(m.encode(self.plan))
        c=m.Cutover(self.root,self.d/'PLAN.json',m.digest(self.d/'PLAN.json'),self.a)
        with self.assertRaises(ValueError):c.prepare()

if __name__=='__main__':unittest.main()
