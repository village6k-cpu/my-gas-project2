"""Five-service stop transaction, separate from scheduler and data transport.

The adapter must collect fresh real gates and verify each exact process birth.
No launches, stops, task mutations or data writes occur on import. Failure after
the durable stop intent always leaves the complete pre-stop child inventory and
an honest partial receipt; it never restores ingress or starts another consumer.
"""
import copy
import re
import migration_source_recovery as checks

ROLES=checks.ROLES


def validate_inventory(intent, inventory):
    if (sorted(r.get('role') for r in intent.get('profiles',[]))!=sorted(ROLES)
            or set(inventory)!=set(ROLES)):
        raise ValueError('complete_five_owner_child_inventory_required')
    seen={p['pid'] for p in intent['profiles']}
    for role,children in inventory.items():
        if not isinstance(children,list):raise ValueError('recursive_child_inventory_required')
        for child in children:
            if not checks.identity(child) or child['pid'] in seen:
                raise ValueError('invalid_or_shared_child_identity')
            seen.add(child['pid'])


def execute_stop(adapter):
    """Prepared fences must already be active; no default verified booleans.

    The bridge producer fence precedes worker drain. The participant connects to
    that same owner, closes HTTP only after accepted worker results have settled,
    and acknowledges the exact published observation before the parent may stop.
    """
    adapter.gate('before_participant')
    inventory=adapter.inventory_children()
    validate_inventory(adapter.intent,inventory)
    inventory_sha=adapter.persist('source-child-inventory.json',inventory)
    accepted_sha=None

    def receipt(closed):
        rows=[]
        for old in adapter.intent['profiles']:
            role=old['role']
            try:state=adapter.classify_tree(role,inventory[role])
            except Exception:state='unknown'
            if state not in ('stopped','unaffected','partial','unknown'):
                state='unknown'
            rows.append({'role':role,'pid':old['pid'],'started':old['started'],
                         'status':state,'children_inventory_complete':True,
                         'children':inventory[role]})
        all_closed=all(r['status']=='stopped' for r in rows)
        return {'schema':1,'intent_sha256':adapter.intent_sha,'stopped_at':adapter.clock(),
                'accepted_work_sha256':accepted_sha,'child_inventory_sha256':inventory_sha,
                'profiles':rows,'source_closed':closed and all_closed}

    try:
        adapter.start_bridge_participant()
        ready=adapter.wait_bridge_ready()
        adapter.gate('before_stop_intent')
        accepted=adapter.accepted_work(ready)
        accepted_sha=adapter.persist('accepted-work-closure.json',accepted)
        # This marker precedes every termination attempt, including a failed one.
        # It is published atomically, after fsync; check its actual presence if
        # the publishing call itself reports an uncertain failure.
        adapter.persist('SOURCE_STOP_REQUESTED',{
            'schema':'village-source-stop-request/v1','intent_sha256':adapter.intent_sha,
            'child_inventory_sha256':inventory_sha,'accepted_work_sha256':accepted_sha,
            'bridge_observation_sha256':ready['sha256'],'requested_at':adapter.clock()})
        adapter.command_bridge_stop(ready)
        adapter.wait_bridge_ack(ready)
        for role in ROLES:
            adapter.gate('before_terminate:'+role)
            adapter.terminate_owned_tree(role,inventory[role])
            if adapter.classify_tree(role,inventory[role])!='stopped':
                raise RuntimeError(role+':source_tree_not_closed')
            adapter.persist('source-stop-progress-'+role+'.json',
                            {'role':role,'closed':True,'intent_sha256':adapter.intent_sha})
            if role=='bridge':adapter.wait_bridge_exit(ready)
        adapter.verify_all_closed()
        result=receipt(True)
        if result['source_closed'] is not True:raise RuntimeError('source_closure_changed')
    except BaseException:
        # Preserve the initial failure without occupying the canonical receipt.
        # A fresh explicit reconciliation must adjudicate partial/unknown trees
        # before the existing rollback consumer can use a canonical receipt.
        if adapter.stop_request_present():adapter.persist('source-stop-partial-receipt.json',receipt(False))
        else:
            # Abort only the owned bridge close. Producer/watchdog/profile/voice
            # fences stay engaged for the separate all-backends recovery gate.
            try:adapter.abort_bridge_participant()
            except Exception as error:
                adapter.persist('bridge-abort-failed.json',{'error':str(error),'source_stop_authorized':False})
        raise
    adapter.persist('source-stop-receipt.json',result)
    return result


def reconcile_receipt(intent,partial,partial_sha,intent_sha,snapshot,remote,*,now,activated):
    """Read-only adjudication; never relabel a still-partial tree as closed.

    A subsequently exited child may now prove a stopped tree. An all-live source
    may prove an abort before any actual termination. Both require the existing
    recovery planner's full current contracts, child identities, ports, native
    inactivity and detached-store checks. The original failed receipt is kept.
    """
    result={'ready':False,'receipt':None,'errors':[],'process_changes':False}
    try:
        if (not re.fullmatch('[a-f0-9]{64}',partial_sha) or partial.get('schema')!=1
                or partial.get('intent_sha256')!=intent_sha
                or sorted(r['role'] for r in partial['profiles'])!=sorted(ROLES)
                or snapshot.get('errors')!=[] or not checks.fresh(snapshot.get('observed_at'),now)):
            raise ValueError('fresh_bound_partial_stop_observation_required')
        proposed=copy.deepcopy(partial);proposed['reconciled_from_sha256']=partial_sha
        for row in proposed['profiles']:
            owner=next(r for r in intent['profiles'] if r['role']==row['role'])
            if (not checks.same_identity(owner,row) or row.get('children_inventory_complete') is not True
                    or not isinstance(row.get('children'),list) or any(not checks.identity(c) for c in row['children'])):
                raise ValueError('original_complete_child_inventory_required')
            live=[any(checks.same_identity(p,old) for p in snapshot['processes']) for old in [owner]+row['children']]
            if all(live):row['status']='unaffected'
            elif not any(live):row['status']='stopped'
            else:raise ValueError(row['role']+':remaining_old_tree_requires_owned_closure')
        proposed['stop_attempt_only']=all(r['status']=='unaffected' for r in proposed['profiles'])
        proposed['source_closed']=all(r['status']=='stopped' for r in proposed['profiles'])
        plan=checks.build_plan(intent,proposed,intent_sha,snapshot,remote,now=now,activated=activated)
        if not plan['ready']:result['errors']=plan['errors'];return result
        result.update(ready=True,receipt=proposed)
    except (KeyError,TypeError,ValueError) as error:result['errors'].append(str(error))
    return result
