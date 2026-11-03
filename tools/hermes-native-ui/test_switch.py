import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import yaml

spec = importlib.util.spec_from_file_location('switch', Path(__file__).with_name('switch.py'))
switch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(switch)


class ToolSwitchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.binary = self.root / 'tools/cua-driver'
        self.write(self.binary, 'driver')
        self.cfg = {'agent': {'disabled_toolsets': ['computer_use', 'video']},
                    'platform_toolsets': {'slack': ['messaging'], 'kakao_village': ['skills', 'village']},
                    'browser': {'inactivity_timeout': 123}, 'approvals': {'mode': False},
                    'model': {'default': 'keep-model'}, 'finance': {'price': 10000}}
        self.env = {'HOME': 'isolated-home', 'AUTH_SENTINEL': 'private-test-value', 'HERMES_CUA_DRIVER_CMD': 'bad command'}
        manifest = {'services': {}}
        for name, home, code in [('root', 'hermes-root', 'hermes-root-code'), ('worker', 'hermes-root/profiles/kakaoworker', 'hermes-worker-code')]:
            cfgpath = self.root / home / 'config.yaml'
            envpath = self.root / 'control' / (name + '.env.json')
            self.write(cfgpath, yaml.safe_dump(self.cfg))
            self.write(envpath, json.dumps(self.env))
            self.write(self.root / home / 'gateway_state.json', '{"active_agents":0}')
            self.write(self.root / code / 'tools/browser_tool.py',
                       '    # Auto-start recording if configured and this is first navigation\n'
                       '        else:\n            try:\n                _run_browser_command(task_id, "close", [], timeout=10)')
            manifest['services'][name] = {'env_file': str(envpath), 'env_sha256': switch.sha(envpath.read_bytes()),
                                         'runtime_file_sha256': {str(cfgpath): switch.sha(cfgpath.read_bytes())}}
        for home in ['hermes-root', 'hermes-root/profiles/kakaoworker']:
            self.write(self.root / home / 'skills/computer-use/SKILL.md', 'Hermes drives cua-driver')
        self.write(self.root / 'hermes-root/skills/orca-cli/SKILL.md', 'old skill')
        self.write(self.root / 'control/runtime.json', json.dumps(manifest))
        self.write(self.root / 'ACTIVATION.json', json.dumps({'manifest_sha256': switch.sha((self.root/'control/runtime.json').read_bytes()), 'gates': {'existing_verified': True}}))

    def write(self, path, text):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    def test_dry_run_has_no_writes(self):
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        result = switch.apply(self.root, self.binary)
        after = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        self.assertTrue(result['dryRun'])

    def test_preserves_model_finance_credentials_gates_and_is_idempotent(self):
        result = switch.apply(self.root, self.binary, True)
        cfg = yaml.safe_load((self.root/'hermes-root/config.yaml').read_text())
        for key in ['model', 'finance', 'approvals']:
            self.assertEqual(cfg[key], self.cfg[key])
        self.assertEqual(cfg['agent']['disabled_toolsets'], ['video'])
        self.assertEqual(cfg['browser']['inactivity_timeout'], 123)
        self.assertIn('village', cfg['platform_toolsets']['kakao_village'])
        env = json.loads((self.root/'control/root.env.json').read_text())
        self.assertEqual(env['AUTH_SENTINEL'], self.env['AUTH_SENTINEL'])
        self.assertEqual(env['HOME'], self.env['HOME'])
        self.assertEqual(json.loads((self.root/'ACTIVATION.json').read_text())['gates'], {'existing_verified': True})
        self.assertTrue((Path(result['backup'])/'orca-cli/SKILL.md').exists())
        self.assertEqual(switch.apply(self.root, self.binary)['changed'], 0)

    def test_active_customer_work_prevents_any_apply(self):
        self.write(self.root/'hermes-root/gateway_state.json', '{"active_agents":1}')
        before = (self.root/'control/root.env.json').read_bytes()
        with self.assertRaisesRegex(AssertionError, 'active Hermes'):
            switch.apply(self.root, self.binary, True)
        self.assertEqual((self.root/'control/root.env.json').read_bytes(), before)

    def test_manifest_drift_refuses_apply(self):
        self.write(self.root/'control/root.env.json', '{}')
        with self.assertRaisesRegex(AssertionError, 'environment drift'):
            switch.apply(self.root, self.binary, True)


if __name__ == '__main__':
    unittest.main()
