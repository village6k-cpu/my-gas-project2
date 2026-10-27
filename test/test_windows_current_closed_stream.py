from pathlib import Path
import json
import sys
import tempfile
from types import SimpleNamespace
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/windows'))
import migration_closed_stream as m


class StreamTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.base=Path(self.temp.name);self.control=self.base/'control';self.control.mkdir()
        self.roots=[]
        for name in m.closed.NAMES:
            p=self.base/name;p.mkdir();(p/'payload').write_bytes(b'current')
            self.roots.append({'name':name,'source':str(p),'excluded':[]})
        self.destination='/Users/choijaehyeong/VillageMigration/20260930-windows/snapshots/current-final-closed-fixture'
        self.calls=0;self.transport_calls=0;self.fail_gate=None;self.mutation=None
        self.trees=SimpleNamespace(inventory=lambda *a:({'payload':(7,100)},['.']))
        self.transport=SimpleNamespace(__file__='fixture-transfer.py',
           SUPPORTS_EXACT_RELATIVE_EXCLUSIONS=True,main=self.send)

    def gate(self):
        self.calls+=1
        if self.calls==self.fail_gate:raise RuntimeError('source fence changed')
        return {'intent_sha256':'a'*64,'stop_sha256':'b'*64,
                'all_five_owners_absent':True,'scheduled_writers_absent':True}

    def send(self):
        self.transport_calls+=1
        config=Path(sys.argv[1]);cfg=json.loads(config.read_text())
        files=[{'path':r['name']+'/payload','bytes':7,'sha256':'c'*64} for r in cfg['roots']]
        manifest={'files':files,'directories':[r['name'] for r in cfg['roots']],
                  'errors':[],'changed_during_read':[]}
        if self.mutation:self.mutation(manifest)
        config.with_suffix('.manifest.json').write_text(json.dumps(manifest))
        config.with_suffix('.ssh-out').write_text(json.dumps({'destination':cfg['destination'],
            'production_enabled':False,'verified_files':len(manifest['files']),
            'verified_directories':len(manifest['directories']),
            'verified_bytes':sum(x['bytes'] for x in manifest['files'])}))

    def run_stream(self):
        return m.stream(self.roots,self.destination,self.control,self.gate,self.trees,self.transport,['fixture-ssh'])

    def test_closed_source_stream_records_no_local_full_copy(self):
        result=self.run_stream()
        self.assertTrue(result['cold_capture_verified'])
        self.assertFalse(result['local_full_payload_copy'])
        self.assertTrue((self.control/'closed-stream-v1/COLD-VERIFIED.json').is_file())
        self.assertEqual(self.calls,3)
        self.assertFalse((self.control/'closed-stream-v1/root-profile').exists())

    def test_no_transport_before_fresh_cold_gate(self):
        self.fail_gate=1
        with self.assertRaises(RuntimeError):self.run_stream()
        self.assertEqual(self.transport_calls,0)
        self.assertFalse((self.control/'closed-stream-v1').exists())

    def test_failed_post_transfer_gate_never_publishes_cold_proof(self):
        self.fail_gate=3
        with self.assertRaises(RuntimeError):self.run_stream()
        self.assertEqual(self.transport_calls,1)
        self.assertFalse((self.control/'closed-stream-v1/COLD-VERIFIED.json').exists())
        self.assertTrue((self.control/'closed-stream-v1/PARTIAL.json').is_file())

    def test_receiver_self_consistent_omission_still_fails_source_inventory(self):
        self.mutation=lambda manifest:manifest['files'].pop()
        with self.assertRaises(ValueError):self.run_stream()
        self.assertFalse((self.control/'closed-stream-v1/COLD-VERIFIED.json').exists())

    def test_source_tree_change_after_stream_blocks_proof(self):
        self.mutation=lambda _:setattr(self.trees,'inventory',lambda *a:({'payload':(8,200)},['.']))
        with self.assertRaisesRegex(ValueError,'source_tree_changed'):self.run_stream()

    def test_legacy_basename_exclusions_are_not_accepted(self):
        self.transport.SUPPORTS_EXACT_RELATIVE_EXCLUSIONS=False
        with self.assertRaises(ValueError):self.run_stream()
        self.assertEqual(self.transport_calls,0)

    def test_changed_files_or_missing_hash_blocks_proof(self):
        self.mutation=lambda manifest:manifest['changed_during_read'].append('root-profile/payload')
        with self.assertRaises(ValueError):self.run_stream()


if __name__=='__main__':unittest.main()
