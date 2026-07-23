const ALLOWED_KAKAO_HOSTS = new Set(['business.kakao.com', 'center-pf.kakao.com']);

export function isAllowedBridgeUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'http:' &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost') &&
      url.pathname === '/events' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function isAllowedSender(sender = {}) {
  try {
    const url = new URL(sender.url || sender.tab?.url || '');
    return url.protocol === 'https:' && ALLOWED_KAKAO_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

export async function postBridgeEvent(bridgeUrl, event, fetchImpl = fetch) {
  if (!isAllowedBridgeUrl(bridgeUrl)) return { ok: false, status: 0 };
  try {
    const response = await fetchImpl(bridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    return { ok: response.ok, status: response.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== 'village_kakao_bridge_event') return false;
    if (!isAllowedSender(sender)) {
      sendResponse({ ok: false, status: 0 });
      return false;
    }
    postBridgeEvent(message.bridgeUrl, message.event).then(sendResponse);
    return true;
  });
}
