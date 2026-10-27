#!/usr/bin/env python3
"""Start one isolated Village service from its verified migration manifest.

Launchd owns restart policy. This launcher never stops another process, loads a
shell profile, restores a queue, or enables a service during a read-only check.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import sys

REQUIRED_GATES=(
    'backups_verified','model_quality_verified','performance_verified',
    'coexistence_verified','windows_consumers_drained',
    'final_state_reconciled','rollback_ready',
)

def sha256_file(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()

def contained(root,value,label):
    p=Path(value).resolve()
    if not p.is_relative_to(root):
        raise ValueError(f'{label} must remain inside the isolated installation')
    return p

def build_launch(manifest_path,service,*,check_only=False):
    manifest_path=Path(manifest_path).resolve()
    manifest=json.loads(manifest_path.read_text(encoding='utf-8'))
    if manifest.get('schema')!='village-macos-runtime/v1':
        raise ValueError('unsupported runtime manifest')
    root=Path(manifest['root']).resolve()
    contained(root,manifest_path,'manifest')
    services=manifest.get('services',{})
    if service not in services or not service.replace('-','').isalnum():
        raise ValueError('unknown service')
    used=set()
    for entry in services.values():
        for port in entry.get('ports',[]):
            if type(port) is not int or not 1024<=port<=65535:
                raise ValueError('invalid service port')
            if port in used:raise ValueError('duplicate port in runtime manifest')
            used.add(port)
    entry=services[service]
    argv=entry['argv']
    if not isinstance(argv,list) or not argv or not all(isinstance(x,str) and '\0' not in x for x in argv):
        raise ValueError('invalid service argv')
    program=contained(root,argv[0],'program')
    cwd=contained(root,entry['cwd'],'cwd')
    env_file=contained(root,entry['env_file'],'env_file')
    if not program.is_file() or not cwd.is_dir() or not env_file.is_file():
        raise ValueError('missing service program, cwd or environment')
    if entry.get('env_sha256')!=sha256_file(env_file):
        raise ValueError('environment hash mismatch')
    env=json.loads(env_file.read_text(encoding='utf-8'))
    if not isinstance(env,dict) or not all(isinstance(k,str) and isinstance(v,str) and '=' not in k and '\0' not in k+v for k,v in env.items()):
        raise ValueError('invalid service environment')
    if 'HERMES_HOME' in env:contained(root,env['HERMES_HOME'],'HERMES_HOME')
    activation=root/'ACTIVATION.json'
    verified=False
    if not check_only:
        if (root/'MIGRATION-INACTIVE').exists():raise ValueError('installation is inactive')
        if not activation.is_file():raise ValueError('missing activation receipt')
        proof=json.loads(activation.read_text(encoding='utf-8'))
        if proof.get('manifest_sha256')!=sha256_file(manifest_path):
            raise ValueError('activation manifest hash mismatch')
        for gate in REQUIRED_GATES:
            if proof.get('gates',{}).get(gate) is not True:
                raise ValueError('activation gate failed: '+gate)
        for value,expected in entry.get('runtime_file_sha256',{}).items():
            target=contained(root,value,'runtime file')
            if not target.is_file() or sha256_file(target)!=expected:
                raise ValueError('runtime file hash mismatch')
        verified=True
    return {'root':root,'argv':argv,'cwd':cwd,'env':env,'ports':entry.get('ports',[]),'activation_verified':verified,'service':service}

def acquire_service_lock(plan):
    import fcntl
    directory=plan['root']/'state/service-locks'
    directory.mkdir(parents=True,exist_ok=True,mode=0o700)
    lock=directory/(plan['service']+'.lock')
    fd=os.open(lock,os.O_RDWR|os.O_CREAT,0o600)
    try:
        fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        raise RuntimeError('service already has an owner') from None
    os.set_inheritable(fd,True)
    return fd

def run(plan):
    if sys.platform!='darwin':raise RuntimeError('service activation requires macOS')
    if not plan['activation_verified']:raise RuntimeError('activation was not verified')
    if not os.access(plan['argv'][0],os.X_OK):raise RuntimeError('service program is not executable')
    fd=acquire_service_lock(plan)
    # A failed bind leaves the incumbent untouched. The service itself performs
    # the authoritative bind immediately after exec; launchd handles failure.
    try:
        for port in plan['ports']:
            with socket.socket() as probe:probe.bind(('127.0.0.1',port))
        os.chdir(plan['cwd'])
        os.execve(plan['argv'][0],plan['argv'],plan['env'])
    finally:
        os.close(fd)

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--manifest',required=True)
    parser.add_argument('--service',required=True)
    parser.add_argument('--check',action='store_true')
    args=parser.parse_args()
    try:
        plan=build_launch(args.manifest,args.service,check_only=args.check)
        if args.check:
            print(json.dumps({'valid':True,'service':args.service,'activation_verified':False,'started':False,'ports':plan['ports']}))
            return 0
        run(plan)
    except (ValueError,RuntimeError,OSError,KeyError) as error:
        # Do not include environment values or full command arguments in errors.
        print(json.dumps({'valid':False,'service':args.service,'error_type':type(error).__name__,'started':False}),file=sys.stderr)
        return 1

if __name__=='__main__':raise SystemExit(main())
