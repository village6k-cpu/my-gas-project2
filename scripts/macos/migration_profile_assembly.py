"""Assemble new inactive profiles from a bound current six-tree restoration.

No source stop, profile promotion, activation or business replay. GBrain logical
validation and fresh source closure remain separate activation gates.
"""
from copy import deepcopy
from pathlib import Path
import json,os
import migration_final_cron as cron
import migration_profile_overlay as overlay
import migration_session_paths as session_paths
from migration_streamed_restore import digest
from migration_voice_phase import PhaseTransitionLock

TREES={'root-profile','worker-profile','bridge-queue','gbrain-db','inventory-stock-alerts','kakao-corrections'}


def bound(path,pin):
    path=Path(path)
    if path.is_symlink() or digest(path)!=pin:raise ValueError('assembly_provenance_changed')
    return json.loads(path.read_text(encoding='utf-8'))


def raw_readback(raw,manifest):
    files,dirs=overlay.inventory(raw)
    rows={overlay.relative(r['path']):r for r in manifest['files']}
    if (len(rows)!=len(manifest['files']) or set(files)!=set(rows)
            or len(manifest['directories'])!=len(set(manifest['directories']))
            or set(dirs)!=set(manifest['directories'])
            or {p.split('/')[0] for p in set(files)|set(dirs)}!=TREES):
        raise ValueError('restored_raw_inventory_changed')
    for name,p in files.items():
        row=rows[name]
        if (digest(p)!=row['sha256'] or p.stat().st_size!=row['bytes']
                or ('mtime_ns' in row and p.stat().st_mtime_ns!=row['mtime_ns'])):
            raise ValueError('restored_raw_payload_changed')


def assembled_readback(output,report):
    for role,profile in (('root',output/'root'),('worker',output/'root/profiles/kakaoworker')):
        files,dirs=overlay.inventory(profile)
        if role=='root':
            files={k:v for k,v in files.items() if not k.startswith('profiles/kakaoworker/')}
            dirs=[p for p in dirs if p not in ('profiles','profiles/kakaoworker')
                  and not p.startswith('profiles/kakaoworker/')]
        expected=report['profiles'][role]
        if (set(files)!=set(expected['sha256']) or set(dirs)!=set(expected['directories'])
                or any(digest(p)!=expected['sha256'][name] for name,p in files.items())):
            raise ValueError('assembled_profile_payload_changed')


def assemble(restoration,policy_path,output,candidate,*,restoration_sha,policy_sha,is_inactive,now):
    restoration,policy_path,output,root=(Path(p).resolve() for p in (restoration,policy_path,output,candidate))
    if (output.exists() or not all(p.is_relative_to(root) for p in (restoration,policy_path,output))
            or output==root or output.is_relative_to(restoration) or restoration.is_relative_to(output)):
        raise ValueError('separate_new_inactive_assembly_required')
    def gate():
        if (not (root/'MIGRATION-INACTIVE').is_file() or (root/'ACTIVATION.json').exists()
                or is_inactive() is not True):raise ValueError('all_native_owners_must_remain_inactive')
    gate()
    with PhaseTransitionLock(root):
        gate()
        return _assemble(restoration,policy_path,output,root,restoration_sha,policy_sha,gate,now)


def _assemble(restoration,policy_path,output,root,restoration_sha,policy_sha,gate,now):
    receipt_path=restoration/'RESTORATION.json'
    receipt=bound(receipt_path,restoration_sha);policy=bound(policy_path,policy_sha)
    if (receipt.get('schema')!='village-current-full-stream-restoration/v1'
            or receipt.get('complete') is not True or receipt.get('promoted') is not False
            or receipt.get('activated') is not False or set(receipt.get('canonical',{}))!={'root','worker'}
            or policy.get('schema')!='village-current-profile-assembly-policy/v1'
            or Path(policy['candidate']).resolve()!=root or set(policy['profiles'])!={'root','worker'}):
        raise ValueError('complete_current_restoration_and_policy_required')
    def reference(ref):
        p=Path(ref['path'])
        if not p.resolve().is_relative_to(root.parent):raise ValueError('assembly_reference_outside_migration')
        return bound(p,ref['sha256'])
    manifest_ref=policy['transport_manifest']
    if manifest_ref['sha256']!=receipt['transport_manifest_sha256']:
        raise ValueError('raw_manifest_not_bound_to_restoration')
    manifest=reference(manifest_ref);raw=restoration/'raw';raw_readback(raw,manifest)
    # Current source observation proves worker has no cron document. Never
    # import an unexpected Windows cron document without its own reviewed port.
    if (raw/'worker-profile/cron/jobs.json').exists():
        raise ValueError('worker_cron_requires_explicit_native_policy')
    planned={}
    for role in ('root','worker'):
        rules=deepcopy(policy['profiles'][role]);profile=raw/(role+'-profile')
        required={'state.db','projects.db','verification_evidence.db','cron/executions.db'}
        if role=='root':required|={'kanban.db','cron/slack-heybilli-ai-gate.db'}
        if not required.issubset(receipt['canonical'][role]):raise ValueError('operational_sqlite_database_missing')
        for name,pin in rules.pop('source_anchors',{}).items():
            overlay.relative(name)
            if digest(profile/name)!=pin:raise ValueError('source_configuration_anchor_changed')
        canonical={}
        for name,row in receipt['canonical'][role].items():
            overlay.relative(name);p=restoration/'canonical'/role/name
            if row.get('integrity')!='ok' or digest(p)!=row['canonical_sha256']:
                raise ValueError('canonical_database_changed')
            canonical[name]={'path':str(p),'sha256':row['canonical_sha256']}
        planned[role]=(profile,rules,canonical)
    latest_cron=raw/'root-profile/cron/jobs.json'
    prepared_cron=cron.prepare(json.loads(latest_cron.read_text(encoding='utf-8')),
        reference(policy['cron']['baseline']),reference(policy['cron']['native']),now=now)
    for job in prepared_cron['document']['jobs']:
        p=Path(job['workdir']).resolve()
        if not p.is_relative_to(root) or not p.is_dir():raise ValueError('native_cron_directory_unavailable')
    gate();output.mkdir(mode=0o700)
    report={'schema':'village-current-profile-assembly/v1','complete':False,'promoted':False,'activated':False,
        'restoration_sha256':restoration_sha,'policy_sha256':policy_sha,'profiles':{},'session_paths':{},
        'cron_next_run_adjustments':prepared_cron['next_run_adjustments'],'cron_backfill':False,
        'gbrain_logical_validation_pending':True,'current_source_closure_verified':False,
        'business_completion_verified':False}
    try:
        controls=output/'controls';controls.mkdir(mode=0o700)
        jobs=controls/'root.cron.jobs.json'
        with jobs.open('x',encoding='utf-8') as f:
            json.dump(prepared_cron['document'],f,ensure_ascii=False);f.flush();os.fsync(f.fileno())
        jobs.chmod(0o600)
        for role,(profile,rules,canonical) in planned.items():
            gate();state=canonical['state.db'];mapped=output/'mapped-databases'/role/'state.db'
            result=session_paths.restore(state['path'],mapped,state['sha256'],policy['session_mappings'],root)
            report['session_paths'][role]=result
            canonical['state.db']={'path':str(mapped),'sha256':result['restored_sha256']}
            if role=='root':
                rules['controls']['cron/jobs.json']={'path':str(jobs),'sha256':digest(jobs),'source_sha256':digest(latest_cron)}
            native=rules.pop('native')
            report['profiles'][role]=overlay.build(profile,native,output/role,canonical=canonical,
                                                   allowed_root=root,**rules)
        parent=output/'root/profiles';parent.mkdir(mode=0o700)
        (output/'worker').rename(parent/'kakaoworker')
        bound(receipt_path,restoration_sha);bound(policy_path,policy_sha);reference(manifest_ref)
        raw_readback(raw,manifest);gate();assembled_readback(output,report)
        report['complete']=True
        pending=output/'ASSEMBLY.pending.json'
        with pending.open('x',encoding='utf-8') as f:json.dump(report,f,indent=2);f.flush();os.fsync(f.fileno())
        pending.chmod(0o600);os.rename(pending,output/'ASSEMBLY.json')
        if os.name=='posix':
            for directory in sorted([output]+[p for p in output.rglob('*') if p.is_dir()],key=lambda p:len(p.parts),reverse=True):
                fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
                try:os.fsync(fd)
                finally:os.close(fd)
        return report
    except BaseException:
        report['complete']=False
        try:
            with (output/'ASSEMBLY.partial.json').open('x',encoding='utf-8') as f:
                json.dump(report,f,indent=2);f.flush();os.fsync(f.fileno())
        except OSError:pass
        raise
