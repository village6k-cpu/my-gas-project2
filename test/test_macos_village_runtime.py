import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import os
import sys

MODULE=Path(__file__).resolve().parents[1]/'scripts/macos/village-runtime.py'
spec=importlib.util.spec_from_file_location('village_runtime',MODULE)
runtime=importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)

class RuntimeActivationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name).resolve()
        (self.root/'bin').mkdir();(self.root/'state').mkdir();(self.root/'home').mkdir()
        (self.root/'bin/python').write_text('fixture')
        self.manifest=self.root/'runtime.json'
        self.env=self.root/'root.env.json'
        self.env.write_text(json.dumps({'HERMES_HOME':str(self.root/'home'),'PATH':str(self.root/'bin')}))
        self.data={'schema':'village-macos-runtime/v1','root':str(self.root),'services':{'root':{'argv':[str(self.root/'bin/python'),'-m','hermes_cli.main','gateway','run'],'cwd':str(self.root/'home'),'env_file':str(self.env),'ports':[18642]}}}
        self.data['services']['root']['env_sha256']=runtime.sha256_file(self.env)
        self.manifest.write_text(json.dumps(self.data))
    def activate(self):
        proof={'manifest_sha256':runtime.sha256_file(self.manifest),'gates':{name:True for name in runtime.REQUIRED_GATES}}
        (self.root/'ACTIVATION.json').write_text(json.dumps(proof))
    def test_missing_activation_cannot_start_customer_services(self):
        with self.assertRaisesRegex(ValueError,'activation'):runtime.build_launch(self.manifest,'root')
    def test_staging_marker_blocks_even_with_activation_receipt(self):
        self.activate();(self.root/'MIGRATION-INACTIVE').touch()
        with self.assertRaisesRegex(ValueError,'inactive'):runtime.build_launch(self.manifest,'root')
    def test_missing_single_writer_gate_blocks_start(self):
        self.activate();p=self.root/'ACTIVATION.json';v=json.loads(p.read_text());v['gates']['windows_consumers_drained']=False;p.write_text(json.dumps(v))
        with self.assertRaisesRegex(ValueError,'windows_consumers_drained'):runtime.build_launch(self.manifest,'root')
    def test_changed_manifest_requires_fresh_activation(self):
        self.activate();self.manifest.write_text(self.manifest.read_text()+' ')
        with self.assertRaisesRegex(ValueError,'manifest'):runtime.build_launch(self.manifest,'root')
    def test_existing_mac_home_is_rejected(self):
        self.env.write_text(json.dumps({'HERMES_HOME':str(self.root.parent/'.hermes')}))
        self.data['services']['root']['env_sha256']=runtime.sha256_file(self.env);self.manifest.write_text(json.dumps(self.data));self.activate()
        with self.assertRaisesRegex(ValueError,'HERMES_HOME'):runtime.build_launch(self.manifest,'root')
    def test_known_manifest_uses_only_its_explicit_environment(self):
        self.activate();plan=runtime.build_launch(self.manifest,'root')
        self.assertEqual(plan['env'],{'HERMES_HOME':str(self.root/'home'),'PATH':str(self.root/'bin')})
        self.assertEqual(plan['ports'],[18642])
    def test_duplicate_port_between_services_is_rejected(self):
        self.data['services']['worker']={**self.data['services']['root']}
        self.manifest.write_text(json.dumps(self.data));self.activate()
        with self.assertRaisesRegex(ValueError,'duplicate port'):runtime.build_launch(self.manifest,'root')
    def test_check_mode_does_not_require_activation_but_reports_inactive(self):
        result=runtime.build_launch(self.manifest,'root',check_only=True)
        self.assertFalse(result['activation_verified'])
    def test_changed_environment_cannot_reuse_an_activation(self):
        self.activate();self.env.write_text(self.env.read_text()+' ')
        with self.assertRaisesRegex(ValueError,'environment hash'):runtime.build_launch(self.manifest,'root')
    def test_profile_file_overrides_must_match_the_reviewed_activation(self):
        profile=self.root/'home/config.yaml';profile.write_text('platforms: {}')
        self.data['services']['root']['runtime_file_sha256']={str(profile):runtime.sha256_file(profile)}
        self.manifest.write_text(json.dumps(self.data));self.activate()
        profile.write_text('platforms: {slack: {enabled: true}}')
        with self.assertRaisesRegex(ValueError,'runtime file hash'):runtime.build_launch(self.manifest,'root')
    @unittest.skipUnless(sys.platform=='darwin','POSIX service ownership is checked on the destination Mac')
    def test_two_launchers_cannot_own_the_same_service(self):
        self.activate();plan=runtime.build_launch(self.manifest,'root')
        owner=runtime.acquire_service_lock(plan)
        try:
            with self.assertRaisesRegex(RuntimeError,'already has an owner'):runtime.acquire_service_lock(plan)
        finally:os.close(owner)

if __name__=='__main__':unittest.main()
