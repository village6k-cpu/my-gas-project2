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
import os
import shutil
import sqlite3
import struct
from contextlib import closing


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
        if 'mtime_ns' in row and (type(row['mtime_ns']) is not int
                or (snapshot/name).stat().st_mtime_ns!=row['mtime_ns']):
            raise ValueError('raw_payload_modified_time_changed')
        size+=row['bytes']
    totals={'verified_files':len(files),'verified_directories':len(dirs),'verified_bytes':size}
    transport=json.loads((snapshot/'VERIFIED.json').read_text(encoding='utf-8'))
    if (transport.get('production_enabled') is not False or transport.get('destination')!=str(snapshot)
            or any(type(cold.get(k)) is not int or cold[k]!=v or transport.get(k)!=v for k,v in totals.items())):
        raise ValueError('cold_or_transport_readback_totals_differ')
    return dict(totals,schema='village-current-streamed-raw-readback/v1',raw_verified=True,
                provenance_sha256=dict(pins),transport_manifest_sha256=cold['transport_manifest_sha256'],
                canonicalized=False,promoted=False,activated=False,business_completion_verified=False)


def validate_sqlite_wal(raw,wal):
    """Account for every retained frame before SQLite can silently discard one.

    SQLite fileformat2 sections4.1/4.2 define the endian-aware rolling sums.
    This strict cold-restoration contract rejects stale, torn or uncommitted
    tails rather than deciding that unverified operational bytes are obsolete.
    Raw bytes remain available for an explicit independent adjudication.
    """
    if not wal.exists() or wal.stat().st_size==0:return {'frames':0,'commits':0}
    with raw.open('rb') as f:main=f.read(100)
    with wal.open('rb') as f:
        header=f.read(32)
        if len(header)!=32:raise ValueError('wal_header_truncated')
        magic,version,page_size,_,salt1,salt2,c0,c1=struct.unpack('>8I',header)
        db_page=int.from_bytes(main[16:18],'big');db_page=65536 if db_page==1 else db_page
        if (magic not in (0x377f0682,0x377f0683) or version!=3007000
                or page_size!=db_page or page_size<512 or page_size>65536 or page_size&(page_size-1)):
            raise ValueError('wal_header_invalid_or_page_size_differs')
        endian='<' if magic==0x377f0682 else '>'
        def checksum(data,seed=(0,0)):
            a,b=seed
            for x,y in struct.iter_unpack(endian+'II',data):
                a=(a+x+b)&0xffffffff;b=(b+y+a)&0xffffffff
            return a,b
        state=checksum(header[:24])
        if state!=(c0,c1):raise ValueError('wal_header_checksum_failed')
        frames=commits=last_commit=database_pages=0
        while True:
            frame=f.read(24+page_size)
            if not frame:break
            if len(frame)!=24+page_size:raise ValueError('wal_frame_truncated')
            page,db_size,s1,s2,x,y=struct.unpack('>6I',frame[:24])
            if page==0 or page>0xfffffffe or (s1,s2)!=(salt1,salt2):
                raise ValueError('wal_stale_or_invalid_frame_requires_adjudication')
            state=checksum(frame[:8]+frame[24:],state)
            if state!=(x,y):raise ValueError('wal_frame_checksum_failed')
            frames+=1
            if db_size:
                if db_size>0xfffffffe:raise ValueError('wal_commit_size_invalid')
                commits+=1;last_commit=frames;database_pages=db_size
        if frames!=last_commit:raise ValueError('wal_uncommitted_tail_requires_adjudication')
    return {'frames':frames,'commits':commits,'database_pages':database_pages,
            'all_retained_frames_verified':True}


def canonicalize_sqlite(raw,output,main_sha,wal_sha,allowed_root):
    """Recover only a new SQLite clone; never open or repair the raw database."""
    raw,output,allowed_root=(Path(p).resolve() for p in (raw,output,allowed_root))
    if (not output.is_relative_to(allowed_root) or output==raw or output.exists()
            or any(Path(str(output)+s).exists() for s in ('-wal','-shm'))
            or (allowed_root/'ACTIVATION.json').exists()):raise ValueError('new_inactive_sqlite_clone_required')
    wal=Path(str(raw)+'-wal')
    if digest(raw)!=main_sha or (wal.exists() and digest(wal)!=wal_sha) or (not wal.exists() and wal_sha is not None):
        raise ValueError('raw_sqlite_pair_changed')
    wal_evidence=validate_sqlite_wal(raw,wal)
    journal=Path(str(raw)+'-journal')
    if journal.exists() and journal.stat().st_size:
        raise ValueError('retained_rollback_journal_requires_adjudication')
    output.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    for source,target in [(raw,output)]+([(wal,Path(str(output)+'-wal'))] if wal.exists() else []):
        with source.open('rb') as src,target.open('xb') as dst:
            shutil.copyfileobj(src,dst,1024*1024);dst.flush();os.fsync(dst.fileno())
        target.chmod(0o600)
    with closing(sqlite3.connect(output.as_uri()+'?mode=rw',uri=True)) as db:
        if db.execute('PRAGMA integrity_check').fetchall()!=[('ok',)]:raise ValueError('closed_clone_integrity_failed')
        tables=[r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        def counts():return {n:db.execute('SELECT count(*) FROM "'+n.replace('"','""')+'"').fetchone()[0] for n in tables}
        before=counts()
        if db.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()[0]!=0:raise ValueError('clone_checkpoint_busy')
        if db.execute('PRAGMA journal_mode=DELETE').fetchone()[0]!='delete':raise ValueError('canonical_journal_failed')
        if counts()!=before or db.execute('PRAGMA integrity_check').fetchall()!=[('ok',)]:raise ValueError('canonical_clone_changed_rows')
    with output.open('rb+') as f:f.flush();os.fsync(f.fileno())
    if (digest(raw)!=main_sha or (wal.exists() and digest(wal)!=wal_sha)
            or (Path(str(output)+'-wal').exists() and Path(str(output)+'-wal').stat().st_size)):
        raise ValueError('raw_pair_changed_or_canonical_wal_remains')
    return {'raw_sha256':main_sha,'raw_wal_sha256':wal_sha,'canonical_sha256':digest(output),
            'counts':before,'integrity':'ok','wal':wal_evidence,'raw_bytes_preserved':True,'promoted':False}


def restore_snapshot(snapshot,provenance,pins,output,candidate,*,is_inactive):
    """Offline reconstruction only; is_inactive must freshly check all16 owners.

    This does not prove current Windows writer closure or authorize promotion.
    New raw copies retain file modification times. SQLite recovery/checkpointing
    happens exclusively in new clones; GBrain raw payloads remain untouched.
    """
    snapshot,provenance=Path(snapshot).absolute(),Path(provenance).absolute()
    candidate=Path(candidate).resolve();output=Path(output).resolve()
    if (not output.is_relative_to(candidate) or output==candidate or output.exists()
            or any(output==p or output.is_relative_to(p) or p.is_relative_to(output) for p in (snapshot.resolve(),provenance.resolve()))):
        raise ValueError('separate_new_restoration_required')
    def gate():
        if (not (candidate/'MIGRATION-INACTIVE').is_file() or (candidate/'ACTIVATION.json').exists()
                or is_inactive() is not True):raise ValueError('all_native_business_owners_must_remain_inactive')
    gate();verified=verify_snapshot(snapshot,provenance,pins)
    if shutil.disk_usage(candidate).free<verified['verified_bytes']*2+1024**3:
        raise ValueError('insufficient_native_restoration_reserve')
    manifest=json.loads((snapshot/'MANIFEST.json').read_text(encoding='utf-8'))
    rows={r['path']:r for r in manifest['files']};names=set(expected_sources(bound(provenance/'intent.json',pins['intent'])))
    output.mkdir(mode=0o700);raw=output/'raw';raw.mkdir(mode=0o700)
    report={'schema':'village-current-full-stream-restoration/v1','complete':False,'promoted':False,'activated':False,
            'provenance_sha256':dict(pins),'transport_manifest_sha256':verified['transport_manifest_sha256'],
            'raw':{},'canonical':{},'gbrain_raw_preserved':False,'gbrain_logical_validation_pending':True,
            'current_source_closure_verified':False,'business_completion_verified':False}
    try:
        for name in sorted(names):
            gate();shutil.copytree(snapshot/name,raw/name,copy_function=shutil.copy2)
            selected={p:r for p,r in rows.items() if p.startswith(name+'/')}
            for path,row in selected.items():
                target=raw/path;target.chmod(0o600)
                with target.open('rb+') as f:f.flush();os.fsync(f.fileno())
                if (digest(target)!=row['sha256'] or target.stat().st_size!=row['bytes']
                        or ('mtime_ns' in row and target.stat().st_mtime_ns!=row['mtime_ns'])):
                    raise ValueError('restored_raw_payload_differs')
            actual_files={p.relative_to(raw).as_posix() for p in (raw/name).rglob('*') if p.is_file()}
            actual_dirs={name}|{p.relative_to(raw).as_posix() for p in (raw/name).rglob('*') if p.is_dir()}
            wanted_dirs={p for p in manifest['directories'] if p==name or p.startswith(name+'/')}
            if actual_files!=set(selected) or actual_dirs!=wanted_dirs:raise ValueError('restored_raw_paths_differ')
            report['raw'][name]={'verified_files':len(selected),'verified_directories':len(actual_dirs),
                                 'verified_bytes':sum(r['bytes'] for r in selected.values())}
        discovered={}
        for path,row in rows.items():
            with (raw/path).open('rb') as f:header=f.read(16)
            if header==b'SQLite format 3\x00':
                if path.split('/')[0] not in ('root-profile','worker-profile'):
                    raise ValueError('unmapped_sqlite_database_requires_explicit_restoration_contract')
                discovered[path]=row
        report['sqlite_discovered']=sorted(discovered)
        for role in ('root','worker'):
            prefix=role+'-profile/'
            databases={p[len(prefix):]:r for p,r in discovered.items() if p.startswith(prefix)}
            required={'state.db','projects.db','verification_evidence.db','cron/executions.db'}
            if role=='root':required|={'kanban.db','cron/slack-heybilli-ai-gate.db'}
            if not required.issubset(databases):raise ValueError('operational_sqlite_database_missing')
            report['canonical'][role]={}
            for relative,row in sorted(databases.items()):
                gate();path=prefix+relative
                report['canonical'][role][relative]=canonicalize_sqlite(raw/path,output/'canonical'/role/relative,
                    row['sha256'],rows.get(path+'-wal',{}).get('sha256'),candidate)
        # Read raw bytes again after SQLite recovery to prove no raw WAL/main
        # or other retained payload was changed by the clone operations.
        for path,row in rows.items():
            if digest(raw/path)!=row['sha256']:raise ValueError('raw_payload_changed_during_restoration')
        verify_snapshot(snapshot,provenance,pins);gate()
        if os.name=='posix':
            for directory in sorted([output]+[p for p in output.rglob('*') if p.is_dir()],key=lambda p:len(p.parts),reverse=True):
                directory.chmod(0o700);fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
                try:os.fsync(fd)
                finally:os.close(fd)
        report.update(complete=True,gbrain_raw_preserved=True)
        pending=output/'RESTORATION.pending.json'
        with pending.open('x',encoding='utf-8') as f:json.dump(report,f,indent=2);f.flush();os.fsync(f.fileno())
        os.rename(pending,output/'RESTORATION.json')
        if os.name=='posix':
            fd=os.open(output,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(fd)
            finally:os.close(fd)
        return report
    except BaseException:
        report['complete']=False
        try:
            with (output/'RESTORATION.partial.json').open('x',encoding='utf-8') as f:
                json.dump(report,f,indent=2);f.flush();os.fsync(f.fileno())
        except OSError:pass
        raise
