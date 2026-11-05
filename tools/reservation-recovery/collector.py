#!/usr/bin/env python3
"""Owned read-only collector recovery; never navigate/reload a business agent's tab."""
import argparse
import importlib.util
import json
from pathlib import Path
import time
from urllib.request import urlopen
from urllib.parse import urlparse, parse_qs, urlencode

MARKER = 'village_collector'

def list_url(value):
    u=urlparse(value)
    if u.scheme!='https' or u.hostname!='business.kakao.com' or not u.path.endswith('/chats') or not u.path.startswith('/space/'):
        raise ValueError('Exact authenticated Kakao channel list required')
    return u._replace(query=urlencode({MARKER:'1'}),fragment='').geturl()

def owned_page(pages, expected_url):
    matches=[p for p in pages if p.get('type')=='page' and p.get('url')==expected_url]
    if len(matches)>1: raise ValueError('Multiple collector tabs require reconciliation')
    return matches[0] if matches else None

def ensure_owned_page(pages, expected_url, *, create, refresh, wait):
    existing=owned_page(pages, expected_url)
    if existing:return existing,False
    created=create(expected_url)
    target_id=created.get('targetId')
    if not target_id or any(p.get('id')==target_id for p in pages):raise ValueError('Invalid owned target creation receipt')
    for _ in range(30):
        current=next((p for p in refresh() if p.get('id')==target_id),None)
        if current and current.get('type')=='page' and current.get('url')==expected_url and current.get('webSocketDebuggerUrl'):
            return current,True
        wait(.1)
    raise RuntimeError('Owned collector did not load')

def load_control(root):
    try:return json.loads((root/'control/reservation-recovery-control.json').read_text())
    except (OSError,ValueError):return {}

def run(root,port,url,repair=False):
    path=root/'production-runtime/tools/kakao-dom-bridge/inject-watcher-cdp.py'
    spec=importlib.util.spec_from_file_location('watcher_injector',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    exact=list_url(url);pages=module.load_pages(port);classification=module.classify_kakao_targets(pages)
    if not classification['authenticated']:return {'ok':False,**classification,'collectorOwned':False}
    page=owned_page(pages,exact)
    if not page and not repair:return {'ok':False,**classification,'state':'collector_missing','collectorOwned':False}
    created=False
    if not page:
        with urlopen(f'http://127.0.0.1:{port}/json/version',timeout=3) as response:version=json.load(response)
        ws=version.get('webSocketDebuggerUrl','');u=urlparse(ws)
        if u.hostname not in ('127.0.0.1','localhost') or u.port!=port or not u.path.startswith('/devtools/browser/'):
            raise ValueError('Unexpected local browser socket')
        browser=module.CDPWebSocket(ws);browser.connect()
        try:
            def create(value):
                return browser.call('Target.createTarget',{'url':value,'background':True}).get('result',{})
            page,created=ensure_owned_page(pages,exact,create=create,refresh=lambda:module.load_pages(port),wait=time.sleep)
        finally:browser.close()
    # Recheck exact ownership immediately before every write to this target.
    cdp=module.CDPWebSocket(page['webSocketDebuggerUrl']);cdp.connect()
    try:
        cdp.call('Runtime.runIfWaitingForDebugger',{})
        value=module.probe_watcher(cdp)
        if not module.watcher_reports_authenticated(value,classification['authenticated']):return {'ok':False,**classification,'authenticated':False,'watcherReady':False,'state':'login_required','collectorOwned':True}
        scope_result=cdp.call('Runtime.evaluate',{'expression':Path(__file__).with_name('collector-scope.js').read_text(),'awaitPromise':True,'returnByValue':True})
        scope=scope_result.get('result',{}).get('result',{}).get('value') or {}
        if scope.get('ok') is not True:return {'ok':False,**classification,'watcherReady':False,'collectorOwned':True,'scope':scope,'state':'consultation_scope_unknown'}
        value=module.probe_watcher(cdp)
        if not module.watcher_reports_authenticated(value,classification['authenticated']):
            return {'ok':False,**classification,'authenticated':False,'watcherReady':False,'state':'login_required','collectorOwned':True}
        extra=cdp.call('Runtime.evaluate',{'expression':"JSON.stringify(window.__villageKakaoWatcherInstance?.state?.deepCoverage||null)",'returnByValue':True})
        geometry=cdp.call('Runtime.evaluate',{'expression':"JSON.stringify([...document.querySelectorAll('div,ul,main')].filter(e=>e.scrollHeight>e.clientHeight+80&&e.clientHeight>80&&e.querySelector('input[id^=chat-select-]')).map(e=>({tag:e.tagName,classes:e.className,height:e.clientHeight,total:e.scrollHeight,top:e.scrollTop})).slice(0,10))",'returnByValue':True})
        scroll_geometry=json.loads(geometry.get('result',{}).get('result',{}).get('value')or'[]')
        coverage=json.loads(extra.get('result',{}).get('result',{}).get('value') or 'null')
        scanning=bool(coverage and coverage.get('running') and time.time()-__import__('datetime').datetime.fromisoformat((coverage.get('lastProgressAt')or coverage['startedAt']).replace('Z','+00:00')).timestamp()<120)
        watermark=root/'state/reservation-coverage.json'
        try:previous_coverage=json.loads(watermark.read_text())
        except (OSError,ValueError):previous_coverage={}
        if coverage and coverage.get('complete') is True:
            previous_coverage={'lastSuccessfulScanAt':coverage['finishedAt'],'coverage':coverage};watermark.write_text(json.dumps(previous_coverage))
        last_scan=previous_coverage.get('lastSuccessfulScanAt')
        gap_days=0 if not last_scan else max(0,int((time.time()-__import__('datetime').datetime.fromisoformat(last_scan.replace('Z','+00:00')).timestamp())/86400))
        lookback=max(14,gap_days+2)
        content=module.DEFAULT_CONTENT_JS.read_text();version=module.extract_watcher_version(content)
        paused=load_control(root).get('pauseBackfill') is True
        def collector_injection():return 'window.__villageCollectorRecoveryPaused='+str(paused).lower()+';window.__villageCollectorLookbackDays='+str(lookback)+';\n'+module.build_injection(content)
        try:current_install=json.loads((root/'state/collector-runtime.json').read_text())
        except (OSError,ValueError):current_install={}
        desired_signature=__import__('hashlib').sha256(collector_injection().encode()).hexdigest()
        changed_source=current_install.get('source')!=desired_signature
        if repair and (changed_source or (not scanning and not module.watcher_is_healthy(value,version))):
            current=owned_page(module.load_pages(port),exact)
            if not current or current['id']!=page['id']:raise ValueError('Collector ownership changed')
            # This target belongs solely to the collector. Business agent state is irrelevant.
            injection=collector_injection()
            registry=root/'state/collector-runtime.json'
            try:installed=json.loads(registry.read_text())
            except (OSError,ValueError):installed={}
            signature=__import__('hashlib').sha256(injection.encode()).hexdigest()
            if installed.get('target')!=page['id'] or installed.get('source')!=signature:
                if installed.get('target')==page['id'] and installed.get('script'):
                    cdp.call('Page.removeScriptToEvaluateOnNewDocument',{'identifier':installed['script']})
                hook=cdp.call('Page.addScriptToEvaluateOnNewDocument',{'source':injection}).get('result',{}).get('identifier')
                registry.write_text(json.dumps({'target':page['id'],'source':signature,'script':hook}))
            cdp.call('Page.reload',{'ignoreCache':True})
            deadline=time.monotonic()+10
            while time.monotonic()<deadline:
                time.sleep(.25);cdp.call('Runtime.runIfWaitingForDebugger',{})
                injected=cdp.call('Runtime.evaluate',{'expression':injection,'awaitPromise':True,'returnByValue':True}) if not (value or {}).get('hasWatcher') else {}
                if injected.get('result',{}).get('exceptionDetails'):raise RuntimeError('Collector watcher injection rejected')
                scope_result=cdp.call('Runtime.evaluate',{'expression':Path(__file__).with_name('collector-scope.js').read_text(),'awaitPromise':True,'returnByValue':True})
                scope=scope_result.get('result',{}).get('result',{}).get('value') or {}
                value=module.probe_watcher(cdp)
                if scope.get('ok') and module.watcher_is_healthy(value,version):break
        healthy=bool(scope.get('ok')) and module.watcher_is_healthy(value,version)
        return {'ok':healthy,**classification,'state':'healthy' if healthy else 'collector_repair_required',
                'scroll_geometry':scroll_geometry,'watcherReady':healthy or scanning,'scope':scope,'coverage':coverage,'collectorOwned':True,'collectorCreated':created,'targetId':page['id'],'watcher':value}
    finally:cdp.close()

def main():
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,required=True);p.add_argument('--port',type=int,default=19223);p.add_argument('--url',required=True);p.add_argument('--repair',action='store_true');a=p.parse_args()
    try:print(json.dumps(run(a.root,a.port,a.url,a.repair)));return 0
    except Exception as error:print(json.dumps({'ok':False,'watcherReady':False,'error':str(error)[:200]}));return 1
if __name__=='__main__':raise SystemExit(main())
