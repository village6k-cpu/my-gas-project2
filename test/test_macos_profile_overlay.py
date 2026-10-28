"""Latest learning and uncertain receipts win over inactive native preparations."""
from pathlib import Path
import hashlib,importlib.util,json,os,sys,tempfile,unittest,sqlite3,subprocess
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/macos'))


class ProfileOverlayTests(unittest.TestCase):
    def setUp(self):
        p=Path(__file__).resolve().parents[1]/'scripts/macos/migration_profile_overlay.py'
        self.assertTrue(p.is_file(),'current final-profile overlay is missing')
        spec=importlib.util.spec_from_file_location('current_profile_overlay',p)
        self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name);(self.root/'MIGRATION-INACTIVE').touch()
        self.raw=self.root/'raw';self.raw.mkdir();self.native=self.root/'native';self.native.mkdir()
        self.out=self.root/'out'
        (self.raw/'learning.md').write_text('latest Windows learning',encoding='utf-8')
        (self.native/'learning.md').write_text('old preparation',encoding='utf-8')
        (self.raw/'uncertain.bin').write_bytes(b'uncertain\0\xff')
        (self.raw/'empty').mkdir()
        (self.raw/'gateway_state.json').write_text('{"pid":123}')
        self.kwargs=dict(overrides={},controls={},canonical={},native_only=[],excluded=[],
                         owned_controls={},allowed_root=self.root)

    def build(self):return self.m.build(self.raw,self.native,self.out,**self.kwargs)
    def pin(self,p):return hashlib.sha256(p.read_bytes()).hexdigest()

    def test_latest_learning_uncertain_payloads_and_empty_directories_are_preserved(self):
        p=self.raw/'uncertain.bin';stamp=1609459200123456700;os.utime(p,ns=(stamp,stamp))
        result=self.build()
        self.assertEqual((self.out/'learning.md').read_text(),'latest Windows learning')
        self.assertEqual((self.out/'uncertain.bin').read_bytes(),p.read_bytes())
        self.assertEqual((self.out/'uncertain.bin').stat().st_mtime_ns,p.stat().st_mtime_ns)
        self.assertTrue((self.out/'empty').is_dir());self.assertFalse((self.out/'gateway_state.json').exists())
        self.assertTrue((self.raw/'gateway_state.json').is_file());self.assertFalse(result['activated'])

    def drain(self):
        body={'action':'drain','migration_id':'fixture','principal':'village-studio-migration:fixture',
              'owner':{'pid':123,'started':4.5}}
        p=self.raw/'.drain_request.json';p.write_text(json.dumps(body));return p,body

    def test_only_exact_bound_migration_drain_is_omitted_from_native_profile(self):
        p,body=self.drain()
        with self.assertRaisesRegex(ValueError,'unowned_drain'):self.build()
        self.assertFalse(self.out.exists())
        self.kwargs['owned_controls']={'.drain_request.json':{'sha256':self.pin(p),
            'migration_id':'fixture','owner':body['owner']}}
        result=self.build();self.assertFalse((self.out/p.name).exists());self.assertTrue(p.is_file())
        self.assertEqual(result['omitted_owned_controls'][p.name],self.pin(p))

    def test_changed_operator_drain_or_source_adaptation_is_preserved_and_blocks(self):
        p,body=self.drain();self.kwargs['owned_controls']={p.name:{'sha256':'0'*64,
            'migration_id':'fixture','owner':body['owner']}}
        with self.assertRaises(ValueError):self.build()
        self.assertFalse(self.out.exists());self.assertTrue(p.is_file())
        p.unlink();self.kwargs['owned_controls']={}
        self.kwargs['overrides']={'learning.md':{'source_sha256':'0'*64,'native_sha256':self.pin(self.native/'learning.md')}}
        with self.assertRaises(ValueError):self.build()
        self.assertFalse(self.out.exists())

    def test_all_bound_canonical_databases_replace_raw_and_wal_only_in_new_output(self):
        canonical=self.root/'canonical';canonical.mkdir()
        for name in ('state.db','new-agent.sqlite'):
            (self.raw/name).write_bytes(b'raw main');(self.raw/(name+'-wal')).write_bytes(b'raw committed WAL')
            (canonical/name).write_bytes(b'canonical committed bytes')
            self.kwargs['canonical'][name]={'path':str(canonical/name),'sha256':self.pin(canonical/name)}
        self.build()
        for name in self.kwargs['canonical']:
            self.assertEqual((self.out/name).read_bytes(),(canonical/name).read_bytes())
            self.assertFalse((self.out/(name+'-wal')).exists());self.assertTrue((self.raw/(name+'-wal')).is_file())

    def test_activation_or_unclassified_sqlite_cannot_create_output(self):
        (self.root/'ACTIVATION.json').touch()
        with self.assertRaises(ValueError):self.build()
        self.assertFalse(self.out.exists());(self.root/'ACTIVATION.json').unlink()
        (self.raw/'unclassified.sqlite').write_bytes(b'SQLite format 3\0'+b'unknown')
        with self.assertRaises(ValueError):self.build()
        self.assertFalse(self.out.exists())

    def test_real_hot_sqlite3_journal_cannot_roll_back_canonical_data(self):
        raw=self.raw/'state.sqlite3'
        db=sqlite3.connect(raw)
        try:
            db.executescript('PRAGMA page_size=512;CREATE TABLE facts(body TEXT);')
            db.executemany('INSERT INTO facts VALUES(?)',[('raw_committed-'+'x'*200,)]*200);db.commit()
        finally:db.close()
        child="""import os,sqlite3,sys
db=sqlite3.connect(sys.argv[1]);db.execute('PRAGMA cache_size=2')
db.execute('BEGIN IMMEDIATE');db.execute("UPDATE facts SET body='unfinished-'||body")
os._exit(0)
"""
        subprocess.run([sys.executable,'-c',child,str(raw)],cwd=self.root,check=True,timeout=10)
        journal=self.raw/'state.sqlite3-journal'
        before=journal.read_bytes();self.assertEqual(before[:8],bytes.fromhex('d9d505f920a163d7'))
        canonical=self.root/'canonical.sqlite3';db=sqlite3.connect(canonical)
        try:db.executescript("CREATE TABLE facts(body TEXT);INSERT INTO facts VALUES('canonical_latest');");db.commit()
        finally:db.close()
        self.kwargs['canonical']={'state.sqlite3':{'path':str(canonical),'sha256':self.pin(canonical)}}
        with self.assertRaisesRegex(ValueError,'journal'):self.build()
        self.assertFalse(self.out.exists());self.assertEqual(journal.read_bytes(),before)


if __name__=='__main__':unittest.main()
