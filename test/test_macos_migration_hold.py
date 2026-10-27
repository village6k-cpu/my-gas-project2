import hashlib
import importlib.util
import json
from pathlib import Path
import unittest

MODULE=Path(__file__).resolve().parents[1]/'scripts/macos/migration_recovery_hold.py'


class RecoveryHoldMigrationTests(unittest.TestCase):
    def setUp(self):
        spec=importlib.util.spec_from_file_location('migration_hold',MODULE)
        self.subject=importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.subject)
        self.source_queue='C:/Village/runtime/queue/hermes-gateway'
        self.native_queue='/Users/operator/VillageMigration/candidate/runtime/queue/hermes-gateway'
        self.manifest={'schema':'village-gateway-held-jobs/v1',
                       'freezeBefore':'2026-10-24T03:00:57.221Z',
                       'queueDirectory':self.source_queue,
                       'entries':[{'jobId':'one','sha256':'a'*64},{'jobId':'two','sha256':'b'*64}],
                       'createdBy':'preserve this metadata'}

    def prepare(self,manifest=None,**overrides):
        raw=json.dumps(manifest or self.manifest).encode()
        args=dict(source_sha256=hashlib.sha256(raw).hexdigest(),source_queue=self.source_queue,
                  native_queue=self.native_queue,job_hashes={'one':'a'*64,'two':'b'*64})
        args.update(overrides)
        return self.subject.prepare(raw,**args)

    def test_only_queue_location_changes_and_all_frozen_identities_survive(self):
        original=json.dumps(self.manifest,sort_keys=True)
        result,proof=self.prepare()
        decoded=json.loads(result)
        self.assertEqual(decoded,{**self.manifest,'queueDirectory':self.native_queue})
        self.assertEqual(json.dumps(self.manifest,sort_keys=True),original)
        self.assertEqual(proof['held_jobs'],2)
        self.assertTrue(proof['held_entries_unchanged'])
        self.assertEqual(proof['native_sha256'],hashlib.sha256(result).hexdigest())

    def test_changed_source_or_held_payload_refuses_preparation(self):
        with self.assertRaisesRegex(ValueError,'source hash'):
            self.prepare(source_sha256='0'*64)
        for hashes in ({'one':'a'*64},{'one':'a'*64,'two':'c'*64}):
            with self.subTest(hashes=hashes), self.assertRaisesRegex(ValueError,'held payload'):
                self.prepare(job_hashes=hashes)

    def test_duplicate_job_and_invalid_cutoff_are_refused(self):
        for changes in ({'entries':[self.manifest['entries'][0]]*2},
                        {'freezeBefore':'2026-10-24T03:00:57Z'},
                        {'freezeBefore':'not-a-date'}):
            with self.subTest(changes=changes),self.assertRaises(ValueError):
                self.prepare({**self.manifest,**changes})

    def test_unexpected_source_queue_and_unsafe_native_path_are_refused(self):
        with self.assertRaisesRegex(ValueError,'source queue'):
            self.prepare(source_queue='C:/different/queue/hermes-gateway')
        for destination in ('relative/queue','C:/still-windows/queue','/Users/operator/../other/queue'):
            with self.subTest(destination=destination),self.assertRaisesRegex(ValueError,'native queue'):
                self.prepare(native_queue=destination)

    def test_windows_case_and_slashes_are_compared_without_rewriting_metadata(self):
        changed={**self.manifest,'queueDirectory':self.source_queue.replace('/','\\').upper()}
        output,_=self.prepare(changed)
        self.assertEqual(json.loads(output)['entries'],self.manifest['entries'])


if __name__=='__main__':unittest.main()
