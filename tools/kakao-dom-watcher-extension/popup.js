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

document.addEventListener('DOMContentLoaded', load);
$('save').addEventListener('click', save);
