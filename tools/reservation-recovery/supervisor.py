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

def stable_process_birth(process):
    # psutil's default macOS timestamp is adjusted when the wall clock changes.
    # The unadjusted kernel birth time remains stable across interpreter lifetimes.
    if sys.platform == 'darwin':
        from psutil import _psosx
        value = _psosx.Process(process.pid).create_time(monotonic=True)
    else:
        value = process.create_time()
    return int(round(value * 100))

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
            and stable_process_birth(process)==state.get('start_time')
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
    collector=root/'control/reservation-recovery/collector.py'
    url='https://business.kakao.com/space/353491/channel/_xhPMls/chats'
    command=[str(root/'venv-root/bin/python'),str(collector),'--root',str(root),'--port',str(port),'--url',url]
    try:
        result=subprocess.run(command+(['--repair'] if repair else []),capture_output=True,text=True,timeout=40)
        probe=json.loads(result.stdout)
    except (OSError,ValueError,subprocess.TimeoutExpired):probe={}
    bridge_env=read_json(root/'control/bridge.env.json')
    from urllib.request import Request
    try:
        request=Request('http://127.0.0.1:8787/hermes/v1/status',headers={'Authorization':'Bearer '+bridge_env['KAKAO_HERMES_BRIDGE_TOKEN']})
        with urlopen(request,timeout=10) as response:gateway=json.load(response)
        health={'ok':True,'gateway':gateway}
    except (OSError,ValueError,KeyError):health={}
    action=watcher_action(probe)
    # The collector owns its exact target, so busy Slack/customer turns do not
    # suspend intake repair. Its helper never reloads an agent's search or room.
    if probe.get('collectorOwned') is True and probe.get('watcherReady') is True:action='observe'
    elif probe.get('authenticated') is True:action='collector_repair_failed'
    heartbeat=root/'production-runtime/tools/kakao-dom-bridge/queue/heartbeats.ndjson'
    try:age=max(0,time.time()-heartbeat.stat().st_mtime)
    except OSError:age=None
    report={'measured_at':time.time(),'action':action,'cdp_ready':probe.get('cdpReady') is True,
        'authenticated':probe.get('authenticated'),'watcher_ready':probe.get('watcherReady') is True,
        'bridge_responding':health.get('ok') is True,'heartbeat_age_seconds':age,
        'consumer_fresh':health.get('gateway',{}).get('consumer',{}).get('fresh') is True,
        'collector_diagnostics':probe.get('watcher'),
        'queue':health.get('gateway',{}).get('queue',{}),
        'auth_required':probe.get('state') in ('login_required','second_factor_required'),
        'scope':probe.get('scope'),
        'collector_owned':probe.get('collectorOwned') is True,
        'coverage':probe.get('coverage'),
        'scroll_geometry':probe.get('scroll_geometry'),
        'full_business_workflow_verified':False}
    if repair:
        from recovery_policy import maintain_health
        report['recovery']=maintain_health(root,report,health)
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
