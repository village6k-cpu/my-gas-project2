const DEFAULT_CONFIG = {
  enabled: true,
  bridgeUrl: 'http://127.0.0.1:8787/events',
  minSilenceMs: 1500,
  debug: false
};

function $(id) {
  return document.getElementById(id);
}

function load() {
  chrome.storage.sync.get(DEFAULT_CONFIG, (config) => {
    $('enabled').checked = Boolean(config.enabled);
    $('bridgeUrl').value = config.bridgeUrl || DEFAULT_CONFIG.bridgeUrl;
    $('minSilenceMs').value = Number(config.minSilenceMs || DEFAULT_CONFIG.minSilenceMs);
    $('debug').checked = Boolean(config.debug);
  });
}

function save() {
  const config = {
    enabled: $('enabled').checked,
    bridgeUrl: $('bridgeUrl').value.trim() || DEFAULT_CONFIG.bridgeUrl,
    minSilenceMs: Number($('minSilenceMs').value || DEFAULT_CONFIG.minSilenceMs),
    debug: $('debug').checked
  };
  chrome.storage.sync.set(config, () => {
    $('status').textContent = '저장됨';
    window.setTimeout(() => { $('status').textContent = ''; }, 1800);
  });
}

async function testBridge() {
  const bridgeUrl = $('bridgeUrl').value.trim() || DEFAULT_CONFIG.bridgeUrl;
  const payload = {
    source: 'kakao_channel_manager_dom',
    status: 'popup_bridge_test',
    reason: 'popup_bridge_test',
    detectedAt: new Date().toISOString(),
    url: 'chrome-extension-popup',
    title: 'Village Kakao Watcher Popup',
    roomKey: 'popup-bridge-test',
    eventHash: `popup-${Date.now()}`,
    previewText: '확장 프로그램 popup에서 보낸 bridge 연결 테스트',
    unreadCount: null,
    pageVisibility: 'visible'
  };

  $('status').textContent = '테스트 전송 중...';
  try {
    const response = await fetch(bridgeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const text = await response.text();
    $('status').textContent = response.ok ? 'Bridge 테스트 성공' : `Bridge 테스트 실패: ${response.status} ${text.slice(0, 80)}`;
  } catch (error) {
    $('status').textContent = `Bridge 테스트 실패: ${error.message}`;
  }
}

document.addEventListener('DOMContentLoaded', load);
$('save').addEventListener('click', save);
$('testBridge').addEventListener('click', testBridge);
