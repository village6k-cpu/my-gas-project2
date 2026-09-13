const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawnSync}=require('node:child_process');
const modulePath=path.join(__dirname,'../scripts/windows/kakao-runtime-incident.js');
const api=fs.existsSync(modulePath)?require(modulePath):{};

function fixture(){
 let state={},now=1800000000000,posts=0,offline=false,uncertainPost=false;const messages=[];
 const deps={channel:'C0B769B394K',now:()=>now,load:()=>structuredClone(state),save:s=>{state=structuredClone(s);},
  slack:async(method,p)=>{
   if(offline)throw Error('Slack unavailable');
   if(method==='chat.postMessage') {
    posts++;const m={...p,ts:'1800000000.'+posts};messages.push(m);
    if(uncertainPost)throw Error('response lost');return {ok:true,channel:p.channel,ts:m.ts};
   }
   return {ok:true,messages};
  }};
 return {deps,get state(){return state;},get posts(){return posts;},get messages(){return messages;},
  advance:ms=>now+=ms,offline:x=>offline=x,uncertainPost:x=>uncertainPost=x};
}

test('a watchdog failure before any RQ exists creates one verified owner incident',async()=>{
 assert.equal(typeof api.reportIncident,'function');const f=fixture();
 assert.equal((await api.reportIncident({...f.deps,healthy:false,reason:'plugin_validation_failed'})).status,'sent');
 assert.equal((await api.reportIncident({...f.deps,healthy:false,reason:'capture_unavailable'})).status,'already_sent');
 assert.equal(f.posts,1);assert.match(f.messages[0].text,/자동등록/);assert.match(f.messages[0].text,/재고/);
 assert.ok(f.state.incident.receipt.ts);
});

test('an uncertain POST is read back using the same incident identity instead of resent',async()=>{
 assert.equal(typeof api.reportIncident,'function');const f=fixture();f.uncertainPost(true);
 await assert.rejects(api.reportIncident({...f.deps,healthy:false,reason:'capture_unavailable'}));
 const id=f.state.incident.id;f.offline(true);f.advance(180000);
 await assert.rejects(api.reportIncident({...f.deps,healthy:false,reason:'capture_unavailable'}));
 f.offline(false);f.uncertainPost(false);
 assert.equal((await api.reportIncident({...f.deps,healthy:false,reason:'capture_unavailable'})).status,'sent');
 assert.equal(f.posts,1);assert.equal(f.state.incident.id,id);
});

test('verified recovery closes the incident quietly and a later outage gets its own notice',async()=>{
 assert.equal(typeof api.reportIncident,'function');const f=fixture();
 await api.reportIncident({...f.deps,healthy:false,reason:'capture_unavailable'});
 const first=f.state.incident.id;
 assert.equal((await api.reportIncident({...f.deps,healthy:true})).status,'healthy');assert.equal(f.posts,1);
 await api.reportIncident({...f.deps,healthy:false,reason:'capture_unavailable'});
 assert.equal(f.posts,2);assert.notEqual(f.state.incident.id,first);
});

test('healthy monitoring never initializes an alert or calls Slack',async()=>{
 assert.equal(typeof api.reportIncident,'function');const f=fixture();f.offline(true);
 assert.equal((await api.reportIncident({...f.deps,healthy:true})).status,'healthy');assert.equal(f.posts,0);
});

test('watchdog catches validation failures and verifies capture after recovery before clearing the incident',()=>{
 const src=fs.readFileSync(path.join(__dirname,'../scripts/windows/watch-kakao-production.ps1'),'utf8');
 assert.match(src,/kakao-runtime-incident\.js/);
 assert.match(src,/catch\s*\{[\s\S]*Report-WatchdogIncident[\s\S]*throw/);
 assert.match(src,/Invoke-KakaoLiveEvaluator\s*\r?\n\s*Confirm-WatchdogRecovery/);
});

test('the real watchdog invokes its independent notifier when plugin validation aborts before capture', {skip:process.platform!=='win32'},()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'village-watchdog-failure-'));
 try {
  const scripts=path.join(temp,'scripts/windows'),bridge=path.join(temp,'tools/kakao-dom-bridge');
  fs.mkdirSync(scripts,{recursive:true});fs.mkdirSync(bridge,{recursive:true});
  fs.copyFileSync(path.join(__dirname,'../scripts/windows/watch-kakao-production.ps1'),path.join(scripts,'watch-kakao-production.ps1'));
  const marker=path.join(temp,'notifier-call.json');
  fs.writeFileSync(path.join(scripts,'kakao-runtime-incident.js'),`require('node:fs').writeFileSync(${JSON.stringify(marker)},JSON.stringify(process.argv.slice(2)));`);
  fs.writeFileSync(path.join(bridge,'inject-watcher-cdp.py'),'');
  for(const [name,value] of Object.entries({'env.fixture':'','benchmark.json':JSON.stringify({accepted:true,latency_status:'pass'}),'receipt.json':'{}','smoke.json':'{}'}))fs.writeFileSync(path.join(temp,name),value);
  const quote=s=>"'"+s.replaceAll("'","''")+"'";
  const command=`function Import-Module {}\nfunction Import-DotEnvFile {}\nfunction Set-KakaoLiveRuntimeEnvironment {}\nfunction Test-KakaoPluginInstallReceipt {return $false}\n& ${quote(path.join(scripts,'watch-kakao-production.ps1'))} -EnvFile ${quote(path.join(temp,'env.fixture'))} -ChromePath unused -NodePath ${quote(process.execPath)} -HermesPythonPath ${quote(process.execPath)} -BenchmarkReportPath ${quote(path.join(temp,'benchmark.json'))} -PluginReceiptPath ${quote(path.join(temp,'receipt.json'))} -SmokeEvidencePath ${quote(path.join(temp,'smoke.json'))} -ConfirmKakaoGatewayCutover`;
  const result=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',command],{encoding:'utf8',windowsHide:true,timeout:20000});
  assert.notEqual(result.status,0,'failed validation must retain a failed task result');
  assert.ok(fs.existsSync(marker),'notifier must be called even though no capture/job/RQ could be created');
  assert.deepEqual(JSON.parse(fs.readFileSync(marker,'utf8')),['--failure','plugin_validation_failed']);
 } finally {
  assert.equal(path.dirname(path.resolve(temp)),path.resolve(os.tmpdir()));
  assert.ok(path.basename(temp).startsWith('village-watchdog-failure-'));
  fs.rmSync(temp,{recursive:true,force:true});
 }
});
