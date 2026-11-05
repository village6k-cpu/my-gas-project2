"""Owned collector deep-scan coverage; leave interactive watchers' limits unchanged."""
from pathlib import Path

def upgrade(s):
 s=s.replace('2026-11-05-durable-coverage-v18','2026-11-05-durable-coverage-v21').replace('2026-11-05-durable-coverage-v19','2026-11-05-durable-coverage-v21').replace('2026-11-05-durable-coverage-v20','2026-11-05-durable-coverage-v21')
 s=s.replace('lookbackDays:14','lookbackDays:STATE.config.recoveryLookbackDays||14').replace('15*86400000','((STATE.config.recoveryLookbackDays||14)+1)*86400000').replace('deepBackstopMaxRows:1500,','deepBackstopMaxRows:1500,recoveryLookbackDays:window.__villageCollectorLookbackDays||14,')
 if 'lastProgressAt:new Date' not in s:s=s.replace('          posted += 1;', '          posted += 1;\n          if(STATE.deepCoverage)Object.assign(STATE.deepCoverage,{posted,lastProgressAt:new Date().toISOString()});')
 anchor='  function chatListScrollContainer() {\n'
 if 'const virtualizedCollector' not in s:
  s=s.replace(anchor,anchor+"    const virtualizedCollector=deepQuerySelectorAll('.ReactVirtualized__List.list_board').find(el=>el.scrollHeight>el.clientHeight+80&&isVisible(el));\n    if(virtualizedCollector)return virtualizedCollector;\n")
 return s

def patch_coverage(source):
 if any(v in source for v in ['durable-coverage-v24','durable-coverage-v23','durable-coverage-v22','durable-coverage-v21']):return source
 if 'durable-coverage-v20' in source:return upgrade(source)
 if 'durable-coverage-v19' in source or 'durable-coverage-v18' in source:return upgrade(source)
 s=source
 s=s.replace("const WATCHER_VERSION = '2026-11-02-read-room-catchup-v17'","const WATCHER_VERSION = '2026-11-05-durable-coverage-v18'")
 assert 'durable-coverage-v18' in s
 s=s.replace('    lastSignatureAt: new Map(),','    lastSignatureAt: new Map(),\n    lastAcceptedAt: new Map(),\n    deepCoverage: null,')
 s=s.replace('if (now - lastAt < STATE.config.minSilenceMs) return;',"if (now - lastAt < STATE.config.minSilenceMs) return STATE.lastAcceptedAt.has(event.eventHash);")
 s=s.replace("      log('event sent', event.reason, event.roomKey, event.previewText);","      STATE.lastAcceptedAt.set(event.eventHash,Date.now());\n      log('event sent', event.reason, event.roomKey, event.previewText);\n      return true;")
 s=s.replace("      console.warn('[Village Kakao Watcher] bridge post failed:', err?.message || err);","      STATE.lastSignatureAt.delete(event.eventHash);\n      console.warn('[Village Kakao Watcher] bridge post failed:', err?.message || err);\n      return false;")
 s=s.replace("    let posted = 0;\n    try {\n      for (let step = 0; step < 20 && posted < STATE.config.deepBackstopMaxRows; step += 1) {",'''    let posted = 0;
    const isolated=new URLSearchParams(location.search).get('village_collector')==='1';
    let boundary=false,failed=0;
    STATE.deepCoverage={startedAt:new Date().toISOString(),running:true,complete:false,lookbackDays:14};
    if(isolated)scroller.scrollTop=0;
    try {
      for (let step = 0; step < (isolated?200:20) && posted < STATE.config.deepBackstopMaxRows; step += 1) {''')
 old="          postEvent(createEvent(row.row, unread ? 'top_rows_backstop' : 'read_room_catchup', row.text));"
 new='''          if(isolated){
            const date=/(\\d{1,2})월\\s*(\\d{1,2})일\\s*$/.exec(row.text);
            if(date){const now=new Date(),seenDate=new Date(now.getFullYear(),Number(date[1])-1,Number(date[2]));
              if(seenDate>now)seenDate.setFullYear(seenDate.getFullYear()-1);
              if(now-seenDate>15*86400000){boundary=true;break;}}
            if(!await postEvent(createEvent(row.row, unread ? 'top_rows_backstop' : 'read_room_catchup', row.text)))failed++;
          }else postEvent(createEvent(row.row, unread ? 'top_rows_backstop' : 'read_room_catchup', row.text));'''
 assert s.count(old)==1;s=s.replace(old,new)
 s=s.replace("        const nextTop = Math.min(scroller.scrollTop", "        if(boundary)break;\n        const nextTop = Math.min(scroller.scrollTop")
 s=s.replace("      scroller.scrollTop = originalTop;\n      STATE.deepBackstopRunning = false;","      scroller.scrollTop = originalTop;\n      STATE.deepCoverage={...STATE.deepCoverage,running:false,complete:isolated&&boundary&&failed===0,posted,failed,boundaryReached:boundary,finishedAt:new Date().toISOString()};\n      STATE.deepBackstopRunning = false;")
 s=s.replace("    STATE.config = { ...DEFAULT_CONFIG, ...(await loadConfig()) };","    STATE.config = { ...DEFAULT_CONFIG, ...(await loadConfig()) };\n    if(new URLSearchParams(location.search).get('village_collector')==='1')Object.assign(STATE.config,{deepBackstopMaxRows:1500,deepBackstopIntervalMs:600000,deepBackstopStartupDelayMs:10000});")
 return upgrade(s)


def patch(source):
 s=patch_coverage(source)
 s=s.replace('2026-11-05-durable-coverage-v21','2026-11-05-durable-coverage-v23').replace('2026-11-05-durable-coverage-v22','2026-11-05-durable-coverage-v23').replace('2026-11-05-durable-coverage-v23','2026-11-05-durable-coverage-v24')
 if 'async function postEventOnce' not in s:
  s=s.replace('  async function postEvent(event) {',"""  async function postEvent(event) {
    STATE.pendingPosts ||= new Map();
    if(STATE.pendingPosts.has(event.eventHash))return STATE.pendingPosts.get(event.eventHash);
    const pending=postEventOnce(event);STATE.pendingPosts.set(event.eventHash,pending);
    try{return await pending;}finally{STATE.pendingPosts.delete(event.eventHash);}
  }
  async function postEventOnce(event) {""")
 s=s.replace("if(!await postEvent(createEvent(row.row, unread ? 'top_rows_backstop' : 'read_room_catchup', row.text)))failed++;","if(!await postEvent(createEvent(row.row, 'read_room_catchup', row.text)))failed++;")
 if 'STATE.liveResumeAfter' not in s:
  s=s.replace('  function inspectElement(el, reason) {', '  function inspectElement(el, reason) {\n    if(STATE.deepBackstopRunning||Date.now()<(STATE.liveResumeAfter||0))return;')
  s=s.replace('      const currentRows = topRowsSnapshot();', '      if(STATE.deepBackstopRunning||Date.now()<(STATE.liveResumeAfter||0))return;\n      const currentRows = topRowsSnapshot();')
  s=s.replace('      scroller.scrollTop = originalTop;', '      STATE.liveResumeAfter=Date.now()+1500;\n      scroller.scrollTop = originalTop;')
 s=s.replace("    if (!STATE.config.enabled || !STATE.config.deepBackstopEnabled || STATE.deepBackstopRunning) return;","    if (!STATE.config.enabled || !STATE.config.deepBackstopEnabled || STATE.deepBackstopRunning || window.__villageCollectorRecoveryPaused===true) return;")
 if 'Count only rows actually offered to intake' not in s:
  s=s.replace('          posted += 1;\n          if(STATE.deepCoverage)Object.assign(STATE.deepCoverage,{posted,lastProgressAt:new Date().toISOString()});\n','')
  anchor="          }else postEvent(createEvent(row.row, unread ? 'top_rows_backstop' : 'read_room_catchup', row.text));"
  assert s.count(anchor)==1
  s=s.replace(anchor,anchor+'\n          // Count only rows actually offered to intake; the old-date boundary is excluded.\n          posted += 1;\n          if(STATE.deepCoverage)Object.assign(STATE.deepCoverage,{posted,lastProgressAt:new Date().toISOString()});')
 return s

if __name__=='__main__':
 import argparse
 p=argparse.ArgumentParser();p.add_argument('file',type=Path);p.add_argument('--out',type=Path,required=True);a=p.parse_args();a.out.write_text(patch(a.file.read_text()))
