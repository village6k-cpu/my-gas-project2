"""One transition lock for native closure/activation and source voice renewal.

Every controller publishing SOURCE-CLOSED, ACTIVATION, or the native voice phase
must hold PhaseTransitionLock across its state checks and atomic publication.
This module never creates activation or closure authority itself.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import time


class PhaseBusy(RuntimeError):pass


class PhaseTransitionLock:
    def __init__(self,root,*,timeout=2):
        path=Path(root)/'state/voice-ingress-v1/phase-transition.lock'
        if path.is_symlink():raise ValueError('linked_native_phase_lock')
        self.fd=os.open(path,os.O_CREAT|os.O_RDWR,0o600)
        if os.fstat(self.fd).st_size==0:os.write(self.fd,b'0');os.fsync(self.fd)
        deadline=time.monotonic()+timeout
        while True:
            try:
                if os.name=='nt':
                    import msvcrt
                    os.lseek(self.fd,0,os.SEEK_SET);msvcrt.locking(self.fd,msvcrt.LK_NBLCK,1)
                else:
                    import fcntl
                    fcntl.flock(self.fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic()>=deadline:
                    os.close(self.fd);self.fd=None
                    raise PhaseBusy('native_transition_in_progress') from None
                time.sleep(.01)
    def close(self):
        if self.fd is None:return
        if os.name=='nt':
            import msvcrt
            os.lseek(self.fd,0,os.SEEK_SET);msvcrt.locking(self.fd,msvcrt.LK_UNLCK,1)
        else:
            import fcntl
            fcntl.flock(self.fd,fcntl.LOCK_UN)
        os.close(self.fd);self.fd=None
    def __enter__(self):return self
    def __exit__(self,*_):self.close()


def publish_source_phase(root,phase,intake_config_sha256,previous_controller_sha256):
    root=Path(root).resolve();state=root/'state/voice-ingress-v1'
    phase=json.loads(json.dumps(phase,allow_nan=False))
    if (phase.get('schema')!='village-voice-phase/v1' or phase.get('mode') not in ('hold','windows')
            or not re.fullmatch('[a-f0-9]{64}',str(phase.get('controller_config_sha256','')))):
        raise ValueError('invalid_bounded_source_phase')
    if phase['mode']=='windows':
        owners=phase.get('effective_owners',{})
        if (set(owners)!={'root','voice'} or any(type(r.get('pid')) is not int or r['pid']<=0
                or type(r.get('started')) not in (int,float) or not math.isfinite(r['started'])
                or r['started']<=0 for r in owners.values())):
            raise ValueError('effective_source_identities_required')
    with PhaseTransitionLock(root):
        raw=(state/'config.json').read_bytes();cfg=json.loads(raw)
        prior=json.loads((state/'phase.json').read_text(encoding='utf-8'))
        if (hashlib.sha256(raw).hexdigest()!=intake_config_sha256
                or any(d.get('epoch')!=phase.get('epoch') or d.get('source')!=phase.get('source') for d in (cfg,prior))):
            raise ValueError('native_intake_namespace_changed')
        if ((root/'ACTIVATION.json').exists() or (root/'SOURCE-CLOSED.json').exists()
                or not (root/'MIGRATION-INACTIVE').is_file() or prior.get('mode')=='mac'):
            return {'renewed':False,'reason':'native_or_closed'}
        if prior.get('controller_config_sha256') not in (None,phase['controller_config_sha256'],previous_controller_sha256):
            raise ValueError('different_source_controller_is_authoritative')
        if phase['mode']=='windows':phase['verified_unix']=time.time()
        else:phase.pop('verified_unix',None)
        target=state/'phase.json';temporary=state/'phase.controller.tmp'
        with temporary.open('w',encoding='utf-8') as f:
            json.dump(phase,f);f.flush();os.fsync(f.fileno())
        temporary.chmod(0o600);os.replace(temporary,target)
        if os.name=='posix':
            fd=os.open(state,os.O_RDONLY|os.O_DIRECTORY)
            try:os.fsync(fd)
            finally:os.close(fd)
        return {'renewed':True,'mode':phase['mode']}


def recover_source_phase(root,authorization,*,is_inactive):
    """Revoke one bound preactivation closure after all five backends recover.

    The authenticated Windows recovery parent supplies the actual bound receipt
    hashes. This function neither starts a service nor grants a Windows lease.
    It archives the exact closure and leaves HOLD for the new source controller.
    """
    auth=json.loads(json.dumps(authorization,allow_nan=False));root=Path(root).resolve()
    state=root/'state/voice-ingress-v1';closure=root/'SOURCE-CLOSED.json'
    hashes=('inputs_sha256','intent_sha256','stop_sha256','backends_sha256',
            'intake_config_sha256','previous_controller_sha256','controller_config_sha256')
    if (auth.get('schema')!='village-current-voice-recovery/v1'
            or any(not re.fullmatch('[a-f0-9]{64}',str(auth.get(k,''))) for k in hashes)
            or (auth.get('closure_sha256') is not None
                and not re.fullmatch('[a-f0-9]{64}',str(auth['closure_sha256'])))):
        raise ValueError('bound_voice_recovery_authorization_required')
    encoded=json.dumps(auth,sort_keys=True,separators=(',',':')).encode()
    auth_sha=hashlib.sha256(encoded).hexdigest()
    archive=state/('SOURCE-CLOSED.recovered-'+auth_sha+'.json')
    receipt=state/('SOURCE-VOICE-RECOVERED-'+auth_sha+'.json')
    result={'recovered':True,'authorization_sha256':auth_sha,'mode':'hold',
            'archived_closure':archive.relative_to(root).as_posix() if auth.get('closure_sha256') else None}
    with PhaseTransitionLock(root):
        cfg_raw=(state/'config.json').read_bytes();cfg=json.loads(cfg_raw)
        prior=json.loads((state/'phase.json').read_text(encoding='utf-8'))
        if ((root/'ACTIVATION.json').exists() or not (root/'MIGRATION-INACTIVE').is_file()
                or prior.get('mode')=='mac' or is_inactive() is not True):
            raise ValueError('native_activation_or_owners_forbid_source_recovery')
        if (hashlib.sha256(cfg_raw).hexdigest()!=auth['intake_config_sha256']
                or any(d.get('epoch')!=auth.get('epoch') or d.get('source')!=auth.get('origin_source') for d in (cfg,prior))
                or prior.get('controller_config_sha256') not in
                    (auth['previous_controller_sha256'],auth['controller_config_sha256'])):
            raise ValueError('original_voice_namespace_or_controller_changed')
        if any(p.is_symlink() for p in (closure,archive,receipt)):
            raise ValueError('linked_voice_recovery_artifact')
        expected={'schema':'village-current-source-closure/v1','intent_sha256':auth['intent_sha256'],
                  'stop_sha256':auth['stop_sha256'],'epoch':auth['epoch'],'source':auth['origin_source']}
        if closure.exists():
            raw=closure.read_bytes()
            if (auth.get('closure_sha256') is None or hashlib.sha256(raw).hexdigest()!=auth['closure_sha256']
                    or json.loads(raw)!=expected or archive.exists()):
                raise ValueError('unowned_source_closure_preserved')
        elif auth.get('closure_sha256') is not None:
            if not archive.is_file() or hashlib.sha256(archive.read_bytes()).hexdigest()!=auth['closure_sha256']:
                raise ValueError('owned_source_closure_missing_without_archive')
        if receipt.exists():
            if json.loads(receipt.read_text())!=result:raise ValueError('different_voice_recovery_receipt')
            return result
        hold={'schema':'village-voice-phase/v1','epoch':auth['epoch'],'source':auth['origin_source'],
              'mode':'hold','controller_config_sha256':auth['controller_config_sha256']}
        pending=state/'phase.recovery.tmp'
        with pending.open('w',encoding='utf-8') as f:
            json.dump(hold,f);f.flush();os.fsync(f.fileno())
        pending.chmod(0o600);os.replace(pending,state/'phase.json')
        if closure.exists():os.rename(closure,archive)
        with receipt.open('x',encoding='utf-8') as f:
            json.dump(result,f);f.flush();os.fsync(f.fileno())
        receipt.chmod(0o600)
        if os.name=='posix':
            for directory in (state,root):
                fd=os.open(directory,os.O_RDONLY|os.O_DIRECTORY)
                try:os.fsync(fd)
                finally:os.close(fd)
        return result
