"""Build only a new offline profile from latest Windows raw state.

Latest learning and uncertain receipts always win unless an exact hash-bound
native OS adaptation/control is declared. No existing profile is overwritten.
Process ownership and this migration's proven drain are omitted only from the
new execution copy; complete source bytes remain in the raw restoration.
"""
from pathlib import Path,PurePosixPath
import json,math,os,re,shutil
from migration_streamed_restore import digest

OWNER_FILES={'gateway.pid','gateway.lock','gateway_state.json',
             '.gateway-planned-stop.json','processes.json'}


def relative(value):
    p=PurePosixPath(value) if isinstance(value,str) else None
    if (p is None or not value or '\\' in value or '\0' in value or p.is_absolute()
            or '..' in p.parts or '.' in p.parts or re.match(r'^[a-zA-Z]:',value) or str(p)!=value):
        raise ValueError('unsafe_relative_profile_path')
    return value


def inventory(root):
    files={};directories=[]
    for p in root.rglob('*'):
        if p.is_symlink():raise ValueError('linked_raw_profile_payload')
        name=p.relative_to(root).as_posix();relative(name)
        if p.is_dir():directories.append(name)
        elif p.is_file():files[name]=p
        else:raise ValueError('special_profile_payload')
    return files,directories


def build(raw,native,output,*,overrides,controls,canonical,native_only,excluded,owned_controls,allowed_root):
    raw,native,output,root=(Path(p).resolve() for p in (raw,native,output,allowed_root))
    if (output.exists() or not raw.is_dir() or not native.is_dir()
            or not (root/'MIGRATION-INACTIVE').is_file() or (root/'ACTIVATION.json').exists()
            or not all(p.is_relative_to(root) for p in (raw,native,output))
            or any(output==p or output.is_relative_to(p) or p.is_relative_to(output) for p in (raw,native))):
        raise ValueError('separate_new_inactive_profile_required')
    # The cold-capture layer already excludes reviewed caches. Do not allow a
    # later assembly policy to silently omit additional operational content.
    if excluded or set(owned_controls)-{'.drain_request.json'}:
        raise ValueError('unreviewed_profile_omission')
    for name in [*overrides,*controls,*canonical,*owned_controls]:relative(name)
    if set(overrides)&set(controls) or (set(overrides)|set(controls))&set(canonical):
        raise ValueError('conflicting_native_replacements')
    files,directories=inventory(raw);omitted={}
    drain=files.get('.drain_request.json')
    if drain is not None or owned_controls:
        binding=owned_controls.get('.drain_request.json',{});owner=binding.get('owner',{})
        if (drain is None or digest(drain)!=binding.get('sha256')
                or type(owner.get('pid')) is not int or owner['pid']<=0
                or type(owner.get('started')) not in (int,float) or not math.isfinite(owner['started'])
                or owner['started']<=0 or not isinstance(binding.get('migration_id'),str) or not binding['migration_id']):
            raise ValueError('unowned_drain_preserved')
        body=json.loads(drain.read_text(encoding='utf-8'))
        if (body.get('action')!='drain' or body.get('owner')!=owner
                or body.get('migration_id')!=binding['migration_id']
                or body.get('principal')!='village-studio-migration:'+binding['migration_id']):
            raise ValueError('unowned_drain_preserved')
        omitted['.drain_request.json']=binding['sha256']
    selected={};policies={}
    for name,p in files.items():
        if name in OWNER_FILES or name in omitted or name=='gateway-locks' or name.startswith('gateway-locks/'):continue
        if any(name in (db+'-wal',db+'-shm') for db in canonical):continue
        with p.open('rb') as f:header=f.read(16)
        empty_journal=False
        if (name.endswith(('.db-journal','.sqlite-journal','.sqlite3-journal')) or any(name==db+'-journal' for db in canonical)):
            parent=name[:-len('-journal')];database=files.get(parent)
            if p.stat().st_size!=0 or parent not in canonical or database is None:
                raise ValueError('rollback_journal_requires_adjudication')
            with database.open('rb') as f:signature=f.read(16)
            if signature!=b'SQLite format 3\0':raise ValueError('rollback_journal_requires_adjudication')
            # A zero-byte journal contains no rollback records. Retain the
            # exact empty file, paired only with a verified canonical DB.
            empty_journal=True
        if (header==b'SQLite format 3\0' or name.endswith(('.db','.sqlite'))) and name not in canonical:
            raise ValueError('unclassified_sqlite_database')
        selected[name]=p;policies[name]='verified_empty_sqlite_journal' if empty_journal else 'latest_raw'
    for name,binding in overrides.items():
        p=native/name
        if (name not in selected or digest(files[name])!=binding['source_sha256'] or p.is_symlink()
                or not p.resolve().is_relative_to(native) or digest(p)!=binding['native_sha256']):
            raise ValueError('source_or_native_adaptation_changed')
        selected[name]=p;policies[name]='verified_native_adaptation'
    for kind,rows in (('prepared_control',controls),('canonical_database',canonical)):
        for name,binding in rows.items():
            original=Path(binding['path']);p=original.resolve()
            adding=kind=='prepared_control' and binding.get('source_absent') is True
            if (name in OWNER_FILES or name in omitted or name=='.drain_request.json'
                    or name=='gateway-locks' or name.startswith('gateway-locks/')
                    or (adding and (name in files or 'source_sha256' in binding))
                    or (name not in selected and not adding) or not p.is_relative_to(root)
                    or original.is_symlink() or digest(p)!=binding['sha256']):
                raise ValueError('invalid_prepared_replacement')
            if kind=='prepared_control' and not adding and digest(files[name])!=binding['source_sha256']:
                raise ValueError('source_configuration_changed')
            selected[name]=p;policies[name]=kind
    for binding in native_only:
        name=relative(binding['path']);p=native/name
        if (name in files or name in selected or name in OWNER_FILES or name=='.drain_request.json'
                or name=='gateway-locks' or name.startswith('gateway-locks/') or p.is_symlink()
                or not p.resolve().is_relative_to(native) or digest(p)!=binding['sha256']):
            raise ValueError('invalid_native_only_addition')
        selected[name]=p;policies[name]='verified_native_only'
    hashes={name:digest(p) for name,p in selected.items()}
    wanted_dirs={name for name in directories if name!='gateway-locks' and not name.startswith('gateway-locks/')}
    for name in selected:
        wanted_dirs.update(p.as_posix() for p in PurePosixPath(name).parents if p.as_posix()!='.')
    output.mkdir(parents=True,mode=0o700)
    for name in directories:
        if name!='gateway-locks' and not name.startswith('gateway-locks/'):
            (output/name).mkdir(parents=True,exist_ok=True,mode=0o700)
    for name,p in selected.items():
        target=output/name;target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        shutil.copy2(p,target);target.chmod(0o700 if p.stat().st_mode&0o111 else 0o600)
        if name in files and policies[name] in ('verified_native_adaptation','prepared_control'):
            stamp=files[name].stat();os.utime(target,ns=(stamp.st_atime_ns,stamp.st_mtime_ns))
        with target.open('rb+') as f:f.flush();os.fsync(f.fileno())
        if digest(target)!=hashes[name] or digest(p)!=hashes[name]:raise ValueError('offline_profile_payload_changed')
    if (root/'ACTIVATION.json').exists() or not (root/'MIGRATION-INACTIVE').is_file():
        raise ValueError('native_activation_changed_during_profile_copy')
    actual_files,actual_dirs=inventory(output)
    if set(actual_files)!=set(hashes) or set(actual_dirs)!=wanted_dirs:
        raise ValueError('offline_profile_inventory_changed')
    if os.name=='posix':
        for directory in sorted([output]+[p for p in output.rglob('*') if p.is_dir()],key=lambda p:len(p.parts),reverse=True):
            fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(fd)
            finally:os.close(fd)
    return {'files':len(selected),'policies':policies,'sha256':hashes,'raw_preserved':True,
            'directories':sorted(wanted_dirs),'omitted_owned_controls':omitted,'promoted':False,'activated':False}
