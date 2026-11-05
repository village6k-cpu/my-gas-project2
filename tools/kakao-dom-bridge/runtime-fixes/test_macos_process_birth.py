import ast, importlib.util, os, pathlib, sys, types, unittest
from unittest.mock import Mock, patch
BASE=pathlib.Path(os.environ.get('VILLAGE_RUNTIME_ROOT', '/nonexistent-village-runtime'))
def load_start(path):
 tree=ast.parse(path.read_text());fn=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='_get_process_start_time')
 ns={'Path':pathlib.Path,'Optional':__import__('typing').Optional,'sys':sys}
 exec(compile(ast.Module(body=[fn],type_ignores=[]),str(path),'exec'),ns)
 return ns['_get_process_start_time']
def supervisor():
 s=importlib.util.spec_from_file_location('birthsupervisor',BASE/'control/village-supervisor.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);return m
@unittest.skipUnless((BASE/'control/village-supervisor.py').exists(), 'Set VILLAGE_RUNTIME_ROOT to the installed runtime')
class BirthIdentity(unittest.TestCase):
 def fake_psutil(self,adjusted=101,raw=100):
  p=types.ModuleType('psutil');p.Process=Mock(return_value=Mock(create_time=Mock(return_value=adjusted)))
  mac=types.ModuleType('psutil._psosx');mac.Process=Mock(return_value=Mock(create_time=Mock(return_value=raw)));p._psosx=mac
  return p,mac
 def test_wall_clock_adjustment_does_not_change_gateway_birth(self):
  for code in ['hermes-root-code','hermes-worker-code']:
   f=load_start(BASE/code/'gateway/status.py');p,mac=self.fake_psutil()
   with patch.object(sys,'platform','darwin'),patch.dict(sys.modules,{'psutil':p,'psutil._psosx':mac}):
    self.assertEqual(f(987654321),10000)
    p.Process.return_value.create_time.return_value=105
    self.assertEqual(f(987654321),10000)
 def test_reused_pid_has_different_stable_birth(self):
  f=load_start(BASE/'hermes-worker-code/gateway/status.py');p,mac=self.fake_psutil(raw=200)
  with patch.object(sys,'platform','darwin'),patch.dict(sys.modules,{'psutil':p,'psutil._psosx':mac}):self.assertEqual(f(987654321),20000)
 def test_supervisor_accepts_same_process_despite_clock_adjustment(self):
  m=supervisor();p,mac=self.fake_psutil();process=p.Process.return_value
  process.pid=987654321;process.is_running.return_value=True;process.status.return_value='running';p.STATUS_ZOMBIE='zombie';p.Error=OSError
  home=pathlib.Path('/same/home');code=pathlib.Path('/same/code')
  process.cmdline.return_value=['python','-m','hermes_cli.main','gateway','run'];process.environ.return_value={'HERMES_HOME':str(home),'PYTHONPATH':str(code)}
  state={'kind':'hermes-gateway','pid':process.pid,'hermes_home':str(home),'start_time':10000}
  with patch.object(sys,'platform','darwin'),patch.dict(sys.modules,{'psutil':p,'psutil._psosx':mac}):
   self.assertTrue(m.gateway_owned(state,home,code))
   mac.Process.return_value.create_time.return_value=102
   self.assertFalse(m.gateway_owned(state,home,code))
 def test_windows_birth_behavior_unchanged(self):
  f=load_start(BASE/'hermes-worker-code/gateway/status.py');p,mac=self.fake_psutil()
  with patch.object(sys,'platform','win32'),patch.dict(sys.modules,{'psutil':p,'psutil._psosx':mac}):self.assertEqual(f(987654321),10100)
 def test_busy_or_unverified_gateway_still_blocks_recovery(self):
  m=supervisor();idle={'owner_verified':True,'gateway_state':'running','active_agents':0};h={'ok':True,'state':{'activeWorkerRuns':0},'gateway':{'queue':{'claimed':0},'application_counts':{}}}
  self.assertTrue(m.recovery_idle(idle,idle,h))
  self.assertFalse(m.recovery_idle(dict(idle,active_agents=1),idle,h))
  self.assertFalse(m.recovery_idle(idle,dict(idle,owner_verified=False),h))
if __name__=='__main__':unittest.main()
