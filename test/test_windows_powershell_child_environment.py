from pathlib import Path
import sys,unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/windows'))
import migration_source_recovery_executor as m

class NativePowerShellEnvironmentTests(unittest.TestCase):
    def test_uses_native_modules_instead_of_inherited_core_modules(self):
        env={'SystemRoot':'C:\\Windows','PSModulePath':'C:\\Program Files\\PowerShell\\7\\Modules','HERMES_HOME':'isolated-helper','CUSTOM':'preserved'}
        child=m.native_powershell_environment(env)
        self.assertEqual(child['PSModulePath'],'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules')
        self.assertEqual(child['HERMES_HOME'],'isolated-helper');self.assertEqual(child['CUSTOM'],'preserved')
        self.assertEqual(env['PSModulePath'],'C:\\Program Files\\PowerShell\\7\\Modules')
    def test_accepts_uppercase_windows_environment_keys(self):
        env=m.native_powershell_environment({'SYSTEMROOT':'D:\\Windows','PSMODULEPATH':'incompatible'})
        self.assertEqual(env['PSModulePath'],'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules')
        self.assertNotIn('PSMODULEPATH',env)
    def test_non_windows_fixture_without_systemroot_is_not_rewritten(self):
        env={'PATH':'/usr/bin'};self.assertEqual(m.native_powershell_environment(env),env)

if __name__=='__main__':unittest.main()
