import contextvars, importlib.util, os, pathlib, sys, types, unittest
root=pathlib.Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('village_plugin_candidate',root/'integrations/hermes-village-master/__init__.py')
plugin=importlib.util.module_from_spec(spec);spec.loader.exec_module(plugin)
child=False
sys.modules['agent.delegation_context']=types.SimpleNamespace(is_delegated_child_process_context=lambda:child)
config={'ownerId':'UOWNER','teamId':'TTEAM'}
class ContextTests(unittest.TestCase):
 def invoke(self, values):
  def run():
   for name,value in values.items():contextvars.ContextVar('HERMES_SESSION_'+name).set(value)
   return plugin.current_source(config)
  return contextvars.Context().run(run)
 def base(self):return dict(PLATFORM='slack',USER_ID='UOWNER',CHAT_ID='C123',MESSAGE_ID='1790000000.123456',THREAD_ID='1790000000.000001',KEY='agent:main:slack:group:TTEAM:C123:1790000000.000001')
 def test_current_source_selection(self):self.assertEqual(self.invoke(self.base())['channel'],'C123')
 def test_unbound_env_not_authority(self):
  os.environ['HERMES_SESSION_USER_ID']='UOWNER'
  with self.assertRaisesRegex(ValueError,'no CLI'):self.invoke({})
 def test_other_sender_and_workspace_rejected(self):
  for patch in [{'USER_ID':'USTAFF'},{'KEY':'agent:main:slack:group:TOTHER:C123'}]:
   with self.assertRaises(ValueError):self.invoke({**self.base(),**patch})
 def test_delegated_child_rejected_even_with_owner_context(self):
  global child
  child=True
  try:
   with self.assertRaisesRegex(ValueError,'children'):self.invoke(self.base())
  finally:child=False
if __name__=='__main__':unittest.main()
