"""Cold capture of the current five-owner source. No stop, launch or data repair.

Operational mode requires real stop/recovery inputs and the active scheduler
fence. A successful file copy is never treated as proof of writer closure.
"""
import argparse
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import re
import shutil
import time

NAMES = ('root-profile', 'worker-profile', 'bridge-queue', 'gbrain-db',
         'inventory-stock-alerts', 'kakao-corrections')
MARGIN = 1024**3
SAFE_EXCLUSIONS = {
    'root-profile': frozenset(('.migration','backups','benchmarks','desktop','git',
        'hermes-agent','migration-conflicts','profiles','protected-backups',
        'recovery-backups','skills-backups','state-repair-backups','state-snapshots',
        'lsp/node_modules','plugins/orca-status/__pycache__','scripts/__pycache__',
        'skills/productivity/productivity-integrations/scripts/google-workspace/__pycache__',
        'watch-voice-relay/__pycache__')),
    'worker-profile': frozenset(('backups','lsp/node_modules',
        'plugins/.kakao_village.rollback/__pycache__','plugins/kakao_village/__pycache__')),
    'bridge-queue': frozenset(), 'gbrain-db': frozenset(('.gbrain-resolve.sock',)),
    'inventory-stock-alerts': frozenset(), 'kakao-corrections': frozenset(),
}


def save_new(path, value):
    with Path(path).open('x', encoding='utf-8') as f:
        json.dump(value, f, indent=2); f.flush(); os.fsync(f.fileno())


def publish_verified(path, value):
    path = Path(path)
    pending = path.with_name(path.name+'.pending')
    save_new(pending,value)
    # All fallible writes/flushes finish before the success name becomes visible.
    # The exclusive destination directory is owned by this capture attempt.
    if path.exists(): raise FileExistsError('success_marker_already_exists')
    os.rename(pending,path)


def validate_roots(roots, dest):
    if (not isinstance(roots, list) or len(roots) != len(NAMES)
            or {r.get('name') for r in roots} != set(NAMES)):
        raise ValueError('exactly_six_current_capture_roots_required')
    paths = []
    for row in roots:
        p = Path(row['source']).resolve()
        excluded = row.get('excluded')
        if (not p.is_dir() or not isinstance(excluded, list)
                or not all(isinstance(x,str) and x and not Path(x).is_absolute()
                           and '..' not in Path(x).parts for x in excluded)):
            raise ValueError('invalid_current_capture_root')
        if not set(excluded).issubset(SAFE_EXCLUSIONS[row['name']]):
            raise ValueError('capture_exclusion_could_omit_operational_state')
        if p == dest or dest.is_relative_to(p) or p.is_relative_to(dest):
            raise ValueError('capture_destination_overlaps_source')
        for prior, omissions in paths:
            if p == prior: raise ValueError('duplicate_source_root')
            for child, parent, ignored in ((p,prior,omissions),(prior,p,excluded)):
                if child.is_relative_to(parent):
                    relative = child.relative_to(parent)
                    if not any(relative == Path(x) or relative.is_relative_to(Path(x))
                               for x in ignored):
                        raise ValueError('unexcluded_nested_capture_root')
        paths.append((p,excluded))


def check_gate(row, before=None):
    if (not isinstance(row,dict) or row.get('all_five_owners_absent') is not True
            or row.get('scheduled_writers_absent') is not True
            or any(not re.fullmatch('[a-f0-9]{64}',str(row.get(k,'')))
                   for k in ('intent_sha256','stop_sha256'))):
        raise ValueError('five_owner_cold_closure_required')
    if before and any(row[k] != before[k] for k in ('intent_sha256','stop_sha256')):
        raise ValueError('cold_closure_binding_changed')
    return row


def capture(roots, destination, gate, copier, *, required_bytes, free_bytes):
    dest = Path(destination).resolve()
    validate_roots(roots,dest)
    if dest.exists(): raise FileExistsError('immutable_capture_destination_exists')
    if (type(required_bytes) is not int or required_bytes < 0
            or type(free_bytes) is not int or free_bytes < required_bytes + MARGIN):
        raise ValueError('insufficient_space_for_closed_capture')
    before = check_gate(gate())
    dest.mkdir(mode=0o700)
    result = {'schema':'village-current-closed-capture/v1', 'started_unix':time.time(),
              'before':before, 'roots':{}, 'copy_complete':False}
    try:
        for row in roots:
            copied = copier(row['source'],dest/row['name'],excluded=row['excluded'])
            if (copied.get('copy_verified') is not True
                    or not isinstance(copied.get('files'),list)
                    or not isinstance(copied.get('directories'),list)
                    or type(copied.get('bytes')) is not int):
                raise ValueError('exact_file_and_directory_manifest_required')
            names = []
            for item in copied['files']:
                name = item.get('path','')
                if (not name or Path(name).is_absolute() or '..' in Path(name).parts
                        or not re.fullmatch('[a-f0-9]{64}',str(item.get('sha256','')))
                        or type(item.get('bytes')) is not int or item['bytes'] < 0):
                    raise ValueError('invalid_copied_file_manifest')
                names.append(name)
            if len(names) != len(set(names)) or sum(x['bytes'] for x in copied['files']) != copied['bytes']:
                raise ValueError('inconsistent_copied_file_manifest')
            save_new(dest/(row['name']+'.manifest.json'),copied)
            result['roots'][row['name']] = {'manifest_sha256':hashlib.sha256(
                (dest/(row['name']+'.manifest.json')).read_bytes()).hexdigest(),
                'files':len(copied['files']),'bytes':copied['bytes']}
            result['after'] = check_gate(gate(),before)
        result.update(copy_complete=True,finished_unix=time.time())
        publish_verified(dest/'VERIFIED.json',result)
    except BaseException:
        result['copy_complete'] = False
        save_new(dest/'PARTIAL.json',result)
        raise
    return result


def load_helper(ref, name, base):
    path = Path(ref['path']).resolve()
    if not path.is_relative_to(base.resolve()): raise ValueError('helper_outside_protected_staging')
    if hashlib.sha256(path.read_bytes()).hexdigest() != ref['sha256']:
        raise ValueError('closed_capture_helper_changed')
    spec = importlib.util.spec_from_file_location(name,path)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


def validate_work_closure(proof, stop, intent, proof_sha):
    """Only the actual source-stop controller may produce this receipt.

    Historical failed/uncertain obligations may remain pending. Their payloads
    must be explicitly retained; they are not successful or eligible for replay.
    """
    if (proof.get('schema') != 'village-current-accepted-work-closure/v1'
            or not re.fullmatch('[a-f0-9]{64}',str(proof.get('intent_sha256','')))
            or stop.get('accepted_work_sha256') != proof_sha
            or proof.get('intent_sha256') != stop.get('intent_sha256')):
        raise ValueError('actual_accepted_work_receipt_required')
    owners = {x['role']:x for x in intent['profiles']}
    rows = proof.get('owners',{})
    if set(rows) != {'root','worker','bridge','relay','voice'}:
        raise ValueError('accepted_work_owner_inventory_incomplete')
    for role,row in rows.items():
        old = owners[role]
        if (row.get('pid') != old['pid'] or type(row.get('started')) not in (int,float)
                or not math.isfinite(row['started'])
                or abs(row['started']-old['started']) >= .01):
            raise ValueError('accepted_work_owner_changed')
    for role in ('root','worker'):
        row = rows[role]
        if (row.get('gateway_state') != 'draining'
                or any(type(row.get(k)) is not int or row[k] != 0 for k in
                       ('active_agents','pending_messages','running_cron'))):
            raise ValueError('gateway_accepted_work_not_settled')
    bridge = rows['bridge']
    if (bridge.get('drained') is not True or bridge.get('http_closed') is not True
            or bridge.get('preexisting_work_verified') is not True
            or any(type(bridge.get(k)) is not int or bridge[k] != 0 for k in
                   ('pending_handlers','pending_tracked_work'))):
        raise ValueError('bridge_accepted_work_not_settled')
    voice = rows['voice']
    if (voice.get('threads') != 1 or type(voice.get('threads')) is not int
            or type(voice.get('non_listening_tcp_connections')) is not int
            or voice['non_listening_tcp_connections'] != 0
            or voice.get('ingress_mode') != 'hold'
            or voice.get('ingress_dispatching') != 0
            or type(voice.get('ingress_dispatching')) is not int
            or not isinstance(voice.get('ingress_epoch'),str) or not voice['ingress_epoch']
            or not isinstance(voice.get('receipt_status_counts'),dict)
            or any(k != 'webhook_accepted' or type(v) is not int or v < 0
                   for k,v in voice['receipt_status_counts'].items())):
        raise ValueError('voice_accepted_work_not_settled')
    if rows['relay'].get('owned_producer_paused') is not True:
        raise ValueError('source_browser_producer_not_paused')
    quiet = proof.get('slack_quiet',{})
    if (type(quiet.get('settled_seconds')) not in (int,float)
            or not 300 <= quiet['settled_seconds'] < 3600
            or quiet.get('new_input_observed') is not False):
        raise ValueError('slack_memory_only_requests_not_settled')
    pending = proof.get('preserved_obligations',{})
    if (pending.get('replay_authorized') is not False
            or not re.fullmatch('[a-f0-9]{64}',str(pending.get('manifest_sha256','')))):
        raise ValueError('pending_obligations_must_be_preserved_without_replay')


def main():
    import migration_source_recovery as checks
    import migration_source_recovery_executor as recovery
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--control',required=True)
    parser.add_argument('--inputs-sha',required=True)
    parser.add_argument('--stop-sha',required=True)
    parser.add_argument('--capture-plan-sha',required=True)
    parser.add_argument('--capture',action='store_true')
    args = parser.parse_args()
    adapter = recovery.WindowsAdapter(args.control,args.inputs_sha,args.stop_sha)
    control = adapter.control
    config = recovery.read_bound(control/'closed-capture-plan.json',args.capture_plan_sha)
    if config.get('schema') != 'village-current-closed-capture-plan/v1':
        raise ValueError('wrong_current_cold_capture_plan')
    if hashlib.sha256(Path(__file__).read_bytes()).hexdigest() != config.get('capture_module_sha256'):
        raise ValueError('current_capture_module_changed')
    _,accepted = adapter.reference(config['accepted_work'])
    validate_work_closure(accepted,adapter.receipt,adapter.intent,config['accepted_work']['sha256'])
    trees = load_helper(config['copy_helper'],'pinned_closed_tree',checks.BASE.parent)
    guards = load_helper(config['guard_helper'],'pinned_scheduled_guards',checks.BASE.parent)
    _,entrypoints = adapter.reference(config['task_entrypoints'])
    _,ops = adapter.reference(config['ops_entrypoints'])
    roots = config['roots']
    homes = {r['role']:r['home'] for r in adapter.intent['profiles']}
    expected = {'root-profile':homes['root'],'worker-profile':homes['worker'],
        'bridge-queue':'C:/Village/runtimes/my-gas-project2-production/tools/kakao-dom-bridge/queue',
        'gbrain-db':'C:/Users/ssper/.gbrain/brain.pglite',
        'inventory-stock-alerts':'C:/Village/runtime/inventory-stock-alerts',
        'kakao-corrections':'C:/Users/ssper/AppData/Local/Village/kakao-corrections'}
    if any(checks.norm(r['source']) != checks.norm(expected.get(r['name'])) for r in roots):
        raise ValueError('cold_capture_source_differs_from_current_contract')
    # Runtime databases and their WAL/SHM companions must be copied together.
    for row in roots:
        if row['name'].endswith('-profile') and any(
                x == 'state.db' or x.startswith('state.db-') for x in row['excluded']):
            raise ValueError('profile_sqlite_or_wal_must_not_be_excluded')
    dest = control/'closed-raw-v1'
    validate_roots(roots,dest.resolve())

    def gate():
        if (control/'SOURCE_RECOVERY_STARTED').exists():
            raise ValueError('source_recovery_invalidates_capture')
        plan = adapter.gate()
        if (any(r['status'] != 'stopped' for r in adapter.receipt['profiles'])
                or any(s['method'] in ('reuse_verified_replacement','preserve_unaffected')
                       for s in plan['steps'])):
            raise ValueError('every_current_owner_must_be_absent')
        extra = [arg for job in ops for arg in job['argv'][1:]
                 if Path(arg).suffix.lower() in ('.ps1','.py','.js','.mjs')]
        extra += ['C:/Village/my-gas-project2/scripts/windows/inventory-stock-alert-relay.js',
                  'C:/Village/runtimes/my-gas-project2-production/tools/ai-browser-worker/mine-kakao-corrections.mjs']
        scoped = guards.inventory(adapter.intent,entrypoints,writers_stopped=True,extra_entrypoints=extra)
        if scoped.get('drained') is not True:
            raise ValueError('detached_scheduled_writer_remains')
        return {'checked_unix':time.time(),'intent_sha256':adapter.inputs['intent']['sha256'],
                'stop_sha256':args.stop_sha,'all_five_owners_absent':True,
                'scheduled_writers_absent':True,'all_21_tasks_fenced':True,
                'destination_inactive':True,'owned_watcher_paused':True}

    gate()
    required = sum(sum(v[0] for v in trees.inventory(r['source'],frozenset(r['excluded']))[0].values())
                   for r in roots)
    free = shutil.disk_usage(control).free
    if not args.capture:
        print(json.dumps({'closure_current':True,'required_bytes':required,
                          'free_bytes':free,'capture_executed':False})); return
    result = capture(roots,dest,gate,trees.copy_closed_tree,required_bytes=required,free_bytes=free)
    print(json.dumps({'copy_complete':result['copy_complete'],'roots':result['roots']}))


if __name__ == '__main__': main()
