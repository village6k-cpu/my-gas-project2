"""Synthetic provenance and raw-payload checks; never operational stop evidence."""
from pathlib import Path
import copy
import hashlib
import importlib.util
import json
import os
import sqlite3
from contextlib import closing
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/macos'))


class StreamedRestoreTests(unittest.TestCase):
    def setUp(self):
        path=Path(__file__).resolve().parents[1]/'scripts/macos/migration_streamed_restore.py'
        self.assertTrue(path.is_file(),'current full-byte restoration verifier is missing')
        spec=importlib.util.spec_from_file_location('streamed_restore',path)
        self.m=importlib.util.module_from_spec(spec);spec.loader.exec_module(self.m)
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name);self.snapshot=self.base/'snapshot';self.snapshot.mkdir()
        self.proofs=self.base/'proofs';self.proofs.mkdir()
        def digest(raw):return hashlib.sha256(raw).hexdigest()
        self.digest=digest
        self.intent={'profiles':[{'role':role,'pid':i+10,'started':1.2+i,
            'home':('C:/fixture-'+role)} for i,role in enumerate(('root','worker','bridge','relay','voice'))]}
        self.stop={'schema':1,'stopped_at':20,'profiles':[dict(x,status='stopped',
            children_inventory_complete=True,children=[]) for x in self.intent['profiles']]}
        self.work={'schema':'village-current-accepted-work-closure/v1','owners':{}}
        for owner in self.intent['profiles']:
            row=dict(owner);self.work['owners'][row['role']]=row
            if row['role'] in ('root','worker'):row.update(gateway_state='draining',active_agents=0,pending_messages=0,running_cron=0)
            elif row['role']=='bridge':row.update(drained=True,http_closed=True,preexisting_work_verified=True,pending_handlers=0,pending_tracked_work=0)
            elif row['role']=='voice':row.update(threads=1,non_listening_tcp_connections=0,ingress_mode='hold',ingress_dispatching=0,ingress_epoch='SYNTHETIC',receipt_status_counts={})
            else:row['owned_producer_paused']=True
        self.work.update(slack_quiet={'settled_seconds':300,'new_input_observed':False},
            preserved_obligations={'replay_authorized':False,'manifest_sha256':'f'*64})
        self.pins={}
        self.save('intent',self.intent)
        self.stop['intent_sha256']=self.pins['intent'];self.work['intent_sha256']=self.pins['intent']
        self.save('work',self.work);self.stop['accepted_work_sha256']=self.pins['work'];self.save('stop',self.stop)
        sources=self.m.expected_sources(self.intent)
        files=[];directories=[]
        for name,source in sources.items():
            p=self.snapshot/name;p.mkdir();directories.append(name)
            data=b'SYNTHETIC-NOT-PRODUCTION\nuncertain and failed payload retained'
            (p/'retained.bin').write_bytes(data)
            files.append({'path':name+'/retained.bin','bytes':len(data),'sha256':digest(data)})
        self.manifest={'errors':[],'changed_during_read':[],'source_roots':[
            {'name':n,'source':s,'exclude_relative_dirs':[],'exclude_relative_files':[]} for n,s in sources.items()],
            'files':files,'directories':directories}
        self.refresh_manifest()
        gate={'checked_unix':21,'intent_sha256':self.pins['intent'],'stop_sha256':self.pins['stop'],
            'all_five_owners_absent':True,'scheduled_writers_absent':True,'all_21_tasks_fenced':True,
            'destination_inactive':True,'owned_watcher_paused':True}
        self.cold={'schema':'village-current-closed-stream/v1','before':gate,'after':dict(gate,checked_unix=23),
            'destination':str(self.snapshot),'started_unix':21,'finished_unix':24,
            'payload_transferred':True,'cold_capture_verified':True,'production_activated':False,
            'local_full_payload_copy':False,'transport_manifest_sha256':digest((self.snapshot/'MANIFEST.json').read_bytes()),
            'verified_files':len(files),'verified_directories':len(directories),'verified_bytes':sum(x['bytes'] for x in files)}
        self.save('cold',self.cold)

    def save(self,name,value):
        raw=json.dumps(value).encode();(self.proofs/(name+'.json')).write_bytes(raw)
        self.pins[name]=self.digest(raw)

    def refresh_manifest(self):
        (self.snapshot/'MANIFEST.json').write_text(json.dumps(self.manifest),encoding='utf-8')
        (self.snapshot/'VERIFIED.json').write_text(json.dumps({'destination':str(self.snapshot),
            'production_enabled':False,'verified_files':len(self.manifest['files']),
            'verified_directories':len(self.manifest['directories']),
            'verified_bytes':sum(x['bytes'] for x in self.manifest['files'])}),encoding='utf-8')

    def verify(self):return self.m.verify_snapshot(self.snapshot,self.proofs,self.pins)

    def test_bound_full_stream_preserves_all_six_raw_trees_without_promoting(self):
        before={str(p):p.read_bytes() for p in self.snapshot.rglob('*') if p.is_file()}
        result=self.verify()
        self.assertTrue(result['raw_verified']);self.assertFalse(result['activated'])
        self.assertFalse(result['promoted']);self.assertEqual(result['verified_files'],6)
        self.assertEqual(before,{str(p):p.read_bytes() for p in self.snapshot.rglob('*') if p.is_file()})

    def test_generic_transport_verified_without_bound_cold_proof_is_insufficient(self):
        (self.proofs/'cold.json').unlink()
        with self.assertRaises((ValueError,OSError)):self.verify()

    def test_changed_bound_proof_or_source_payload_is_rejected(self):
        p=self.proofs/'stop.json';original=p.read_bytes();p.write_bytes(original+b' ')
        with self.assertRaises(ValueError):self.verify()
        p.write_bytes(original)
        (self.snapshot/'gbrain-db/retained.bin').write_bytes(b'changed')
        with self.assertRaises(ValueError):self.verify()

    def test_unclosed_owner_or_missing_quiet_readback_blocks(self):
        for mutate in ('owner','quiet','gate'):
            work=copy.deepcopy(self.work);stop=copy.deepcopy(self.stop);cold=copy.deepcopy(self.cold)
            if mutate=='owner':stop['profiles'][0]['status']='unaffected'
            if mutate=='quiet':work['slack_quiet']['settled_seconds']=299
            if mutate=='gate':cold['after']['all_21_tasks_fenced']=False
            self.save('work',work);stop['accepted_work_sha256']=self.pins['work'];self.save('stop',stop)
            for key in ('before','after'):cold[key]['stop_sha256']=self.pins['stop']
            self.save('cold',cold)
            with self.subTest(mutate=mutate),self.assertRaises(ValueError):self.verify()

    def test_alternate_historical_source_and_operational_exclusion_are_rejected(self):
        for change in ('source','exclude','unknown-root'):
            manifest=copy.deepcopy(self.manifest)
            if change=='source':manifest['source_roots'][0]['source']='C:/MacMiniMirror'
            elif change=='exclude':manifest['source_roots'][0]['exclude_relative_dirs']=['memory']
            else:manifest['source_roots'][0]['name']='old-root'
            (self.snapshot/'MANIFEST.json').write_text(json.dumps(manifest),encoding='utf-8')
            cold=copy.deepcopy(self.cold);cold['transport_manifest_sha256']=self.digest((self.snapshot/'MANIFEST.json').read_bytes());self.save('cold',cold)
            with self.subTest(change=change),self.assertRaises(ValueError):self.verify()

    def test_unlisted_file_or_symlink_is_rejected(self):
        extra=self.snapshot/'root-profile/unlisted';extra.write_bytes(b'extra')
        with self.assertRaises(ValueError):self.verify()
        extra.unlink()
        try:extra.symlink_to(self.snapshot/'worker-profile/retained.bin')
        except OSError:self.skipTest('synthetic symlink creation unavailable')
        with self.assertRaises(ValueError):self.verify()

    def test_recorded_source_mtime_is_part_of_payload_verification(self):
        row=self.manifest['files'][0];p=self.snapshot/row['path']
        row['mtime_ns']=p.stat().st_mtime_ns;self.refresh_manifest()
        self.cold['transport_manifest_sha256']=self.digest((self.snapshot/'MANIFEST.json').read_bytes())
        self.save('cold',self.cold);self.verify()
        os.utime(p,ns=(row['mtime_ns']+1000,row['mtime_ns']+1000))
        with self.assertRaises(ValueError):self.verify()

    def prepare_sqlite_payloads(self):
        for label in ('root','worker'):
            names=['state.db','projects.db','verification_evidence.db','cron/executions.db']
            if label=='root':names+=['kanban.db','cron/slack-heybilli-ai-gate.db']
            for name in names:
                p=self.snapshot/(label+'-profile')/name;p.parent.mkdir(parents=True,exist_ok=True)
                db=sqlite3.connect(p)
                try:
                    db.execute('pragma journal_mode=wal');db.execute('pragma wal_autocheckpoint=0')
                    db.execute('create table facts(body blob)')
                    db.execute('insert into facts values(?)',(b'pending\x00\xff',));db.commit()
                    # Copy a committed WAL pair into immutable fixture files,
                    # then close the live fixture connection before restoration.
                    import shutil
                    live=self.base/('live-'+label+'-'+name.replace('/','-'));live.mkdir()
                    shutil.copyfile(p,live/'state.db');shutil.copyfile(str(p)+'-wal',live/'state.db-wal')
                finally:db.close()
                shutil.copyfile(live/'state.db',p);shutil.copyfile(live/'state.db-wal',str(p)+'-wal')
        self.authenticate_payloads()

    def authenticate_payloads(self):
        self.manifest['files']=[];self.manifest['directories']=[]
        for p in self.snapshot.rglob('*'):
            relative=p.relative_to(self.snapshot).as_posix()
            if relative in ('MANIFEST.json','VERIFIED.json'):continue
            if p.is_dir():self.manifest['directories'].append(relative)
            else:self.manifest['files'].append({'path':relative,'bytes':p.stat().st_size,
                'sha256':self.digest(p.read_bytes()),'mtime_ns':p.stat().st_mtime_ns})
        self.refresh_manifest();self.cold.update(verified_files=len(self.manifest['files']),
            verified_directories=len(self.manifest['directories']),
            verified_bytes=sum(r['bytes'] for r in self.manifest['files']),
            transport_manifest_sha256=self.digest((self.snapshot/'MANIFEST.json').read_bytes()))
        self.save('cold',self.cold)

    def test_full_restoration_retains_six_raw_trees_and_ten_sqlite_databases(self):
        self.prepare_sqlite_payloads()
        candidate=self.base/'candidate';candidate.mkdir();(candidate/'MIGRATION-INACTIVE').touch()
        output=candidate/'restored';calls=[]
        def inactive():calls.append(1);return True
        report=self.m.restore_snapshot(self.snapshot,self.proofs,self.pins,output,candidate,is_inactive=inactive)
        self.assertTrue(report['complete']);self.assertFalse(report['promoted']);self.assertFalse(report['activated'])
        self.assertEqual(sum(len(r) for r in report['canonical'].values()),10)
        self.assertTrue(all(r['counts']['facts']==1 for role in report['canonical'].values() for r in role.values()))
        self.assertTrue((output/'RESTORATION.json').is_file());self.assertGreater(len(calls),10)
        self.assertFalse((candidate/'hermes-root').exists());self.assertFalse((candidate/'ACTIVATION.json').exists())
        for row in self.manifest['files']:
            self.assertEqual(self.digest((self.snapshot/row['path']).read_bytes()),row['sha256'])
            p=output/'raw'/row['path'];self.assertEqual(self.digest(p.read_bytes()),row['sha256'])
            self.assertEqual(p.stat().st_mtime_ns,row['mtime_ns'])

    def test_authenticated_corrupt_wal_cannot_publish_successful_restoration(self):
        self.prepare_sqlite_payloads()
        wal=self.snapshot/'root-profile/state.db-wal'
        data=bytearray(wal.read_bytes());data[-1]^=1;wal.write_bytes(data)
        self.authenticate_payloads()  # Transport hashes are authentic, WAL is not.
        candidate=self.base/'candidate';candidate.mkdir();(candidate/'MIGRATION-INACTIVE').touch()
        with self.assertRaisesRegex(ValueError,'wal_'):
            self.m.restore_snapshot(self.snapshot,self.proofs,self.pins,candidate/'out',candidate,is_inactive=lambda:True)
        self.assertFalse((candidate/'out/RESTORATION.json').exists())
        self.assertEqual(wal.read_bytes(),bytes(data))

    def test_unmapped_sqlite_outside_hermes_profiles_blocks_full_restoration(self):
        self.prepare_sqlite_payloads()
        with closing(sqlite3.connect(self.snapshot/'bridge-queue/retained.sqlite')) as db:
            db.execute('create table obligations(body blob)')
            db.execute('insert into obligations values(?)',(b'uncertain',));db.commit()
        self.authenticate_payloads()
        candidate=self.base/'candidate';candidate.mkdir();(candidate/'MIGRATION-INACTIVE').touch()
        with self.assertRaisesRegex(ValueError,'unmapped_sqlite'):
            self.m.restore_snapshot(self.snapshot,self.proofs,self.pins,candidate/'out',candidate,is_inactive=lambda:True)
        self.assertFalse((candidate/'out/RESTORATION.json').exists())

    def test_sqlite_wal_header_frames_and_committed_boundary_are_all_checked(self):
        self.prepare_sqlite_payloads()
        raw=self.snapshot/'root-profile/state.db';wal=Path(str(raw)+'-wal')
        original=wal.read_bytes()
        for mutation in ('header','salt','frame_checksum','truncated','page_size','uncommitted_tail'):
            data=bytearray(original)
            if mutation=='header':data[24]^=1
            elif mutation=='salt':data[40]^=1
            elif mutation=='frame_checksum':data[48]^=1
            elif mutation=='truncated':data=data[:-1]
            elif mutation=='page_size':data[8:12]=(512).to_bytes(4,'big')
            else:data.extend(original[32:32+24+4096])
            wal.write_bytes(data)
            with self.subTest(mutation=mutation),self.assertRaisesRegex(ValueError,'wal_'):
                self.m.canonicalize_sqlite(raw,self.base/('clone-'+mutation),self.digest(raw.read_bytes()),
                    self.digest(data),self.base)
        wal.write_bytes(original)

    def test_active_candidate_never_starts_raw_restoration(self):
        self.assertTrue(hasattr(self.m,'restore_snapshot'),'current full-byte restoration is missing')
        candidate=self.base/'candidate';candidate.mkdir();(candidate/'MIGRATION-INACTIVE').touch()
        with self.assertRaises(ValueError):self.m.restore_snapshot(self.snapshot,self.proofs,self.pins,candidate/'out',candidate,is_inactive=lambda:False)
        self.assertFalse((candidate/'out').exists())


if __name__=='__main__':unittest.main()
