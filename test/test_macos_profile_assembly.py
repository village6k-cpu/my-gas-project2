"""Synthetic final assembly: actual SQLite clones, latest histories, no activation."""
from pathlib import Path
from datetime import datetime
import hashlib,importlib.util,json,os,shutil,sqlite3,sys,tempfile,unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/macos'))


class AssemblyTests(unittest.TestCase):
    def setUp(self):
        p=Path(__file__).resolve().parents[1]/'scripts/macos/migration_profile_assembly.py'
        self.assertTrue(p.exists(),'current final assembly controller is missing')
        spec=importlib.util.spec_from_file_location('current_assembly',p)
        self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);(self.root/'MIGRATION-INACTIVE').touch()
        (self.root/'state/voice-ingress-v1').mkdir(parents=True)
        (self.root/'runtime').mkdir();self.rest=self.root/'restoration';self.rest.mkdir()
        self.raw=self.rest/'raw';self.raw.mkdir();self.output=self.root/'assembly'
        self.report={'schema':'village-current-full-stream-restoration/v1','complete':True,
            'promoted':False,'activated':False,'canonical':{},'gbrain_logical_validation_pending':True}
        self.policy={'schema':'village-current-profile-assembly-policy/v1','candidate':str(self.root),
            'profiles':{},'session_mappings':{'C:/Village/current':str(self.root/'runtime')}}
        for role in ('root','worker'):
            raw=self.raw/(role+'-profile');raw.mkdir();native=self.root/('native-'+role);native.mkdir()
            (raw/'learning.md').write_text('latest learned context');(raw/'uncertain.bin').write_bytes(b'pending\0\xff')
            (raw/'gateway_state.json').write_text('{"pid":123}')
            body={'action':'drain','migration_id':'fixture','principal':'village-studio-migration:fixture',
                  'owner':{'pid':123,'started':4.5}}
            (raw/'.drain_request.json').write_text(json.dumps(body))
            names=['state.db','projects.db','verification_evidence.db','cron/executions.db']
            names+=['kanban.db','cron/slack-heybilli-ai-gate.db'] if role=='root' else ['new-agent.sqlite3']
            self.report['canonical'][role]={}
            for name in names:
                p=raw/name;p.parent.mkdir(parents=True,exist_ok=True);db=sqlite3.connect(p)
                try:
                    db.executescript('CREATE TABLE facts(body BLOB);')
                    db.execute('INSERT INTO facts VALUES(?)',(b'latest\0\xff',))
                    if name=='state.db':
                        db.executescript('CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,history TEXT);CREATE TABLE messages(body BLOB);')
                        db.execute('INSERT INTO sessions VALUES(?,?,?)',('current','C:/Village/current','history C:/Village/current unchanged'))
                        db.execute('INSERT INTO messages VALUES(?)',(b'original history\0\xff',))
                    db.commit()
                finally:db.close()
                canonical=self.rest/'canonical'/role/name;canonical.parent.mkdir(parents=True,exist_ok=True)
                shutil.copy2(p,canonical)
                self.report['canonical'][role][name]={'integrity':'ok','canonical_sha256':self.pin(canonical)}
            self.policy['profiles'][role]={'native':str(native),'overrides':{},'controls':{},
                'native_only':[],'excluded':[],'source_anchors':{},'owned_controls':{
                    '.drain_request.json':{'sha256':self.pin(raw/'.drain_request.json'),
                        'migration_id':'fixture','owner':body['owner']}}}
        for name in ('bridge-queue','gbrain-db','inventory-stock-alerts','kakao-corrections'):
            p=self.raw/name;p.mkdir();(p/'retained').write_bytes(b'uncertain data')
        self.baseline={'jobs':[{'id':'job','prompt':'same model and business instructions','enabled':True,
            'state':'scheduled','schedule':{'kind':'cron','expr':'*/10 * * * *'},'workdir':'C:/Village/current',
            'last_status':'old','next_run_at':'2026-10-28T10:00:00+09:00','fire_claim':None}]}
        native=json.loads(json.dumps(self.baseline));native['jobs'][0]['workdir']=str(self.root/'runtime')
        latest=json.loads(json.dumps(self.baseline));latest['jobs'][0]['last_status']='latest'
        self.json(self.raw/'root-profile/cron/jobs.json',latest)
        self.json(self.root/'baseline-cron.json',self.baseline);self.json(self.root/'native-cron.json',native)
        self.policy['cron']={'baseline':self.ref(self.root/'baseline-cron.json'),'native':self.ref(self.root/'native-cron.json')}
        self.refresh_manifest();self.policy_path=self.root/'policy.json';self.json(self.policy_path,self.policy)
        self.json(self.rest/'RESTORATION.json',self.report)

    def pin(self,p):return hashlib.sha256(p.read_bytes()).hexdigest()
    def ref(self,p):return {'path':str(p),'sha256':self.pin(p)}
    def json(self,p,v):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(v),encoding='utf-8')
    def refresh_manifest(self):
        manifest={'files':[],'directories':[]}
        for p in self.raw.rglob('*'):
            name=p.relative_to(self.raw).as_posix()
            if p.is_dir():manifest['directories'].append(name)
            else:manifest['files'].append({'path':name,'sha256':self.pin(p),'bytes':p.stat().st_size,'mtime_ns':p.stat().st_mtime_ns})
        self.json(self.root/'transport-manifest.json',manifest)
        self.policy['transport_manifest']=self.ref(self.root/'transport-manifest.json')
        self.report['transport_manifest_sha256']=self.policy['transport_manifest']['sha256']

    def build(self):
        return self.m.assemble(self.rest,self.policy_path,self.output,self.root,
            restoration_sha=self.pin(self.rest/'RESTORATION.json'),policy_sha=self.pin(self.policy_path),
            is_inactive=lambda:True,now=datetime.fromisoformat('2026-10-28T10:17:00+09:00'))

    def test_latest_learning_history_extra_database_and_owned_drain_handled_without_promotion(self):
        result=self.build();self.assertTrue(result['complete']);self.assertFalse(result['activated'])
        self.assertTrue(result['gbrain_logical_validation_pending'])
        for profile in (self.output/'root',self.output/'root/profiles/kakaoworker'):
            self.assertEqual((profile/'learning.md').read_text(),'latest learned context')
            self.assertEqual((profile/'uncertain.bin').read_bytes(),b'pending\0\xff')
            self.assertFalse((profile/'.drain_request.json').exists())
            self.assertFalse((profile/'gateway_state.json').exists())
            db=sqlite3.connect(profile/'state.db')
            try:
                self.assertEqual(db.execute('SELECT cwd FROM sessions').fetchone()[0],str((self.root/'runtime').resolve()))
                self.assertEqual(db.execute('SELECT history FROM sessions').fetchone()[0],'history C:/Village/current unchanged')
                self.assertEqual(db.execute('SELECT body FROM messages').fetchone()[0],b'original history\0\xff')
            finally:db.close()
        self.assertTrue((self.output/'root/profiles/kakaoworker/new-agent.sqlite3').is_file())
        job=json.loads((self.output/'root/cron/jobs.json').read_text())['jobs'][0]
        self.assertEqual(job['last_status'],'latest');self.assertEqual(job['next_run_at'],'2026-10-28T10:20:00+09:00')
        self.assertTrue((self.output/'ASSEMBLY.json').is_file());self.assertFalse((self.root/'ACTIVATION.json').exists())

    def test_changed_raw_payload_cannot_assemble(self):
        (self.raw/'worker-profile/uncertain.bin').write_bytes(b'changed')
        with self.assertRaises(ValueError):self.build()
        self.assertFalse(self.output.exists())

    def test_native_owner_appearing_during_assembly_prevents_success_publication(self):
        calls=[]
        def inactive():calls.append(1);return len(calls)<4
        with self.assertRaises(ValueError):
            self.m.assemble(self.rest,self.policy_path,self.output,self.root,
                restoration_sha=self.pin(self.rest/'RESTORATION.json'),policy_sha=self.pin(self.policy_path),
                is_inactive=inactive,now=datetime.fromisoformat('2026-10-28T10:17:00+09:00'))
        self.assertFalse((self.output/'ASSEMBLY.json').exists())
        self.assertTrue((self.raw/'root-profile/.drain_request.json').is_file())

    def test_changed_canonical_clone_or_wrong_policy_pin_blocks_before_output(self):
        p=self.rest/'canonical/root/state.db';before=p.read_bytes();p.write_bytes(before+b'changed')
        with self.assertRaises(ValueError):self.build()
        self.assertFalse(self.output.exists());p.write_bytes(before)
        with self.assertRaises(ValueError):
            self.m.assemble(self.rest,self.policy_path,self.output,self.root,
                restoration_sha=self.pin(self.rest/'RESTORATION.json'),policy_sha='0'*64,
                is_inactive=lambda:True,now=datetime.fromisoformat('2026-10-28T10:17:00+09:00'))
        self.assertFalse(self.output.exists())

    def test_changed_cron_business_definition_blocks_instead_of_importing_staging(self):
        p=self.raw/'root-profile/cron/jobs.json';value=json.loads(p.read_text());value['jobs'][0]['prompt']='changed business instructions'
        self.json(p,value);self.refresh_manifest();self.json(self.policy_path,self.policy);self.json(self.rest/'RESTORATION.json',self.report)
        with self.assertRaises(ValueError):self.build()
        self.assertFalse(self.output.exists())

    def test_final_profile_content_mutation_cannot_publish_success(self):
        def inactive():
            target=self.output/'root/learning.md'
            if (self.output/'root/profiles/kakaoworker').is_dir():target.write_text('changed during final observation')
            return True
        with self.assertRaisesRegex(ValueError,'assembled'):
            self.m.assemble(self.rest,self.policy_path,self.output,self.root,
                restoration_sha=self.pin(self.rest/'RESTORATION.json'),policy_sha=self.pin(self.policy_path),
                is_inactive=inactive,now=datetime.fromisoformat('2026-10-28T10:17:00+09:00'))
        self.assertFalse((self.output/'ASSEMBLY.json').exists())

    def test_worker_cron_requires_a_separate_reviewed_contract(self):
        self.json(self.raw/'worker-profile/cron/jobs.json',self.baseline)
        self.refresh_manifest();self.json(self.policy_path,self.policy);self.json(self.rest/'RESTORATION.json',self.report)
        with self.assertRaisesRegex(ValueError,'worker_cron'):self.build()
        self.assertFalse(self.output.exists())


if __name__=='__main__':unittest.main()
