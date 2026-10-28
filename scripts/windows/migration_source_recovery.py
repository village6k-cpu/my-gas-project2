"""Read-only recovery planner. Never starts tasks/processes or changes fencing.

Receipt schema 1: intent_sha256 (exact input bytes), stopped_at (Unix seconds),
profiles (all five current roles). Each profile records role, pid, started, status
('stopped' or 'unaffected'), children_inventory_complete:true and children
[{pid,started}]. Children must be the complete recursive inventory captured
before the stop; do not manufacture an empty inventory after parents exit.

An emitted plan is NOT execution authorization. Keep ingress/watchdogs fenced,
recheck before each action, and verify readiness before restoring task owners.
"""
import argparse
import hashlib
import json
import inspect
import math
import ntpath
from pathlib import Path
import secrets
import subprocess
import time

BASE = Path('C:/Village/migration-staging/studio-20260930/resume-20261027')
CONTROL = BASE / 'scheduler-fence-v2'
REMOTE_HOST = 'choijaehyeong@100.103.83.1'
CANDIDATE = '/Users/choijaehyeong/VillageMigration/20260930-windows/candidate'
SSH_KEY = 'C:/Users/ssper/.ssh/village_macmini_migration'
FUTURE_LABELS = tuple('com.village.migrated.' + x for x in (
    'root', 'worker', 'bridge', 'relay', 'voice', 'chrome', 'watcher', 'inventory-brief',
    'ledger-sheet-sync', 'preflight', 'return-issues', 'setmaster-reconcile',
    'tax-tracks-sync', 'weekly-brain-card', 'corrections-nightly', 'inventory-stock-relay'))
ROLES = ('bridge', 'relay', 'worker', 'root', 'voice')
TASKS = {'root': 'Hermes_Gateway', 'worker': 'Hermes_Gateway_Kakaoworker_Native',
         'voice': 'Hermes_Watch_Voice_Relay'}
MAX_AGE = 30
REMOTE_UID = 501


def number(value):
    return type(value) in (int, float) and math.isfinite(value)


def identity(row):
    return (isinstance(row, dict) and type(row.get('pid')) is int and row['pid'] > 0
            and number(row.get('started')) and row['started'] > 0)


def same_identity(left, right):
    return (identity(left) and identity(right) and left['pid'] == right['pid']
            and abs(left['started'] - right['started']) < .01)


def norm(path):
    return ntpath.normcase(ntpath.normpath(path)) if isinstance(path, str) else None


def same_python_search_path(actual, expected):
    """Allow only full repetitions of the same ordered Windows search roots.

    Windows gateway startup prepends its project/site pair to the inherited
    PYTHONPATH. Reusing a captured environment can repeat that complete pair.
    A different root, order, omitted entry or empty component remains drift.
    """
    if actual == expected:return True
    if not isinstance(actual,str) or not isinstance(expected,str):return False
    def primitive(value):
        parts=value.split(';')
        if len(parts)>64 or not all(parts):return None
        for size in range(1,len(parts)+1):
            if len(parts)%size==0 and parts==parts[:size]*(len(parts)//size):return parts[:size]
    left,right=primitive(actual),primitive(expected)
    return left is not None and left==right


def same_contract(actual, expected):
    return (all(norm(actual.get(k)) == norm(expected[k]) for k in ('exe', 'cwd'))
            and all(k in actual and actual[k] == expected[k]
                    for k in ('argv', 'home'))
            and 'pythonpath' in actual
            and same_python_search_path(actual['pythonpath'],expected['pythonpath']))


def same_entrypoint(actual, expected):
    """Separate role candidates from helpers sharing Python/Node and HOME.

    This is not a writer-closure proof. Complete old child inventory and the
    separate detached/scheduled-writer audit are still required before capture.
    """
    def program(argv):
        if not isinstance(argv, list) or not all(isinstance(x, str) for x in argv):
            return None
        # Classify only understood invocations. Inline code, preloads, flags
        # taking values and unknown forms are not proof of a different helper.
        benign = {'-u','-B','-E','-I','-O','-OO','-P','-q','-s','-S','-v',
                  '-x','-b','-bb','-d','-R','--trace-warnings','--no-warnings',
                  '--enable-source-maps'}
        index = 1
        while index < len(argv):
            arg = argv[index]
            if arg in benign:
                index += 1
                continue
            if arg == '-m':
                if index + 1 >= len(argv) or not argv[index+1]:
                    return None
                return ('module', argv[index+1].lower())
            if arg.startswith('-m') and len(arg) > 2:
                return ('module', arg[2:].lower())
            if arg == '--':
                index += 1
                if index >= len(argv):
                    return None
                arg = argv[index]
            elif arg.startswith('-'):
                return None
            if not arg.lower().endswith(('.py','.pyw','.js','.mjs','.cjs')):
                return None
            return ('script', norm(arg))
        return None
    a, b = program(actual.get('argv')), program(expected.get('argv'))
    if a is None or b is None:
        return True  # Unclassified means it cannot be excluded as a helper.
    if a == b:
        return True
    if a[0] != b[0]:
        module = a[1] if a[0] == 'module' else b[1]
        script = a[1] if a[0] == 'script' else b[1]
        suffix = ntpath.sep + module.replace('.', ntpath.sep)
        return script.endswith(suffix + '.py') or script.endswith(suffix + '.pyw')
    return False


def owned_descendant(actual, owner):
    if owner is None or not isinstance(actual.get('ancestors'), list):
        return False
    previous = actual['started']
    seen = {actual['pid']}
    for parent in actual['ancestors']:
        if not identity(parent) or parent['pid'] in seen or parent['started'] > previous:
            return False
        seen.add(parent['pid']);previous = parent['started']
        if same_identity(parent, owner):
            return True
    return False


def distinct_owned_helper(actual, verified_owners):
    """A classified different entrypoint in an exact live profile's lineage.

    This only distinguishes a tool child from a competing service candidate.
    It never exempts the child from accepted-work or writer-closure checks.
    """
    return (any(owned_descendant(actual,owner) for owner in verified_owners)
            and all(not same_entrypoint(actual,owner) for owner in verified_owners))


def confirmed_label_absence(domain_verified, code, diagnostic, label, uid):
    expected = 'Bad request.\nCould not find service "' + label + '" in domain for user gui: ' + str(uid)
    return (domain_verified is True and code == 113
            and diagnostic.replace('\r\n', '\n').strip() == expected)


def fresh(value, now):
    return number(value) and 0 <= now - value <= MAX_AGE


def build_plan(intent, receipt, intent_sha, snapshot, remote, *, now, activated):
    """Pure validation of observations. Never return actionable steps on errors."""
    result = dict(schema=1, measured_unix=now, ready=False, execution_authorized=False,
                  process_changes=False, task_changes=False, errors=[], steps=[],
                  requires_fresh_check_before_each_action=True,
                  ingress_and_watchdogs_must_remain_fenced=True)
    errors = result['errors']
    if activated is not False:
        errors.append('local_mac_activation_history_forbids_source_recovery')
    try:
        if (not isinstance(remote, dict) or not fresh(remote.get('observed_at'), now)
                or remote.get('host') != REMOTE_HOST or remote.get('candidate') != CANDIDATE
                or remote.get('inactive') is not True or remote.get('activation_absent') is not True
                or remote.get('domain_verified') is not True or remote.get('uid') != REMOTE_UID
                or remote.get('errors') != [] or not isinstance(remote.get('labels'), dict)
                or set(remote['labels']) != set(FUTURE_LABELS)
                or any(v != 'unloaded' for v in remote['labels'].values())):
            errors.append('fresh_complete_remote_inactivity_proof_required')
        if (not isinstance(snapshot, dict) or not fresh(snapshot.get('observed_at'), now)
                or snapshot.get('errors') != [] or not isinstance(snapshot.get('processes'), list)
                or not isinstance(snapshot.get('listeners'), list)):
            errors.append('fresh_complete_source_observation_required')
            return result
        expected = intent['profiles']
        rows = receipt['profiles']
        if (sorted(x['role'] for x in expected) != sorted(ROLES)
                or sorted(x['role'] for x in rows) != sorted(ROLES)):
            raise ValueError('five_unique_roles_required')
        if (receipt.get('schema') != 1 or receipt.get('intent_sha256') != intent_sha
                or not isinstance(intent_sha, str) or len(intent_sha) != 64
                or not number(receipt.get('stopped_at')) or not 0 < receipt['stopped_at'] <= now):
            raise ValueError('intent_bound_stop_receipt_required')
        if not any(x.get('status') == 'stopped' for x in rows):
            # An explicit failed-attempt reconciliation can prove all five old
            # trees still intact. A bare all-unaffected receipt remains invalid.
            pin=receipt.get('reconciled_from_sha256')
            if (receipt.get('stop_attempt_only') is not True or not isinstance(pin,str)
                    or len(pin)!=64 or any(c not in '0123456789abcdef' for c in pin)
                    or not all(x.get('status')=='unaffected' for x in rows)):
                raise ValueError('no_source_stop_recorded')
        processes = snapshot['processes']
        if any(not identity(p) for p in processes) or len({p['pid'] for p in processes}) != len(processes):
            raise ValueError('invalid_process_observation')
        for listener in snapshot['listeners']:
            if type(listener.get('port')) is not int or type(listener.get('pid')) is not int:
                raise ValueError('unknown_listener_owner')
        planned = []
        verified_owners=[p for p in processes if any(same_contract(p,old) for old in expected)]
        for role in ROLES:
            old = next(x for x in expected if x['role'] == role)
            stop = next(x for x in rows if x['role'] == role)
            if (not identity(old) or not all(isinstance(old.get(k), str) and old[k]
                    for k in ('exe', 'cwd', 'home')) or not isinstance(old.get('argv'), list)
                    or not old['argv'] or not all(isinstance(v, str) for v in old['argv'])
                    or 'pythonpath' not in old or not isinstance(old.get('ports'), list)
                    or any(type(p) is not int or not 1 <= p <= 65535 for p in old['ports'])):
                raise ValueError('invalid_source_contract')
            if (not same_identity(old, stop) or stop.get('status') not in ('stopped', 'unaffected')
                    or stop.get('children_inventory_complete') is not True
                    or not isinstance(stop.get('children'), list)
                    or any(not identity(c) for c in stop['children'])
                    or len({c['pid'] for c in stop['children']}) != len(stop['children'])
                    or old['started'] >= receipt['stopped_at']):
                errors.append(role + ':invalid_identity_or_child_receipt')
                continue
            stopped = stop['status'] == 'stopped'
            for previous in [old] + stop['children']:
                live = [p for p in processes if same_identity(p, previous)]
                if stopped and live:
                    errors.append(role + ':old_parent_or_child_still_alive')
                elif not stopped and not live:
                    errors.append(role + ':unaffected_identity_changed')
            matches = [p for p in processes if same_contract(p, old)]
            selected = matches[0] if len(matches) == 1 else None
            # Exact argv with different cwd/env is not a safe absent-process case.
            # Also catch a changed argv under this profile, excluding other known roles.
            for proc in processes:
                near = (proc.get('argv') == old['argv'] or
                        (norm(proc.get('exe')) == norm(old['exe']) and proc.get('home') == old['home']
                         and not distinct_owned_helper(proc,verified_owners)
                         and (same_entrypoint(proc, old) or not owned_descendant(proc, selected))
                         and not any(same_contract(proc, other) for other in expected)))
                if near and not same_contract(proc, old):
                    errors.append(role + ':near_candidate_has_wrong_execution_contract')
            if len(matches) > 1:
                errors.append(role + ':duplicate_exact_candidates')
                continue
            selected = matches[0] if matches else None
            if not stopped and (selected is None or not same_identity(selected, old)):
                errors.append(role + ':unaffected_owner_changed')
            if stopped and selected and selected['started'] < receipt['stopped_at']:
                errors.append(role + ':replacement_predates_stop_receipt')
            for port in old['ports']:
                owners = {c['pid'] for c in snapshot['listeners'] if c['port'] == port}
                if owners != ({selected['pid']} if selected else set()):
                    errors.append(role + ':expected_port_missing_or_wrong_owner')
            if selected:
                planned.append(dict(role=role, method='reuse_verified_replacement' if stopped
                                    else 'preserve_unaffected', pid=selected['pid'], started=selected['started']))
            elif role in ('bridge', 'relay'):
                planned.append(dict(role=role, method='current_guarded_bridge_relay_recovery_required',
                                    forbidden_task='Village-Kakao-Production-Start',
                                    preserve_existing_chrome_and_paused_watcher=True))
            else:
                planned.append(dict(role=role, method='known_scheduler_task', task=TASKS[role]))
        # GBrain's launcher and Bun are outside the five service exe names. An
        # unaccounted interpreter may still own its store after a parent exits.
        # Do not call that a closed source merely because Python/Node are gone.
        for proc in processes:
            if (ntpath.basename(proc.get('exe','')).lower() in ('bun.exe','gbrain.exe')
                    and not any(owned_descendant(proc,owner) for owner in verified_owners)):
                errors.append('detached_store_interpreter_requires_ownership_resolution')
        if not errors:
            result.update(ready=True, steps=planned, intent_sha256=intent_sha,
                          remote_observed_at=remote['observed_at'], source_observed_at=snapshot['observed_at'],
                          plan_expires_unix=min(remote['observed_at'], snapshot['observed_at']) + MAX_AGE)
    except (KeyError, TypeError, ValueError, AttributeError):
        errors.append('malformed_or_incomplete_recovery_input')
    return result


def collect_source(intent, receipt):
    """Only read process metadata and system listener ownership; never dump env."""
    import psutil
    begin = time.time()
    result = dict(observed_at=begin, processes=[], listeners=[], errors=[])
    exe_names = {ntpath.basename(p['exe']).lower() for p in intent['profiles']}
    exe_names.update(('bun.exe','gbrain.exe'))
    relevant_ids = {p['pid'] for p in intent['profiles']}
    relevant_ids.update(c['pid'] for p in receipt['profiles'] for c in p['children'])
    for proc in psutil.process_iter():
        relevant = proc.pid in relevant_ids
        name_known = False
        try:
            relevant = relevant or proc.name().lower() in exe_names
            name_known = True
            if not relevant:
                continue
            start = proc.create_time()
            row = dict(pid=proc.pid, started=start)
            if relevant:
                env = proc.environ()
                row.update(exe=proc.exe(), argv=proc.cmdline(), cwd=proc.cwd(),
                           home=env.get('HERMES_HOME'), pythonpath=env.get('PYTHONPATH'),
                           ancestors=[dict(pid=p.pid,started=p.create_time()) for p in proc.parents()])
                if proc.create_time() != start:
                    raise ValueError('identity_changed_during_read')
            result['processes'].append(row)
        except psutil.NoSuchProcess:
            if relevant:
                result['errors'].append('relevant_process_changed_during_read')
        except (psutil.Error, OSError, ValueError):
            if relevant or not name_known:
                result['errors'].append('relevant_process_metadata_unreadable')
    try:
        ports = {p for row in intent['profiles'] for p in row['ports']}
        result['listeners'] = [dict(port=c.laddr.port, pid=c.pid)
                               for c in psutil.net_connections(kind='tcp')
                               if c.status == psutil.CONN_LISTEN and c.laddr and c.laddr.port in ports]
    except psutil.Error:
        result['errors'].append('system_listener_ownership_unreadable')
    return result


def collect_remote():
    """Authenticated, fresh read-only SSH query; unknown launchctl errors fail closed."""
    nonce = secrets.token_hex(24)
    begin = time.time()
    script = '''import json,os,subprocess,pathlib
p=pathlib.Path(CANDIDATE)
r=dict(nonce=NONCE,host=HOST,candidate=CANDIDATE,labels={},errors=[])
def present(path):
    try: path.lstat(); return True
    except FileNotFoundError: return False
try:
    r['inactive']=present(p/'MIGRATION-INACTIVE')
    r['activation_absent']=not present(p/'ACTIVATION.json')
    r['uid']=os.getuid()
    domain=subprocess.run(['/bin/launchctl','print','gui/'+str(r['uid'])],capture_output=True,text=True,timeout=3)
    r['domain_verified']=domain.returncode==0 and r['uid']==501
    files=list((p/'refresh-20261027-v2/control/launchd').glob('*.plist'))
    if {x.stem for x in files}!=set(LABELS):r['errors'].append('future_manifest_labels_differ')
    for label in LABELS:
        q=subprocess.run(['/bin/launchctl','print','gui/'+str(os.getuid())+'/'+label],capture_output=True,text=True,timeout=3)
        r['labels'][label]='loaded' if q.returncode==0 else ('unloaded' if confirmed_label_absence(r['domain_verified'],q.returncode,q.stderr,label,r['uid']) else 'unknown')
except Exception:
    r['errors'].append('remote_read_failed')
print(json.dumps(r))
'''
    script = (inspect.getsource(confirmed_label_absence) + '\nCANDIDATE=' + repr(CANDIDATE) + '\nHOST=' + repr(REMOTE_HOST) + '\nNONCE='
              + repr(nonce) + '\nLABELS=' + repr(FUTURE_LABELS) + '\n' + script)
    try:
        read = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
                               '-o', 'ConnectTimeout=8', '-i', SSH_KEY, REMOTE_HOST, '/usr/bin/python3 -'],
                              input=script, text=True, capture_output=True, timeout=25, check=True)
        proof = json.loads(read.stdout)
        if proof.pop('nonce', None) != nonce:
            raise ValueError('remote_nonce_mismatch')
        proof['observed_at'] = begin
        return proof
    except (subprocess.SubprocessError, OSError, ValueError):
        return dict(errors=['fresh_remote_query_failed'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--intent', type=Path, default=BASE / 'current-source-identity-preparation-v1.json')
    parser.add_argument('--stop-receipt', type=Path, required=True)
    args = parser.parse_args()
    try:
        # Control directory must exist; a missing directory is not proof of no history.
        if not CONTROL.is_dir():
            raise ValueError('missing_protected_handoff_control')
        marker = CONTROL / 'MAC_EVER_ACTIVATED'
        def present(path):
            try: path.lstat(); return True
            except FileNotFoundError: return False
        activated = present(marker)
        raw = args.intent.read_bytes()
        intent = json.loads(raw.decode('utf-8-sig'))
        receipt_raw = args.stop_receipt.read_bytes()
        receipt = json.loads(receipt_raw.decode('utf-8-sig'))
        remote = collect_remote()
        source = collect_source(intent, receipt)
        result = build_plan(intent, receipt, hashlib.sha256(raw).hexdigest(), source, remote,
                            now=time.time(), activated=activated or present(marker))
        if args.intent.read_bytes() != raw or args.stop_receipt.read_bytes() != receipt_raw:
            result.update(ready=False, steps=[])
            result['errors'].append('input_changed_during_check')
    except (OSError, ValueError, KeyError, TypeError):
        result = dict(schema=1, ready=False, execution_authorized=False, process_changes=False,
                      task_changes=False, steps=[], errors=['recovery_inputs_unavailable_or_invalid'])
    print(json.dumps(result, sort_keys=True))
    return 0 if result['ready'] else 2


if __name__ == '__main__':
    raise SystemExit(main())
