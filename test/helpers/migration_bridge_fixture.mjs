import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
const sha = b => createHash('sha256').update(b).digest('hex');
const wait = ms => new Promise(r => setTimeout(r, ms));
export async function fixture(t, {busy = '', actual = false, transport = 'cli', mismatchPort = false, recoveryHold = false, v2 = false} = {}) {
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
      function timerRuntime(kind) {let timer=null;return {state:{digestRunning:false,noticeCleanupRunning:process.env.FIXTURE_BUSY==='timer-start' && kind==='notice'},async start(){return timer;},stop(){timer=null;}};}
      const workOrchestratorDigestRuntime=timerRuntime('digest');
      const workOrchestratorNoticeCleanupRuntime=timerRuntime('notice');
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
        if (req.url === '/fixture-never-requested') console.log(CONFIG, workOrchestratorActionPoller, gatewayChannel, gatewayResultApplicationCoordinator, kakaoAutomationAuditCoordinator, manualSendInFlight, queuedWorkerSlotsByRoom, state, workerChain, registrationRetryRunning, gatewayFailureNotificationCoordinator,workOrchestratorDigestRuntime,workOrchestratorNoticeCleanupRuntime);
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
  if(['gateway','gateway_no_send'].includes(transport)) Object.assign(env,{SUPABASE_URL:'https://synthetic.invalid',SUPABASE_SERVICE_ROLE_KEY:'SYNTHETIC-NOT-A-CREDENTIAL'});
  if(v2 || recoveryHold) Object.assign(env,{FIXTURE_FAST_INTERVALS:'1',WORK_ORCHESTRATOR_V2_RUNTIME_MODE:'v2',
    WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED:'true',WORK_ORCHESTRATOR_V2_DIGEST_ENABLED:'true',WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED:'true',
    WORK_ORCHESTRATOR_V2_REPORT_ONLY_ENABLED:'true',WORK_ORCHESTRATOR_V2_HEYBILLI_ACTIONS_READY:'true',
    WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED:'true',WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED:'true',SLACK_DASHBOARD_URL:'https://synthetic.invalid',
    SLACK_AGENT_CARD_DELIVERY_ENABLED:'false',AI_WORKER_FOLLOW_UP_ITEMS_ENABLED:'false',P0_SLACK_ESCALATION_ENABLED:'false',SLACK_ACTION_POLL_ENABLED:'false',
    WORK_ORCHESTRATOR_V2_INBOX_CHANNEL_ID:'CSYNTHETIC',WORK_ORCHESTRATOR_V2_DIGEST_CHANNEL_ID:'CSYNTHETIC',SLACK_BOT_TOKEN:'SYNTHETIC-NOT-A-CREDENTIAL',
    WORK_ORCHESTRATOR_V2_SLACK_BOT_USER_ID:'USYNTHETIC',WORK_ORCHESTRATOR_V2_SLACK_BOT_ID:'BSYNTHETIC',WORK_ORCHESTRATOR_V2_SLACK_TEAM_ID:'TSYNTHETIC'});
  if(recoveryHold) {
    const manifest=path.join(root,'synthetic-held-manifest.json');
    const job={job_id:'SYNTHETIC-HELD-NOT-PRODUCTION',room_key:'SYNTHETIC-NOT-A-CUSTOMER',room_revision:1,state:'ready',
      created_at:'2025-01-01T00:00:00.000Z',updated_at:'2025-01-01T00:00:00.000Z',queue_order:1,attempts:0,event:{},local_context:{}};
    const jobRaw=JSON.stringify(job)+'\n',queue=path.join(root,'queue/hermes-gateway');await fs.mkdir(queue,{recursive:true});
    await fs.writeFile(path.join(queue,sha(job.job_id)+'.json'),jobRaw);
    await fs.writeFile(manifest,JSON.stringify({schema:'village-gateway-held-jobs/v1',queueDirectory:path.join(root,'queue/hermes-gateway'),
      freezeBefore:'2026-01-01T00:00:00.000Z',entries:[{jobId:job.job_id,sha256:sha(jobRaw)}]}));
    Object.assign(env,{KAKAO_GATEWAY_RECOVERY_MANIFEST:manifest});
  }
  const preload = path.join(root,'deny-external.mjs');
  await fs.writeFile(preload, `import http from 'node:http'; import https from 'node:https'; import net from 'node:net'; import fs from 'node:fs'; import path from 'node:path';
    const deny=()=>{throw Error('External traffic forbidden in fixture');};
    const exists=fs.existsSync,read=fs.readFileSync;
    const productionEnv=p=>path.basename(String(p))==='.env' && !path.resolve(String(p)).startsWith(path.resolve(process.env.HERMES_HOME)+path.sep);
    fs.existsSync=p=>productionEnv(p)?false:exists(p);
    fs.readFileSync=(p,...a)=>{if(productionEnv(p))throw Error('Production env forbidden in fixture');return read(p,...a);};
    if(process.env.FIXTURE_FAST_INTERVALS==='1'){const interval=globalThis.setInterval;globalThis.setInterval=(fn,ms,...args)=>interval(fn,ms>=30000?20:ms,...args);}
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

