"""Byte-cache acceleration never changes closed Windows byte authority."""
import copy
import hashlib
import importlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts/windows'))
try:delta=importlib.import_module('migration_delta_stream')
except ImportError:delta=None
sha=lambda b:hashlib.sha256(b).hexdigest()


class DeltaTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(delta,'lossless closed-source delta transport required')
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();self.source=self.root/'source';self.source.mkdir()
        self.cache=self.root/'windows-byte-cache';self.cache.mkdir();self.chunk=65536
    def baseline(self,name,data,*,chunks=True):
        p=self.cache/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_bytes(data)
        r={'path':str(p),'bytes':len(data),'sha256':sha(data)}
        if chunks:r['chunks']=[sha(data[i:i+self.chunk]) for i in range(0,len(data),self.chunk)]
        return r
    def catalog(self,entries):return {'schema':'village-windows-byte-cache-catalog/v1','byte_cache_only':True,'source_closed':False,'chunk_bytes':self.chunk,'entries':entries}
    def roundtrip(self,catalog):
        payload=io.BytesIO();m=delta.build_archive([{'name':'root-profile','source':str(self.source),'exclude_relative_dirs':[],'exclude_relative_files':[]}],catalog,payload)
        payload.seek(0);out=self.root/'closed-output';r=delta.receive_archive(payload,out,catalog,allowed_roots=[self.cache],require_inactive=False)
        return m,r,out
    def test_one_changed_block_and_append_preserve_all_exact_bytes_and_nanosecond_time(self):
        old=b'a'*self.chunk+b'b'*self.chunk+b'c'*self.chunk
        base=self.baseline('state.db',old);new=b'a'*self.chunk+b'x'*self.chunk+b'c'*self.chunk+b'TAIL'
        p=self.source/'state.db';p.write_bytes(new);stamp=1700000000123456700;os.utime(p,ns=(stamp,stamp))
        plan=delta.file_plan(p,base,self.chunk)
        self.assertEqual(plan['mode'],'delta');self.assertEqual([r['index'] for r in plan['blocks']],[1,3])
        prior=(self.cache/'state.db').stat().st_mtime_ns
        m,r,out=self.roundtrip(self.catalog({'root-profile/state.db':base}))
        self.assertEqual((out/'root-profile/state.db').read_bytes(),new)
        self.assertEqual((out/'root-profile/state.db').stat().st_mtime_ns,stamp)
        self.assertEqual((self.cache/'state.db').read_bytes(),old);self.assertEqual((self.cache/'state.db').stat().st_mtime_ns,prior)
        self.assertEqual(r['verified_bytes'],len(new));self.assertFalse(r['production_enabled'])
        self.assertEqual(r['transferred_payload_bytes'],self.chunk+4)
    def test_unchanged_files_are_reused_without_payload_and_deleted_paths_never_reappear(self):
        old=b'cached';base=self.baseline('keep',old,chunks=False);removed=self.baseline('deleted',b'DO NOT RESTORE',chunks=False)
        (self.source/'keep').write_bytes(old);(self.source/'empty').mkdir();(self.source/'zero').write_bytes(b'')
        _,r,out=self.roundtrip(self.catalog({'root-profile/keep':base,'root-profile/deleted':removed}))
        self.assertEqual(r['transferred_payload_bytes'],0);self.assertFalse((out/'root-profile/deleted').exists())
        self.assertTrue((out/'root-profile/empty').is_dir());self.assertEqual((out/'root-profile/zero').read_bytes(),b'')
    def test_shrinking_file_truncates_the_clone_to_the_current_source(self):
        base=self.baseline('long',b'a'*self.chunk+b'b'*self.chunk)
        (self.source/'long').write_bytes(b'a'*10)
        _,_,out=self.roundtrip(self.catalog({'root-profile/long':base}))
        self.assertEqual((out/'root-profile/long').read_bytes(),b'a'*10)
    @unittest.skipUnless(sys.platform=='darwin','actual APFS clonefile contract')
    def test_native_delta_uses_copy_on_write_without_copying_or_mutating_the_baseline(self):
        original=b'a'*self.chunk+b'b'*self.chunk
        base=self.baseline('state.db',original);(self.source/'state.db').write_bytes(b'a'*self.chunk+b'latest')
        with patch.object(delta.shutil,'copyfileobj',side_effect=AssertionError('unexpected full copy fallback')):
            _,_,out=self.roundtrip(self.catalog({'root-profile/state.db':base}))
        self.assertEqual((out/'root-profile/state.db').read_bytes(),b'a'*self.chunk+b'latest')
        self.assertEqual((self.cache/'state.db').read_bytes(),original)
    def test_changed_whole_file_without_block_index_is_transferred_as_current_source(self):
        base=self.baseline('document',b'old',chunks=False);(self.source/'document').write_bytes(b'LATEST')
        _,r,out=self.roundtrip(self.catalog({'root-profile/document':base}))
        self.assertEqual((out/'root-profile/document').read_bytes(),b'LATEST');self.assertEqual(r['transferred_payload_bytes'],6)
    def test_a_changed_or_wrong_baseline_cannot_create_a_verified_reconstruction(self):
        base=self.baseline('state.db',b'a'*self.chunk);(self.source/'state.db').write_bytes(b'a'*self.chunk)
        catalog=self.catalog({'root-profile/state.db':base});payload=io.BytesIO();delta.build_archive([{'name':'root-profile','source':str(self.source)}],catalog,payload)
        (self.cache/'state.db').write_bytes(b'z'*self.chunk);payload.seek(0)
        with self.assertRaises(ValueError):delta.receive_archive(payload,self.root/'out',catalog,allowed_roots=[self.cache],require_inactive=False)
        self.assertFalse((self.root/'out/VERIFIED.json').exists())
    def test_catalog_references_cannot_read_incumbent_or_escape_allowed_windows_snapshots(self):
        base=self.baseline('keep',b'a');catalog=self.catalog({'root-profile/keep':base})
        for altered in ({**base,'path':str(self.root/'incumbent-private')},{**base,'sha256':'bad'},{**base,'chunks':[]}):
            with self.assertRaises(ValueError):delta.validate_catalog(self.catalog({'root-profile/keep':altered}),[self.cache])
        bad=copy.deepcopy(catalog);bad['entries']['../escape']=bad['entries'].pop('root-profile/keep')
        with self.assertRaises(ValueError):delta.validate_catalog(bad,[self.cache])
    def test_partial_or_extra_archive_members_cannot_publish_success(self):
        (self.source/'new').write_bytes(b'latest');catalog=self.catalog({});payload=io.BytesIO()
        delta.build_archive([{'name':'root-profile','source':str(self.source)}],catalog,payload)
        raw=payload.getvalue()
        with self.assertRaises((ValueError,EOFError,OSError,tarfile.TarError)):
            delta.receive_archive(io.BytesIO(raw[:len(raw)//2]),self.root/'out',catalog,allowed_roots=[self.cache],require_inactive=False)
        self.assertFalse((self.root/'out/VERIFIED.json').exists())


if __name__=='__main__':unittest.main()
