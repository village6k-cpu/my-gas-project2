import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';

const adapter = await import('./migration_bridge_work_probe.mjs').catch(() => ({}));
const sha = b => createHash('sha256').update(b).digest('hex');
const wait = ms => new Promise(r => setTimeout(r, ms));

async function debugOwner(url) {
  const socket=new WebSocket(url);
  await once(socket,'open');
  let next=0,paused=null;const pending=new Map();
  socket.addEventListener('message',event=>{
    const m=JSON.parse(event.data);
    if(m.id) {const p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}}
    else if(m.method==='Debugger.paused')paused=m.params;
    else if(m.method==='Debugger.resumed')paused=null;
  });
  return {socket,get paused(){return paused;},command(method,params={}) {
    const id=++next;return new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
  }};
}

async function fixture(t, {busy = '', actual = false, transport = 'cli', mismatchPort = false} = {}) {
  const parent = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(parent, 'village-private-work-test-'));
  const port = actual ? 19878 : 19879;
  let runtime = root;
  if (actual) {
    runtime = process.env.VILLAGE_TEST_SOURCE_RUNTIME;
    assert.ok(runtime, 'explicit current source runtime required');
    runtime = path.join(runtime, 'tools/kakao-dom-bridge');
  } else {
    await fs.writeFile(path.join(root, 'hermes-gateway-http.mjs'), `
      export function create() {
        const confirmationInFlight = new Map();
        const documentInFlight = new Map();
        const registeredReservationChangeInFlight = new Map();
        const confirmedReservationCommitInFlight = new Map();
        if (process.env.FIXTURE_BUSY === 'http') documentInFlight.set('PRIVATE-CUSTOMER', {secret:'NEVER-REPORT'});
        return async function handler(req,res,url) {
          if (false) console.log(confirmationInFlight, documentInFlight, registeredReservationChangeInFlight, confirmedReservationCommitInFlight);
          return false;
        };
      }`);
    await fs.writeFile(path.join(root, 'hermes-gateway-channel.mjs'), `
      export function create() {
        let mutationTail = process.env.FIXTURE_BUSY === 'channel' ? new Promise(()=>{}) : Promise.resolve();
        return {async status() { await mutationTail; }};
      }`);
    await fs.writeFile(path.join(root, 'server.mjs'), `
      import http from 'node:http';
      import {create as createHttp} from './hermes-gateway-http.mjs';
      import {create as createChannel} from './hermes-gateway-channel.mjs';
      const CONFIG = {port: Number(process.env.PORT) + (process.env.FIXTURE_MISMATCH === '1' ? 1 : 0)};
      const workOrchestratorActionPoller = {enabled:false};
      const gatewayHttpHandler = createHttp();
      const gatewayChannel = createChannel();
      function app() { let applicationTail = process.env.FIXTURE_BUSY === 'app' ? new Promise(()=>{}) : Promise.resolve(); return {async idle() { await applicationTail; }}; }
      function audit() { let projectionInFlight = process.env.FIXTURE_BUSY === 'audit' ? new Promise(()=>{}) : null; return {projectPending() { return projectionInFlight; }}; }
      const gatewayResultApplicationCoordinator = app();
      const kakaoAutomationAuditCoordinator = audit();
      function recovery() {let recoveryTail=process.env.FIXTURE_BUSY==='recovery' ? new Promise(()=>{}) : Promise.resolve();return {async recover(){await recoveryTail;}};}
      const gatewayFailureNotificationCoordinator = recovery();
      const workerChain=process.env.FIXTURE_BUSY==='chain' ? new Promise(()=>{}) : Promise.resolve();
      const registrationRetryRunning=process.env.FIXTURE_BUSY==='registration';
      const manualSendInFlight = new Map();
      const queuedWorkerSlotsByRoom = new Map();
      if (process.env.FIXTURE_BUSY === 'manual') manualSendInFlight.set('PRIVATE-CUSTOMER','NEVER-REPORT');
      const state = {workerRunning:false,slackActionPollRunning:false,p0SlackEscalationRunning:false,recoverySweepRunning:false,tabCleanupRunning:false,
        activeWorkerRuns:0,workerQueueLength:0,rooms:new Map(),activeWorkerJobIds:new Set(),workOrchestrator:{noticeCleanupRunning:false,digestRunning:false,workActionPollRunning:false}};
      if (process.env.FIXTURE_BUSY === 'worker') state.workerRunning = true;
      const server = http.createServer(async (req,res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        if (req.url === '/fixture-never-requested') console.log(CONFIG, workOrchestratorActionPoller, gatewayChannel, gatewayResultApplicationCoordinator, kakaoAutomationAuditCoordinator, manualSendInFlight, queuedWorkerSlotsByRoom, state, workerChain, registrationRetryRunning, gatewayFailureNotificationCoordinator);
        await gatewayHttpHandler(req,res,url);
        if (url.pathname === '/health') await gatewayChannel.status();
        if (url.pathname.startsWith('/migration-private-work/')) res.statusCode=404;
        res.end('ok');
      });
      server.listen(Number(process.env.PORT), '127.0.0.1', ()=>console.log('listening on'));
    `);
  }
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => ['PATH','SYSTEMROOT','WINDIR','TEMP','TMP'].includes(k.toUpperCase())));
  Object.assign(env, {HOME:root, USERPROFILE:root, HERMES_HOME:root, QUEUE_DIR:path.join(root,'queue'), PORT:String(port), FIXTURE_BUSY:busy,
    FIXTURE_MISMATCH:mismatchPort?'1':'0',KAKAO_HERMES_TRANSPORT:transport, KAKAO_HERMES_BRIDGE_TOKEN:'SYNTHETIC-NOT-A-CREDENTIAL', SUPABASE_RECOVERY_ENABLED:'false', KAKAO_TAB_CLEANUP_ENABLED:'0'});
  if(transport==='gateway_no_send') Object.assign(env,{SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'SYNTHETIC-NOT-A-CREDENTIAL'});
  const preload = path.join(root,'deny-external.mjs');
  await fs.writeFile(preload, `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import fs from 'node:fs'; import path from 'node:path';
    const deny=()=>{throw Error('External traffic forbidden in fixture');};
    const exists=fs.existsSync,read=fs.readFileSync;
    const productionEnv=p=>path.basename(String(p))==='.env' && !path.resolve(String(p)).startsWith(path.resolve(process.env.HERMES_HOME)+path.sep);
    fs.existsSync=p=>productionEnv(p)?false:exists(p);
    fs.readFileSync=(p,...a)=>{if(productionEnv(p))throw Error('Production env forbidden in fixture');return read(p,...a);};
    http.request=deny; https.request=deny; globalThis.fetch=deny; net.Socket.prototype.connect=deny;`);
  const child = spawn(process.execPath, ['--inspect=127.0.0.1:0','--import',pathToFileURL(preload).href,path.join(runtime,'server.mjs')],
    {env,cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stderr = '', stdout = '';
  child.stderr.on('data', c => {stderr += c;}); child.stdout.on('data', c => {stdout += c;});
  t.after(async () => {
    if(child.exitCode === null && child.signalCode === null) { const done=once(child,'exit'); child.kill(); await done; }
    assert.equal(path.dirname(root),parent); assert.ok(path.basename(root).startsWith('village-private-work-test-'));
    await fs.rm(root,{recursive:true,force:true});
  });
  const deadline = Date.now()+15000;
  while (!stdout.includes('listening on') && Date.now()<deadline) {
    if(child.exitCode!==null) throw Error('Fixture failed: '+stderr.slice(-800));
    await wait(20);
  }
  assert.ok(stdout.includes('listening on'), 'fixture must be listening');
  const ws = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/)?.[0]; assert.ok(ws);
  const modules = {};
  for (const [name,file] of Object.entries({server:'server.mjs',http:'hermes-gateway-http.mjs',channel:'hermes-gateway-channel.mjs'})) {
    const filename = path.join(runtime,file);
    modules[name] = {path:filename,sha256:sha(await fs.readFile(filename))};
  }
  return {ws,expected:{pid:child.pid,exe:process.execPath,cwd:root,port,modules},root};
}

test('probe is implemented before use', () => {
  assert.equal(typeof adapter.observeBridgePrivateWork,'function','read-only private-work observer is required');
});

test('real closure maps and promise states are observed without leaking private values or changing source', async t => {
  const {ws,expected} = await fixture(t);
  const result = await adapter.observeBridgePrivateWork(ws,expected);
  assert.equal(result.observation_only,true); assert.equal(result.stop_authorized,false);
  assert.equal(result.idle,true,JSON.stringify(result));
  assert.deepEqual(result.http_in_flight,{confirmationInFlight:0,documentInFlight:0,registeredReservationChangeInFlight:0,confirmedReservationCommitInFlight:0});
  assert.deepEqual(result.promises,{applicationTail:'fulfilled',projectionInFlight:'absent',mutationTail:'fulfilled',recoveryTail:'fulfilled',workerChain:'fulfilled'});
  assert.equal(JSON.stringify(result).includes('NEVER-REPORT'),false);
  for(const row of Object.values(expected.modules)) assert.equal(sha(await fs.readFile(row.path)),row.sha256);
  assert.equal((await fetch(`http://127.0.0.1:${expected.port}/health`)).status,200,'debugger always resumes');
});

for (const busy of ['http','app','audit','channel','manual','worker','recovery','chain','registration']) {
  test(`preexisting ${busy} work blocks idle observation`, async t => {
    const {ws,expected} = await fixture(t,{busy});
    const before=Date.now();
    const result = await adapter.observeBridgePrivateWork(ws,expected);
    assert.equal(result.idle,false);
    assert.equal(result.stop_authorized,false);
    assert.equal(JSON.stringify(result).includes('PRIVATE-CUSTOMER'),false);
    assert.equal(JSON.stringify(result).includes('NEVER-REPORT'),false);
    assert.ok(Date.now()-before<3000,'observation must not wait on the pending channel tail');
    assert.equal((await fetch(`http://127.0.0.1:${expected.port}/fixture-responsive`)).status,200);
  });
}

test('wrong process or loaded source hash fails closed and leaves server responding', async t => {
  const {ws,expected} = await fixture(t);
  await assert.rejects(adapter.observeBridgePrivateWork(ws,{...expected,pid:expected.pid+1}),/ownership/);
  const modules = structuredClone(expected.modules); modules.http.sha256='0'.repeat(64);
  await assert.rejects(adapter.observeBridgePrivateWork(ws,{...expected,modules}),/hash/);
  assert.equal((await fetch(`http://127.0.0.1:${expected.port}/health`)).status,200);
});

test('CURRENT production source, isolated from all external traffic, exposes its four private maps', async t => {
  const {ws,expected} = await fixture(t,{actual:true});
  const result = await adapter.observeBridgePrivateWork(ws,expected);
  assert.equal(result.idle,true,JSON.stringify(result));
  assert.equal(Object.keys(result.http_in_flight).length,4);
  assert.deepEqual(result.promises,{applicationTail:'absent',projectionInFlight:'absent',mutationTail:'absent',recoveryTail:'absent',workerChain:'fulfilled'});
  assert.equal(result.stop_authorized,false);
});

test('CURRENT no-send gateway source exposes its real channel mutation tail', async t => {
  const {ws,expected} = await fixture(t,{actual:true,transport:'gateway_no_send'});
  const result=await adapter.observeBridgePrivateWork(ws,expected);
  assert.equal(result.promises.mutationTail,'fulfilled');
  assert.equal(result.idle,true,JSON.stringify(result));
});

test('failure while paused removes breakpoint and resumes the owned server', async t => {
  const {ws,expected}=await fixture(t,{mismatchPort:true});
  await assert.rejects(adapter.observeBridgePrivateWork(ws,expected),/evaluation rejected/);
  assert.equal((await fetch(`http://127.0.0.1:${expected.port}/health`)).status,200);
});

test('observer never resumes a pause owned by another debugger',async t=>{
  const {ws,expected}=await fixture(t);
  const owner=await debugOwner(ws);
  let request;
  try {
    await owner.command('Debugger.enable');await owner.command('Debugger.pause');
    request=fetch(`http://127.0.0.1:${expected.port}/fixture-responsive`,{signal:AbortSignal.timeout(20000)}).catch(()=>null);
    const until=Date.now()+2000;while(!owner.paused && Date.now()<until)await wait(10);
    assert.ok(owner.paused);
    await assert.rejects(adapter.observeBridgePrivateWork(ws,expected),/pause|observation request/);
    assert.ok(owner.paused,'unrelated debugger pause must remain owned by its original debugger');
    await owner.command('Debugger.evaluateOnCallFrame',{callFrameId:owner.paused.callFrames[0].callFrameId,expression:'1'});
  } finally {
    if(owner.paused)await owner.command('Debugger.resume');owner.socket.close();if(request)await request;
  }
});
