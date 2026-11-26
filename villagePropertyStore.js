/** Settings are an explicit, bounded set. Every other key is an operational record. */
function villagePropertySettings_() {
  return [
  'OPERATIONS_RECORDS_STORE_V1', 'inventorySemanticStore_v1_manifest',
  'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'CONTRACT_FOLDER_ID', 'CONTRAT_FOLDER_ID',
  'CONTRACT_TEMPLATE_ID', 'DASHBOARD_PHOTO_APPSHEET_FOLDER_ID', 'DASHBOARD_PHOTO_FOLDER_ID',
  'PHOTO_FOLDER_ID', '반출반납사진_FOLDER_ID', '반출반납사진_이미지_FOLDER_ID',
  'GROWTH_SLACK_WEBHOOK', 'HEYVILLY_AUTOPILOT_URL', 'GUIDE_ALERT_PHONE',
  'GUIDE_ALIMTALK_SUSPENDED', 'GUIDE_DOOR_PASSWORD',
  'MASTER_CORRECTION_APPLY_ENABLED', 'MASTER_CORRECTION_OWNER_ID',
  'MASTER_CORRECTION_PROOF_KEY', 'MASTER_CORRECTION_TEAM_ID',
  'MYPAGE_BASE_URL', 'MYPAGE_KAKAO_URL', 'MYPAGE_NOTICE', 'MYPAGE_SECRET',
  'PAYAPP_FEEDBACK_URL', 'PAYAPP_GOODNAME_PREFIX', 'PAYAPP_OPENPAYTYPE',
  'PAYAPP_RETURN_URL', 'PAYAPP_SMS_USE', 'PAYAPP_TEST_GOODNAME', 'PAYAPP_USERID',
  'PAYMENT_LEDGER_ENABLED', 'POPBILL_CORP_NUM', 'POPBILL_LINK_ID', 'POPBILL_SECRET_KEY',
  'POPBILL_SENDER_NUM', 'POPBILL_TPL_REGISTER', 'POPBILL_TPL_AVAIL',
  'SUPABASE_ANON_KEY', 'SUPABASE_BOT_EMAIL', 'SUPABASE_BOT_PASSWORD',
  'SUPABASE_SERVICE_KEY', 'SUPABASE_URL', 'TRADE_ID_RESERVATION_SECRET',
  'VILLAGE2_API_URL', 'VILLAGE_API_WRITE_KEY_V1', 'VILLAGE_API_WRITE_KEY_V2',
  'VILLAGE_KAKAO_AI_ADMIN_TOKEN', 'VILLAGE_KAKAO_AI_ADMIN_URL',
  'VILLAGE_OPS_API_URL', 'VILLAGE_OPS_KEY', 'WEB_APP_URL',
  '개고생2_API_KEY', '개고생2_API_URL', '개고생2_URL',
  'inventoryRisk_v1_enabled', 'inventoryRisk_v1_channel', 'inventoryRisk_v1_slackToken',
  'inventoryRisk_v1_turnaroundMinutes', 'inventoryRisk_v1_notificationHour',
  'preRegStock_v1_enabled', 'preRegStock_v1_channel', 'preRegStock_v1_externalRelay'
  ];
}
var VILLAGE_SCRIPT_PROPERTIES_FACADE_ = null;

/** Only this adapter and explicit storage diagnostics may access the physical settings store. */
function villageRawProperties_() { return PropertiesService.getScriptProperties(); }

function villagePropertyIsSetting_(key) {
  return villagePropertySettings_().indexOf(String(key)) >= 0;
}

function villagePropertyRuntimeReady_(config) {
  return !!config && !!config.runtimeReadyAt && Date.now() >= config.runtimeReadyAt;
}

/** Snapshot values stay fresh; only immutable sheet handles and row locations are cached. */
function villagePropertyReadAll_(base, config) {
  var result = base.getProperties();
  if (config.runtimeLegacyClearedAt) {
    Object.keys(result).forEach(function(key) { if (!villagePropertyIsSetting_(key)) delete result[key]; });
  }
  OPERATIONAL_PROPERTY_GROUPS_.forEach(function(group) {
    if (group === 'runtime' && !villagePropertyRuntimeReady_(config)) return;
    if (Date.now() < config.readyAt) return;
    var records = operationalPropertySheetRows_(operationalPropertySheet_(config, group), group);
    Object.keys(records).forEach(function(key) {
      if (operationalPropertyReady_(config, key) && records[key].value !== null &&
          !Object.prototype.hasOwnProperty.call(result, key)) result[key] = records[key].value;
    });
  });
  return result;
}

/** Preserve the Properties interface while moving all operational data out of its quota. */
function villageScriptProperties_() {
  if (VILLAGE_SCRIPT_PROPERTIES_FACADE_) return VILLAGE_SCRIPT_PROPERTIES_FACADE_;
  var base = villageRawProperties_(), config, configRead = false;
  function activeConfig() {
    if (!configRead) { config = operationalPropertyConfig_(base); configRead = true; }
    return villagePropertyRuntimeReady_(config) ? config : null;
  }
  var stores = Object.create(null), facade;
  function store(key) {
    var group = operationalPropertyGroup_(key);
    return stores[group] || (stores[group] = operationalPropertyStore_(group, base));
  }
  facade = {
    getProperty: function(key) {
      key = String(key);
      if (villagePropertyIsSetting_(key) || !activeConfig()) return base.getProperty(key);
      return store(key).getProperty(key);
    },
    setProperty: function(key, value) {
      key = String(key);
      if (villagePropertyIsSetting_(key) || !activeConfig()) base.setProperty(key, String(value));
      else store(key).setProperty(key, String(value));
      return facade;
    },
    deleteProperty: function(key) {
      key = String(key);
      if (villagePropertyIsSetting_(key) || !activeConfig()) base.deleteProperty(key);
      else store(key).deleteProperty(key);
      return facade;
    },
    getProperties: function() { return activeConfig() ? villagePropertyReadAll_(base, config) : base.getProperties(); },
    getKeys: function() {
      if (!activeConfig() && typeof base.getKeys === 'function') return base.getKeys();
      return Object.keys(facade.getProperties());
    },
    setProperties: function(values, deleteOthers) {
      if (deleteOthers) throw new Error('Replacing all settings and operational records is not supported');
      if (!activeConfig()) { base.setProperties(values, false); return facade; }
      operationalPropertyWithLock_(function() {
        var settings = {}, grouped = Object.create(null);
        Object.keys(values).forEach(function(key) {
          if (villagePropertyIsSetting_(key)) settings[key] = String(values[key]);
          else {
            var group = operationalPropertyGroup_(key);
            (grouped[group] || (grouped[group] = {}))[key] = String(values[key]);
          }
        });
        if (Object.keys(settings).length) base.setProperties(settings, false);
        Object.keys(grouped).forEach(function(group) {
          var keys = Object.keys(grouped[group]);
          store(keys[0]).setProperties(grouped[group], false);
        });
      });
      return facade;
    },
    deleteAllProperties: function() { throw new Error('Deleting all operational records through settings is not supported'); }
  };
  Object.defineProperty(facade, '__villageRawStore', { value: base });
  Object.defineProperty(facade, '__villageRoutedStorage', { get: function() { return !!activeConfig(); } });
  VILLAGE_SCRIPT_PROPERTIES_FACADE_ = facade;
  return facade;
}
