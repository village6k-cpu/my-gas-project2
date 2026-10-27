import ast,copy,importlib.util,json,sys,types,unittest
from pathlib import Path
root=Path(__file__).resolve().parents[1]
source=root/'scripts/windows/hermes-profile-overlay/plugins/kakao_village'
pkg=types.ModuleType('external_supply_test');pkg.__path__=[str(source)];sys.modules[pkg.__name__]=pkg
# These transport-only imports do not participate in typed validation.
registry=types.ModuleType('tools.registry');registry.tool_error=lambda *a,**k:None;registry.tool_result=lambda *a,**k:None
sys.modules['tools']=types.ModuleType('tools');sys.modules['tools.registry']=registry
http=types.ModuleType(pkg.__name__+'.http_client');http.BridgeClient=object;http.BridgeClientError=RuntimeError;sys.modules[http.__name__]=http
from contextvars import ContextVar
ctx=types.ModuleType(pkg.__name__+'.turn_context');ctx.ACTIVE_TURN_FENCE=ContextVar('test');sys.modules[ctx.__name__]=ctx
spec=importlib.util.spec_from_file_location(pkg.__name__+'.registered_change_tool',source/'registered_change_tool.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
m={'confirmed':True,'kind':'external_supply_allocation','target_scope':'registered_trade','trade_id':'261027-001','source_evidence':{'customer_request':'한 대 외부지원','staff_confirmation':'한 대 확보','conversation_revision':3},'expected_period':{'start_date':'2026-10-27','start_time':'10:00','end_date':'2026-10-28','end_time':'10:00'},'expected_before':[{'schedule_id':'261027-001-04','name':'모니터','quantity':2}],'desired_after':[],'date_change':None,'external_supply':{'supplier':'제휴샵','quantity':1,'expected_note':''}}
class Tests(unittest.TestCase):
 def test_native_type_preserves_external_quantity_without_pickup_field(self):self.assertEqual(module._validate_mutation(m,3),m)
 def test_schema_advertises_executable_allocation_and_not_equipment_add(self):
  schema=next(ast.literal_eval(n.value) for n in ast.parse((source/'__init__.py').read_text(encoding='utf-8')).body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='REGISTERED_CHANGE_SCHEMA' for t in n.targets))
  import jsonschema
  jsonschema.validate({'mutation':m},schema['parameters'])
 def test_invalid_quantity_scope_and_supplier_are_rejected(self):
  for field,value in [('quantity',3),('quantity',0),('quantity',True),('supplier','샵|다른샵')]:
   bad=copy.deepcopy(m);bad['external_supply'][field]=value
   with self.assertRaises(ValueError):module._validate_mutation(bad,3)
if __name__=='__main__':unittest.main()
