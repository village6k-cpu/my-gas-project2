"""Lossless byte-cache acceleration for a separately proven closed source.

Windows remains authoritative. Cached Windows bytes on the Mac are only an
untrusted accelerator: every reconstructed file must match the final source SHA.
No canonicalization, SQLite opening, repair, activation or source stop occurs.
"""
import base64
import ctypes
import gzip
import hashlib
import io
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import time

SUPPORTS_EXACT_RELATIVE_EXCLUSIONS=True
SUPPORTS_FILE_MTIME_NS=True
SUPPORTS_WINDOWS_BYTE_CACHE=True
ROOTS={'root-profile','worker-profile','bridge-queue','gbrain-db','inventory-stock-alerts','kakao-corrections'}
NATIVE=Path('/Users/choijaehyeong/VillageMigration/20260930-windows')
DEFAULT_BASES=[NATIVE/'snapshots'/name for name in ('windows-live-byte-cache-20261028-v1',
              'root-sqlite-20261027-v1','worker-sqlite-20261027-v1')]
_SOURCE=Path(__file__).read_bytes() if globals().get('__file__') and Path(__file__).is_file() else b''


def sha(value):return hashlib.sha256(value).hexdigest()


def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()


def relative(value):
    p=PurePosixPath(value)
    if (not isinstance(value,str) or not value or '\\' in value or ':' in value or '\x00' in value
            or p.is_absolute() or '..' in p.parts or p.as_posix()!=value):raise ValueError('unsafe_relative_path')
    return p


def validate_catalog(catalog,allowed_roots=None):
    allowed=[Path(p).resolve() for p in (DEFAULT_BASES if allowed_roots is None else allowed_roots)]
    if (catalog.get('schema')!='village-windows-byte-cache-catalog/v1'
            or catalog.get('byte_cache_only') is not True or catalog.get('source_closed') is not False
            or catalog.get('chunk_bytes')!=65536 or not isinstance(catalog.get('entries'),dict)):
        raise ValueError('wrong_windows_byte_cache_catalog')
    for name,row in catalog['entries'].items():
        if relative(name).parts[0] not in ROOTS:raise ValueError('unexpected_retained_root')
        p=Path(row['path']);resolved=p.resolve()
        if (not any(resolved.is_relative_to(a) and resolved!=a for a in allowed)
                or os.path.normcase(os.path.abspath(p))!=os.path.normcase(str(resolved))
                or type(row.get('bytes')) is not int or row['bytes']<0
                or not re.fullmatch('[a-f0-9]{64}',row.get('sha256',''))):raise ValueError('unsafe_windows_byte_cache_reference')
        if 'chunks' in row and (not isinstance(row['chunks'],list)
                or len(row['chunks'])!=math.ceil(row['bytes']/catalog['chunk_bytes'])
                or any(not re.fullmatch('[a-f0-9]{64}',s) for s in row['chunks'])):
            raise ValueError('incomplete_baseline_block_index')


def file_plan(path,baseline=None,chunk_bytes=65536):
    path=Path(path);before=path.stat();h=hashlib.sha256();changed=[];i=0
    with path.open('rb') as f:
        while b:=f.read(chunk_bytes):
            pin=sha(b);h.update(b)
            if baseline and 'chunks' in baseline and (i>=len(baseline['chunks']) or baseline['chunks'][i]!=pin):
                changed.append({'index':i,'bytes':len(b),'sha256':pin})
            i+=1
    after=path.stat()
    if (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('source_file_changed_during_index')
    pin=h.hexdigest();mode='raw'
    if baseline and pin==baseline['sha256'] and before.st_size==baseline['bytes']:mode='reuse'
    elif baseline and 'chunks' in baseline:mode='delta'
    return {'mode':mode,'bytes':before.st_size,'sha256':pin,'mtime_ns':before.st_mtime_ns,'blocks':changed if mode=='delta' else []}


def add_bytes(archive,name,data):
    info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o600;archive.addfile(info,io.BytesIO(data))


def build_archive(roots,catalog,stream):
    """Stream only changed bytes; the manifest still describes every source byte."""
    # Source has no access to native file paths. Structural/path validation of
    # native references is repeated by the receiver with its fixed allowlist.
    if catalog.get('schema')!='village-windows-byte-cache-catalog/v1' or catalog.get('chunk_bytes')!=65536:
        raise ValueError('bound_byte_cache_catalog_required')
    manifest={'created_unix':time.time(),'source_roots':roots,'files':[],'directories':[],
              'excluded':[],'changed_during_read':[],'errors':[]}
    ident=0
    with gzip.GzipFile(fileobj=stream,mode='wb',compresslevel=1) as compressed,tarfile.open(fileobj=compressed,mode='w|') as archive:
        for root in roots:
            name=root['name'];source=Path(root['source'])
            if name not in ROOTS or not source.is_dir():raise ValueError('unexpected_source_root')
            def fail(error):raise error
            for directory,dirs,files in os.walk(source,followlinks=False,onerror=fail):
                rel=Path(directory).relative_to(source);dirname=name if rel==Path('.') else name+'/'+rel.as_posix()
                info=tarfile.TarInfo(dirname);info.type=tarfile.DIRTYPE;info.mode=0o700;archive.addfile(info);manifest['directories'].append(dirname)
                for d in list(dirs):
                    p=Path(directory)/d;r=(rel/d).as_posix()
                    if r in root.get('exclude_relative_dirs',[]):dirs.remove(d);manifest['excluded'].append({'root':name,'path':r});continue
                    if p.is_symlink() or getattr(p.lstat(),'st_file_attributes',0)&getattr(stat,'FILE_ATTRIBUTE_REPARSE_POINT',0):raise ValueError('source_payload_link')
                for f in sorted(files):
                    p=Path(directory)/f;r=(rel/f).as_posix();target=name+'/'+r
                    if r in root.get('exclude_relative_files',[]):manifest['excluded'].append({'root':name,'path':r});continue
                    if p.is_symlink() or not stat.S_ISREG(p.lstat().st_mode):raise ValueError('source_payload_special_file')
                    relative(target);base=catalog['entries'].get(target);plan=file_plan(p,base,catalog['chunk_bytes'])
                    ident+=1
                    if plan['mode']=='raw':
                        info=tarfile.TarInfo(target);info.size=plan['bytes'];info.mode=0o600
                        h=hashlib.sha256()
                        class Reader:
                            def read(self,size):
                                b=opened.read(size);h.update(b);return b
                        with p.open('rb') as opened:archive.addfile(info,Reader())
                        if h.hexdigest()!=plan['sha256']:raise ValueError('raw_source_changed_during_transfer')
                    else:
                        instruction={k:plan[k] for k in ('mode','bytes','sha256','mtime_ns','blocks')};instruction.update(path=target,id=ident)
                        add_bytes(archive,f'__DELTA__/{ident:08x}.json',json.dumps(instruction,separators=(',',':')).encode())
                        if plan['mode']=='delta':
                            with p.open('rb') as opened:
                                for block in plan['blocks']:
                                    opened.seek(block['index']*catalog['chunk_bytes']);b=opened.read(block['bytes'])
                                    if len(b)!=block['bytes'] or sha(b)!=block['sha256']:raise ValueError('delta_source_changed_during_transfer')
                                    add_bytes(archive,f'__DELTA__/{ident:08x}/{block["index"]:08x}.bin',b)
                    after=p.stat()
                    if (after.st_size,after.st_mtime_ns)!=(plan['bytes'],plan['mtime_ns']):raise ValueError('source_changed_after_transfer')
                    manifest['files'].append({'path':target,'bytes':plan['bytes'],'sha256':plan['sha256'],'mtime_ns':plan['mtime_ns']})
        add_bytes(archive,'MANIFEST.json',json.dumps(manifest,separators=(',',':')).encode())
    return manifest


def clone_bytes(source,target):
    if target.exists():raise ValueError('reconstruction_target_already_exists')
    cloned=False
    if sys.platform=='darwin':
        libc=ctypes.CDLL(None,use_errno=True);fn=libc.clonefile
        fn.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_int];fn.restype=ctypes.c_int
        cloned=fn(os.fsencode(source),os.fsencode(target),0)==0
    if not cloned:
        with Path(source).open('rb') as src,Path(target).open('xb') as dst:shutil.copyfileobj(src,dst,1024*1024)
    target.chmod(0o600)


def receive_archive(stream,destination,catalog,*,allowed_roots=None,require_inactive=True):
    validate_catalog(catalog,allowed_roots)
    base=Path(destination)
    if require_inactive:
        if (base.parent!=NATIVE/'snapshots' or not re.fullmatch('current-final-closed-[a-z0-9-]+',base.name)
                or not (NATIVE/'candidate/MIGRATION-INACTIVE').is_file() or (NATIVE/'candidate/ACTIVATION.json').exists()):
            raise ValueError('new_inactive_current_closed_destination_required')
    if base.exists():raise ValueError('immutable_destination_already_exists')
    base.mkdir(mode=0o700);seen=set();directories=set();tar_seen=set();pending={};instructions={};payload=0;manifest=None;verified_bases={}
    with tarfile.open(fileobj=stream,mode='r|gz') as archive:
        for member in archive:
            relative(member.name)
            if member.name in tar_seen or not (member.isfile() or member.isdir()):raise ValueError('duplicate_or_special_archive_member')
            tar_seen.add(member.name)
            if member.name=='MANIFEST.json':
                if member.size>32*1024*1024:raise ValueError('manifest_too_large')
                manifest=json.load(archive.extractfile(member));continue
            if manifest is not None:raise ValueError('members_after_manifest')
            parts=PurePosixPath(member.name).parts
            if parts[0]=='__DELTA__':
                if not member.isfile():raise ValueError('invalid_delta_member')
                if len(parts)==2 and parts[1].endswith('.json'):
                    if member.size>32*1024*1024:raise ValueError('delta_instruction_too_large')
                    row=json.load(archive.extractfile(member));name=row['path'];relative(name);ident=row['id']
                    if (parts[1]!=f'{ident:08x}.json' or name in seen or name not in catalog['entries']
                            or row['mode'] not in ('reuse','delta') or type(row['bytes']) is not int or row['bytes']<0):raise ValueError('invalid_delta_instruction')
                    ref=catalog['entries'][name];source=Path(ref['path']);key=(str(source),ref['sha256'])
                    if key not in verified_bases:
                        if not source.is_file() or source.is_symlink() or source.stat().st_size!=ref['bytes'] or digest(source)!=ref['sha256']:
                            raise ValueError('baseline_bytes_changed')
                        verified_bases[key]=True
                    target=base.joinpath(*PurePosixPath(name).parts);target.parent.mkdir(parents=True,exist_ok=True,mode=0o700);clone_bytes(source,target)
                    with target.open('r+b') as out:out.truncate(row['bytes'])
                    seen.add(name);instructions[name]=row
                    blocks=row['blocks']
                    if not isinstance(blocks,list) or (row['mode']=='reuse' and (blocks or row['bytes']!=ref['bytes'] or row['sha256']!=ref['sha256'])):
                        raise ValueError('invalid_reuse_instruction')
                    used=set()
                    for block in blocks:
                        i=block['index'];size=block['bytes']
                        if (type(i) is not int or i<0 or i in used or i*catalog['chunk_bytes']>=row['bytes']
                                or size!=min(catalog['chunk_bytes'],row['bytes']-i*catalog['chunk_bytes'])
                                or not re.fullmatch('[a-f0-9]{64}',block.get('sha256',''))):raise ValueError('invalid_delta_block')
                        used.add(i);pending[f'__DELTA__/{ident:08x}/{i:08x}.bin']=(target,i,size,block['sha256'])
                else:
                    if member.name not in pending:raise ValueError('unexpected_delta_block')
                    target,i,size,pin=pending.pop(member.name)
                    if member.size!=size:raise ValueError('delta_block_size_changed')
                    b=archive.extractfile(member).read()
                    if sha(b)!=pin:raise ValueError('delta_block_hash_changed')
                    with target.open('r+b') as out:out.seek(i*catalog['chunk_bytes']);out.write(b)
                    payload+=size
                continue
            if parts[0] not in ROOTS:raise ValueError('unexpected_archive_root')
            target=base.joinpath(*parts)
            if member.isdir():
                if member.name in seen:raise ValueError('directory_file_collision')
                target.mkdir(parents=True,exist_ok=True,mode=0o700);directories.add(member.name);continue
            if member.name in seen or member.name in directories:raise ValueError('duplicate_output_file')
            target.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
            with target.open('xb') as out:shutil.copyfileobj(archive.extractfile(member),out,1024*1024)
            target.chmod(0o600);seen.add(member.name);payload+=member.size
    if pending or not manifest or manifest.get('errors')!=[] or manifest.get('changed_during_read')!=[]:raise ValueError('incomplete_closed_archive')
    rows=manifest['files'];names=[r['path'] for r in rows]
    if len(names)!=len(set(names)) or set(names)!=seen or set(manifest['directories'])!=directories or len(manifest['directories'])!=len(directories):
        raise ValueError('source_manifest_inventory_mismatch')
    for row in rows:
        relative(row['path']);p=base.joinpath(*PurePosixPath(row['path']).parts)
        if p.stat().st_size!=row['bytes'] or digest(p)!=row['sha256']:raise ValueError('reconstructed_source_hash_mismatch')
        if row['path'] in instructions and any(instructions[row['path']][k]!=row[k] for k in ('bytes','sha256','mtime_ns')):raise ValueError('delta_instruction_manifest_mismatch')
        if type(row.get('mtime_ns')) is not int:raise ValueError('source_file_time_missing')
        os.utime(p,ns=(row['mtime_ns'],row['mtime_ns']))
        if p.stat().st_mtime_ns!=row['mtime_ns']:raise ValueError('source_file_time_changed')
        with p.open('r+b') as f:os.fsync(f.fileno())
    if require_inactive and ((NATIVE/'candidate/ACTIVATION.json').exists() or not (NATIVE/'candidate/MIGRATION-INACTIVE').is_file()):
        raise ValueError('destination_activation_during_copy')
    result={'verified_files':len(rows),'verified_directories':len(directories),'verified_bytes':sum(r['bytes'] for r in rows),
            'transferred_payload_bytes':payload,'destination':str(base),'production_enabled':False,'byte_cache_is_source_authority':False}
    (base/'MANIFEST.json').write_text(json.dumps(manifest,separators=(',',':')))
    (base/'VERIFIED.json').write_text(json.dumps(result,separators=(',',':')))
    return result


def main():
    config_path=Path(sys.argv[1]);cfg=json.loads(config_path.read_text());ref=cfg['baseline_catalog']
    raw=Path(ref['local_path']).read_bytes()
    if sha(raw)!=ref['sha256']:raise ValueError('source_catalog_binding_changed')
    catalog=json.loads(raw)
    if Path(__file__).read_bytes()!=_SOURCE:raise ValueError('transport_module_changed')
    encoded=base64.b64encode(gzip.compress(_SOURCE,compresslevel=1)).decode()
    from shlex import quote
    code="import base64,gzip,json,pathlib,sys;g={'__name__':'migration_delta_remote','__file__':None};exec(gzip.decompress(base64.b64decode('"+encoded+"')),g);p=pathlib.Path(sys.argv[2]);raw=p.read_bytes();assert g['sha'](raw)==sys.argv[3];print(json.dumps(g['receive_archive'](sys.stdin.buffer,sys.argv[1],json.loads(raw))))"
    command=cfg['ssh']+['umask 077; /usr/bin/python3 -c '+quote(code)+' '+quote(cfg['destination'])+' '+quote(ref['remote_path'])+' '+quote(ref['sha256'])]
    log=config_path.with_suffix('');manifest=None
    with log.with_suffix('.ssh-out').open('xb') as out,log.with_suffix('.ssh-err').open('xb') as err:
        p=subprocess.Popen(command,stdin=subprocess.PIPE,stdout=out,stderr=err)
        try:
            manifest=build_archive(cfg['roots'],catalog,p.stdin);p.stdin.close();result=p.wait(timeout=120)
        except BaseException:
            p.stdin.close()
            try:p.wait(timeout=10)
            except subprocess.TimeoutExpired:p.terminate()
            raise
        finally:
            if manifest is not None:log.with_suffix('.manifest.json').write_text(json.dumps(manifest,separators=(',',':')))
    if result:raise RuntimeError('native_delta_reconstruction_failed_inspect_private_logs')
    print(log.with_suffix('.ssh-out').read_text())


if __name__=='__main__':main()
