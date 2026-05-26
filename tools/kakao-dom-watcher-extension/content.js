(() => {
  'use strict';

  const DEFAULT_CONFIG = {
    enabled: true,
    bridgeUrl: 'http://127.0.0.1:8787/events',
    minSilenceMs: 1500,
    maxTextLength: 280,
    debug: false
  };

  const STATE = {
    config: { ...DEFAULT_CONFIG },
    lastSignatureAt: new Map(),
    observer: null,
    heartbeatTimer: null,
    topRowPollTimer: null,
    lastTopRowsSignature: null
  };

  function log(...args) {
    if (STATE.config.debug) console.info('[Village Kakao Watcher]', ...args);
  }

  function loadConfig() {
    return new Promise((resolve) => {
      if (!chrome?.storage?.sync) return resolve(DEFAULT_CONFIG);
      chrome.storage.sync.get(DEFAULT_CONFIG, resolve);
    });
  }

  function normalizeText(value) {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, STATE.config.maxTextLength);
  }

  function hashText(value) {
    let hash = 2166136261;
    const text = String(value || '');
    for (let i = 0; i < text.length; i += 1) {
      hash ^= text.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function nearestChatRow(el) {
    if (!el || !(el instanceof Element)) return null;
    return el.closest([
      '[role="listitem"]',
      '[role="row"]',
      'li',
      '[class*="chat"]',
      '[class*="Chat"]',
      '[class*="talk"]',
      '[class*="Talk"]',
      '[class*="room"]',
      '[class*="Room"]'
    ].join(','));
  }

  function isPageContainerLike(row, rowText) {
    const id = row?.id || '';
    if (/^(kakaoWrap|kakaoContent)$/i.test(id)) return true;
    if (row === document.documentElement || row === document.body) return true;

    const text = String(rowText || '');
    if (/^(전체 채팅목록|중요채팅 목록|차단친구 목록)$/.test(text)) return true;
    const pageChromeSignals = [
      '채팅 목록 채팅 목록',
      '1:1 채팅사용 여부',
      '상담 완료하기',
      '채팅방 나가기',
      '친구차단'
    ];
    const isSettingsBlock = text.includes('1:1 채팅사용 여부') && text.includes('채팅설정');
    const importanceMarkers = (text.match(/중요\s/g) || []).length;
    const looksLikeChatListContainer = text.length > 120 && importanceMarkers >= 2;

    return pageChromeSignals.filter((needle) => text.includes(needle)).length >= 2
      || isSettingsBlock
      || looksLikeChatListContainer;
  }

  function extractUnreadCount(rowText) {
    const text = String(rowText || '');
    const candidates = [
      /안읽음\s*(\d+)/,
      /읽지\s*않은\s*메시지\s*(\d+)/,
      /unread\s*(\d+)/i,
      /새\s*메시지\s*(\d+)/,
      /\b([1-9][0-9]?)\b/g
    ];

    for (const re of candidates) {
      const match = re.exec(text);
      if (match && Number(match[1]) > 0) return Number(match[1]);
    }
    return null;
  }

  function hasUnreadSignal(el, text) {
    const attrs = [
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('title'),
      el.getAttribute?.('class')
    ].filter(Boolean).join(' ');
    const haystack = `${text || ''} ${attrs}`;
    return /안읽|읽지 않은|새 메시지|unread|badge|Badge/i.test(haystack) || extractUnreadCount(haystack) !== null;
  }

  function buildRoomKey(row, text) {
    const explicit = row?.getAttribute?.('data-id')
      || row?.getAttribute?.('data-chat-id')
      || row?.getAttribute?.('data-room-id')
      || row?.id;
    if (explicit) return `attr:${explicit}`;

    const rect = row?.getBoundingClientRect?.();
    const spatialHint = rect ? `${Math.round(rect.top / 10)}:${Math.round(rect.left / 10)}` : 'unknown';
    const textHint = normalizeText(text).slice(0, 80);
    return `dom:${spatialHint}:${hashText(textHint)}`;
  }

  function createEvent(row, reason, changedText) {
    const rowText = normalizeText(row?.innerText || row?.textContent || changedText || '');
    const roomKey = buildRoomKey(row, rowText);
    const unreadCount = extractUnreadCount(rowText);
    const signature = hashText(`${location.href}|${roomKey}|${rowText}|${reason}`);

    return {
      source: 'kakao_channel_manager_dom',
      status: 'pending_ai_review',
      reason,
      detectedAt: new Date().toISOString(),
      url: location.href,
      title: document.title,
      roomKey,
      eventHash: signature,
      previewText: rowText,
      unreadCount,
      pageVisibility: document.visibilityState,
      userAgent: navigator.userAgent
    };
  }

  async function postEvent(event) {
    if (!STATE.config.enabled) return;

    const now = Date.now();
    const lastAt = STATE.lastSignatureAt.get(event.eventHash) || 0;
    if (now - lastAt < STATE.config.minSilenceMs) return;
    STATE.lastSignatureAt.set(event.eventHash, now);

    try {
      await fetch(STATE.config.bridgeUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        keepalive: true
      });
      log('event sent', event.reason, event.roomKey, event.previewText);
    } catch (err) {
      console.warn('[Village Kakao Watcher] bridge post failed:', err?.message || err);
    }
  }

  function inspectElement(el, reason) {
    if (!isVisible(el)) return;
    const text = normalizeText(el.innerText || el.textContent || '');
    if (!text) return;

    const row = nearestChatRow(el) || el;
    const rowText = normalizeText(row.innerText || row.textContent || text);
    if (!rowText) return;
    if (isPageContainerLike(row, rowText)) return;

    if (reason === 'mutation' && !hasUnreadSignal(el, text) && !hasUnreadSignal(row, rowText)) {
      // 새 메시지 DOM은 class 이름이 불안정하다. 다만 모든 mutation을 보내면 너무 시끄러워지므로
      // unread/badge/새 메시지 신호가 있을 때만 이벤트로 올린다.
      return;
    }

    postEvent(createEvent(row, reason, text));
  }

  function scanInitialUnread() {
    const candidates = Array.from(document.querySelectorAll([
      '[aria-label*="안읽"]',
      '[aria-label*="읽지"]',
      '[aria-label*="새 메시지"]',
      '[class*="badge"]',
      '[class*="Badge"]',
      '[class*="unread"]',
      '[class*="Unread"]',
      '[role="listitem"]',
      'li'
    ].join(','))).slice(0, 250);

    for (const el of candidates) {
      const text = normalizeText(el.innerText || el.textContent || el.getAttribute('aria-label') || '');
      if (hasUnreadSignal(el, text)) inspectElement(el, 'initial_scan');
    }
  }

  function chatRowCandidates() {
    return Array.from(document.querySelectorAll([
      '[role="listitem"]',
      '[role="row"]',
      'li',
      '[class*="chat"]',
      '[class*="Chat"]',
      '[class*="room"]',
      '[class*="Room"]'
    ].join(',')))
      .filter(isVisible)
      .map((el) => {
        const row = nearestChatRow(el) || el;
        const text = normalizeText(row.innerText || row.textContent || el.innerText || el.textContent || '');
        const rect = row.getBoundingClientRect?.();
        return { row, text, top: rect ? rect.top : Number.POSITIVE_INFINITY, left: rect ? rect.left : Number.POSITIVE_INFINITY };
      })
      .filter(({ row, text, top }) => text && text.length >= 4 && text.length <= 220 && top > 0 && !isPageContainerLike(row, text));
  }

  function firstVisibleChatRow() {
    const rows = chatRowCandidates().sort((a, b) => (a.top - b.top) || (a.left - b.left));
    return rows[0] || null;
  }

  function topRowsSnapshot(limit = 12) {
    const seen = new Set();
    const rows = [];
    for (const item of chatRowCandidates().sort((a, b) => (a.top - b.top) || (a.left - b.left))) {
      const key = `${Math.round(item.top)}:${item.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        row: item.row,
        top: Math.round(item.top),
        left: Math.round(item.left),
        text: item.text,
        signature: hashText(item.text)
      });
      if (rows.length >= limit) break;
    }
    return rows;
  }

  function diagnosticRows(rows) {
    return rows.map(({ top, left, text, signature }) => ({ top, left, text, signature }));
  }

  function rowsSignature(rows) {
    return rows.map((row) => `${row.top}:${row.left}:${row.signature}`).join('|');
  }

  function firstChangedRow(previousRows, currentRows) {
    const previousBySlot = new Map(previousRows.map((row, index) => [`${index}:${row.top}:${row.left}`, row.signature]));
    for (let index = 0; index < currentRows.length; index += 1) {
      const row = currentRows[index];
      if (previousBySlot.get(`${index}:${row.top}:${row.left}`) !== row.signature) return row;
    }
    return currentRows[0] || null;
  }

  function postTopRowsSnapshot(reason = 'top_rows_snapshot') {
    const rows = topRowsSnapshot();
    postEvent({
      source: 'kakao_channel_manager_dom',
      status: 'dom_diagnostic',
      reason,
      detectedAt: new Date().toISOString(),
      url: location.href,
      title: document.title,
      roomKey: 'top-rows-snapshot',
      eventHash: hashText(`${reason}:${location.href}:${JSON.stringify(diagnosticRows(rows))}:${Math.floor(Date.now() / 5000)}`),
      previewText: rows.map((row) => row.text).join(' || '),
      unreadCount: null,
      pageVisibility: document.visibilityState,
      rows: diagnosticRows(rows)
    });
  }

  function startTopRowPolling() {
    if (STATE.topRowPollTimer) window.clearInterval(STATE.topRowPollTimer);

    const seedRows = topRowsSnapshot();
    STATE.lastTopRowsSignature = rowsSignature(seedRows);
    let previousRows = seedRows;

    STATE.topRowPollTimer = window.setInterval(() => {
      if (!STATE.config.enabled) return;
      const currentRows = topRowsSnapshot();
      if (!currentRows.length) return;
      const signature = rowsSignature(currentRows);
      if (!STATE.lastTopRowsSignature) {
        STATE.lastTopRowsSignature = signature;
        previousRows = currentRows;
        return;
      }
      if (signature === STATE.lastTopRowsSignature) return;
      const changed = firstChangedRow(previousRows, currentRows);
      STATE.lastTopRowsSignature = signature;
      previousRows = currentRows;
      if (changed) postEvent(createEvent(changed.row, 'top_rows_changed', changed.text));
    }, 2000);
  }

  function startObserver() {
    if (STATE.observer) STATE.observer.disconnect();

    STATE.observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'attributes') {
          inspectElement(mutation.target, 'mutation');
          continue;
        }
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue;
          inspectElement(node, 'mutation');
          const descendants = node.querySelectorAll?.('[aria-label], [class], [role="listitem"], li') || [];
          for (const child of Array.from(descendants).slice(0, 40)) inspectElement(child, 'mutation');
        }
      }
    });

    STATE.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'aria-label', 'title']
    });

    log('observer started');
  }

  function startHeartbeat() {
    if (STATE.heartbeatTimer) window.clearInterval(STATE.heartbeatTimer);
    STATE.heartbeatTimer = window.setInterval(() => {
      if (!STATE.config.enabled) return;
      postEvent({
        source: 'kakao_channel_manager_dom',
        status: 'watcher_heartbeat',
        reason: 'heartbeat',
        detectedAt: new Date().toISOString(),
        url: location.href,
        title: document.title,
        roomKey: 'watcher-heartbeat',
        eventHash: hashText(`heartbeat:${location.href}:${Math.floor(Date.now() / 60000)}`),
        previewText: '',
        unreadCount: null,
        pageVisibility: document.visibilityState
      });
    }, 60000);
  }

  async function init() {
    STATE.config = { ...DEFAULT_CONFIG, ...(await loadConfig()) };
    if (!STATE.config.enabled) {
      log('disabled');
      return;
    }
    startObserver();
    startTopRowPolling();
    startHeartbeat();
    window.setTimeout(() => postTopRowsSnapshot('top_rows_snapshot'), 1500);
    postEvent({
      source: 'kakao_channel_manager_dom',
      status: 'watcher_heartbeat',
      reason: 'content_script_started',
      detectedAt: new Date().toISOString(),
      url: location.href,
      title: document.title,
      roomKey: 'watcher-heartbeat',
      eventHash: hashText(`content_script_started:${location.href}:${Date.now()}`),
      previewText: '',
      unreadCount: null,
      pageVisibility: document.visibilityState
    });
    window.setTimeout(scanInitialUnread, 3000);
  }

  chrome?.storage?.onChanged?.addListener((changes) => {
    for (const [key, change] of Object.entries(changes)) {
      STATE.config[key] = change.newValue;
    }
    log('config changed', STATE.config);
  });

  init();
})();
