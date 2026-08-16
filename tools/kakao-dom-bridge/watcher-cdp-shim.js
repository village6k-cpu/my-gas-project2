(() => {
  globalThis.__villageKakaoCdpShim = true;
  const existing = globalThis.chrome && typeof globalThis.chrome === 'object' ? globalThis.chrome : {};
  const storage = existing.storage && typeof existing.storage === 'object' ? existing.storage : {};
  const runtime = existing.runtime && typeof existing.runtime === 'object' ? existing.runtime : {};
  if (!storage.sync) {
    storage.sync = { get(defaults, callback) { callback({ ...(defaults || {}) }); } };
  } else if (!storage.sync.get) {
    storage.sync.get = function get(defaults, callback) { callback({ ...(defaults || {}) }); };
  }
  if (!storage.onChanged) {
    storage.onChanged = { addListener() {} };
  } else if (!storage.onChanged.addListener) {
    storage.onChanged.addListener = function addListener() {};
  }
  // Main-world pages can expose or later restore a chrome.runtime.sendMessage
  // stub that is not connected to the extension. Keep a transport reference
  // outside that mutable object so the injected watcher cannot be disconnected.
  const bridgeSend = typeof globalThis.__villageKakaoBridgeSend === 'function'
    ? globalThis.__villageKakaoBridgeSend
    : async function villageKakaoBridgeSend(message) {
    try {
      const url = new URL(String(message?.bridgeUrl || ''));
      if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/events') {
        return { ok: false, status: 0, error: 'bridge_url_not_allowed' };
      }
      if (typeof globalThis.addEventListener === 'function' && typeof globalThis.postMessage === 'function') {
        const requestId = globalThis.crypto?.randomUUID?.() || `village-${Date.now()}-${Math.random()}`;
        const relayed = await new Promise((resolve) => {
          const timer = globalThis.setTimeout?.(() => {
            globalThis.removeEventListener?.('message', onMessage);
            resolve(null);
          }, 1500);
          function onMessage(event) {
            if (event?.data?.type !== 'village_kakao_bridge_response' || event.data.requestId !== requestId) return;
            if (timer) globalThis.clearTimeout?.(timer);
            globalThis.removeEventListener?.('message', onMessage);
            resolve(event.data.result || null);
          }
          globalThis.addEventListener('message', onMessage);
          globalThis.postMessage({
            type: 'village_kakao_bridge_request',
            requestId,
            bridgeUrl: url.toString(),
            event: message?.event || {}
          }, '*');
        });
        if (relayed?.ok) {
          villageKakaoBridgeSend.lastSuccessAt = Date.now();
          return relayed;
        }
      }
      const response = await fetch(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(message?.event || {})
      });
      const result = { ok: response.ok, status: response.status };
      if (result.ok) villageKakaoBridgeSend.lastSuccessAt = Date.now();
      return result;
    } catch (error) {
      return { ok: false, status: 0, error: String(error?.message || error) };
    }
  };
  if (typeof globalThis.__villageKakaoBridgeSend !== 'function') {
    Object.defineProperty(globalThis, '__villageKakaoBridgeSend', {
      value: bridgeSend,
      writable: false,
      configurable: false
    });
  }
  runtime.sendMessage = bridgeSend;
  existing.storage = storage;
  existing.runtime = runtime;
  globalThis.chrome = existing;
})();
