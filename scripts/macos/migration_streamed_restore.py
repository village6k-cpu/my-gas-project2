"""Verify current full-byte cold streams, never infer closure from transport.

No source stop, recovery, profile promotion, activation or business replay occurs
on import or verification. Caller-supplied hashes must come from the actual
Windows stop/capture controller. Offline verification is not current authority.
"""
import hashlib
import importlib.util
import json
import math
import ntpath
from pathlib import Path,PurePosixPath
import re


def digest(path):
    result=hashlib.sha256()
    with Path(path).open('rb') as stream:
        for data in iter(lambda:stream.read(1024*1024),b''):result.update(data)
    return result.hexdigest()


def capture_rules():
    # The shared validator is pure; platform-specific execution is behind main.
    p=Path(__file__).resolve().parents[1]/'windows/migration_closed_capture.py'
    spec=importlib.util.spec_from_file_location('closed_capture_rules',p)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def expected_sources(intent):
    roles={r['role']:r for r in intent['profiles']}
    if len(intent['profiles'])!=5 or set(roles)!={'root','worker','bridge','relay','voice'}:
        raise ValueError('exact_five_current_source_contracts_required')
    return {'root-profile':roles['root']['home'],'worker-profile':roles['worker']['home'],
        'bridge-queue':'C:/Village/runtimes/my-gas-project2-production/tools/kakao-dom-bridge/queue',
        'gbrain-db':'C:/Users/ssper/.gbrain/brain.pglite',
        'inventory-stock-alerts':'C:/Village/runtime/inventory-stock-alerts',
        'kakao-corrections':'C:/Users/ssper/AppData/Local/Village/kakao-corrections'}


def bound(path,pin):
    if (not isinstance(pin,str) or not re.fullmatch('[a-f0-9]{64}',pin)
            or path.is_symlink() or digest(path)!=pin):
        raise ValueError('provenance_hash_or_identity_changed')
    return json.loads(path.read_text(encoding='utf-8-sig'))


def finite(value):return type(value) in (int,float) and math.isfinite(value)


def relative(name):
    if (not isinstance(name,str) or not name or '\\' in name or '\0' in name
            or PurePosixPath(name).is_absolute() or any(x in ('','..','.') for x in name.split('/'))):
        raise ValueError('noncanonical_manifest_path')
    return name


def verify_snapshot(snapshot,provenance,pins):
    snapshot,provenance=Path(snapshot).absolute(),Path(provenance).absolute()
    if snapshot.is_symlink() or provenance.is_symlink():raise ValueError('linked_snapshot_or_provenance')
    if set(pins)!={'cold','intent','stop','work'}:raise ValueError('exact_current_provenance_pins_required')
    docs={k:bound(provenance/(k+'.json'),v) for k,v in pins.items()}
    cold,intent,stop,work=(docs[k] for k in ('cold','intent','stop','work'))
    if (cold.get('schema')!='village-current-closed-stream/v1'
            or cold.get('payload_transferred') is not True or cold.get('cold_capture_verified') is not True
            or cold.get('production_activated') is not False or cold.get('local_full_payload_copy') is not False
            or cold.get('destination')!=str(snapshot)
            or stop.get('schema')!=1 or stop.get('intent_sha256')!=pins['intent']
            or not finite(stop.get('stopped_at')) or stop['stopped_at']<=0):
        raise ValueError('actual_bound_cold_stream_required')
    sources=expected_sources(intent);owners={r['role']:r for r in intent['profiles']}
    rows=stop.get('profiles',[])
    if len(rows)!=5 or {r.get('role') for r in rows}!=set(owners):
        raise ValueError('complete_source_stop_required')
    for row in rows:
        old=owners[row['role']]
        if (row.get('status')!='stopped' or row.get('children_inventory_complete') is not True
                or not isinstance(row.get('children'),list) or row.get('pid')!=old['pid']
                or not finite(row.get('started')) or abs(row['started']-old['started'])>=.01
                or row['started']>=stop['stopped_at']):
            raise ValueError('stopped_exact_source_owner_required')
        children=row['children']
        if (any(type(c.get('pid')) is not int or c['pid']<=0 or not finite(c.get('started'))
                or not 0<c['started']<stop['stopped_at'] for c in children)
                or len({c['pid'] for c in children})!=len(children)):
            raise ValueError('complete_bound_child_inventory_required')
    rules=capture_rules();rules.validate_work_closure(work,stop,intent,pins['work'])
    times=[stop['stopped_at'],cold.get('started_unix')]
    for stage in ('before','after'):
        gate=cold.get(stage,{})
        if (gate.get('intent_sha256')!=pins['intent'] or gate.get('stop_sha256')!=pins['stop']
                or any(gate.get(k) is not True for k in ('all_five_owners_absent','scheduled_writers_absent',
                    'all_21_tasks_fenced','destination_inactive','owned_watcher_paused'))):
            raise ValueError('complete_bound_writer_closure_required')
        times.append(gate.get('checked_unix'))
    times.append(cold.get('finished_unix'))
    # The initial gate may precede started_unix by milliseconds.
    if (not all(finite(t) for t in times) or times[0]>min(times[1:])
            or times[2]>times[3] or max(times[1:4])>times[4]):
        raise ValueError('invalid_cold_capture_timeline')
    manifest=bound(snapshot/'MANIFEST.json',cold.get('transport_manifest_sha256'))
    if manifest.get('errors')!=[] or manifest.get('changed_during_read')!=[]:
        raise ValueError('incomplete_or_changed_transport')
    roots=manifest.get('source_roots',[])
    if len(roots)!=6 or {r.get('name') for r in roots}!=set(sources):
        raise ValueError('exact_six_current_trees_required')
    for root in roots:
        name=root['name']
        if ntpath.normcase(ntpath.normpath(root.get('source','')))!=ntpath.normcase(ntpath.normpath(sources[name])):
            raise ValueError('transport_is_not_current_windows_source')
        if any(k not in {'name','source','exclude_relative_dirs','exclude_relative_files'} for k in root):
            raise ValueError('unreviewed_transport_exclusion')
        omitted=root.get('exclude_relative_dirs',[])+root.get('exclude_relative_files',[])
        if not set(omitted).issubset(rules.SAFE_EXCLUSIONS[name]):
            raise ValueError('operational_state_excluded')
    rows=manifest.get('files',[]);directories=manifest.get('directories',[])
    files={relative(r['path']):r for r in rows};dirs={relative(x) for x in directories}
    if (len(files)!=len(rows) or len(dirs)!=len(directories) or set(files)&dirs
            or not set(sources).issubset(dirs)
            or any(p.split('/')[0] not in sources for p in set(files)|dirs)):
        raise ValueError('incomplete_duplicate_or_unknown_payload_paths')
    for name in set(files)|dirs:
        if '/' in name and str(PurePosixPath(name).parent) not in dirs:
            raise ValueError('manifest_parent_directory_missing')
    actual_files=set();actual_dirs=set()
    for p in snapshot.rglob('*'):
        if p.is_symlink():raise ValueError('linked_raw_payload')
        name=p.relative_to(snapshot).as_posix()
        if p.is_dir():actual_dirs.add(name)
        elif p.is_file():actual_files.add(name)
        else:raise ValueError('special_raw_payload')
    if actual_files!=set(files)|{'MANIFEST.json','VERIFIED.json'} or actual_dirs!=dirs:
        raise ValueError('raw_payload_paths_differ')
    size=0
    for name,row in files.items():
        if (type(row.get('bytes')) is not int or row['bytes']<0
                or (snapshot/name).stat().st_size!=row['bytes'] or digest(snapshot/name)!=row.get('sha256')):
            raise ValueError('raw_payload_hash_or_size_changed')
        size+=row['bytes']
    totals={'verified_files':len(files),'verified_directories':len(dirs),'verified_bytes':size}
    transport=json.loads((snapshot/'VERIFIED.json').read_text(encoding='utf-8'))
    if (transport.get('production_enabled') is not False or transport.get('destination')!=str(snapshot)
            or any(type(cold.get(k)) is not int or cold[k]!=v or transport.get(k)!=v for k,v in totals.items())):
        raise ValueError('cold_or_transport_readback_totals_differ')
    return dict(totals,schema='village-current-streamed-raw-readback/v1',raw_verified=True,
                provenance_sha256=dict(pins),transport_manifest_sha256=cold['transport_manifest_sha256'],
                canonicalized=False,promoted=False,activated=False,business_completion_verified=False)
