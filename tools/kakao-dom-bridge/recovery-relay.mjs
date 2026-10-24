import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

function samePage(value, allowed) {
  try { const u = new URL(value), a = new URL(allowed); return u.origin === a.origin && u.pathname === a.pathname; } catch { return false; }
}
export function createRecoveryRelay({ allowedPageUrl, runId, request = fetch } = {}) {
  const allowed = new URL(allowedPageUrl);
  if (allowed.origin !== 'https://business.kakao.com' || !allowed.pathname.endsWith('/chats') || !runId) throw Error('Exact Kakao list and collector run are required');
  return async (source, message) => {
    const rejected = { ok: false, status: 0 };
    if (!source?.page || source.frame !== source.page.mainFrame() || !samePage(source.page.url(), allowedPageUrl)
      || message?.type !== 'village_kakao_bridge_event' || message.bridgeUrl !== 'http://127.0.0.1:8787/events'
      || !message.event || typeof message.event !== 'object' || Array.isArray(message.event)
      || message.event.source !== 'kakao_channel_manager_dom' || !samePage(message.event.url, allowedPageUrl)) return rejected;
    const body = JSON.stringify(message.event);
    if (Buffer.byteLength(body) > 1024 * 1024) return rejected;
    try {
      const h = await request('http://127.0.0.1:8787/health', { signal: AbortSignal.timeout(3000) });
      const health = await h.json();
      if (!h.ok || health.mode !== 'recovery_collect_only' || health.runId !== runId
        || health.businessAutomationReady !== false || health.customerSendingEnabled !== false) return rejected;
      // The ordinary production bridge does not implement this endpoint.
      const response = await request('http://127.0.0.1:8787/recovery-events', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(3000)
      });
      const ack = await response.json();
      return {
        ok: response.ok && ack.persisted === true && ack.processed === false
          && ack.mode === 'recovery_collect_only' && ack.runId === runId,
        status: response.status || 200
      };
    } catch { return rejected; }
  };
}
function installListener({ bindingName }) {
  globalThis.__villageRecoveryRelayOwner = bindingName;
  if (globalThis[bindingName + '_installed']) return;
  globalThis[bindingName + '_installed'] = true;
  addEventListener('message', async event => {
    const m = event.data;
    if (globalThis.__villageRecoveryRelayOwner !== bindingName || event.source !== window
      || m?.type !== 'village_kakao_bridge_request' || typeof m.requestId !== 'string'
      || m.bridgeUrl !== 'http://127.0.0.1:8787/events') return;
    let result = { ok: false, status: 0 };
    try { result = await globalThis[bindingName]({ type: 'village_kakao_bridge_event', bridgeUrl: m.bridgeUrl, event: m.event }); } catch {}
    window.postMessage({ type: 'village_kakao_bridge_response', requestId: m.requestId, result }, location.origin);
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  if (!path.isAbsolute(config.playwrightPath) || config.cdpUrl !== 'http://127.0.0.1:9223') throw Error('Existing local runtime required');
  const { chromium } = createRequire(import.meta.url)(config.playwrightPath);
  const relay = createRecoveryRelay(config);
  const browser = await chromium.connectOverCDP(config.cdpUrl, { noDefaults: true, timeout: 15000 });
  const pages = browser.contexts().flatMap(c => c.pages()).filter(p => samePage(p.url(), config.allowedPageUrl));
  if (pages.length !== 1) throw Error('Unique existing list required');
  const page = pages[0], bindingName = '__villageRecoveryRelay_' + config.runId.replace(/-/g, '');
  let accepted = 0, rejected = 0;
  await page.exposeBinding(bindingName, async (source, message) => {
    const result = await relay(source, message); if (result.ok) accepted++; else rejected++; return result;
  });
  await page.addInitScript(installListener, { bindingName });
  await page.evaluate(installListener, { bindingName });
  console.log(JSON.stringify({ state: 'relay_attached', pid: process.pid, runId: config.runId, pageUrl: page.url(), businessAutomationReady: false }));
  page.on('close', () => process.exit(1));
  browser.on('disconnected', () => process.exit(1));
  setInterval(() => console.log(JSON.stringify({ at: new Date().toISOString(), accepted, rejected })), 30000);
}
