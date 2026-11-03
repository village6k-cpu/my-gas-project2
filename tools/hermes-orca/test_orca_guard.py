import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).parent


class GuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.binary = self.root / 'vendor'
        self.counter = self.root / 'calls.jsonl'
        self.data = self.root / 'actual-app-data'
        self.data.mkdir()
        (self.data / 'orca-runtime.json').write_text('{}')
        self.binary.write_text('#!' + sys.executable + '\n' + '''import json,os,sys
from pathlib import Path
with open(os.environ['TEST_CALLS'],'a') as f:f.write(json.dumps(sys.argv[1:])+'\\n')
p=Path(os.environ.get('ORCA_USER_DATA_PATH',str(Path.home()/'wrong')))
print(json.dumps({'app':{'running':(p/'orca-runtime.json').exists()},'home':os.environ['HOME'],'args':sys.argv[1:]}))
sys.exit(4 if 'failure' in sys.argv else 0)
''')
        self.binary.chmod(0o700)
        self.policy = self.root / 'policy.json'
        self.policy.write_text(json.dumps({'real_cli': str(self.binary), 'user_data_path': str(self.data), 'log_path': str(self.root / 'guard.jsonl')}))
        self.env = dict(os.environ, HOME=str(self.root / 'isolated'), TEST_CALLS=str(self.counter))

    def run_guard(self, *args):
        return subprocess.run([sys.executable, str(HERE / 'orca_guard.py'), '--policy-file', str(self.policy), *args], env=self.env, capture_output=True, text=True)

    def test_correct_runtime_without_changing_isolated_home(self):
        before = subprocess.run([str(self.binary), 'status'], env=self.env, capture_output=True, text=True)
        self.assertFalse(json.loads(before.stdout)['app']['running'])
        after = self.run_guard('status', '--json')
        self.assertEqual(after.returncode, 0)
        self.assertTrue(json.loads(after.stdout)['app']['running'])
        self.assertEqual(json.loads(after.stdout)['home'], self.env['HOME'])

    def test_open_and_serve_never_reach_vendor(self):
        for args in [('open', '--json'), ('--json', 'open'), ('--environment', 'local', 'open'), ('serve',)]:
            with self.subTest(args=args):
                r = self.run_guard(*args)
                self.assertNotEqual(r.returncode, 0)
                self.assertEqual(json.loads(r.stdout)['error']['code'], 'orca_automatic_start_blocked')
        self.assertFalse(self.counter.exists())

    def test_closed_app_stays_closed(self):
        (self.data / 'orca-runtime.json').unlink()
        r = self.run_guard('status', '--json')
        self.assertFalse(json.loads(r.stdout)['app']['running'])
        self.run_guard('open', '--json')
        self.assertEqual(self.counter.read_text().count('\n'), 1)

    def test_existing_commands_and_exit_code_pass_through(self):
        r = self.run_guard('terminal', 'send', '--text', 'open')
        self.assertEqual(json.loads(r.stdout)['args'], ['terminal', 'send', '--text', 'open'])
        self.assertEqual(self.run_guard('status', 'failure').returncode, 4)

    def test_receipt_contains_no_prompt_or_environment(self):
        self.run_guard('open', '--pairing-code', 'SENSITIVE_TEST_VALUE')
        receipt = (self.root / 'guard.jsonl').read_text()
        self.assertNotIn('SENSITIVE_TEST_VALUE', receipt)
        self.assertNotIn(self.env['HOME'], receipt)


class InstallTests(unittest.TestCase):
    def setUp(self):
        spec = importlib.util.spec_from_file_location('install_guard', HERE / 'install.py')
        self.mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.mod)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'candidate'
        (self.root / 'control').mkdir(parents=True)
        (self.root / 'bin').mkdir()
        (self.root / 'os-home').mkdir()
        (self.root / 'control/root.env.json').write_text(json.dumps({'HOME': str(self.root / 'os-home'), 'PATH': str(self.root / 'bin') + ':/usr/bin:/bin'}))
        self.vendor = Path(self.temp.name) / 'vendor'
        self.vendor.write_text('#!/bin/sh\nprintf "%s\\n" "$ORCA_USER_DATA_PATH"\n')
        self.vendor.chmod(0o700)
        self.data = Path(self.temp.name) / 'app-data'
        self.data.mkdir()

    def test_dry_run_writes_nothing(self):
        self.mod.install(self.root, self.vendor, self.data, execute=False)
        self.assertFalse((self.root / 'bin/orca').exists())
        self.assertFalse((self.root / 'os-home/.bash_profile').exists())

    def test_idempotent_and_preserves_profile_content(self):
        profile = self.root / 'os-home/.bash_profile'
        profile.write_text('export EXISTING_VALUE=keep\n')
        a = self.mod.install(self.root, self.vendor, self.data, execute=True)
        content = profile.read_text()
        b = self.mod.install(self.root, self.vendor, self.data, execute=True)
        self.assertEqual(content, profile.read_text())
        self.assertIn('export EXISTING_VALUE=keep', content)
        self.assertGreater(a['changed'], 0)
        self.assertEqual(b['changed'], 0)

    def test_login_shell_finds_guard_before_system_cli(self):
        self.mod.install(self.root, self.vendor, self.data, execute=True)
        r = subprocess.run(['/bin/bash', '-lc', 'orca open --json'], env=dict(os.environ, HOME=str(self.root / 'os-home')), capture_output=True, text=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(json.loads(r.stdout)['error']['code'], 'orca_automatic_start_blocked')

    def test_other_command_paths_do_not_change(self):
        env = dict(os.environ, HOME=str(self.root / 'os-home'))
        args = ['/bin/bash', '-lc', 'printf "%s" "$PATH"']
        before = subprocess.check_output(args, env=env)
        self.mod.install(self.root, self.vendor, self.data, execute=True)
        self.assertEqual(subprocess.check_output(args, env=env), before)

    def test_rejects_profile_symlink_outside_installation(self):
        outside = Path(self.temp.name) / 'outside'
        outside.write_text('keep')
        (self.root / 'os-home/.bash_profile').symlink_to(outside)
        with self.assertRaises(ValueError):
            self.mod.install(self.root, self.vendor, self.data, execute=True)
        self.assertEqual(outside.read_text(), 'keep')

    def test_rejects_unexpected_existing_launcher_before_any_write(self):
        (self.root / 'bin/orca').write_text('unrelated')
        with self.assertRaises(ValueError):
            self.mod.install(self.root, self.vendor, self.data, execute=True)
        self.assertFalse((self.root / 'bin/orca-policy.json').exists())


if __name__ == '__main__':
    unittest.main()
