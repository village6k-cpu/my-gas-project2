import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock

PATH = Path(__file__).resolve().parents[1] / 'scripts/windows/legacy_watch_proxy.py'
SPEC = importlib.util.spec_from_file_location('legacy_watch_proxy', PATH)
proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proxy)

class LegacyWatchProxyTest(unittest.TestCase):
    def setUp(self):
        self.owner = {'pid': 72, 'started': 1234.5,
                      'exe': 'C:/Windows/System32/OpenSSH/ssh.exe', 'argv': ['ssh', '-N', '-L', 'loopback']}

    def test_reused_pid_is_not_owned(self):
        current = dict(self.owner, started=1235.5)
        self.assertFalse(proxy.same_owner(self.owner, current))

    def test_different_ssh_command_is_not_owned(self):
        self.assertFalse(proxy.same_owner(self.owner, dict(self.owner, argv=['ssh', 'other-host'])))

    def test_exact_owner_is_adopted_without_restart(self):
        self.assertTrue(proxy.same_owner(self.owner, dict(self.owner)))
        self.assertEqual(proxy.next_action([(72, '127.0.0.1')], 72), 'observe')

    def test_unknown_listener_never_triggers_start_or_kill(self):
        self.assertEqual(proxy.next_action([(73, '127.0.0.1')], 72), 'blocked_unknown_listener')
        self.assertEqual(proxy.next_action([(None, '127.0.0.1')], None), 'blocked_unknown_listener')

    def test_non_loopback_or_shared_port_is_blocked(self):
        self.assertEqual(proxy.next_action([(72, '0.0.0.0')], 72), 'blocked_unknown_listener')
        self.assertEqual(proxy.next_action([(72, '127.0.0.1'), (73, '127.0.0.1')], 72), 'blocked_unknown_listener')

    def test_live_owner_without_listener_is_never_duplicated(self):
        self.assertEqual(proxy.next_action([], 72), 'wait_for_owned_tunnel')
        self.assertEqual(proxy.next_action([], None), 'start_forwarder')

    def test_unreadable_known_process_blocks_even_when_port_is_free(self):
        import psutil
        fake = Mock(wraps=psutil)
        fake.NoSuchProcess = psutil.NoSuchProcess
        fake.Error = psutil.Error
        fake.Process.side_effect = psutil.AccessDenied(72)
        with self.assertRaises(proxy.OwnerUnknown):
            proxy.snapshot(fake, 72)
        self.assertEqual(proxy.next_action([], None, ownership_uncertain=True), 'blocked_unknown_owner')

    def test_only_proven_missing_process_is_absent(self):
        import psutil
        fake = Mock(wraps=psutil)
        fake.NoSuchProcess = psutil.NoSuchProcess
        fake.Error = psutil.Error
        fake.Process.side_effect = psutil.NoSuchProcess(72)
        self.assertIsNone(proxy.snapshot(fake, 72))

    def test_healthy_http_without_mac_authority_is_not_ready(self):
        health = {'role': 'durable_voice_intake', 'forwarder': {
            'authority': None, 'thread_alive': True, 'failed': False, 'evaluation_age_seconds': .2}}
        self.assertFalse(proxy.mac_ready(health))
        health['forwarder']['authority'] = 'mac'
        self.assertTrue(proxy.mac_ready(health))
        health['forwarder']['evaluation_age_seconds'] = 10
        self.assertFalse(proxy.mac_ready(health))

if __name__ == '__main__':
    unittest.main()
