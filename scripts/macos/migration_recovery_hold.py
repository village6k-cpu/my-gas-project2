"""Prepare the same frozen recovery policy for a new native queue location.

No filesystem writes, job mutation, recovery, activation or business execution.
The caller supplies hashes from the captured queue; final use needs closed-state
provenance separately. freezeBefore also protects unlisted older jobs.
"""
from datetime import datetime
import hashlib
import json
from pathlib import PurePosixPath, PureWindowsPath
import re


def prepare(raw,*,source_sha256,source_queue,native_queue,job_hashes):
    if (not isinstance(raw,bytes) or not re.fullmatch('[a-f0-9]{64}',source_sha256)
            or hashlib.sha256(raw).hexdigest()!=source_sha256):
        raise ValueError('Recovery manifest source hash changed')
    manifest=json.loads(raw)
    if not isinstance(manifest,dict) or manifest.get('schema')!='village-gateway-held-jobs/v1':
        raise ValueError('Unsupported recovery hold schema')
    actual=manifest.get('queueDirectory','')
    def windows_key(value):
        if not isinstance(value,str) or not PureWindowsPath(value).is_absolute():
            raise ValueError('Invalid source queue')
        if '..' in PureWindowsPath(value).parts:raise ValueError('Unsafe source queue')
        return str(PureWindowsPath(value)).casefold()
    if windows_key(actual)!=windows_key(source_queue):
        raise ValueError('Unexpected source queue')
    if (not isinstance(native_queue,str) or '\\' in native_queue
            or not PurePosixPath(native_queue).is_absolute()
            or '..' in PurePosixPath(native_queue).parts
            or str(PurePosixPath(native_queue))!=native_queue):
        raise ValueError('Unsafe native queue')
    cutoff=manifest.get('freezeBefore','')
    if not isinstance(cutoff,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z',cutoff):
        raise ValueError('Invalid freeze cutoff')
    try:datetime.fromisoformat(cutoff.replace('Z','+00:00'))
    except ValueError:raise ValueError('Invalid freeze cutoff') from None
    entries=manifest.get('entries')
    if not isinstance(entries,list) or not 1<=len(entries)<=10000 or not isinstance(job_hashes,dict):
        raise ValueError('Missing held payload proof')
    seen=set()
    for entry in entries:
        if (not isinstance(entry,dict) or set(entry)!={'jobId','sha256'}
                or not isinstance(entry['jobId'],str) or not entry['jobId'].strip()
                or len(entry['jobId'])>240 or entry['jobId'] in seen
                or not isinstance(entry['sha256'],str) or not re.fullmatch('[a-f0-9]{64}',entry['sha256'])):
            raise ValueError('Invalid or duplicate held identity')
        if job_hashes.get(entry['jobId'])!=entry['sha256']:
            raise ValueError('Captured held payload changed or missing')
        seen.add(entry['jobId'])
    output=json.dumps({**manifest,'queueDirectory':native_queue},ensure_ascii=False,indent=2).encode()+b'\n'
    proof=dict(source_sha256=source_sha256,native_sha256=hashlib.sha256(output).hexdigest(),
               source_queue=actual,native_queue=native_queue,freeze_before=cutoff,
               held_jobs=len(entries),held_entries_unchanged=True,activated=False,
               business_mutations=False,requires_closed_state_provenance=True)
    return output,proof
