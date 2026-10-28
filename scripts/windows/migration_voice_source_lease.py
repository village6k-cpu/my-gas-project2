"""Bounded preactivation voice authority with fresh source-owner discovery.

No business requests, queue changes or routing operations. A trusted controller
must provision the hash-bound private configuration. Routine source restarts may
be followed only after exact execution contracts, gateway state and listener
owners agree. Planned migration drains terminate this controller. Native time
alone starts the fifteen-second authority lease.
"""
import argparse
import base64
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.request import urlopen
import migration_source_recovery as checks


class LeaseHeld(RuntimeError):pass


def digest(path):return hashlib.sha256(Path(path).read_bytes()).hexdigest()


class WriterLock:
    def __init__(self,path):
        self.fd=None;path=Path(path)
        if path.is_symlink():raise LeaseHeld('linked_writer_lock')
        try:
            fd=os.open(path,os.O_CREAT|os.O_EXCL|os.O_RDWR,0o600)
        except FileExistsError:pass
        else:
            try:os.write(fd,b'0');os.fsync(fd)
            finally:os.close(fd)
        self.fd=os.open(path,os.O_RDWR)
        try:
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(self.fd,msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(self.fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:
            os.close(self.fd);self.fd=None
            raise LeaseHeld('another_voice_source_controller_is_live') from None
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


def select_current_sources(contracts,observation,*,now):
    if (set(contracts)!={'root','voice'} or not checks.number(observation.get('observed_unix'))
            or not 0<=now-observation['observed_unix']<=10
            or observation.get('backend_health') is not True):
        raise LeaseHeld('fresh_source_observation_required')
    selected={};processes=observation['processes']
    for role,expected in contracts.items():
        matches=[p for p in processes if checks.same_contract(p,expected)]
        if len(matches)!=1 or not checks.identity(matches[0]):raise LeaseHeld('source_owner_missing_or_ambiguous')
        owner=matches[0]
        for p in processes:
            if checks.same_identity(p,owner) or checks.owned_descendant(p,owner):continue
            if (checks.norm(p.get('exe'))==checks.norm(expected['exe']) and p.get('home')==expected['home']
                    and checks.same_entrypoint(p,expected)):
                raise LeaseHeld('other_source_candidate_has_wrong_contract')
        selected[role]={'pid':owner['pid'],'started':owner['started']}
    state=observation['root_state'];root=selected['root']
    if (state.get('pid')!=root['pid'] or state.get('start_time')!=round(root['started']*100)
            or state.get('gateway_state')!='running'
            or any(state.get('platforms',{}).get(p,{}).get('state')!='connected' for p in ('slack','webhook'))
            or observation['listeners'].get('8644')!=[root['pid']]
            or observation['listeners'].get('8788')!=[selected['voice']['pid']]):
        raise LeaseHeld('gateway_state_or_listener_owner_changed')
    return selected


def recovery_records(config):
    prior=config.get('prior_recovered_stops',[])
    if not isinstance(prior,list) or any(not isinstance(r,dict) or set(r)!={'marker','authorization'} for r in prior):
        raise LeaseHeld('bound_prior_recoveries_required')
    records=[(r['marker'],r['authorization'],True) for r in prior]
    if config.get('historical_stop_marker') is not None:
        records.append((config['historical_stop_marker'],config.get('recovery_authorization'),False))
    paths=[]
    for marker,auth,_ in records:
        if (not isinstance(marker,dict) or set(marker)!={'path','sha256'} or not isinstance(auth,dict)
                or not isinstance(marker['path'],str) or not isinstance(marker['sha256'],str)):
            raise LeaseHeld('bound_recovery_authorization_required')
        paths.append(checks.norm(str(Path(marker['path']).resolve())))
    if len(paths)!=len(set(paths)):raise LeaseHeld('duplicate_historical_stop_authorization')
    return records


def carry_prior_recoveries(config):
    records=recovery_records(config)
    if any(not isinstance(auth.get('recovered'),dict) for _,auth,_ in records):
        raise LeaseHeld('completed_source_recovery_receipt_required')
    return deepcopy([{'marker':marker,'authorization':auth} for marker,auth,_ in records])


def validate_stop_markers(observed,allowed,*,prior=None):
    records=recovery_records({'historical_stop_marker':allowed,'recovery_authorization':{},
                              'prior_recovered_stops':[] if prior is None else prior})
    expected={marker['path']:marker['sha256'] for marker,_,_ in records}
    if observed!=expected:raise LeaseHeld('source_stop_marker_requires_new_authorization')


def phase_payload(config,mode,owners,controller_sha):
    if mode not in ('hold','windows'):raise ValueError('unapproved_source_phase')
    result={'schema':'village-voice-phase/v1','epoch':config['epoch'],'source':config['origin_source'],
            'mode':mode,'controller_config_sha256':controller_sha}
    if mode=='windows':
        if set(owners)!={'root','voice'} or any(not checks.identity(r) for r in owners.values()):
            raise ValueError('exact_effective_owners_required')
        result['effective_owners']=owners
    return result


def validate_private_configuration(config,base):
    def read(ref):
        path=Path(ref['path']).resolve()
        if (not path.is_relative_to(base.resolve()) or path.is_symlink()
                or digest(path)!=ref['sha256']):raise LeaseHeld('private_proof_binding_changed')
        return json.loads(path.read_text(encoding='utf-8-sig'))
    if config.get('schema')!='village-voice-source-controller/v1':raise LeaseHeld('wrong_controller_schema')
    prep=read(config['intake_preparation']);template=read(config['source_template'])
    if (prep.get('schema')!='village-voice-intake-preparation/v1' or prep.get('epoch')!=config['epoch']
            or prep.get('source')!=config['origin_source'] or prep.get('config_sha256')!=config['intake_config_sha256']):
        raise LeaseHeld('original_intake_namespace_must_be_preserved')
    profiles=template.get('profiles',template.get('owners',[]))
    expected={}
    for role in ('root','worker','voice'):
        rows=[r for r in profiles if r.get('role')==role]
        if len(rows)!=1:raise LeaseHeld('current_source_template_missing')
        expected[role]=dict(rows[0])
        expected[role].setdefault('pythonpath',expected[role].get('code'))
    if set(config['contracts'])!={'root','voice'} or any(
            not checks.same_contract(config['contracts'][r],expected[r]) for r in config['contracts']):
        raise LeaseHeld('source_execution_contract_substituted')
    drains={checks.norm(str(Path(expected[r]['home'])/'.drain_request.json')) for r in ('root','worker')}
    if len(config['drain_paths'])!=2 or {checks.norm(p) for p in config['drain_paths']}!=drains:
        raise LeaseHeld('both_source_profile_drains_required')
    origin_writer=read(config['origin_lease_owner'])
    if (not checks.identity(origin_writer) or not config['prior_writers']
            or any(not checks.identity(r) for r in config['prior_writers'])
            or not any(checks.same_identity(origin_writer,r) for r in config['prior_writers'])):
        raise LeaseHeld('original_writer_closure_must_be_verified')
    for allowed,auth,completed_required in recovery_records(config):
        inputs=read(auth['inputs']);stop=read(auth['stop']);backends=read(auth['backends'])
        if (inputs.get('schema')!='village-current-recovery-inputs/v1'
                or inputs.get('stop_sha256')!=auth['stop']['sha256']
                or stop.get('schema')!=1 or stop.get('intent_sha256')!=inputs.get('intent',{}).get('sha256')
                or backends.get('schema')!='village-source-backends-recovered/v1'
                or backends.get('inputs_sha256')!=auth['inputs']['sha256']
                or backends.get('stop_sha256')!=auth['stop']['sha256']
                or backends.get('destination_ever_activated') is not False
                or sorted(r.get('role') for r in backends.get('profiles',[]))!=sorted(checks.ROLES)
                or any(r.get('state')!='running' or type(r.get('pid')) is not int or r['pid']<=0
                       or type(r.get('start_time')) is not int for r in backends['profiles'])
                or Path(allowed['path']).resolve()!=Path(auth['inputs']['path']).resolve().parent/'SOURCE_STOP_REQUESTED'
                or not Path(allowed['path']).resolve().is_relative_to(base.resolve())
                or digest(allowed['path'])!=allowed['sha256']):
            raise LeaseHeld('historical_stop_not_bound_to_actual_backend_recovery')
        if completed_required or 'recovered' in auth:
            if not isinstance(auth.get('recovered'),dict):raise LeaseHeld('completed_source_recovery_receipt_required')
            recovered=read(auth['recovered'])
            if (Path(auth['recovered']['path']).resolve()!=Path(auth['inputs']['path']).resolve().parent/'SOURCE-RECOVERED.json'
                    or recovered.get('schema')!='village-source-recovery/v1'
                    or recovered.get('stopReceiptSha256')!=auth['stop']['sha256']
                    or recovered.get('voiceDispatchRestored') is not True
                    or recovered.get('destinationEverActivated') is not False
                    or sorted(r.get('role') for r in recovered.get('profiles',[]))!=sorted(checks.ROLES)
                    or any(r.get('state')!='running' for r in recovered['profiles'])
                    or {r['role']:(r.get('pid'),r.get('start_time')) for r in recovered['profiles']}
                       !={r['role']:(r['pid'],r['start_time']) for r in backends['profiles']}):
                raise LeaseHeld('historical_stop_requires_completed_source_recovery')


def observe(contracts,root_state):
    import psutil
    measured=time.time();rows=[]
    exes={checks.norm(c['exe']) for c in contracts.values()}
    for p in psutil.process_iter(['pid','name']):
        try:
            if p.info['name'].lower() not in ('python.exe','pythonw.exe'):continue
            exe=p.exe()
            if checks.norm(exe) not in exes:continue
            env=p.environ()
            if env.get('HERMES_HOME') not in {c['home'] for c in contracts.values()}:continue
            rows.append({'pid':p.pid,'started':p.create_time(),'exe':exe,'argv':p.cmdline(),
                'cwd':p.cwd(),'home':env.get('HERMES_HOME'),'pythonpath':env.get('PYTHONPATH'),
                'ancestors':[{'pid':a.pid,'started':a.create_time()} for a in p.parents()]})
        except (psutil.Error,OSError):raise LeaseHeld('source_process_observation_incomplete') from None
    for row in rows:
        p=psutil.Process(row['pid'])
        if abs(p.create_time()-row['started'])>=.01:raise LeaseHeld('source_identity_changed_during_probe')
    # Port ownership is independent of source-candidate classification. An
    # unrelated executable/HOME must not disappear from the listener proof.
    listeners={str(port):[] for port in (8644,8788)}
    for connection in psutil.net_connections(kind='tcp'):
        if connection.status=='LISTEN' and connection.laddr.port in (8644,8788):
            if connection.laddr.ip!='127.0.0.1' or type(connection.pid) is not int:
                raise LeaseHeld('unexpected_source_listener_address_or_owner')
            listeners[str(connection.laddr.port)].append(connection.pid)
    for key in listeners:listeners[key]=sorted(set(listeners[key]))
    state=json.loads(Path(root_state).read_text(encoding='utf-8'))
    healthy=True
    for port in (8644,8788):
        with urlopen('http://127.0.0.1:'+str(port)+'/health',timeout=2) as response:
            healthy=healthy and json.load(response).get('status')=='ok'
    return {'observed_unix':measured,'processes':rows,'root_state':state,
            'listeners':listeners,'backend_health':healthy}


REMOTE_UPDATE=r'''from pathlib import Path
import base64,hashlib,importlib.util,json
C=Path('/Users/choijaehyeong/VillageMigration/20260930-windows/candidate');D=C/'state/voice-ingress-v1'
payload=json.loads(base64.b64decode(PAYLOAD));expected=payload['phase']
ref=payload['native_phase_writer'];helper=Path(ref['path']).resolve()
assert helper.is_relative_to(D) and hashlib.sha256(helper.read_bytes()).hexdigest()==ref['sha256']
spec=importlib.util.spec_from_file_location('pinned_native_phase_writer',helper)
module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
print(json.dumps(module.publish_source_phase(C,expected,payload['intake_config_sha256'],payload.get('previous_controller_sha256'))))
'''


def renew(config,phase):
    payload={'phase':phase,'intake_config_sha256':config['intake_config_sha256'],
             'previous_controller_sha256':config.get('previous_controller_sha256'),
             'native_phase_writer':config['native_phase_writer']}
    script=REMOTE_UPDATE.replace('PAYLOAD',repr(base64.b64encode(json.dumps(payload).encode()).decode()))
    command=['C:/Windows/System32/OpenSSH/ssh.exe','-o','BatchMode=yes','-o','StrictHostKeyChecking=yes',
             '-o','ConnectTimeout=8','-i',checks.SSH_KEY,checks.REMOTE_HOST,
             checks.CANDIDATE+'/venv-root/bin/python -']
    run=subprocess.run(command,input=script.encode(),capture_output=True,timeout=10)
    if run.returncode:raise LeaseHeld('native_phase_update_failed')
    return json.loads(run.stdout)


def main():
    import psutil
    if os.name!='nt':raise LeaseHeld('source_controller_requires_windows')
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config',type=Path,required=True);parser.add_argument('--config-sha',required=True)
    modes=parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--verify-only',action='store_true');modes.add_argument('--run',action='store_true')
    args=parser.parse_args();path=args.config.resolve();base=checks.BASE.resolve();directory=path.parent
    if (not path.is_relative_to(base) or path.is_symlink()
            or os.environ.get('HERMES_HOME')!=str(directory/'helper-home') or os.environ.get('PYTHONPATH')):
        raise LeaseHeld('private_isolated_controller_required')
    if digest(path)!=args.config_sha:raise LeaseHeld('controller_configuration_changed')
    config=json.loads(path.read_text(encoding='utf-8'))
    validate_private_configuration(config,base)
    for ref in config['dependencies']:
        dependency=Path(ref['path']).resolve()
        if not dependency.is_relative_to(base) or digest(dependency)!=ref['sha256']:
            raise LeaseHeld('controller_dependency_changed')
    if not any(Path(r['path']).resolve()==Path(__file__).resolve() for r in config['dependencies']):
        raise LeaseHeld('controller_code_must_be_bound')
    for old in config['prior_writers']:
        try:
            if abs(psutil.Process(old['pid']).create_time()-old['started'])<.01:
                raise LeaseHeld('previous_voice_source_writer_still_alive')
        except psutil.NoSuchProcess:pass
    if args.verify_only:
        markers={str(p.resolve()):digest(p) for p in base.glob('scheduler-fence-v*/SOURCE_STOP_REQUESTED')}
        validate_stop_markers(markers,config.get('historical_stop_marker'),prior=config.get('prior_recovered_stops'))
        if any(Path(p).exists() for p in config['drain_paths']):raise LeaseHeld('source_drain')
        owners=select_current_sources(config['contracts'],observe(config['contracts'],config['root_state']),now=time.time())
        print(json.dumps({'verified':True,'effective_owners':owners,'phase_written':False,'speech_submitted':False}))
        return 0
    with WriterLock(base/'voice-source-controller.lock'):
        while True:
            if digest(path)!=args.config_sha:raise LeaseHeld('controller_configuration_changed')
            validate_private_configuration(config,base)
            for ref in config['dependencies']:
                if digest(ref['path'])!=ref['sha256']:raise LeaseHeld('controller_dependency_changed')
            terminal=False;owners={};reason=None
            try:
                if (directory/'STOP').exists():raise LeaseHeld('operator_stop')
                markers={str(p.resolve()):digest(p) for p in base.glob('scheduler-fence-v*/SOURCE_STOP_REQUESTED')}
                validate_stop_markers(markers,config.get('historical_stop_marker'),prior=config.get('prior_recovered_stops'))
                if any(Path(p).exists() for p in config['drain_paths']):raise LeaseHeld('source_drain')
            except LeaseHeld as exc:terminal=True;reason=str(exc)
            if not terminal:
                try:owners=select_current_sources(config['contracts'],observe(config['contracts'],config['root_state']),now=time.time())
                except (LeaseHeld,OSError,ValueError,psutil.Error):reason='source_temporarily_unavailable'
            phase=phase_payload(config,'hold' if reason else 'windows',owners,args.config_sha)
            try:
                result=renew(config,phase)
                if not result.get('renewed'):terminal=True;reason='native_or_closed'
            except (LeaseHeld,subprocess.SubprocessError,OSError,ValueError):reason='native_lease_not_renewed'
            status={'pid':os.getpid(),'started':psutil.Process().create_time(),'config_sha256':args.config_sha,
                    'status':reason or 'windows_lease_current','effective_owners':owners,
                    'at_windows':time.time(),'terminal':terminal,'business_requests_submitted':0}
            tmp=directory/'STATUS.tmp'
            with tmp.open('w',encoding='utf-8') as f:json.dump(status,f);f.flush();os.fsync(f.fileno())
            os.replace(tmp,directory/'STATUS.json')
            if terminal:return 0
            time.sleep(4)


if __name__=='__main__':raise SystemExit(main())
