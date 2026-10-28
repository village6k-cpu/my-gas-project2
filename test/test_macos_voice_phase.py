"""Cooperating phase writers share one lock across source/native transitions."""
from pathlib import Path
import hashlib
import importlib.util
import json
import tempfile
import threading
import unittest
from unittest.mock import patch


class PhaseTests(unittest.TestCase):
    def setUp(self):
        path=Path(__file__).resolve().parents[1]/'scripts/macos/migration_voice_phase.py'
        self.assertTrue(path.is_file(),'shared native phase transition lock is missing')
        spec=importlib.util.spec_from_file_location('voice_phase',path)
        self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);self.state=self.root/'state/voice-ingress-v1';self.state.mkdir(parents=True)
        (self.root/'MIGRATION-INACTIVE').touch()
        self.source={'root':{'pid':1,'started':1.1},'voice':{'pid':2,'started':1.2}}
        config={'epoch':'SYNTHETIC','source':self.source}
        raw=json.dumps(config).encode();(self.state/'config.json').write_bytes(raw)
        self.sha=hashlib.sha256(raw).hexdigest()
        self.phase={'schema':'village-voice-phase/v1','epoch':'SYNTHETIC','source':self.source,
                    'mode':'windows','controller_config_sha256':'a'*64,'effective_owners':self.source}
        (self.state/'phase.json').write_text(json.dumps(dict(self.phase,mode='hold')))

    def publish(self):return self.m.publish_source_phase(self.root,self.phase,self.sha,None)

    def test_source_publication_prevents_intervening_cooperating_native_transition(self):
        real=self.m.os.replace;attempted=[]
        def before_replace(src,dst):
            def native_writer():
                try:
                    with self.m.PhaseTransitionLock(self.root,timeout=.05):attempted.append('changed')
                except self.m.PhaseBusy:attempted.append('blocked')
            thread=threading.Thread(target=native_writer);thread.start();thread.join(timeout=2)
            self.assertFalse(thread.is_alive());real(src,dst)
        with patch.object(self.m.os,'replace',side_effect=before_replace):self.assertTrue(self.publish()['renewed'])
        self.assertEqual(attempted,['blocked'])
        with self.m.PhaseTransitionLock(self.root):
            (self.root/'ACTIVATION.json').write_text('{}')
            (self.state/'phase.json').write_text(json.dumps(dict(self.phase,mode='mac')))
        self.assertFalse(self.publish()['renewed'])
        self.assertEqual(json.loads((self.state/'phase.json').read_text())['mode'],'mac')

    def test_closure_or_unknown_controller_refuses_source_renewal(self):
        (self.root/'SOURCE-CLOSED.json').write_text('{}')
        self.assertFalse(self.publish()['renewed']);(self.root/'SOURCE-CLOSED.json').unlink()
        (self.state/'phase.json').write_text(json.dumps(dict(self.phase,mode='hold',controller_config_sha256='b'*64)))
        with self.assertRaises(ValueError):self.publish()

    def recovery_fixture(self):
        closure={'schema':'village-current-source-closure/v1','intent_sha256':'b'*64,
                 'stop_sha256':'c'*64,'epoch':'SYNTHETIC','source':self.source}
        raw=json.dumps(closure).encode();(self.root/'SOURCE-CLOSED.json').write_bytes(raw)
        self.auth={'schema':'village-current-voice-recovery/v1','inputs_sha256':'d'*64,
            'intent_sha256':'b'*64,'stop_sha256':'c'*64,'backends_sha256':'e'*64,
            'intake_config_sha256':self.sha,'epoch':'SYNTHETIC','origin_source':self.source,
            'previous_controller_sha256':'a'*64,'controller_config_sha256':'f'*64,
            'closure_sha256':hashlib.sha256(raw).hexdigest()}
        return raw

    def test_recovery_archives_only_bound_closure_and_holds_phase_before_reopening(self):
        raw=self.recovery_fixture();observed=[]
        def inactive():
            observed.append(True)
            return True
        result=self.m.recover_source_phase(self.root,self.auth,is_inactive=inactive)
        self.assertTrue(result['recovered']);self.assertTrue(observed)
        self.assertFalse((self.root/'SOURCE-CLOSED.json').exists())
        self.assertEqual((self.root/result['archived_closure']).read_bytes(),raw)
        self.assertEqual(json.loads((self.state/'phase.json').read_text())['mode'],'hold')
        self.assertEqual(self.m.recover_source_phase(self.root,self.auth,is_inactive=inactive),result)
        self.phase['controller_config_sha256']='f'*64
        self.assertTrue(self.m.publish_source_phase(self.root,self.phase,self.sha,'a'*64)['renewed'])

    def test_activation_unknown_closure_or_native_owner_blocks_recovery_without_mutation(self):
        self.recovery_fixture();before=(self.state/'phase.json').read_bytes()
        for blocked in ('activated','wrong-closure','loaded-owner'):
            if blocked=='activated':(self.root/'ACTIVATION.json').write_text('{}')
            if blocked=='wrong-closure':self.auth['closure_sha256']='0'*64
            with self.subTest(blocked=blocked),self.assertRaises(ValueError):
                self.m.recover_source_phase(self.root,self.auth,is_inactive=lambda:blocked!='loaded-owner')
            self.assertTrue((self.root/'SOURCE-CLOSED.json').is_file())
            self.assertEqual((self.state/'phase.json').read_bytes(),before)
            if blocked=='activated':(self.root/'ACTIVATION.json').unlink()
            if blocked=='wrong-closure':self.recovery_fixture()


if __name__=='__main__':unittest.main()
