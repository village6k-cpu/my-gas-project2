(() => {
  'use strict';

  const GLOBAL_KEY = '__villageKakaoWatcherInstance';
  if (window[GLOBAL_KEY]?.cleanup) window[GLOBAL_KEY].cleanup('replaced_by_new_content_script');

  const DEFAULT_CONFIG = {
    enabled: true,
    bridgeUrl: 'http://127.0.0.1:8787/events',
    minSilenceMs: 1500,
    maxTextLength: 280,
    topRowsSnapshotLimit: 30,
    topRowsPostLimit: 30,
    topRowsBackstopIntervalMs: 60000,
    deepBackstopEnabled: true,
    deepBackstopIntervalMs: 600000,
    deepBackstopStartupDelayMs: 30000,
    deepBackstopMaxRows: 80,
    deepBackstopStepDelayMs: 300,
    debug: false
  };

  const STATE = {
    config: { ...DEFAULT_CONFIG },
    lastSignatureAt: new Map(),
    observer: null,
    heartbeatTimer: null,
    topRowPollTimer: null,
    deepBackstopTimer: null,
    deepBackstopStartupTimer: null,
    snapshotTimer: null,
    initialScanTimer: null,
    urlWatchTimer: null,
    lastUrl: location.href,
    started: false,
    lastTopRowsSignature: null,
    lastTopRowsBackstopAt: 0,
    deepBackstopRunning: false
  };

  function log(...args) {
    if (STATE.config.debug) console.info('[Village Kakao Watcher]', ...args);
  }

  function isKakaoChatManagerPage() {
    const host = location.hostname;
    const path = location.pathname;
    const isKakaoManagerHost = host === 'business.kakao.com' || host === 'center-pf.kakao.com';
    return isKakaoManagerHost && (/^\/_[^/]+\/chats(?:\/|$)/.test(path) || /^\/_chats(?:\/|$)/.test(path));
  }

  function isKakaoMainChatListPage() {
    const host = location.hostname;
    const path = location.pathname;
    const isKakaoManagerHost = host === 'business.kakao.com' || host === 'center-pf.kakao.com';
    return isKakaoManagerHost && (/^\/_[^/]+\/chats\/?$/.test(path) || /^\/_chats\/?$/.test(path));
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
    const virtualizedRow = el.closest('.ReactVirtualized__List.list_board > .ReactVirtualized__Grid__innerScrollContainer > li');
    if (virtualizedRow?.querySelector?.('a.link_chat .txt_name')) return virtualizedRow;
    const structuralRow = el.closest('[role="listitem"], li');
    return structuralRow?.querySelector?.('a.link_chat .txt_name') ? structuralRow : null;
  }

  function extractStableChatId(row) {
    const checkboxId = row?.querySelector?.('input[id^="chat-select-"]')?.id || '';
    const checkboxMatch = /^chat-select-(.+)$/.exec(checkboxId);
    if (checkboxMatch?.[1]) return normalizeText(checkboxMatch[1]);

    const explicit = row?.getAttribute?.('data-chat-id')
      || row?.getAttribute?.('data-room-id')
      || row?.getAttribute?.('data-id')
      || '';
    return normalizeText(explicit);
  }

  function extractCustomerName(row) {
    return normalizeText(row?.querySelector?.('.txt_name')?.textContent || '');
  }

  function extractMessagePreview(row) {
    return normalizeText(row?.querySelector?.('.txt_info')?.textContent || '');
  }

  function extractDisplayTime(row) {
    return normalizeText(row?.querySelector?.('.txt_date')?.textContent || '');
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
      /새\s*메시지\s*(\d+)/
    ];

    for (const re of candidates) {
      const match = re.exec(text);
      if (match && Number(match[1]) > 0) return Number(match[1]);
    }
    const topRowBadge = /^중요\s+(.{1,90}?)\s+([1-9]\d?)\s+(\S.*)$/.exec(normalizeText(text));
    if (topRowBadge) {
      const count = Number(topRowBadge[2]);
      const next = topRowBadge[3] || '';
      if (count > 0 && count <= 20 && !/^(월|일|시|분|초|원|개|건|구|세트|set\b)/i.test(next)) return count;
    }
    return null;
  }

  function extractRowUnreadCount(row, rowText = '') {
    const badgeText = normalizeText(row?.querySelector?.('.num_round')?.textContent || '');
    if (/^[1-9]\d?$/.test(badgeText)) {
      const count = Number(badgeText);
      if (count > 0 && count <= 99) return count;
    }
    return extractUnreadCount(rowText);
  }

  function hasUnreadSignal(el, text) {
    const row = nearestChatRow(el) || el;
    if (extractRowUnreadCount(row, text) > 0) return true;
    const attrs = [
      el.getAttribute?.('aria-label'),
      el.getAttribute?.('title')
    ].filter(Boolean).join(' ');
    // Kakao uses generic `Badge` classes for several visual elements, including
    // regular/old chat rows. Treating every class containing "badge" as unread
    // turned the periodic backstop into a full-chat-list reprocessor.
    if (/안읽|읽지 않은|새 메시지|unread/i.test(`${text || ''} ${attrs}`)) return true;

    const className = String(el.getAttribute?.('class') || '');
    return /(?:^|[\s_-])(?:unread|new-message)(?:$|[\s_-])/i.test(className);
  }

  function buildRoomKey(row, text) {
    const chatId = extractStableChatId(row);
    if (chatId) return `chat:${chatId}`;

    const customerName = extractCustomerName(row);
    if (customerName) return `customer:${hashText(customerName)}`;

    // Fail closed to a non-spatial fallback. Coordinates and full preview text
    // change whenever the virtualized list reorders or a customer writes again.
    return `unknown:${hashText(normalizeText(text).slice(0, 80))}`;
  }

  function canonicalTopRowText(text) {
    return normalizeText(text)
      .replace(/^중요\s+/, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function createEvent(row, reason, changedText) {
    const rowText = normalizeText(row?.innerText || row?.textContent || changedText || '');
    const isTopRowEvent = reason === 'top_row_changed' || reason === 'top_rows_backstop';
    const topRowText = canonicalTopRowText(rowText);
    const roomKey = buildRoomKey(row, rowText);
    const customerName = extractCustomerName(row);
    const messagePreview = extractMessagePreview(row);
    const displayTime = extractDisplayTime(row);
    const unreadCount = extractRowUnreadCount(row, rowText);
    const unreadSignal = hasUnreadSignal(row, rowText);
    const signature = isTopRowEvent
      ? hashText(`kakao-chat-toprow:${roomKey}:${topRowText}:${reason}`)
      : hashText(`${location.href}|${roomKey}|${rowText}|${reason}`);

    return {
      source: 'kakao_channel_manager_dom',
      status: 'pending_ai_review',
      reason,
      detectedAt: new Date().toISOString(),
      url: location.href,
      title: document.title,
      roomKey,
      customerName,
      eventHash: signature,
      previewText: rowText,
      messagePreview,
      displayTime,
      unreadCount,
      unreadSignal,
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
      const result = await chrome.runtime.sendMessage({
        type: 'village_kakao_bridge_event',
        bridgeUrl: STATE.config.bridgeUrl,
        event
      });
      if (!result?.ok) throw new Error(`bridge returned ${result?.status || 0}`);
      log('event sent', event.reason, event.roomKey, event.previewText);
    } catch (err) {
      console.warn('[Village Kakao Watcher] bridge post failed:', err?.message || err);
    }
  }

  function inspectElement(el, reason) {
    if (!isKakaoMainChatListPage()) return;
    if (!isVisible(el)) return;
    const text = normalizeText(el.innerText || el.textContent || '');
    if (!text) return;

    const row = nearestChatRow(el);
    if (!row) return;
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
    for (const { row, text } of chatRowCandidates().slice(0, 250)) {
      if (hasUnreadSignal(row, text)) inspectElement(row, 'initial_scan');
    }
  }

  function chatRowCandidates() {
    const seenRows = new Set();
    return Array.from(document.querySelectorAll([
      '.ReactVirtualized__List.list_board > .ReactVirtualized__Grid__innerScrollContainer > li',
      '[role="grid"].list_board > .ReactVirtualized__Grid__innerScrollContainer > li'
    ].join(',')))
      .filter(isVisible)
      .map((el) => {
        const row = nearestChatRow(el);
        if (!row) return null;
        const text = normalizeText(row.innerText || row.textContent || el.innerText || el.textContent || '');
        const rect = row.getBoundingClientRect?.();
        return { row, text, top: rect ? rect.top : Number.POSITIVE_INFINITY, left: rect ? rect.left : Number.POSITIVE_INFINITY };
      })
      .filter(Boolean)
      .filter(({ row }) => {
        if (seenRows.has(row)) return false;
        seenRows.add(row);
        return true;
      })
      .filter(({ row, text, top }) => text && text.length >= 4 && text.length <= 220 && top > 0 && !isPageContainerLike(row, text));
  }

  function firstVisibleChatRow() {
    const rows = chatRowCandidates().sort((a, b) => (a.top - b.top) || (a.left - b.left));
    return rows[0] || null;
  }

  function topRowsSnapshot(limit = STATE.config.topRowsSnapshotLimit || 30) {
    const seen = new Set();
    const rows = [];
    for (const item of chatRowCandidates().sort((a, b) => (a.top - b.top) || (a.left - b.left))) {
      const canonicalText = canonicalTopRowText(item.text);
      const roomKey = buildRoomKey(item.row, item.text);
      const key = roomKey;
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({
        row: item.row,
        roomKey,
        top: Math.round(item.top),
        left: Math.round(item.left),
        text: item.text,
        signature: hashText(`${roomKey}:${canonicalText}`)
      });
      if (rows.length >= limit) break;
    }
    return rows;
  }

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function chatListScrollContainer() {
    const candidates = [
      document.scrollingElement,
      ...Array.from(document.querySelectorAll('main, section, [role="main"], [role="list"], div, ul'))
    ].filter(Boolean)
      .filter((el) => el.scrollHeight > el.clientHeight + 80 && isVisible(el));

    return candidates
      .map((el) => {
        const rowsInside = chatRowCandidates().filter((item) => el === document.scrollingElement || el.contains(item.row)).length;
        return { el, score: rowsInside * 1000 + Math.min(el.clientHeight || 0, 1000) };
      })
      .sort((a, b) => b.score - a.score)[0]?.el || document.scrollingElement;
  }

  async function runDeepBackstopSweep(reason = 'deep_backstop') {
    if (!STATE.config.enabled || !STATE.config.deepBackstopEnabled || STATE.deepBackstopRunning) return;
    if (!isKakaoMainChatListPage()) return;
    const scroller = chatListScrollContainer();
    if (!scroller) return;

    STATE.deepBackstopRunning = true;
    const originalTop = scroller.scrollTop;
    const seen = new Set();
    let posted = 0;
    try {
      for (let step = 0; step < 20 && posted < STATE.config.deepBackstopMaxRows; step += 1) {
        const rows = topRowsSnapshot(STATE.config.topRowsSnapshotLimit || 30);
        for (const row of rows) {
          if (posted >= STATE.config.deepBackstopMaxRows) break;
          if (seen.has(row.signature)) continue;
          seen.add(row.signature);
          // A deep scan is only a recovery path for genuinely unread rows. Do
          // not emit every historical chat row just because it is visible.
          if (!hasUnreadSignal(row.row, row.text) && !extractUnreadCount(row.text)) continue;
          posted += 1;
          postEvent(createEvent(row.row, 'top_rows_backstop', row.text));
        }
        const nextTop = Math.min(scroller.scrollTop + Math.max(240, Math.floor(scroller.clientHeight * 0.85)), scroller.scrollHeight - scroller.clientHeight);
        if (!Number.isFinite(nextTop) || nextTop <= scroller.scrollTop + 4) break;
        scroller.scrollTop = nextTop;
        await sleep(STATE.config.deepBackstopStepDelayMs);
      }
      log(reason, 'posted rows', posted);
    } finally {
      scroller.scrollTop = originalTop;
      STATE.deepBackstopRunning = false;
    }
  }

  function diagnosticRows(rows) {
    return rows.map(({ top, left, text, signature }) => ({ top, left, text, signature }));
  }

  function rowsSignature(rows) {
    return rows.map((row) => row.signature).join('|');
  }

  function changedRows(previousRows, currentRows) {
    const previousSignatures = new Set(previousRows.map((row) => row.signature));
    const changed = [];
    for (let index = 0; index < currentRows.length; index += 1) {
      const row = currentRows[index];
      if (!previousSignatures.has(row.signature)) changed.push(row);
    }
    return changed;
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
      const now = Date.now();
      const backstopDue = now - STATE.lastTopRowsBackstopAt >= STATE.config.topRowsBackstopIntervalMs;
      if (signature === STATE.lastTopRowsSignature && !backstopDue) return;
      const changed = signature === STATE.lastTopRowsSignature ? [] : changedRows(previousRows, currentRows);
      const unreadBackstop = currentRows.filter((row) => hasUnreadSignal(row.row, row.text));
      // The bridge already handles live row changes. Periodically re-posting
      // every read row caused stale conversations to be classified as new.
      const readBackstop = [];
      const toPost = [];
      const seen = new Set();
      for (const row of [...changed, ...unreadBackstop, ...readBackstop].slice(0, STATE.config.topRowsPostLimit || 30)) {
        const key = row.signature;
        if (seen.has(key)) continue;
        seen.add(key);
        toPost.push(row);
      }
      STATE.lastTopRowsSignature = signature;
      previousRows = currentRows;
      if (backstopDue) STATE.lastTopRowsBackstopAt = now;
      const changedKeys = new Set(changed.map((row) => row.signature));
      for (const row of toPost) {
        const key = row.signature;
        postEvent(createEvent(row.row, changedKeys.has(key) ? 'top_row_changed' : 'top_rows_backstop', row.text));
      }
    }, 2000);
  }

  function startDeepBackstop() {
    if (STATE.deepBackstopTimer) window.clearInterval(STATE.deepBackstopTimer);
    if (STATE.deepBackstopStartupTimer) window.clearTimeout(STATE.deepBackstopStartupTimer);
    if (!STATE.config.deepBackstopEnabled) return;
    STATE.deepBackstopStartupTimer = window.setTimeout(() => runDeepBackstopSweep('deep_backstop_startup'), STATE.config.deepBackstopStartupDelayMs);
    STATE.deepBackstopTimer = window.setInterval(() => runDeepBackstopSweep('deep_backstop_interval'), STATE.config.deepBackstopIntervalMs);
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

  function stopWatcher(reason = 'stopped') {
    if (STATE.observer) {
      STATE.observer.disconnect();
      STATE.observer = null;
    }
    if (STATE.heartbeatTimer) window.clearInterval(STATE.heartbeatTimer);
    if (STATE.topRowPollTimer) window.clearInterval(STATE.topRowPollTimer);
    if (STATE.deepBackstopTimer) window.clearInterval(STATE.deepBackstopTimer);
    if (STATE.deepBackstopStartupTimer) window.clearTimeout(STATE.deepBackstopStartupTimer);
    if (STATE.snapshotTimer) window.clearTimeout(STATE.snapshotTimer);
    if (STATE.initialScanTimer) window.clearTimeout(STATE.initialScanTimer);
    STATE.heartbeatTimer = null;
    STATE.topRowPollTimer = null;
    STATE.deepBackstopTimer = null;
    STATE.deepBackstopStartupTimer = null;
    STATE.snapshotTimer = null;
    STATE.initialScanTimer = null;
    STATE.deepBackstopRunning = false;
    STATE.started = false;
    if (['replaced_by_new_content_script', 'pagehide', 'beforeunload'].includes(reason) && STATE.urlWatchTimer) {
      window.clearInterval(STATE.urlWatchTimer);
      STATE.urlWatchTimer = null;
    }
    log('watcher stopped', reason);
  }

  function startUrlWatcher() {
    if (STATE.urlWatchTimer) return;
    STATE.urlWatchTimer = window.setInterval(() => {
      if (STATE.lastUrl === location.href) return;
      STATE.lastUrl = location.href;
      if (isKakaoMainChatListPage()) {
        startWatcher();
      } else if (STATE.started) {
        stopWatcher('left_main_chat_list_page');
      }
    }, 1000);
  }

  function startWatcher() {
    if (STATE.started || !STATE.config.enabled) return;
    if (!isKakaoMainChatListPage()) {
      log('not the Kakao main chat list page', location.href);
      return;
    }
    STATE.started = true;
    startObserver();
    startTopRowPolling();
    startDeepBackstop();
    startHeartbeat();
    STATE.snapshotTimer = window.setTimeout(() => postTopRowsSnapshot('top_rows_snapshot'), 1500);
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
    STATE.initialScanTimer = window.setTimeout(scanInitialUnread, 3000);
  }

  async function init() {
    STATE.config = { ...DEFAULT_CONFIG, ...(await loadConfig()) };
    startUrlWatcher();
    if (!STATE.config.enabled) {
      log('disabled');
      stopWatcher('disabled_on_init');
      return;
    }
    startWatcher();
  }

  window[GLOBAL_KEY] = { cleanup: stopWatcher, state: STATE };
  window.addEventListener('pagehide', () => stopWatcher('pagehide'));
  window.addEventListener('beforeunload', () => stopWatcher('beforeunload'));

  chrome?.storage?.onChanged?.addListener((changes) => {
    const wasEnabled = STATE.config.enabled;
    for (const [key, change] of Object.entries(changes)) {
      STATE.config[key] = change.newValue;
    }
    log('config changed', STATE.config);
    if (wasEnabled && !STATE.config.enabled) stopWatcher('disabled_by_config');
    if (!wasEnabled && STATE.config.enabled) startWatcher();
  });

  init();
})();
