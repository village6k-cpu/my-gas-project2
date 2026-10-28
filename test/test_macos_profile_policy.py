"""Synthetic final manifests: changed learning and unowned drains fail closed."""
import copy,hashlib,importlib.util,json
from pathlib import Path
import sys,unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/macos'))

class PolicyTests(unittest.TestCase):
    def setUp(self):
        self.path=Path(__file__).resolve().parents[1]/'scripts/macos/migration_profile_policy.py'
        self.assertTrue(self.path.is_file(),'final profile policy binder is missing')
        spec=importlib.util.spec_from_file_location('final_policy',self.path);self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
        self.intent_sha='a'*64;self.ref={'path':'/candidate/raw/MANIFEST.json','sha256':'b'*64}
        self.intent={'profiles':[{'role':r,'pid':10+i,'started':100.1+i,'home':'C:/fixture/'+r} for i,r in enumerate(('root','worker'))]}
        self.drains={'schema':'village-owned-drains/v1','intent_sha256':self.intent_sha,'migration_id':'SYNTHETIC','profiles':[]}
        self.blueprint={'schema':'village-current-profile-assembly-policy-blueprint/v1','candidate':'/candidate','profiles':{},'cron':{'unchanged':True},'session_mappings':{'C:/fixture':'/candidate/runtime'},'unmapped_execution_directories':[],'live_source_drift_to_reconcile':[]}
        self.manifest={'files':[]}
        for row in self.intent['profiles']:
            role=row['role'];self.blueprint['profiles'][role]={'native':'/candidate/native/'+role,'overrides':{'learning.md':{'source_sha256':'c'*64,'native_sha256':'d'*64}},'controls':{},'source_anchors':{'learning.md':'c'*64},'native_only':[],'excluded':[]}
            self.drains['profiles'].append({'role':role,'path':row['home']+'/.drain_request.json','owner':{k:row[k] for k in ('pid','started')},'created':True,'original_absent':True,'sha256':'e'*64})
            self.manifest['files'] += [{'path':role+'-profile/learning.md','sha256':'c'*64},{'path':role+'-profile/.drain_request.json','sha256':'e'*64}]
    def freeze(self):return self.m.freeze_policy(self.blueprint,self.manifest,self.drains,self.intent,self.intent_sha,self.ref)
    def test_exact_latest_anchors_and_actual_owned_drains_are_bound_without_mutating_blueprint(self):
        before=copy.deepcopy(self.blueprint);result=self.freeze()
        self.assertEqual(result['schema'],'village-current-profile-assembly-policy/v1');self.assertEqual(result['transport_manifest'],self.ref)
        self.assertEqual(result['profiles']['root']['owned_controls']['.drain_request.json']['migration_id'],'SYNTHETIC')
        self.assertEqual(result['profiles']['worker']['owned_controls']['.drain_request.json']['sha256'],'e'*64)
        self.assertEqual(self.blueprint,before)
    def test_any_later_learning_change_requires_reconciliation_before_assembly(self):
        self.manifest['files'][0]['sha256']='f'*64
        with self.assertRaisesRegex(ValueError,'source_binding_changed'):self.freeze()
    def test_a_preparation_drain_or_another_owner_cannot_omit_a_real_marker(self):
        for key,value in (('created',False),('original_absent',False),('sha256','f'*64),('owner',{'pid':99,'started':2})):
            original=copy.deepcopy(self.drains)
            self.drains['profiles'][0][key]=value
            with self.subTest(key=key),self.assertRaises(ValueError):self.freeze()
            self.drains=original
    def test_unmapped_execution_directory_duplicate_manifest_and_missing_source_control_block(self):
        self.blueprint['unmapped_execution_directories']=['C:/unknown']
        with self.assertRaises(ValueError):self.freeze()
        self.blueprint['unmapped_execution_directories']=[]
        self.manifest['files'].append(copy.deepcopy(self.manifest['files'][0]))
        with self.assertRaises(ValueError):self.freeze()
        self.manifest['files'].pop()
        self.blueprint['profiles']['root']['controls']['config.yaml']={'path':'/candidate/config','sha256':'1'*64,'source_sha256':'2'*64}
        with self.assertRaises(ValueError):self.freeze()
    def test_an_explicit_source_absent_control_cannot_overwrite_a_new_source_file(self):
        self.blueprint['profiles']['root']['controls']['new.env']={'path':'/candidate/control','sha256':'1'*64,'source_absent':True}
        self.freeze();self.manifest['files'].append({'path':'root-profile/new.env','sha256':'2'*64})
        with self.assertRaises(ValueError):self.freeze()

if __name__=='__main__':unittest.main()
