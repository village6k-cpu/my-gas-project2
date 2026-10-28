"""Copy a closed verified snapshot to a NEW inactive DB; relocate cwd only.

No CLI and no live-profile promotion. Caller supplies a verified raw snapshot
and a new output below the isolated installation. Never apply to a live DB.
"""
from pathlib import Path
import hashlib
import re
import shutil
import sqlite3

def digest(path):
    h=hashlib.sha256()
    with Path(path).open('rb') as f:
        for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
    return h.hexdigest()

def key(value):
    if not isinstance(value,str):return value
    normalized=value.replace('\\','/')
    return normalized.casefold() if re.match(r'^[A-Za-z]:/',normalized) else value

def identifier(value):return '"'+value.replace('"','""')+'"'

def restore(raw,output,expected_sha,mappings,allowed_root):
    raw=Path(raw).resolve();output=Path(output).resolve();root=Path(allowed_root).resolve()
    if output.exists() or not output.is_relative_to(root) or output==raw:raise ValueError('new isolated output required')
    if (root/'ACTIVATION.json').exists():raise ValueError('installation already activated')
    wal=Path(str(raw)+'-wal')
    if wal.exists() and wal.stat().st_size:raise ValueError('raw snapshot has WAL')
    if digest(raw)!=expected_sha:raise ValueError('raw snapshot SHA mismatch')
    normalized={}
    for old,new in mappings.items():
        target=Path(new).resolve()
        if not target.is_relative_to(root) or not target.is_dir():raise ValueError('mapped directory is unavailable or outside installation')
        if key(old) in normalized:raise ValueError('duplicate source path mapping')
        normalized[key(old)]=str(target)
    output.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    # Exclusive creation also refuses a racing existing output.
    with raw.open('rb') as src,output.open('xb') as dst:shutil.copyfileobj(src,dst,1024*1024)
    output.chmod(0o600)
    conn=sqlite3.connect(output.as_uri()+'?mode=rw',uri=True)
    try:
        conn.execute('PRAGMA journal_mode=DELETE')
        conn.execute('ATTACH DATABASE ? AS original',(raw.as_uri()+'?mode=ro&immutable=1',))
        columns=[r[1] for r in conn.execute('PRAGMA main.table_info(sessions)')]
        if 'cwd' not in columns or 'id' not in columns:raise ValueError('unexpected sessions schema')
        changes=[]
        for session_id,old in conn.execute('SELECT id,cwd FROM main.sessions'):
            new=normalized.get(key(old))
            if new is not None and new!=old:changes.append({'id':session_id,'old':old,'new':new})
        def guard(action,arg1,arg2,db,trigger):
            if action in (sqlite3.SQLITE_INSERT,sqlite3.SQLITE_DELETE):return sqlite3.SQLITE_DENY
            if action==sqlite3.SQLITE_UPDATE and (db!='main' or arg1!='sessions' or arg2!='cwd'):return sqlite3.SQLITE_DENY
            return sqlite3.SQLITE_OK
        conn.set_authorizer(guard)
        with conn:
            for r in changes:
                cursor=conn.execute('UPDATE main.sessions SET cwd=? WHERE id=? AND cwd=?',(r['new'],r['id'],r['old']))
                if cursor.rowcount!=1:raise ValueError('session mapping count mismatch')
        cols=','.join(identifier(x) for x in columns if x!='cwd')
        for left,right in [('main','original'),('original','main')]:
            if conn.execute(f'SELECT {cols} FROM {left}.sessions EXCEPT SELECT {cols} FROM {right}.sessions LIMIT 1').fetchone():raise ValueError('non-cwd session content changed')
        tables=[r[0] for r in conn.execute("SELECT name FROM main.sqlite_master WHERE type='table'")]
        for table in tables:
            q=identifier(table)
            if conn.execute(f'SELECT count(*) FROM main.{q}').fetchone()!=conn.execute(f'SELECT count(*) FROM original.{q}').fetchone():raise ValueError('row count changed')
        conn.set_authorizer(None)
        if conn.execute('PRAGMA main.integrity_check').fetchall()!=[('ok',)]:raise ValueError('restored DB integrity failed')
    finally:conn.close()
    if digest(raw)!=expected_sha:raise ValueError('raw snapshot changed')
    return {'updated_sessions':len(changes),'mappings':changes,'raw_sha256':expected_sha,'restored_sha256':digest(output),'integrity':'ok','non_cwd_writes_denied':True,'promoted':False}
