"""Install reviewed recovery code into an existing pinned isolated runtime."""
import argparse,hashlib,json,shutil,time
from pathlib import Path
HERE=Path(__file__).parent

def sha(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def native_adapter_bytes(original,patch_bytes):
    import subprocess,tempfile
    marker=b'def _claim_capacity_available'
    value=original
    if marker not in value:
        with tempfile.TemporaryDirectory() as directory:
            base=Path(directory);target=base/'hermes-root/profiles/kakaoworker/plugins/kakao_village/adapter.py';target.parent.mkdir(parents=True);target.write_bytes(original)
            result=subprocess.run(['/usr/bin/patch','-N','-p1','--batch'],cwd=base,input=patch_bytes,capture_output=True)
            if result.returncode or marker not in target.read_bytes():raise ValueError('Native adapter forward patch failed')
            value=target.read_bytes()
    if b'getattr(owner, "_external_drain_active", False)' not in value:
        newline=b'\r\n' if b'\r\n' in value else b'\n'
        anchor=b'        owner = getattr(getattr(self, "_message_handler", None), "__self__", None)'+newline
        if value.count(anchor)!=1:raise ValueError('Native adapter capacity owner anchor mismatch')
        value=value.replace(anchor,anchor+b'        if getattr(owner, "_draining", False) or getattr(owner, "_external_drain_active", False):'+newline+b'            return False'+newline)
    return value

def install(root,watchdog_only=False):
    manifest=root/'control/runtime.json';activation=root/'ACTIVATION.json'
    m=json.loads(manifest.read_text());a=json.loads(activation.read_text());assert a['manifest_sha256']==sha(manifest)
    for service in m['services'].values():
        for file,h in service.get('runtime_file_sha256',{}).items():assert sha(Path(file))==h,file
    backup=root/'control'/('automatic-recovery-'+time.strftime('%Y%m%d-%H%M%S'));backup.mkdir(mode=0o700)
    shutil.copy2(manifest,backup/'runtime.json');shutil.copy2(activation,backup/'ACTIVATION.json')
    changed=[]
    def copy(src,dest,service):
        dest.parent.mkdir(parents=True,exist_ok=True)
        existed=dest.exists();saved=backup/(str(dest.relative_to(root)).replace('/','__'))
        if existed:shutil.copy2(dest,saved)
        changed.append((dest,saved,existed))
        temporary=dest.with_suffix(dest.suffix+'.recovery-install');shutil.copy2(src,temporary);temporary.replace(dest);digest=sha(dest)
        for existing_service in m['services'].values():
            if str(dest) in existing_service.get('runtime_file_sha256',{}):existing_service['runtime_file_sha256'][str(dest)]=digest
        m['services'][service].setdefault('runtime_file_sha256',{})[str(dest)]=digest
    try:
        from patch_launcher import patch as patch_launcher
        launcher=root/'control/village-runtime.py';staged=backup/'launcher.next.py';staged.write_text(patch_launcher(launcher.read_text()));copy(staged,launcher,'bridge')
        for name in ['collector.py','supervisor.py','recovery_policy.py','publish-status.mjs','collector-scope.js']:
            copy(HERE/name,root/'control/reservation-recovery'/name,'watcher')
        m['services']['watcher']['argv'][1]=str(root/'control/reservation-recovery/supervisor.py')
        if not watchdog_only:
            from patch_bridge import patch as patch_bridge
            import patch_safe_retry, patch_load_safety
            from patch_watcher import patch as patch_watcher
            bridge=root/'production-runtime/tools/kakao-dom-bridge/server.mjs'
            watcher=root/'production-runtime/tools/kakao-dom-watcher-extension/content.js'
            staged=backup/'server.next.mjs';staged.write_text(patch_bridge(bridge.read_text()) if 'createIntakeCoordinator' not in bridge.read_text() else bridge.read_text());staged.write_text(patch_safe_retry.server(staged.read_text()));staged.write_text(patch_load_safety.patch(staged.read_text()));copy(staged,bridge,'bridge')
            staged=backup/'content.next.js';staged.write_text(patch_watcher(watcher.read_text()));copy(staged,watcher,'watcher')
            from patch_shim import patch as patch_shim
            shim=root/'production-runtime/tools/kakao-dom-bridge/watcher-cdp-shim.js';staged=backup/'shim.next.js';staged.write_text(patch_shim(shim.read_text()));copy(staged,shim,'watcher')
            from patch_capture_integrity import patch as patch_capture_integrity
            integrity=root/'production-runtime/tools/ai-browser-worker/capture-integrity.mjs';staged=backup/'capture-integrity.next.mjs';staged.write_text(patch_capture_integrity(integrity.read_text()));copy(staged,integrity,'bridge')
            from patch_owned_capture import patch as patch_owned_capture
            owned=root/'production-runtime/tools/ai-browser-worker/owned-room-capture.mjs';staged=backup/'owned-capture.next.mjs';staged.write_text(patch_owned_capture(owned.read_text()));copy(staged,owned,'bridge')
            notices=root/'production-runtime/tools/ai-browser-worker/pricing-owner-notices.mjs';staged=backup/'notices.next.mjs';staged.write_text(patch_load_safety.notices(notices.read_text()));copy(staged,notices,'bridge')
            for name in ['durable-intake.mjs','intake-coordinator.mjs']:
                copy(HERE.parent/'kakao-dom-bridge'/name,root/'production-runtime/tools/kakao-dom-bridge'/name,'bridge')
            channel=root/'production-runtime/tools/kakao-dom-bridge/hermes-gateway-channel.mjs'
            text=channel.read_text();needle='.sort((left, right) => left.queue_order - right.queue_order)[0];'
            assert text.count(needle)==1 or 'const backfill=j=>' in text
            text=text.replace(needle,".sort((left,right)=>{const backfill=j=>{const e=j.local_context?.job?.events;return Array.isArray(e)&&e.length>0&&e.every(x=>x.recoveryOnly===true)?1:0;};return backfill(left)-backfill(right)||left.queue_order-right.queue_order;})[0];")
            text=text.replace("return Array.isArray(e)&&e.length>0&&e.every(x=>x.recoveryOnly===true)?1:0;","return Array.isArray(e)&&e.length>0&&e.every(x=>x.recoveryOnly===true)?(e.some(x=>x.recoveryOf)?1:2):0;")
            staged=backup/'channel.next.mjs';staged.write_text(patch_safe_retry.channel(text));copy(staged,channel,'bridge')
            env_file=root/'control/bridge.env.json';shutil.copy2(env_file,backup/'bridge.env.json');env=json.loads(env_file.read_text());env['READ_BACKSTOP_LOOKBACK_DAYS']='14';env_file.write_text(json.dumps(env,ensure_ascii=False,indent=2)+'\n');m['services']['bridge']['env_sha256']=sha(env_file)
        if not watchdog_only:
            import subprocess,tempfile
            adapter=root/'hermes-root/profiles/kakaoworker/plugins/kakao_village/adapter.py'
            staged=backup/'adapter.next.py';staged.write_bytes(native_adapter_bytes(adapter.read_bytes(),(HERE/'native-adapter-concurrency.patch').read_bytes()));copy(staged,adapter,'worker')
            config=root/'hermes-root/profiles/kakaoworker/config.yaml'
            import re
            cfg=config.read_text()
            if re.search(r'^max_concurrent_sessions:',cfg,re.M):cfg=re.sub(r'^max_concurrent_sessions:.*$', 'max_concurrent_sessions: 2',cfg,flags=re.M)
            else:cfg+='\nmax_concurrent_sessions: 2\n'
            staged=backup/'worker-config.next.yaml';staged.write_text(cfg);copy(staged,config,'worker')
        manifest.write_text(json.dumps(m,ensure_ascii=False,indent=2)+'\n');a['manifest_sha256']=sha(manifest)
        a.setdefault('post_cutover_maintenance',{})['automatic_reservation_recovery']={'backup':str(backup),'watchdog_only':watchdog_only,'installed_at':time.time()}
        activation.write_text(json.dumps(a,ensure_ascii=False,indent=2)+'\n')
    except Exception:
        for dest,saved,existed in reversed(changed):
            if existed:shutil.copy2(saved,dest)
        if (backup/'bridge.env.json').exists():shutil.copy2(backup/'bridge.env.json',root/'control/bridge.env.json')
        shutil.copy2(backup/'runtime.json',manifest);shutil.copy2(backup/'ACTIVATION.json',activation)
        raise
    print(json.dumps({'installed':True,'backup':str(backup),'watchdog_only':watchdog_only,'activation_gates_preserved':a['gates']==json.loads((backup/'ACTIVATION.json').read_text())['gates']}))
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--watchdog-only',action='store_true');x=p.parse_args();install(x.root,x.watchdog_only)
