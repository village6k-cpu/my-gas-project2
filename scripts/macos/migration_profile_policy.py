"""Bind a reviewed profile blueprint to the final raw manifest and owned drains.

This pure binder does not prove source closure, copy profiles, omit raw bytes or
grant activation. The caller must independently verify the complete cold capture
and restoration provenance before using its result with profile assembly.
"""
from copy import deepcopy
import math
from pathlib import PureWindowsPath
import re
from migration_profile_overlay import relative


def pin(value):
    return isinstance(value,str) and re.fullmatch('[a-f0-9]{64}',value) is not None


def freeze_policy(blueprint,manifest,drains,intent,intent_sha,manifest_ref):
    if (blueprint.get('schema')!='village-current-profile-assembly-policy-blueprint/v1'
            or set(blueprint.get('profiles',{}))!={'root','worker'}
            or blueprint.get('unmapped_execution_directories')
            or blueprint.get('live_source_drift_to_reconcile')
            or not pin(intent_sha) or not pin(manifest_ref.get('sha256'))
            or not isinstance(manifest_ref.get('path'),str)
            or drains.get('schema')!='village-owned-drains/v1'
            or drains.get('intent_sha256')!=intent_sha
            or not isinstance(drains.get('migration_id'),str) or not drains['migration_id']
            or sorted(r.get('role') for r in drains.get('profiles',[]))!=['root','worker']):
        raise ValueError('reviewed_blueprint_and_actual_owned_drains_required')
    files={}
    for row in manifest['files']:
        name=relative(row['path'])
        if name in files or not pin(row.get('sha256')):raise ValueError('unique_final_manifest_required')
        files[name]=row['sha256']
    profiles=deepcopy(blueprint['profiles'])
    for role,rules in profiles.items():
        if rules.get('excluded'):raise ValueError('unreviewed_profile_omission')
        prefix=role+'-profile/'
        required={}
        def require(name,expected):
            relative(name)
            if (not pin(expected) or (name in required and required[name]!=expected)
                    or files.get(prefix+name)!=expected):
                raise ValueError('source_binding_changed:'+role+':'+name)
            required[name]=expected
        for name,expected in rules['source_anchors'].items():require(name,expected)
        for name,row in rules['overrides'].items():require(name,row['source_sha256'])
        for name,row in rules['controls'].items():
            if row.get('source_absent') is True:
                relative(name)
                if prefix+name in files or 'source_sha256' in row:raise ValueError('source_absent_control_changed')
            else:require(name,row.get('source_sha256'))
        for row in rules['native_only']:
            if prefix+relative(row['path']) in files:raise ValueError('native_only_collides_with_latest_source')
        owners=[r for r in intent['profiles'] if r.get('role')==role]
        if len(owners)!=1:raise ValueError('exact_source_profile_owner_required')
        owner=owners[0];row=next(r for r in drains['profiles'] if r['role']==role)
        identity={k:owner[k] for k in ('pid','started')}
        if (type(identity['pid']) is not int or identity['pid']<=0
                or type(identity['started']) not in (int,float) or not math.isfinite(identity['started']) or identity['started']<=0
                or row.get('owner')!=identity or row.get('created') is not True or row.get('original_absent') is not True
                or PureWindowsPath(row['path'])!=PureWindowsPath(owner['home'])/'.drain_request.json'
                or not pin(row.get('sha256')) or files.get(prefix+'.drain_request.json')!=row['sha256']):
            raise ValueError('actual_owned_profile_drain_required')
        rules['owned_controls']={'.drain_request.json':{'sha256':row['sha256'],
            'owner':identity,'migration_id':drains['migration_id']}}
    return {'schema':'village-current-profile-assembly-policy/v1','candidate':blueprint['candidate'],
            'profiles':profiles,'session_mappings':deepcopy(blueprint['session_mappings']),
            'cron':deepcopy(blueprint['cron']),'transport_manifest':deepcopy(manifest_ref)}
