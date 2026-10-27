import importlib.util
from pathlib import Path
import unittest

MODULE=Path(__file__).resolve().parents[1]/'scripts/macos/village-cua-driver.py'

class NativeCuaSocketTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.module=None
        if MODULE.exists():
            spec=importlib.util.spec_from_file_location('cua_wrapper',MODULE)
            cls.module=importlib.util.module_from_spec(spec);spec.loader.exec_module(cls.module)
    def test_default_native_connection_uses_only_migration_socket(self):
        self.assertIsNotNone(self.module,'native socket adapter is required for the isolated HOME')
        self.assertEqual(self.module.driver_args(['mcp'],'/tmp/village-migrated-cua.sock'),['mcp','--socket','/tmp/village-migrated-cua.sock'])
        self.assertEqual(self.module.driver_args(['call','check_permissions','{}'],'/tmp/village-migrated-cua.sock'),['call','check_permissions','{}','--socket','/tmp/village-migrated-cua.sock'])
    def test_explicit_session_socket_and_readonly_version_are_preserved(self):
        self.assertIsNotNone(self.module)
        args=['mcp','--embedded','--socket','/tmp/hc-session.sock']
        self.assertEqual(self.module.driver_args(args,'/tmp/village-migrated-cua.sock'),args)
        self.assertEqual(self.module.driver_args(['--version'],'/tmp/village-migrated-cua.sock'),['--version'])
    def test_manifest_discovery_retains_socket_for_direct_binary_invocation(self):
        self.assertIsNotNone(self.module)
        got=self.module.scoped_manifest({'mcp_invocation':{'command':'/private/CuaDriver','args':['mcp']}},'/tmp/village-migrated-cua.sock')
        self.assertEqual(got['mcp_invocation'],{'command':'/private/CuaDriver','args':['mcp','--socket','/tmp/village-migrated-cua.sock']})
        got=self.module.scoped_manifest(got,'/tmp/village-migrated-cua.sock','/private/wrapper')
        self.assertEqual(got['mcp_invocation']['command'],'/private/wrapper')
    def test_screen_wake_assertion_lasts_only_for_computer_control_connection(self):
        self.assertTrue(callable(getattr(self.module,'invocation',None)))
        self.assertEqual(self.module.invocation('/private/CuaDriver',['mcp']),
                         ['/usr/bin/caffeinate','-d','-u','/private/CuaDriver','mcp'])
        self.assertEqual(self.module.invocation('/private/CuaDriver',['--version']),
                         ['/private/CuaDriver','--version'])

if __name__=='__main__':unittest.main()
