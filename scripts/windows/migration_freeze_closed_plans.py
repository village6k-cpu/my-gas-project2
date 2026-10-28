"""Bind prepared transfer/recovery plans to an actual complete source stop.

No service, queue, task or routing mutation. Before SourceStop, --verify-only
reports that operational receipts are missing without creating those receipts.
"""
import argparse
from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import time

import migration_closed_capture as capture
import migration_source_recovery as checks
import migration_source_recovery_executor as recovery

ROLES=checks.ROLES


def pin(value):
    if not isinstance(value,str) or not re.fullmatch('[a-f0-9]{64}',value):
        raise ValueError('actual_content_hash_required')
    return value


def freeze_documents(capture_blueprint,recovery_blueprint,*,intent,intent_sha,stop,
                     stop_sha,request,inventory,inventory_sha,accepted,accepted_ref,
                     tasks_sha,watcher_pause,owned_drains,now):
    """Pure binding. A preparation document can never stand in for a receipt."""
    for value in (intent_sha,stop_sha,inventory_sha,tasks_sha,accepted_ref.get('sha256'),
                  watcher_pause.get('sha256'),owned_drains.get('sha256')):pin(value)
    if (capture_blueprint.get('schema')!='village-current-closed-capture-plan/v1'
            or recovery_blueprint.get('schema')!='village-current-recovery-inputs/v1'
            or recovery_blueprint.get('intent',{}).get('sha256')!=intent_sha
            or stop.get('schema')!=1 or stop.get('source_closed') is not True
            or stop.get('intent_sha256')!=intent_sha
            or stop.get('child_inventory_sha256')!=inventory_sha
            or request.get('schema')!='village-source-stop-request/v1'
            or request.get('intent_sha256')!=intent_sha
            or request.get('child_inventory_sha256')!=inventory_sha
            or request.get('accepted_work_sha256')!=accepted_ref['sha256']
            or not checks.number(request.get('requested_at'))
            or not checks.number(stop.get('stopped_at'))
            or not request['requested_at']<=stop['stopped_at']<=now
            or sorted(r.get('role') for r in stop.get('profiles',[]))!=sorted(ROLES)
            or sorted(r.get('role') for r in intent.get('profiles',[]))!=sorted(ROLES)
            or set(inventory)!=set(ROLES)):
        raise ValueError('actual_complete_five_owner_stop_required')
    for row in stop['profiles']:
        old=next(x for x in intent['profiles'] if x['role']==row['role'])
        if (row.get('status')!='stopped' or not checks.same_identity(old,row)
                or row.get('children_inventory_complete') is not True
                or not isinstance(row.get('children'),list)
                or any(not checks.identity(c) for c in row['children'])
                or row['children']!=inventory[row['role']]):
            raise ValueError('actual_recursive_child_closure_required')
    capture.validate_work_closure(accepted,stop,intent,accepted_ref['sha256'])
    c,r=deepcopy(capture_blueprint),deepcopy(recovery_blueprint)
    c.pop('preparation_only',None);r.pop('preparation_only',None)
    c['accepted_work']=deepcopy(accepted_ref)
    r.update(stop_sha256=stop_sha,tasks_sha256=tasks_sha,
             watcher_pause=deepcopy(watcher_pause),owned_drains=deepcopy(owned_drains))
    return c,r


def ref(path):
    path=Path(path).resolve()
    return {'path':str(path),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()}


class FenceReader:
    assert_fence_lease=recovery.WindowsAdapter.assert_fence_lease
    assert_fenced=recovery.WindowsAdapter.assert_fenced

    def __init__(self,control,scheduler):
        self.control=control;self.inputs={'scheduler_manifest':scheduler}


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--preparation',required=True)
    p.add_argument('--capture-blueprint-sha',required=True)
    p.add_argument('--recovery-blueprint-sha',required=True)
    p.add_argument('--verify-only',action='store_true')
    args=p.parse_args()
    directory=Path(args.preparation).resolve();control=checks.CONTROL.resolve()
    if not directory.is_relative_to(checks.BASE.resolve()):raise ValueError('private_preparation_required')
    c=recovery.read_bound(directory/'CLOSED-CAPTURE-BLUEPRINT.json',args.capture_blueprint_sha)
    r=recovery.read_bound(directory/'RECOVERY-INPUTS-BLUEPRINT.json',args.recovery_blueprint_sha)
    if not (control/'SOURCE_STOP_REQUESTED').is_file():
        if not args.verify_only:raise ValueError('actual_source_stop_required')
        print(json.dumps({'operational_plan_ready':False,'reason':'actual_source_stop_not_performed',
                          'operational_receipts_created':False,'source_changed':False}));return
    if checks.norm(os.environ.get('HERMES_HOME'))!=checks.norm(str(control/'helper-home')) or os.environ.get('PYTHONPATH'):
        raise ValueError('isolated_recovery_controller_environment_required')
    def read_ref(binding):
        path=Path(binding['path']).resolve()
        if not path.is_relative_to(checks.BASE.parent.resolve()):raise ValueError('private_reference_required')
        return recovery.read_bound(path,binding['sha256'])
    intent=read_ref(r['intent']);manifest=read_ref(r['scheduler_manifest'])
    request_path=control/'SOURCE_STOP_REQUESTED';stop_path=control/'source-stop-receipt.json'
    child_path=control/'source-child-inventory.json';accepted_path=control/'accepted-work-closure.json'
    task_path=control/'original-task-states.json';watcher_path=control/'WATCHER-PAUSED.json';drain_path=control/'owned-drains.json'
    bindings={name:ref(path) for name,path in [('request',request_path),('stop',stop_path),('children',child_path),
        ('accepted',accepted_path),('tasks',task_path),('watcher',watcher_path),('drains',drain_path)]}
    loaded={k:read_ref(v) for k,v in bindings.items()}
    tasks=loaded['tasks']
    if len(tasks)!=21 or len({x['name'] for x in tasks})!=21 or {x['name'] for x in tasks}!={x['name'] for x in manifest['tasks']}:
        raise ValueError('actual_original_21_task_states_required')
    if {x['name'] for x in c['roots']}!=set(capture.NAMES):raise ValueError('six_current_roots_required')
    frozen_c,frozen_r=freeze_documents(c,r,intent=intent,intent_sha=r['intent']['sha256'],
        stop=loaded['stop'],stop_sha=bindings['stop']['sha256'],request=loaded['request'],
        inventory=loaded['children'],inventory_sha=bindings['children']['sha256'],accepted=loaded['accepted'],
        accepted_ref=bindings['accepted'],tasks_sha=bindings['tasks']['sha256'],watcher_pause=bindings['watcher'],
        owned_drains=bindings['drains'],now=time.time())
    def gate():
        if any((control/n).exists() for n in ('MAC_EVER_ACTIVATED','SOURCE_RECOVERY_STARTED')):
            raise ValueError('activation_or_source_recovery_invalidates_cold_plan')
        for binding in bindings.values():read_ref(binding)
        FenceReader(control,r['scheduler_manifest']).assert_fenced()
        remote=checks.collect_remote();source=checks.collect_source(intent,loaded['stop'])
        plan=checks.build_plan(intent,loaded['stop'],r['intent']['sha256'],source,remote,now=time.time(),activated=False)
        if not plan['ready'] or any(x['method'] in ('reuse_verified_replacement','preserve_unaffected') for x in plan['steps']):
            raise ValueError('fresh_actual_source_closure_required')
        helper=r['watcher_helper'];path=Path(helper['path']).resolve()
        if not path.is_relative_to(checks.BASE.parent.resolve()) or ref(path)['sha256']!=helper['sha256']:
            raise ValueError('owned_watcher_helper_changed')
        spec=importlib.util.spec_from_file_location('freeze_owned_watcher',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
        w=m.operate(read_ref(r['browser']),'inspect',watcher_path)['readback']
        if w.get('enabled') is not False or w.get('pauseOwnedByReceipt') is not True or w.get('deepRunning') is not False:
            raise ValueError('owned_watcher_pause_required')
    gate()
    if args.verify_only:
        print(json.dumps({'operational_plan_ready':True,'operational_receipts_created':False,'source_changed':False}));return
    if any((control/n).exists() for n in ('recovery-inputs.json','closed-capture-plan.json')):
        raise ValueError('inspect_existing_freeze_before_retry')
    recovery.write_new(control/'recovery-inputs.json',frozen_r)
    recovery_ref=ref(control/'recovery-inputs.json')
    adapter=recovery.WindowsAdapter(control,recovery_ref['sha256'],bindings['stop']['sha256'])
    adapter.gate();gate()
    recovery.write_new(control/'closed-capture-plan.json',frozen_c)
    print(json.dumps({'recovery_inputs':recovery_ref,'closed_capture_plan':ref(control/'closed-capture-plan.json'),
                      'stop_sha256':bindings['stop']['sha256'],'source_changed':False,'production_activated':False}))


if __name__=='__main__':main()
