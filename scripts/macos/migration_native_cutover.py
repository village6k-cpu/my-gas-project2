"""Bound native permission, pre-bootstrap revocation and one-shot activation.

The platform adapter must prove actual ownership and source closure. No service
commands run on import. Once a bootstrap request is durable, Windows rollback
is forbidden: an uncertain native request may have accepted new business work.
"""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import uuid

from migration_voice_phase import PhaseTransitionLock

GATES=('backups_verified','model_quality_verified','performance_verified',
       'coexistence_verified','windows_consumers_drained','final_state_reconciled','rollback_ready')
CORE=('chrome','bridge','root','worker','voice','relay')
AFTER_CORE=('watcher','inventory-brief','ledger-sheet-sync','preflight','return-issues',
            'setmaster-reconcile','tax-tracks-sync','weekly-brain-card','corrections-nightly',
            'inventory-stock-relay')
SERVICES=CORE+AFTER_CORE


def encode(doc):return json.dumps(doc,sort_keys=True,separators=(',',':'),ensure_ascii=False,allow_nan=False).encode()
def digest(path):
    with Path(path).open('rb') as f:return hashlib.file_digest(f,'sha256').hexdigest()
def reference(path):return {'path':str(Path(path).absolute()),'sha256':digest(path)}


def sync_dir(path):
    if os.name=='posix':
        fd=os.open(path,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(fd)
        finally:os.close(fd)


def write_new(path,doc):
    path=Path(path)
    if path.is_symlink():raise ValueError('linked_cutover_artifact')
    raw=encode(doc);temporary=path.with_name('.'+path.name+'.publishing-'+uuid.uuid4().hex)
    with temporary.open('xb') as f:
        if f.write(raw)!=len(raw):raise OSError('short_cutover_artifact_write')
        f.flush();os.fsync(f.fileno())
    temporary.chmod(0o600)
    # Hard-link publication is atomic and never replaces an existing target.
    # A crash leaves either no final name or the complete fsynced document.
    os.link(temporary,path);sync_dir(path.parent)
    temporary.unlink();sync_dir(path.parent)


class Cutover:
    def __init__(self,root,plan_path,plan_sha256,adapter):
        self.root=Path(root).resolve();self.path=Path(plan_path).absolute()
        self.pin=plan_sha256;self.adapter=adapter;self.d=self.path.parent
        self.state=self.root/'state/voice-ingress-v1'
        if self.d!=self.root/'state/cutover-actual-v1':raise ValueError('fixed_cutover_directory_required')

    def safe(self,path):
        path=Path(path).absolute()
        if not path.is_relative_to(self.root):raise ValueError('cutover_path_outside_installation')
        for node in (path,)+tuple(path.parents):
            if node.is_symlink():raise ValueError('linked_cutover_artifact')
            if node==self.root:break
        return path

    def bound(self,ref):
        if not re.fullmatch('[a-f0-9]{64}',str(ref.get('sha256',''))):raise ValueError('cutover_hash_required')
        path=self.safe(ref['path'])
        if digest(path)!=ref['sha256']:raise ValueError('cutover_evidence_changed')
        return json.loads(path.read_text(encoding='utf-8-sig'))

    def load(self):
        p=self.bound({'path':str(self.path),'sha256':self.pin})
        if (p.get('schema')!='village-native-cutover-plan/v1' or p.get('candidate')!=str(self.root)
                or not isinstance(p.get('epoch'),str) or not p['epoch'] or not isinstance(p.get('source'),dict)
                or any(not re.fullmatch('[a-f0-9]{64}',str(p.get(k,'')))
                       for k in ('intent_sha256','stop_sha256','inactive_sha256'))
                or set(p.get('gates',{}))!=set(GATES)):
            raise ValueError('complete_bound_cutover_plan_required')
        manifest=self.bound(p['manifest']);cfg=self.bound(p['intake_config'])
        if (self.safe(p['manifest']['path'])!=self.root/'control/runtime.json'
                or set(manifest.get('services',{}))!=set(SERVICES)
                or self.safe(p['intake_config']['path'])!=self.state/'config.json'
                or cfg.get('epoch')!=p['epoch'] or cfg.get('source')!=p['source']
                or self.safe(p['previous_phase']['path'])!=self.state/'phase.json'):
            raise ValueError('wrong_cutover_manifest_or_intake_namespace')
        for gate,ref in p['gates'].items():
            proof=self.bound(ref)
            if (proof.get('schema')!='village-native-cutover-gate/v1' or proof.get('gate')!=gate
                    or proof.get('passed') is not True or proof.get('intent_sha256')!=p['intent_sha256']
                    or proof.get('stop_sha256')!=p['stop_sha256'] or not isinstance(proof.get('evidence'),list)):
                raise ValueError('wrong_or_failed_cutover_gate')
            for item in proof['evidence']:
                path=self.safe(item['path'])
                if digest(path)!=item['sha256']:raise ValueError('underlying_cutover_evidence_changed')
        return p

    def outputs(self,p):
        closure={'schema':'village-current-source-closure/v1','intent_sha256':p['intent_sha256'],
                 'stop_sha256':p['stop_sha256'],'epoch':p['epoch'],'source':p['source']}
        closure_sha=hashlib.sha256(encode(closure)).hexdigest()
        activation={'schema':'village-native-activation/v1','manifest_sha256':p['manifest']['sha256'],
                    'source_closed_sha256':closure_sha,'cutover_plan_sha256':self.pin,
                    'gates':dict.fromkeys(GATES,True),'gate_evidence':p['gates']}
        return closure,activation

    def phase_unchanged(self,p):
        prior=self.bound(p['previous_phase'])
        if prior.get('mode')!='hold' or prior.get('epoch')!=p['epoch'] or prior.get('source')!=p['source']:
            raise ValueError('owned_hold_phase_required')

    def assert_permission(self,p):
        for name,doc in zip(('SOURCE-CLOSED.json','ACTIVATION.json'),self.outputs(p)):
            if self.safe(self.root/name).read_bytes()!=encode(doc):raise ValueError('cutover_permission_changed')
        if self.safe(self.root/'MIGRATION-INACTIVE').exists():raise ValueError('native_still_inactive')
        journal=json.loads(self.safe(self.d/'PERMISSION-INTENT.json').read_text())
        if journal.get('plan_sha256')!=self.pin:raise ValueError('different_permission_intent')

    def prepare(self):
        with PhaseTransitionLock(self.root):
            p=self.load();self.phase_unchanged(p);self.adapter.preactivation()
            inactive=self.safe(self.root/'MIGRATION-INACTIVE')
            if digest(inactive)!=p['inactive_sha256']:raise ValueError('inactive_marker_changed')
            if any(self.safe(self.root/name).exists() for name in ('ACTIVATION.json','SOURCE-CLOSED.json')):
                raise ValueError('existing_native_authority_preserved')
            self.adapter.final_source_closed()
            write_new(self.d/'PERMISSION-INTENT.json',{'plan_sha256':self.pin,
                'inactive_b64':base64.b64encode(inactive.read_bytes()).decode()})
            # Any interruption from this point can be revoked only with no
            # bootstrap intent, all native labels absent and all service locks.
            closure,activation=self.outputs(p)
            write_new(self.root/'SOURCE-CLOSED.json',closure)
            write_new(self.root/'ACTIVATION.json',activation)
            inactive.unlink();sync_dir(self.root)
            write_new(self.d/'PERMISSION-GRANTED.json',{'plan_sha256':self.pin,'services_started':False})
            return {'permission_granted':True,'services_started':False}

    def revoke(self):
        with PhaseTransitionLock(self.root),self.adapter.hold_all_service_locks():
            p=self.load();self.phase_unchanged(p)
            if any(self.safe(self.d/name).exists() for name in ('BOOTSTRAP-REQUESTED.json','MAC-READY.json')):
                raise ValueError('bootstrap_requested_no_blind_source_rollback')
            self.adapter.preactivation(require_browser=False)
            journal=json.loads(self.safe(self.d/'PERMISSION-INTENT.json').read_text())
            inactive_raw=base64.b64decode(journal['inactive_b64'],validate=True)
            if journal.get('plan_sha256')!=self.pin or hashlib.sha256(inactive_raw).hexdigest()!=p['inactive_sha256']:
                raise ValueError('unowned_permission_intent')
            pairs=list(zip(('SOURCE-CLOSED.json','ACTIVATION.json'),self.outputs(p)))
            # Validate the complete transaction before moving either artifact.
            for name,doc in pairs:
                for path in (self.root/name,self.d/('REVOKED-'+name)):
                    path=self.safe(path)
                    if path.exists() and path.read_bytes()!=encode(doc):raise ValueError('unowned_permission_preserved')
                if (self.root/name).exists() and (self.d/('REVOKED-'+name)).exists():raise ValueError('duplicate_permission_artifact')
            inactive=self.safe(self.root/'MIGRATION-INACTIVE')
            if inactive.exists() and inactive.read_bytes()!=inactive_raw:raise ValueError('changed_inactive_marker_preserved')
            for name,_ in pairs:
                source=self.root/name
                if source.exists():os.rename(source,self.d/('REVOKED-'+name))
            if not inactive.exists():
                with inactive.open('xb') as f:f.write(inactive_raw);f.flush();os.fsync(f.fileno())
                inactive.chmod(0o600)
            sync_dir(self.root);sync_dir(self.d)
            result={'revoked':True,'plan_sha256':self.pin,'bootstrap_requested':False}
            receipt=self.d/'PERMISSION-REVOKED.json'
            if receipt.exists():
                if json.loads(receipt.read_text())!=result:raise ValueError('revocation_receipt_changed')
            else:write_new(receipt,result)
            return result

    def start(self):
        with PhaseTransitionLock(self.root):
            p=self.load();self.phase_unchanged(p);self.assert_permission(p)
            if self.safe(self.d/'PERMISSION-REVOKED.json').exists():raise ValueError('permission_revoked')
            if self.safe(self.d/'BOOTSTRAP-REQUESTED.json').exists():raise ValueError('never_repeat_uncertain_bootstrap')
            self.adapter.preactivation();self.adapter.final_source_closed()
            write_new(self.d/'BOOTSTRAP-REQUESTED.json',{'plan_sha256':self.pin,
                'services':list(SERVICES),'automatic_source_rollback_allowed':False})
        # No automatic retry from here, including a lost launchctl response.
        self.adapter.handoff_chrome()
        for name in CORE:self.adapter.bootstrap(name)
        self.adapter.core_ready()
        with PhaseTransitionLock(self.root):
            p=self.load();self.phase_unchanged(p);self.assert_permission(p)
            phase={'schema':'village-voice-phase/v1','epoch':p['epoch'],'source':p['source'],
                'mode':'mac','manifest_sha256':p['manifest']['sha256'],
                'source_closed_sha256':digest(self.root/'SOURCE-CLOSED.json')}
            temp=self.safe(self.state/'phase.cutover.tmp');write_new(temp,phase)
            os.replace(temp,self.state/'phase.json');sync_dir(self.state)
        for name in AFTER_CORE:self.adapter.bootstrap(name)
        observed=self.adapter.all_ready()
        result={'started':True,'plan_sha256':self.pin,'observed':observed,'ordinary_business_completion_verified':False}
        write_new(self.d/'MAC-READY.json',result)
        return result
