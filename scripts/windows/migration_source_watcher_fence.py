"""Owned watcher control with an authoritative live extension absence check.

Retains the pinned watcher's process, target, token and no-reload guarantees.
An absent DOM marker requires an empty complete extension-management inventory
and empty unpacked inventory before and after. No DOM status is fabricated.
"""
from contextlib import contextmanager
import hashlib,importlib.util,json,time,uuid
from pathlib import Path
from urllib.request import urlopen

BASE=Path('C:/Village/migration-staging/studio-20260930/prepared-helpers-v7/source_watcher_fence.py')
BASE_SHA='d2664be61e3eaa58370101c05fbd30fbb84eb9183fb151961b6eaef66319febc'
INJECTOR=Path('C:/Village/runtimes/my-gas-project2-production/tools/kakao-dom-bridge/inject-watcher-cdp.py')
PORT=9223
MANAGEMENT_EXPRESSION="""new Promise((resolve,reject)=>{
  if(location.origin!=='chrome://extensions'||!chrome.developerPrivate?.getExtensionsInfo){reject(Error('API unavailable'));return;}
  const accept=rows=>{
    if(chrome.runtime.lastError||!Array.isArray(rows)){reject(Error('Complete inventory unavailable'));return;}
    resolve({api:'chrome.developerPrivate.getExtensionsInfo',complete:true,
      extensions:rows.map(r=>({id:r.id,state:r.state,type:r.type,location:r.location}))});
  };
  try{
    const pending=chrome.developerPrivate.getExtensionsInfo({includeDisabled:true,includeTerminated:true},accept);
    if(pending&&typeof pending.then==='function')pending.then(accept,reject);
  }catch(error){reject(error);}
})"""

def extensions_absent(response,management):
    if (not isinstance(response,dict) or 'error' in response
            or not isinstance(response.get('result',{}).get('extensions'),list)):
        raise RuntimeError('Authoritative Chrome extension inventory unavailable')
    if (not isinstance(management,dict)
            or management.get('api')!='chrome.developerPrivate.getExtensionsInfo'
            or management.get('complete') is not True
            or not isinstance(management.get('extensions'),list)):
        raise RuntimeError('Complete Chrome extension management inventory unavailable')
    return response['result']['extensions']==[] and management['extensions']==[]

def allow_verified_absence(expression):
    old="document.documentElement.dataset.villageKakaoExtensionWatcherStatus!=='stopped'"
    if expression.count(old)!=1:raise RuntimeError('Pinned watcher guard changed')
    return expression.replace(old,"("+old+" && !(document.documentElement.dataset.villageKakaoExtensionWatcherStatus===undefined))")

def load(path,name):
    spec=importlib.util.spec_from_file_location(name,path)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

@contextmanager
def owned_management_target(cdp,browser,receipt):
    import psutil
    p=psutil.Process(browser['pid'])
    if (abs(p.create_time()-browser['started'])>=.01 or p.cmdline()!=browser['argv']
            or Path(p.exe()).resolve()!=Path(browser['exe']).resolve()
            or 9223 not in {c.laddr.port for c in p.net_connections(kind='tcp') if c.status==psutil.CONN_LISTEN and c.laddr}):
        raise RuntimeError('Owned Chrome inventory listener changed')
    with urlopen('http://127.0.0.1:9223/json/version',timeout=5) as r:version=json.load(r)
    c=cdp.CDPWebSocket(version['webSocketDebuggerUrl']);c.connect();target=None;page=None
    directory=Path(receipt).parent/'watcher-extension-inventory';directory.mkdir(exist_ok=True)
    journal=directory/uuid.uuid4().hex
    def save(suffix,value):journal.with_suffix(suffix+'.json').write_text(json.dumps(value),encoding='utf-8')
    try:
        before={p['id'] for p in cdp.load_pages(9223)}
        save('.intent',{'browser':browser['pid'],'started':browser['started'],'url':'chrome://extensions/','background':True})
        q=c.call('Target.createTarget',{'url':'chrome://extensions/','background':True})
        returned=q['result']['targetId']
        if returned in before:raise RuntimeError('Management target was not newly owned')
        target=returned;save('.created',{'target':target})
        deadline=time.monotonic()+5
        while True:
            pages=[p for p in cdp.load_pages(9223) if p['id']==target and p['url']=='chrome://extensions/']
            if pages:break
            if time.monotonic()>deadline:raise RuntimeError('Owned extension management target unavailable')
            time.sleep(.1)
        page=cdp.CDPWebSocket(pages[0]['webSocketDebuggerUrl']);page.connect()
        yield c,page,save
    finally:
        if page:page.close()
        try:
            if target:
                q=c.call('Target.closeTarget',{'targetId':target});save('.closed',q)
                if q.get('result',{}).get('success') is not True:raise RuntimeError('Owned management target close not verified')
        finally:c.close()

def runtime_extensions_absent(browser_cdp,page):
    # getExtensions alone lists only unpacked extensions. The privileged Chrome
    # management page also covers packed/store/policy extensions, including
    # disabled and terminated entries. Missing/error APIs never imply absence.
    q=page.call('Runtime.evaluate',{'expression':MANAGEMENT_EXPRESSION,'returnByValue':True,'awaitPromise':True})
    if q.get('error') or q.get('result',{}).get('exceptionDetails'):raise RuntimeError('Complete extension management query failed')
    management=q.get('result',{}).get('result',{}).get('value')
    unpacked=browser_cdp.call('Extensions.getExtensions',{})
    return extensions_absent(unpacked,management),{'management':management,'unpacked':unpacked}

def operate(browser,mode,receipt):
    if hashlib.sha256(BASE.read_bytes()).hexdigest()!=BASE_SHA:raise RuntimeError('Pinned base watcher helper changed')
    base=load(BASE,'current_watcher_base');cdp=load(INJECTOR,'current_watcher_inventory_cdp')
    with owned_management_target(cdp,browser,receipt) as (browser_cdp,page,save):
        absent,before=runtime_extensions_absent(browser_cdp,page);save('.before',before)
        if absent:
            expression=base.watcher_expression
            base.watcher_expression=lambda mode,prior:allow_verified_absence(expression(mode,prior))
        result=base.operate(browser,mode,receipt)
        after_absent,after=runtime_extensions_absent(browser_cdp,page);save('.after',after)
        if after_absent!=absent:raise RuntimeError('Chrome extension inventory changed during watcher operation')
    state=result['readback'];status=state.get('extensionStatus')
    if status!='stopped' and not (absent and status is None):
        raise RuntimeError('Extension inactivity not proven')
    state['extensionStatus']=status
    state['extensionInactiveVerified']=True
    state['extensionRuntimeInventoryEmpty']=absent
    return result
