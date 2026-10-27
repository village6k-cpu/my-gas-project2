#!/usr/bin/env python3
"""Dedicated Chrome entrypoint and non-destructive watcher supervision.

Launch through village-runtime.py. Launchd restarts exited services; this module
never kills a process, authenticates an account, drains work, or replays a job.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from urllib.request import urlopen

def watcher_action(probe):
    if probe.get('cdpReady') is not True:return 'wait_for_chrome'
    if probe.get('authenticated') is not True:return 'user_auth_required'
    return 'observe' if probe.get('watcherReady') is True else 'inject'

def gateway_owned(state,home,code):
    """Reject stale status, reused PIDs, and a different profile's gateway."""
    import psutil
    if (state.get('kind')!='hermes-gateway' or type(state.get('pid')) is not int
            or state['pid']<=0 or state.get('hermes_home')!=str(home)):
        return False
    try:
        process=psutil.Process(state['pid'])
        argv=process.cmdline();env=process.environ()
        return (process.is_running() and process.status()!=psutil.STATUS_ZOMBIE
            and int(round(process.create_time()*100))==state.get('start_time')
            and argv[1:]==['-m','hermes_cli.main','gateway','run']
            and env.get('HERMES_HOME')==str(home)
            and env.get('PYTHONPATH')==str(code))
    except (psutil.Error,OSError,ValueError):return False

def recovery_idle(root_gateway,worker,health):
    applications=health.get('gateway',{}).get('application_counts')
    if (health.get('ok') is not True or not isinstance(applications,dict)
            or any(type(value) is not int or value<0 for value in applications.values())
            or any(applications.get(stage,0)!=0 for stage in ('pending','claimed','applying','applied'))):
        return False
    return (all(state.get('owner_verified') is True
                and state.get('gateway_state')=='running'
                and state.get('active_agents')==0 for state in (root_gateway,worker))
        and health.get('state',{}).get('activeWorkerRuns')==0
        and health.get('gateway',{}).get('queue',{}).get('claimed')==0)

def chrome_argv(root,port,url):
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '--user-data-dir='+str(root/'chrome-kakao'),
        '--remote-debugging-port='+str(port),'--remote-debugging-address=127.0.0.1',
        '--no-first-run','--no-default-browser-check',url]

def read_json(path):
    try:return json.loads(path.read_text(encoding='utf-8'))
    except (OSError,ValueError):return {}

def inspect_once(root,port,*,repair=False):
    injector=root/'production-runtime/tools/kakao-dom-bridge/inject-watcher-cdp.py'
    command=[str(root/'venv-root/bin/python'),str(injector),'--port',str(port),'--wait','5']
    try:
        result=subprocess.run(command+['--probe-only'],capture_output=True,text=True,timeout=20)
        probe=json.loads(result.stdout)
    except (OSError,ValueError,subprocess.TimeoutExpired):probe={}
    try:
        with urlopen('http://127.0.0.1:8787/health',timeout=5) as response:health=json.load(response)
    except (OSError,ValueError):health={}
    root_home=root/'hermes-root';worker_home=root_home/'profiles/kakaoworker'
    root_gateway=read_json(root_home/'gateway_state.json')
    worker=read_json(worker_home/'gateway_state.json')
    root_gateway['owner_verified']=gateway_owned(root_gateway,root_home,root/'hermes-root-code')
    worker['owner_verified']=gateway_owned(worker,worker_home,root/'hermes-worker-code')
    action=watcher_action(probe)
    if action=='inject' and repair:
        if recovery_idle(root_gateway,worker,health):
            try:
                result=subprocess.run(command,capture_output=True,text=True,timeout=25)
                probe=json.loads(result.stdout);action=watcher_action(probe)
            except (OSError,ValueError,subprocess.TimeoutExpired):action='injection_failed'
        else:action='defer_active_or_unknown_work'
    heartbeat=root/'production-runtime/tools/kakao-dom-bridge/queue/heartbeats.ndjson'
    try:age=max(0,time.time()-heartbeat.stat().st_mtime)
    except OSError:age=None
    report={'measured_at':time.time(),'action':action,'cdp_ready':probe.get('cdpReady') is True,
        'authenticated':probe.get('authenticated') is True,'watcher_ready':probe.get('watcherReady') is True,
        'bridge_responding':health.get('ok') is True,'heartbeat_age_seconds':age,
        'consumer_fresh':health.get('gateway',{}).get('consumer',{}).get('fresh') is True,
        'queue':health.get('gateway',{}).get('queue',{}),
        'full_business_workflow_verified':False}
    return report

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--root',required=True)
    parser.add_argument('--component',choices=['chrome','watcher'],required=True)
    parser.add_argument('--port',type=int,default=19223)
    parser.add_argument('--url');parser.add_argument('--once',action='store_true')
    args=parser.parse_args();root=Path(args.root).resolve()
    if sys.platform!='darwin':raise RuntimeError('macOS required')
    if args.component=='chrome':
        if not args.url or not args.url.startswith('https://business.kakao.com/'):raise ValueError('dedicated Kakao URL required')
        argv=chrome_argv(root,args.port,args.url);os.execv(argv[0],argv)
    while True:
        report=inspect_once(root,args.port,repair=not args.once)
        target=root/'state/watcher-supervisor.json';target.parent.mkdir(exist_ok=True,mode=0o700)
        temporary=target.with_suffix('.tmp');temporary.write_text(json.dumps(report),encoding='utf-8');temporary.chmod(0o600);temporary.replace(target)
        print(json.dumps(report),flush=True)
        if args.once:return
        time.sleep(30)

if __name__=='__main__':main()
