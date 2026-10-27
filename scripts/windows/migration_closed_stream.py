"""Stream an independently closed source to an inactive, new Mac snapshot.

No full Windows payload copy, source stop, service launch, recovery or replay.
Transport VERIFIED alone is insufficient; COLD-VERIFIED binds source closure.
"""
import hashlib
import json
from pathlib import Path
import re
import shutil
import sys
import time

import migration_closed_capture as closed


def stream(roots, destination, control, gate, trees, transport, ssh):
    control=Path(control).resolve()
    local=control/'closed-stream-v1'
    closed.validate_roots(roots,local)
    if local.exists(): raise FileExistsError('immutable_stream_capture_exists')
    if not re.fullmatch(r'/Users/choijaehyeong/VillageMigration/20260930-windows/snapshots/current-final-closed-[a-z0-9-]+',destination):
        raise ValueError('unexpected_inactive_snapshot_destination')
    if getattr(transport,'SUPPORTS_EXACT_RELATIVE_EXCLUSIONS',False) is not True:
        raise ValueError('exact_exclusion_transport_required')
    if shutil.disk_usage(control).free < closed.MARGIN:
        raise ValueError('insufficient_metadata_and_log_reserve')
    before=closed.check_gate(gate())
    initial={};expected_files={};expected_dirs=set();transfer_roots=[]
    for row in roots:
        source=Path(row['source'])
        files,dirs=trees.inventory(source,frozenset(row['excluded']))
        initial[row['name']]=(files,dirs)
        for relative,info in files.items():expected_files[row['name']+'/'+relative]=info[0]
        for relative in dirs:expected_dirs.add(row['name'] if relative=='.' else row['name']+'/'+relative)
        omitted_dirs=[];omitted_files=[]
        for relative in row['excluded']:
            (omitted_dirs if (source/relative).is_dir() else omitted_files).append(relative)
        transfer_roots.append({'name':row['name'],'source':str(source),
            'exclude_relative_dirs':omitted_dirs,'exclude_relative_files':omitted_files})
    closed.check_gate(gate(),before)
    local.mkdir(mode=0o700)
    config=local/'transport.json'
    closed.save_new(config,{'ssh':ssh,'destination':destination,'roots':transfer_roots})
    report={'schema':'village-current-closed-stream/v1','before':before,
            'destination':destination,'started_unix':time.time(),
            'payload_transferred':False,'cold_capture_verified':False,
            'production_activated':False,'local_full_payload_copy':False}
    try:
        original=sys.argv
        try:
            sys.argv=[str(transport.__file__),str(config)]
            transport.main()
        finally:sys.argv=original
        raw=(local/'transport.manifest.json').read_bytes()
        manifest=json.loads(raw)
        if manifest.get('errors')!=[] or manifest.get('changed_during_read')!=[]:
            raise ValueError('source_changed_or_transport_incomplete')
        files=manifest.get('files',[])
        if (len(files)!=len(expected_files) or {r['path']:r['bytes'] for r in files}!=expected_files
                or len(manifest.get('directories',[]))!=len(expected_dirs)
                or set(manifest.get('directories',[]))!=expected_dirs):
            raise ValueError('transport_omitted_or_added_source_payload')
        for row in files:
            if not re.fullmatch('[a-f0-9]{64}',str(row.get('sha256',''))):
                raise ValueError('transport_payload_hash_missing')
        remote=json.loads((local/'transport.ssh-out').read_text())
        if (remote.get('destination')!=destination or remote.get('production_enabled') is not False
                or remote.get('verified_files')!=len(files)
                or remote.get('verified_directories')!=len(expected_dirs)
                or remote.get('verified_bytes')!=sum(expected_files.values())):
            raise ValueError('native_transport_readback_mismatch')
        report['payload_transferred']=True
        for row in roots:
            after=trees.inventory(row['source'],frozenset(row['excluded']))
            if after!=initial[row['name']]:raise ValueError('closed_source_tree_changed')
        report['after']=closed.check_gate(gate(),before)
        report.update(cold_capture_verified=True,finished_unix=time.time(),
            transport_manifest_sha256=hashlib.sha256(raw).hexdigest(),
            verified_files=len(files),verified_directories=len(expected_dirs),
            verified_bytes=sum(expected_files.values()))
        closed.publish_verified(local/'COLD-VERIFIED.json',report)
    except BaseException:
        report['cold_capture_verified']=False
        closed.save_new(local/'PARTIAL.json',report)
        raise
    return report
