#!/usr/bin/env python3
"""Wait for verified idle native bridge turns; independent Slack turns continue."""
import argparse,json,os,signal,subprocess,time,uuid
from pathlib import Path
from urllib.request import Request,urlopen
from supervisor import gateway_owned

def read(path):
    try:return json.loads(path.read_text())
    except (OSError,ValueError):return {}

def atomic(path,data):
    tmp=path.with_suffix('.release.tmp');tmp.write_text(json.dumps(data));tmp.chmod(0o600);tmp.replace(path)

def idle_for_release(worker,health,owned):
    applications=health.get('execution_application_counts')or health.get('application_counts')or{}
    return owned and worker.get('active_agents')==0 and health.get('consumer',{}).get('fresh') is True and all(applications.get(s)==0 for s in ['pending','claimed','applying','applied']) and health.get('queue',{}).get('ready')==0

def release(root):
    control=root/'control/reservation-recovery-control.json';original=read(control);token=str(uuid.uuid4())
    atomic(control,{**original,'pauseBackfill':True,'maintenanceOwner':token})
    label=f'gui/{os.getuid()}/com.village.migrated.worker';disabled=False;stable=0;last_report=0
    try:
        while True:
            worker=read(root/'hermes-root/profiles/kakaoworker/gateway_state.json');main=read(root/'hermes-root/gateway_state.json')
            owned=gateway_owned(worker,root/'hermes-root/profiles/kakaoworker',root/'hermes-worker-code')
            env=read(root/'control/bridge.env.json')
            try:
                request=Request('http://127.0.0.1:8787/hermes/v1/status',headers={'Authorization':'Bearer '+env['KAKAO_HERMES_BRIDGE_TOKEN']})
                with urlopen(request,timeout=10) as response:health=json.load(response)
            except (OSError,ValueError,KeyError):health={}
            idle=idle_for_release(worker,health,owned)
            stable=stable+1 if idle else 0
            if time.time()-last_report>30:
                print(json.dumps({'waiting_for_idle':True,'worker_active':worker.get('active_agents'),'slack_active':main.get('active_agents'),'idle_samples':stable}),flush=True);last_report=time.time()
            if stable>=2:break
            time.sleep(2)
        subprocess.run(['launchctl','disable',label],check=True);disabled=True
        latest=read(root/'hermes-root/profiles/kakaoworker/gateway_state.json')
        if latest.get('pid')!=worker['pid'] or latest.get('active_agents')!=0:raise RuntimeError('A business turn started; release deferred without interrupting it')
        os.kill(worker['pid'],signal.SIGTERM)
        import psutil
        try:psutil.Process(worker['pid']).wait(timeout=60)
        except psutil.NoSuchProcess:pass
        subprocess.run(['launchctl','kickstart','-k',f'gui/{os.getuid()}/com.village.migrated.bridge'],check=True)
        print(json.dumps({'bridge_restarted_after_verified_idle':True}),flush=True)
    finally:
        if disabled:
            subprocess.run(['launchctl','enable',label],check=True);subprocess.run(['launchctl','kickstart',label],check=True)
        current=read(control)
        if current.get('maintenanceOwner')==token:
            current.pop('maintenanceOwner',None);current['pauseBackfill']=original.get('pauseBackfill',False);atomic(control,current)
        print(json.dumps({'worker_restart_enabled':True,'backfill_setting_restored':True}),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);args=p.parse_args();release(args.root.resolve())
