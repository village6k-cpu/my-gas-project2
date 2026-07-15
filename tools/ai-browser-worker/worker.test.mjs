import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import {
  buildHermesPrompt,
  extractJsonObject,
  buildSheetAppendPayload,
  buildFollowUpRows,
  buildSheetFailureFollowUpRows,
  buildSheetAvailabilityReport,
  enrichFollowUpRowsWithSheetAvailability,
  fetchExistingConfirmRequestResultForDecision,
  extractConfirmRequestIds,
  mapDecisionToStatusPatch,
  buildGasReadUrl,
  buildReadOnlyRagContext,
  parseVillageAiSse,
  askVillageAi,
  buildReadOnlyLookupContext,
  buildHermesArgs,
  resolveHermesCommand,
  resolveCuaDriverCommand,
  normalizeKakaoWorkerControlMode,
  parseMacHidIdleSeconds,
  checkKakaoCuaFallbackAllowed,
  buildKakaoTabAppleScript,
  ensureKakaoChannelManagerTabViaDevtools,
  ensureKakaoChannelManagerTab,
  kakaoDevtoolsBaseUrlFromEnv,
  pickKakaoMainListTarget,
  pickKakaoMainListWindow,
  pickKakaoConversationWindow,
  pickKakaoConversationTarget,
  findChatRowElementIndex,
  findKakaoChatSearchInputElementIndex,
  extractKakaoConversationEvidence,
  openKakaoTargetChatViaDevtools,
  openKakaoTargetChatFromList,
  extractNavigationHints,
  buildCompactJobForPrompt,
  canAutoSendCustomerAnswer,
  canAutoSendCustomerDocumentAssets,
  isCustomerDocumentAssetRequest,
  customerDocumentAssetsAlreadySent,
  normalizeConfirmRequestTimeForSheet,
  mutablePolicyAutoReplyRisk,
  currentConfirmedPolicyAutoReplySupport,
  autoReplyRequiresRagSupport,
  buildAutoReplyRagQuestion,
  evaluateAutoReplyRagSupport,
  isAutoSendEligibleLiveJob,
  buildAutoReplyDedupeKey,
  hasRecentSentAutoReply,
  filterFollowUpRowsAfterAutoReply,
  filterFollowUpRowsAgainstClosedHistory,
  mergeFollowUpRowsByTopic,
  upsertFollowUpRows,
  routeFollowUpToSlack,
  enrichFollowUpRowWithOperationalCalculations,
  buildSlackFollowUpMessage,
  resolveSlackChannelId,
  deliverSlackFollowUpRows,
  findKakaoMessageInputElementIndex,
  findKakaoSendButtonElementIndex,
  kakaoConversationContainsMessage,
  sendKakaoMessageViaChrome,
  sendKakaoMessageViaDevtools,
  runHermes,
  appendToSheet,
  normalizeConfirmRequestDateForSheet,
  buildCloseKakaoConversationWindowAppleScript,
  closeKakaoConversationWindow,
  closeKakaoConversationTargetViaDevtools
} from './worker.mjs';

test('buildHermesPrompt keeps code as plumbing and requires AI-visible Kakao verification', () => {
  const job = {
    id: 'job-1',
    room_key: 'preview:abc',
    preview_text: '중요 최재형 6 Supabase 실전 테스트 예약문의 오전 8:54',
    payload: { instructions: ['카카오 화면을 직접 확인한다.'] }
  };

  const prompt = buildHermesPrompt(job, { gasApiUrl: 'https://example.test/exec' });

  assert.match(prompt, /AI-first/);
  assert.match(prompt, /카카오.*화면.*직접/s);
  assert.match(prompt, /코드.*판단.*금지/s);
  assert.match(prompt, /Google Sheets.*API/s);
  assert.match(prompt, /FINAL_JSON/);
  assert.match(prompt, /job-1/);
});

test('buildHermesPrompt caps total tool calls and batches read-only lookups', () => {
  const prompt = buildHermesPrompt({ id: 'job-tool-budget', preview_text: '예약 문의' });
  assert.match(prompt, /at most 10 tool calls total/i);
  assert.match(prompt, /Batch.*read-only GAS lookups.*one terminal call/i);
  assert.match(prompt, /reaching.*budget.*FINAL_JSON/i);
});

test('buildCompactJobForPrompt strips bulky raw payload while preserving latest evidence', () => {
  const compact = buildCompactJobForPrompt({
    id: 'job-compact',
    status: 'processing_by_ai_worker',
    room_key: 'preview:abc',
    event_hash: 'dom-123',
    preview_text: '최재형 테스트 FX6 오후 2:29',
    unread_count: 1,
    detected_at: '2026-05-25T05:29:52Z',
    payload: {
      events: [{ previewText: '최재형 테스트 FX6 오후 2:29' }],
      huge: 'x'.repeat(20000)
    }
  });

  assert.deepEqual(Object.keys(compact).sort(), [
    'detected_at', 'event_hash', 'id', 'navigation_hints', 'preview_text', 'room_key', 'source', 'status', 'unread_count'
  ].sort());
  assert.equal(compact.id, 'job-compact');
  assert.equal(compact.preview_text, '최재형 테스트 FX6 오후 2:29');
  assert.deepEqual(compact.navigation_hints, ['최재형']);
  assert.equal(JSON.stringify(compact).includes('xxxxx'), false);
});

test('extractNavigationHints derives customer hint only for chat navigation', () => {
  assert.deepEqual(
    extractNavigationHints({ preview_text: '중요 정재하 2 견적서 먼저 주시면 입금드릴게요! 오후 7:16' }),
    ['정재하']
  );
  assert.deepEqual(
    extractNavigationHints({ customer_name: '오예린', preview_text: '중요 오예린 4 반납했습니다 오후 6:36' }),
    ['오예린']
  );
});

test('buildHermesPrompt uses compact job evidence instead of embedding full raw payload', () => {
  const prompt = buildHermesPrompt({
    id: 'job-big',
    room_key: 'preview:big',
    preview_text: 'FX6 문의',
    payload: { huge: 'x'.repeat(20000) }
  });

  assert.match(prompt, /JOB EVIDENCE FROM SUPABASE/);
  assert.doesNotMatch(prompt, /JOB FROM SUPABASE/);
  assert.equal(prompt.includes('x'.repeat(1000)), false);
  assert.ok(prompt.length < 15000, `prompt too large: ${prompt.length}`);
});

test('buildHermesPrompt uses navigation hints without letting code judge business meaning', () => {
  const prompt = buildHermesPrompt({ id: 'job-nav', preview_text: '중요 정재하 2 견적서 먼저 주시면 입금드릴게요! 오후 7:16' });

  assert.match(prompt, /navigation_hints/);
  assert.match(prompt, /정재하/);
  assert.match(prompt, /navigation evidence, not business classification evidence/);
  assert.match(prompt, /채팅 목록|chat list/);
  assert.match(prompt, /never type into the message compose box/);
});

test('buildHermesPrompt exposes village-ai RAG only as optional read-only reference memory', () => {
  const ragContext = buildReadOnlyRagContext({ villageAiUrl: 'https://village-ai.example', villageAiKakaoSkillSecret: 'secret-value' });
  assert.equal(ragContext.enabled, true);
  assert.equal(ragContext.provider, 'village-ai');
  assert.equal(ragContext.tool.command, 'node tools/ai-browser-worker/worker.mjs --rag-lookup');
  assert.equal(ragContext.tool.env.village_ai_url, 'VILLAGE_AI_URL');
  assert.equal(ragContext.tool.env.secret_env, 'VILLAGE_AI_KAKAO_SKILL_SECRET');
  assert.equal(JSON.stringify(ragContext).includes('secret-value'), false);
  const prompt = buildHermesPrompt({ id: 'job-rag', preview_text: '중요 홍길동 FX3 가격 문의' }, { ragContext });
  assert.match(prompt, /READ-ONLY VILLAGE-AI RAG TOOL/);
  assert.match(prompt, /long-term reference memory/);
  assert.match(prompt, /must not replace current Kakao screen evidence/);
  assert.match(prompt, /question string itself/);
  assert.match(prompt, /RAG 답변을 그대로 복붙하지 말고/);
  assert.match(prompt, /auto_send.*call RAG/s);
  assert.match(prompt, /CURRENT_CONFIRMED_POLICY/);
  assert.match(prompt, /학생 30%/);
  assert.match(prompt, /current-policy match or high-confidence retrieved support/);
  assert.match(prompt, /"rag_usage"/);
  assert.doesNotMatch(prompt, /secret-value/);
});

test('buildReadOnlyRagContext disables gracefully when VILLAGE_AI_URL is absent', () => {
  const ragContext = buildReadOnlyRagContext({});
  assert.equal(ragContext.enabled, false);
  assert.equal(ragContext.tool, null);
  assert.match(ragContext.unavailable_reason, /VILLAGE_AI_URL/);
});

test('parseVillageAiSse accumulates text and meta events from village-ai ask stream', () => {
  const parsed = parseVillageAiSse([
    'data: {"type":"text","text":"안녕하세요"}',
    '',
    'data: {"type":"text","text":". 가능 여부 확인해드릴게요"}',
    '',
    'data: {"type":"meta","confidence":"high","ownerReview":true,"knowledgeSource":"retrieved","usedSources":["faq"],"topSimilarity":0.82,"logId":"log-1"}',
    '',
    'data: {"type":"done"}',
    ''
  ].join('\n'));
  assert.equal(parsed.text, '안녕하세요. 가능 여부 확인해드릴게요');
  assert.equal(parsed.confidence, 'high');
  assert.equal(parsed.ownerReview, true);
  assert.equal(parsed.knowledgeSource, 'retrieved');
  assert.deepEqual(parsed.usedSources, ['faq']);
  assert.equal(parsed.topSimilarity, 0.82);
  assert.equal(parsed.logId, 'log-1');
  assert.equal(parsed.done, true);
});

test('askVillageAi posts to /api/ask and returns parsed SSE without exposing secret', async () => {
  let captured;
  const responseBody = 'data: {"type":"text","text":"참고 답변"}\n\ndata: {"type":"meta","confidence":"low","knowledgeSource":"general","logId":"log-2"}\n\ndata: {"type":"done"}\n\n';
  const result = await askVillageAi({ question: '카카오 맥락 포함 질문', userRole: 'customer' }, {
    villageAiUrl: 'https://village-ai.example/',
    villageAiKakaoSkillSecret: 'secret-value'
  }, {
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 200, text: async () => responseBody };
    }
  });
  assert.equal(captured.url, 'https://village-ai.example/api/ask');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['x-kakao-skill-secret'], 'secret-value');
  assert.equal(JSON.parse(captured.options.body).question, '카카오 맥락 포함 질문');
  assert.equal(result.text, '참고 답변');
  assert.equal(result.confidence, 'low');
  assert.equal(result.knowledgeSource, 'general');
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
});

test('buildHermesPrompt imports Claude Coworker policy while allowing aggressive reply drafting', () => {
  const prompt = buildHermesPrompt({ id: 'job-2', preview_text: 'FX3 내일 가능할까요?' });

  assert.match(prompt, /미리보기만 보고 분류하지 마라/);
  assert.match(prompt, /최근 24시간/s);
  assert.match(prompt, /직원.*이미 답변/s);
  assert.match(prompt, /킬 스위치/s);
  assert.match(prompt, /paused.*price_paused.*active/s);
  assert.match(prompt, /reply_decision\.replyMode="auto_send"/);
  assert.match(prompt, /suggested_reply_draft/s);
});

test('buildHermesPrompt prefers sheet writes for reservation-format requests', () => {
  const prompt = buildHermesPrompt({ id: 'job-3', preview_text: 'a7s3 2대 견적' });

  assert.match(prompt, /장비명은 AI가 최대한 추론\/정규화해서.*F열 item/s);
  assert.match(prompt, /정확 매칭이 불완전하면.*best normalized guess/s);
  assert.match(prompt, /정규화가 애매해도.*확인요청 입력은 막지 않는다/s);
  assert.match(prompt, /Q\/R에는 원문\/추론\/가용확인 후 안내/s);
  assert.match(prompt, /FX3.*A7S3.*FX6/s);
  assert.match(prompt, /할인유형.*학생.*개인사업자\/프리랜서.*일반/s);
  assert.match(prompt, /단골.*일반/s);
  assert.match(prompt, /계약마스터.*스케줄상세.*확인요청/s);
  assert.match(prompt, /예약형식.*should_write_to_sheet=true/s);
  assert.match(prompt, /불확실한 장비명.*입력 차단 사유가 아니라/s);
  assert.match(prompt, /연락처.*고객DB.*should_write_to_sheet=false/s);
  assert.match(prompt, /예약 등록이 불가능해서 연락처부터/s);
});

test('buildHermesPrompt treats read catch-up rows as possible missed reservations', () => {
  const prompt = buildHermesPrompt({ id: 'job-read', preview_text: '중요 최민석 감사합니다. 견적서 부탁드리겠습니다 5월 29일' });

  assert.match(prompt, /read-catchup\/backstop/);
  assert.match(prompt, /마지막 버블.*네네\/감사합니다\/견적서 부탁/s);
  assert.match(prompt, /예약형식 메시지가 있으면.*확인요청\/계약\/스케줄 등록 여부를 확인/s);
  assert.match(prompt, /자동화가 만든 것이라고 추정하거나 보고하지 마라/s);
  assert.match(prompt, /기존 RQ 발견으로 중복 입력 방지/s);
});

test('buildGasReadUrl creates read-only GAS URLs with encoded parameters', () => {
  const url = buildGasReadUrl('https://script.example/exec', 'secret key', {
    action: 'search',
    sheet: '세트마스터',
    col: 1,
    query: 'FX6 바디세트'
  });

  assert.equal(
    url,
    'https://script.example/exec?key=secret+key&action=search&sheet=%EC%84%B8%ED%8A%B8%EB%A7%88%EC%8A%A4%ED%84%B0&col=1&query=FX6+%EB%B0%94%EB%94%94%EC%84%B8%ED%8A%B8'
  );
});

test('buildReadOnlyLookupContext fetches kill switch and exposes read-only lookup templates', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [['price_paused']] })
    };
  };

  const context = await buildReadOnlyLookupContext(
    { gasApiUrl: 'https://script.example/exec', sheetApiKey: 'secret' },
    { preview_text: 'FX6 내일 가능할까요?' },
    { fetchImpl }
  );

  assert.equal(context.kill_switch.status, 'price_paused');
  assert.match(requested[0], /action=read/);
  assert.match(requested[0], /sheet=%EC%84%A4%EC%A0%95/);
  assert.equal(context.lookup_policy.mode, 'read_only');
  assert.match(context.lookup_urls.set_master_search_template, /action=search/);
  assert.match(context.lookup_urls.customer_db_by_name_search_template, /sheet=%EA%B3%A0%EA%B0%9DDB/);
  assert.match(context.lookup_urls.customer_db_by_name_search_template, /col=2/);
  assert.match(context.lookup_urls.request_recent_with_results_gviz, /SELECT\+A%2CB%2CC%2CD%2CE%2CF%2CG%2CI%2CJ%2CK/);
  assert.match(context.lookup_urls.request_by_req_id_gviz_template, /AI_REQ_ID/);
  assert.match(context.lookup_urls.contract_master_recent_gviz, /%EA%B3%84%EC%95%BD%EB%A7%88%EC%8A%A4%ED%84%B0/);
});

test('buildReadOnlyLookupContext reads kill switch from GAS header-only read responses', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ sheet: '설정', rowCount: 0, headers: ['active'], data: [] })
  });

  const context = await buildReadOnlyLookupContext(
    { gasApiUrl: 'https://script.example/exec', sheetApiKey: 'secret' },
    {},
    { fetchImpl }
  );

  assert.equal(context.kill_switch.status, 'active');
});

test('buildHermesPrompt injects read-only lookup context and permits terminal only for safe GET lookup', () => {
  const prompt = buildHermesPrompt(
    { id: 'job-4', preview_text: 'FX6' },
    { lookupContext: { kill_switch: { status: 'active' }, lookup_policy: { mode: 'read_only' } } }
  );

  assert.match(prompt, /READ-ONLY GAS LOOKUP CONTEXT/);
  assert.match(prompt, /terminal.*read-only GAS GET/s);
  assert.match(prompt, /write\/insert\/register\/send APIs.*금지/s);
});

test('buildHermesPrompt requires existing RQ availability result before follow-up reporting', () => {
  const prompt = buildHermesPrompt({ id: 'job-rq', preview_text: '최재원 AX-700 가능 문의' });

  assert.match(prompt, /확인요청에 이미 RQ.*I열\(결과\).*J열\(상세\)/s);
  assert.match(prompt, /사람에게 "RQ 결과를 검토하라"고만 떠넘기지 마라/);
  assert.match(prompt, /결과가 ✅ 가용일 때만.*예약 가능/s);
  assert.match(prompt, /follow-up must report the availability result itself/s);
});

test('buildHermesArgs preserves AI computer_use and bypasses approval with yolo', () => {
  const args = buildHermesArgs('prompt text');
  assert.deepEqual(args.slice(0, 8), ['chat', '--yolo', '-Q', '-t', 'terminal,computer_use,vision', '-q', 'prompt text']);
  assert.ok(args.includes('terminal,computer_use,vision'));
  assert.ok(args.includes('--yolo'));
});

test('resolveHermesCommand finds hermes in launchctl-safe fallback dirs', () => {
  const resolved = resolveHermesCommand('hermes', {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/village6k'
  });
  assert.match(resolved, /(^hermes$|\/hermes$)/);
});

test('resolveCuaDriverCommand finds cua-driver in launchctl-safe fallback dirs or returns empty', () => {
  const resolved = resolveCuaDriverCommand('cua-driver', {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/village6k'
  });
  assert.match(resolved, /(^$|\/cua-driver$)/);
});

test('normalizeKakaoWorkerControlMode supports non-stealing DevTools modes', () => {
  assert.equal(normalizeKakaoWorkerControlMode(''), 'devtools_first');
  assert.equal(normalizeKakaoWorkerControlMode('devtools_only'), 'devtools_only');
  assert.equal(normalizeKakaoWorkerControlMode('no_cua'), 'devtools_only');
  assert.equal(normalizeKakaoWorkerControlMode('cua_first'), 'cua_first');
});

test('parseMacHidIdleSeconds converts macOS idle nanoseconds', () => {
  assert.equal(parseMacHidIdleSeconds('    "HIDIdleTime" = 2500000000'), 2.5);
  assert.equal(parseMacHidIdleSeconds('no idle field'), null);
});

test('checkKakaoCuaFallbackAllowed gates CUA by mode before touching the screen', async () => {
  assert.deepEqual(
    await checkKakaoCuaFallbackAllowed({ mode: 'devtools_only', minIdleSeconds: 120 }),
    { allowed: false, mode: 'devtools_only', reason: 'cua_disabled_by_control_mode' }
  );
  assert.deepEqual(
    await checkKakaoCuaFallbackAllowed({ mode: 'cua_first', minIdleSeconds: 120 }),
    { allowed: true, mode: 'cua_first', reason: 'cua_first_mode' }
  );
  assert.deepEqual(
    await checkKakaoCuaFallbackAllowed({ mode: 'devtools_first', minIdleSeconds: 0 }),
    { allowed: true, mode: 'devtools_first', reason: 'idle_guard_disabled' }
  );
});

test('buildKakaoTabAppleScript focuses existing Kakao Channel Manager tabs or opens one', () => {
  const script = buildKakaoTabAppleScript();
  assert.match(script, /business\.kakao\.com/);
  assert.match(script, /center-pf\.kakao\.com/);
  assert.match(script, /tabUrl contains "\/chats\/"/);
  assert.match(script, / - 빌리지 - 카카오비즈니스/);
  assert.match(script, /set URL of tab t of window w to targetUrl/);
  assert.match(script, /set URL of active tab of newWindow to targetUrl/);
  assert.doesNotMatch(script, /make new window with properties/);
  assert.match(script, /active tab index/);
  assert.match(script, /activate/);
  assert.match(script, /targetUrl/);
});

test('kakaoDevtoolsBaseUrlFromEnv resolves explicit URL and port envs', () => {
  assert.equal(kakaoDevtoolsBaseUrlFromEnv({ KAKAO_DEVTOOLS_URL: 'http://127.0.0.1:9444/' }), 'http://127.0.0.1:9444');
  assert.equal(kakaoDevtoolsBaseUrlFromEnv({ KAKAO_REMOTE_DEBUGGING_PORT: '9223' }), 'http://127.0.0.1:9223');
  assert.equal(kakaoDevtoolsBaseUrlFromEnv({}), '');
});

test('pickKakaoMainListTarget selects list tab and avoids customer popup', () => {
  const target = pickKakaoMainListTarget([
    { id: 'popup', type: 'page', url: 'https://business.kakao.com/_x/chats', title: '최재형 - 빌리지 - 카카오비즈니스 파트너센터' },
    { id: 'conversation-url', type: 'page', url: 'https://business.kakao.com/_x/chats/4925785461840981', title: 'Loading...' },
    { id: 'main', type: 'page', url: 'https://center-pf.kakao.com/_x/chats', title: '카카오비즈니스 파트너센터' }
  ]);
  assert.equal(target.id, 'main');
});

test('ensureKakaoChannelManagerTabViaDevtools reuses automation profile tab without activating it', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, method: init.method || 'GET' });
    if (url === 'http://127.0.0.1:9223/json/list') {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([
          { id: 'main-tab', type: 'page', url: 'https://center-pf.kakao.com/_x/chats', title: '카카오비즈니스 파트너센터' }
        ])
      };
    }
    throw new Error(`unexpected request ${url}`);
  };

  const result = await ensureKakaoChannelManagerTabViaDevtools({
    cdpBaseUrl: 'http://127.0.0.1:9223',
    fetchImpl
  });

  assert.deepEqual(result, {
    status: 'ready_list_via_devtools',
    targetId: 'main-tab',
    url: 'https://center-pf.kakao.com/_x/chats'
  });
  assert.deepEqual(requests.map((request) => request.method), ['GET']);
});

test('ensureKakaoChannelManagerTab invokes osascript with target chat URL when CDP is not configured', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 222;
  let command;
  let args;
  const spawnImpl = (cmd, argv) => {
    command = cmd;
    args = argv;
    return child;
  };

  const resultPromise = ensureKakaoChannelManagerTab({
    url: 'https://business.kakao.com/test/chats',
    timeoutMs: 1000,
    spawnImpl,
    cdpBaseUrl: ''
  });
  child.stdout.write('focused_list\n');
  child.emit('close', 0);

  assert.deepEqual(await resultPromise, { status: 'focused_list' });
  assert.equal(command, 'osascript');
  assert.equal(args[0], '-e');
  assert.match(args[1], /Google Chrome/);
  assert.equal(args[2], 'https://business.kakao.com/test/chats');
});

test('pickKakaoMainListWindow avoids individual Kakao chat popup windows', () => {
  const win = pickKakaoMainListWindow([
    { app_name: 'Google Chrome', title: '여찬영 - 빌리지 - 카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 380, height: 816 } },
    { app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 1280, height: 1050 }, pid: 2, window_id: 20 }
  ]);
  assert.equal(win.pid, 2);
});

test('pickKakaoConversationWindow selects individual Kakao popup matching navigation hint', () => {
  const win = pickKakaoConversationWindow([
    { app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', pid: 1, window_id: 10 },
    { app_name: 'Google Chrome', title: '박재인 - 빌리지 - 카카오비즈니스 파트너센터', is_on_screen: true, pid: 3, window_id: 30 }
  ], ['박재인']);
  assert.equal(win.pid, 3);
  assert.equal(win.window_id, 30);
});

test('pickKakaoConversationTarget selects DevTools customer chat target by hint', () => {
  const target = pickKakaoConversationTarget([
    { type: 'page', title: '카카오비즈니스 파트너센터', url: 'https://business.kakao.com/_xhPMls/chats', id: 'list' },
    { type: 'page', title: '박재인 - 빌리지 - 카카오비즈니스 파트너센터', url: 'https://business.kakao.com/_xhPMls/chats/123', id: 'chat' }
  ], ['박재인']);
  assert.equal(target.id, 'chat');
});

test('findChatRowElementIndex finds AXLink row from navigation hint', () => {
  const tree = `
- [170] AXButton "중요"
- [171] AXLink (정진우 네, 장비 준비돼 있는 거 반출 하시면 됩니다 오후 8:20) actions=[AXShowMenu, AXScrollToVisible]
- [172] AXStaticText = "정진우"
`;
  assert.equal(findChatRowElementIndex(tree, ['정진우']), 171);
});

test('findChatRowElementIndex also matches hints rendered in AXLink child text', () => {
  const tree = `
- [170] AXButton "중요"
- [171] AXLink actions=[AXShowMenu, AXScrollToVisible]
  - [172] AXStaticText = "정진우"
  - [173] AXStaticText = "네, 장비 준비돼 있는 거 반출 하시면 됩니다"
  - [174] AXStaticText = "오후 8:20"
`;
  assert.equal(findChatRowElementIndex(tree, ['정진우']), 171);
});

test('findKakaoChatSearchInputElementIndex finds chat search field and ignores message composer', () => {
  const tree = `
- [11] AXTextField "주소창"
- [100] AXStaticText = "채팅방 검색"
- [101] AXTextField "고객 이름 또는 채팅방 검색"
- [500] AXStaticText = "채팅 메시지 입력 폼"
- [501] AXTextArea "메시지 입력"
`;
  assert.equal(findKakaoChatSearchInputElementIndex(tree), 101);
});

test('extractKakaoConversationEvidence returns compact live AX text tail without classifying', () => {
  const tree = `
- [11] AXStaticText = "박재인"
- [12] AXStaticText = "친구"
- [459] AXStaticText = "80메모리, 배터리 1개 추가 반출"
- [500] AXStaticText = "내일 촬영 종료 후 함께 반납하겠습니다."
- [501] AXStaticText = "감사합니다!"
- [510] AXStaticText = "채팅 메시지 입력 폼"
`;
  const evidence = extractKakaoConversationEvidence(tree, { title: '박재인 - 빌리지 - 카카오비즈니스 파트너센터', hints: ['박재인'], maxItems: 4 });
  assert.equal(evidence.source, 'live_kakao_ax_after_navigation');
  assert.equal(evidence.hint_matched, true);
  assert.deepEqual(evidence.visible_static_text_tail, ['박재인', '80메모리, 배터리 1개 추가 반출', '내일 촬영 종료 후 함께 반납하겠습니다.', '감사합니다!']);
  assert.match(evidence.note, /not a deterministic business classification/);
});

test('openKakaoTargetChatFromList clicks matching AXLink row only for navigation', async () => {
  const calls = [];
  let listCalls = 0;
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('list_windows')) {
        listCalls += 1;
        const windows = listCalls === 1
          ? [{ app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 1280, height: 1050 }, pid: 7, window_id: 70 }]
          : [
              { app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 1280, height: 1050 }, pid: 7, window_id: 70 },
              { app_name: 'Google Chrome', title: '정진우 - 빌리지 - 카카오비즈니스 파트너센터', is_on_screen: true, pid: 8, window_id: 80 }
            ];
        child.stdout.write(JSON.stringify({ windows }));
        child.emit('close', 0);
      } else if (args.includes('get_window_state')) {
        child.stdout.write(JSON.stringify({ tree_markdown: '- [171] AXLink (정진우 네, 장비 준비돼 있는 거 반출 하시면 됩니다 오후 8:20)\n- [22] AXStaticText = "정진우"' }));
        child.emit('close', 0);
      } else if (args.includes('click')) {
        child.stdout.write(JSON.stringify({ ok: true }));
        child.emit('close', 0);
      } else {
        child.stderr.write('unexpected');
        child.emit('close', 1);
      }
    });
    return child;
  };
  const result = await openKakaoTargetChatFromList({ preview_text: '중요 정진우 네, 장비 준비돼 있는 거 반출 하시면 됩니다 오후 8:20' }, { spawnImpl });
  assert.equal(result.status, 'opened_target_chat');
  assert.equal(result.element_index, 171);
  assert.equal(result.conversation_window.window_id, 80);
  assert.ok(calls.some((c) => c.args.includes('click')));
});

test('openKakaoTargetChatFromList uses an already-open matching conversation before searching the list', async () => {
  const calls = [];
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('list_windows')) {
        child.stdout.write(JSON.stringify({
          windows: [
            { app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 1280, height: 1050 }, pid: 7, window_id: 70 },
            { app_name: 'Google Chrome', title: '정진우 - 빌리지 - 카카오비즈니스 파트너센터', is_on_screen: true, pid: 8, window_id: 80 }
          ]
        }));
        child.emit('close', 0);
      } else if (args.includes('get_window_state')) {
        child.stdout.write(JSON.stringify({ tree_markdown: '- [22] AXStaticText = "정진우"\n- [23] AXStaticText = "네, 장비 준비돼 있는 거 반출 하시면 됩니다"' }));
        child.emit('close', 0);
      } else {
        child.stderr.write('unexpected');
        child.emit('close', 1);
      }
    });
    return child;
  };

  const result = await openKakaoTargetChatFromList({ preview_text: '중요 정진우 네, 장비 준비돼 있는 거 반출 하시면 됩니다 오후 8:20' }, { spawnImpl });
  assert.equal(result.status, 'opened_target_chat');
  assert.equal(result.already_open, true);
  assert.equal(result.conversation_window.window_id, 80);
  assert.equal(result.conversation_evidence.hint_matched, true);
  assert.equal(calls.some((c) => c.args.includes('click')), false);
});

test('openKakaoTargetChatFromList uses DevTools when matching conversation is on another macOS Space', async () => {
  const spawnImpl = (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('list_windows')) {
        child.stdout.write(JSON.stringify({
          windows: [
            { app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: false, pid: 7, window_id: 70 },
            { app_name: 'Google Chrome', title: '오래된고객 - 빌리지 - 카카오비즈니스 파트너센터', is_on_screen: false, pid: 8, window_id: 80 }
          ]
        }));
        child.emit('close', 0);
      } else {
        child.stderr.write('unexpected');
        child.emit('close', 1);
      }
    });
    return child;
  };
  let listCalls = 0;
  const fetchImpl = async () => {
    listCalls += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { type: 'page', id: 'chat', title: '오래된고객 - 빌리지 - 카카오비즈니스 파트너센터', url: 'https://business.kakao.com/_xhPMls/chats/123', webSocketDebuggerUrl: 'ws://chat' }
      ])
    };
  };
  const result = await openKakaoTargetChatFromList({
    customer_name: '오래된고객',
    preview_text: '오래된고객 문의'
  }, {
    spawnImpl,
    cdpBaseUrl: 'http://fake-devtools',
    fetchImpl,
    evaluateImpl: async () => ({ title: '오래된고객 - 빌리지 - 카카오비즈니스 파트너센터', text: '오래된고객\n문의 내용' })
  });
  assert.equal(result.status, 'opened_target_chat');
  assert.equal(result.via_devtools, true);
  assert.equal(result.conversation_target.id, 'chat');
  assert.equal(listCalls, 1);
});

test('openKakaoTargetChatFromList searches by customer name when target row is not visible', async () => {
  const calls = [];
  let listCalls = 0;
  let stateCalls = 0;
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('list_windows')) {
        listCalls += 1;
        const windows = listCalls === 1
          ? [{ app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 1280, height: 1050 }, pid: 7, window_id: 70 }]
          : [
              { app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 1280, height: 1050 }, pid: 7, window_id: 70 },
              { app_name: 'Google Chrome', title: '오래된고객 - 빌리지 - 카카오비즈니스 파트너센터', is_on_screen: true, pid: 8, window_id: 80 }
            ];
        child.stdout.write(JSON.stringify({ windows }));
        child.emit('close', 0);
      } else if (args.includes('get_window_state')) {
        stateCalls += 1;
        const tree = stateCalls === 1
          ? '- [100] AXStaticText = "채팅방 검색"\n- [101] AXTextField "고객 이름 또는 채팅방 검색"\n- [171] AXLink (최근고객 네 오후 8:20)'
          : '- [101] AXTextField "고객 이름 또는 채팅방 검색"\n- [222] AXLink (오래된고객 지난 문의 이어서 확인 부탁드립니다 오후 1:10)\n- [223] AXStaticText = "오래된고객"';
        child.stdout.write(JSON.stringify({ tree_markdown: tree }));
        child.emit('close', 0);
      } else if (args.includes('press_key') || args.includes('type_text') || args.includes('click')) {
        child.stdout.write(JSON.stringify({ ok: true }));
        child.emit('close', 0);
      } else {
        child.stderr.write('unexpected');
        child.emit('close', 1);
      }
    });
    return child;
  };

  const result = await openKakaoTargetChatFromList({
    customer_name: '오래된고객',
    preview_text: '오래된고객 지난 문의 이어서 확인 부탁드립니다'
  }, { spawnImpl });

  assert.equal(result.status, 'opened_target_chat');
  assert.equal(result.element_index, 222);
  assert.equal(result.search.searched, true);
  assert.equal(result.search.search_term, '오래된고객');
  assert.equal(result.conversation_window.window_id, 80);
  assert.ok(calls.some((c) => c.args.includes('type_text') && c.args.join(' ').includes('오래된고객')));
});

test('openKakaoTargetChatFromList skips Kakao search typing when search fallback is disabled', async () => {
  const calls = [];
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('list_windows')) {
        child.stdout.write(JSON.stringify({
          windows: [{ app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 1280, height: 1050 }, pid: 7, window_id: 70 }]
        }));
        child.emit('close', 0);
      } else if (args.includes('get_window_state')) {
        child.stdout.write(JSON.stringify({
          tree_markdown: '- [100] AXStaticText = "채팅방 검색"\n- [101] AXTextField "고객 이름 또는 채팅방 검색"\n- [171] AXLink (최근고객 네 오후 8:20)'
        }));
        child.emit('close', 0);
      } else {
        child.stderr.write('unexpected');
        child.emit('close', 1);
      }
    });
    return child;
  };

  const result = await openKakaoTargetChatFromList({
    customer_name: '오래된고객',
    preview_text: '오래된고객 지난 문의 이어서 확인 부탁드립니다'
  }, {
    spawnImpl,
    controlMode: 'cua_first',
    cdpBaseUrl: '',
    allowSearch: false
  });

  assert.equal(result.status, 'chat_row_not_found');
  assert.equal(result.search.disabled, true);
  assert.equal(result.search.reason, 'search_disabled');
  assert.ok(!calls.some((c) => c.args.includes('type_text')));
});

test('openKakaoTargetChatViaDevtools searches list DOM when CUA cannot see off-space Chrome body', async () => {
  const evalCalls = [];
  let listCalls = 0;
  const fetchImpl = async (url) => {
    listCalls += 1;
    const targets = listCalls === 1
      ? [{ type: 'page', id: 'list', title: '카카오비즈니스 파트너센터', url: 'https://business.kakao.com/_xhPMls/chats', webSocketDebuggerUrl: 'ws://list' }]
      : [
          { type: 'page', id: 'list', title: '카카오비즈니스 파트너센터', url: 'https://business.kakao.com/_xhPMls/chats', webSocketDebuggerUrl: 'ws://list' },
          { type: 'page', id: 'chat', title: '오래된고객 - 빌리지 - 카카오비즈니스 파트너센터', url: 'https://business.kakao.com/_xhPMls/chats/123', webSocketDebuggerUrl: 'ws://chat' }
        ];
    return { ok: true, status: 200, text: async () => JSON.stringify(targets) };
  };
  const evaluateImpl = async (target, expression) => {
    evalCalls.push({ target, expression });
    if (target.id === 'list') return { ok: true, status: 'clicked_chat_row_via_devtools', searchTerm: '오래된고객', tried: ['오래된고객'] };
    return { title: target.title, href: target.url, text: '채팅방 레이어\n오래된고객\n지난 문의 이어서 확인 부탁드립니다\n채팅 메시지 입력 폼' };
  };

  const result = await openKakaoTargetChatViaDevtools({
    customer_name: '오래된고객',
    preview_text: '오래된고객 지난 문의 이어서 확인 부탁드립니다'
  }, { cdpBaseUrl: 'http://127.0.0.1:9223', fetchImpl, evaluateImpl });

  assert.equal(result.status, 'opened_target_chat');
  assert.equal(result.via_devtools, true);
  assert.equal(result.opened_by_devtools_search, true);
  assert.equal(result.conversation_target.id, 'chat');
  assert.equal(result.search.search_term, '오래된고객');
  assert.equal(result.conversation_evidence.hint_matched, true);
  assert.ok(evalCalls[0].expression.includes('input[placeholder*="채팅방 이름"]'));
});

test('openKakaoTargetChatViaDevtools can avoid visible Kakao search fallback', async () => {
  let listCalls = 0;
  const fetchImpl = async () => {
    listCalls += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { type: 'page', id: 'list', title: '카카오비즈니스 파트너센터', url: 'https://business.kakao.com/_xhPMls/chats', webSocketDebuggerUrl: 'ws://list' }
      ])
    };
  };
  const evaluateImpl = async (target, expression) => {
    assert.equal(target.id, 'list');
    assert.match(expression, /allowSearchArg/);
    assert.match(expression, /false\)$/);
    return { ok: false, status: 'visible_chat_row_not_found_search_disabled', tried: [] };
  };

  const result = await openKakaoTargetChatViaDevtools({
    customer_name: '오래된고객',
    preview_text: '오래된고객 지난 문의 이어서 확인 부탁드립니다'
  }, {
    cdpBaseUrl: 'http://127.0.0.1:9223',
    fetchImpl,
    evaluateImpl,
    allowSearch: false
  });

  assert.equal(result.status, 'visible_chat_row_not_found_search_disabled');
  assert.equal(result.search.searched, false);
  assert.equal(result.search.disabled, true);
  assert.equal(listCalls, 1);
});

test('openKakaoTargetChatFromList does not claim verified chat when popup is missing', async () => {
  const spawnImpl = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('list_windows')) {
        child.stdout.write(JSON.stringify({ windows: [{ app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 1280, height: 1050 }, pid: 7, window_id: 70 }] }));
        child.emit('close', 0);
      } else if (args.includes('get_window_state')) {
        child.stdout.write(JSON.stringify({ tree_markdown: '- [171] AXLink (정진우 네, 장비 준비돼 있는 거 반출 하시면 됩니다 오후 8:20)' }));
        child.emit('close', 0);
      } else if (args.includes('click')) {
        child.stdout.write(JSON.stringify({ ok: true }));
        child.emit('close', 0);
      } else {
        child.stderr.write('unexpected');
        child.emit('close', 1);
      }
    });
    return child;
  };

  const result = await openKakaoTargetChatFromList({ preview_text: '중요 정진우 네, 장비 준비돼 있는 거 반출 하시면 됩니다 오후 8:20' }, { spawnImpl });
  assert.equal(result.status, 'conversation_window_not_found_after_click');
  assert.equal(result.conversation_window, null);
  assert.equal(result.conversation_evidence.hint_matched, false);
});

test('runHermes rejects quickly and terminates child process tree on timeout', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  let killedPid = null;
  const spawnImpl = () => child;
  const killTree = (pid) => {
    killedPid = pid;
    child.emit('close', null, 'SIGTERM');
  };

  await assert.rejects(
    runHermes('prompt text', { hermesCommand: 'fake-hermes', hermesTimeoutMs: 25 }, { spawnImpl, killTree }),
    /timed out after 25ms/
  );
  assert.equal(killedPid, 12345);
});

test('runHermes returns stdout before timeout when Hermes exits normally', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12346;
  const spawnImpl = () => child;

  const resultPromise = runHermes('prompt text', { hermesCommand: 'fake-hermes', hermesTimeoutMs: 1000 }, { spawnImpl });
  child.stdout.write('FINAL_JSON\n```json\n{}\n```');
  child.emit('close', 0);

  assert.equal(await resultPromise, 'FINAL_JSON\n```json\n{}\n```');
});

test('runHermes defaults nested computer_use capture to AX text mode to avoid huge screenshot payloads', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12347;
  let seenOptions = null;
  const spawnImpl = (_cmd, _args, options) => {
    seenOptions = options;
    return child;
  };

  const resultPromise = runHermes('prompt text', { hermesCommand: 'fake-hermes', hermesTimeoutMs: 1000 }, { spawnImpl });
  child.stdout.write('OK');
  child.emit('close', 0);

  assert.equal(await resultPromise, 'OK');
  assert.equal(seenOptions.env.HERMES_COMPUTER_USE_DEFAULT_CAPTURE_MODE, 'ax');
  assert.equal(seenOptions.env.HERMES_COMPUTER_USE_FORCE_CAPTURE_MODE, 'ax');
  assert.equal(seenOptions.env.HERMES_COMPUTER_USE_DEFAULT_MAX_ELEMENTS, '80');
});

test('extractJsonObject reads fenced FINAL_JSON object', () => {
  const text = `설명\n\nFINAL_JSON\n\`\`\`json\n{"should_write_to_sheet":false,"reason":"테스트"}\n\`\`\``;
  assert.deepEqual(extractJsonObject(text), {
    should_write_to_sheet: false,
    reason: '테스트'
  });
});

test('extractJsonObject ignores trailing diagnostics after the FINAL_JSON object', () => {
  const text = `FINAL_JSON
\`\`\`json
{"should_write_to_sheet":false,"reason":"정상 판단"}
{"diagnostic":"late tool output"}
\`\`\``;
  assert.deepEqual(extractJsonObject(text), {
    should_write_to_sheet: false,
    reason: '정상 판단'
  });
});

test('buildHermesPrompt requires sender separation and customer turn clustering', () => {
  const prompt = buildHermesPrompt({ id: 'job-sender', preview_text: '중요 홍길동 안녕하세요 오후 1:00' });
  assert.match(prompt, /SENDER AND TURN-TAKING POLICY/);
  assert.match(prompt, /staff\/outbound.*customer\/inbound/s);
  assert.match(prompt, /latest customer\/inbound message or a cluster/s);
  assert.match(prompt, /안녕하세요.*27일날.*fx3 가능한가요/s);
  assert.match(prompt, /latest_customer_message_after_last_staff_reply/);
  assert.match(prompt, /staff-confirmed-unregistered case/);
  assert.match(prompt, /reservation_inquiry\.confirmed=true/);
  assert.match(prompt, /conversation_turns/);
});

test('buildSheetAppendPayload refuses writes when latest actionable message is not customer after staff reply', () => {
  const decision = {
    should_write_to_sheet: true,
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      exact_equipment_name_verified_from_set_master: true,
      duplicate_checked_contract_master: true,
      duplicate_checked_schedule_detail: true,
      duplicate_checked_request_sheet: true,
      latest_customer_message_after_last_staff_reply: false,
      no_auto_reply_sent: true
    },
    sheet_row_candidate: { item: '소니 FX3 바디세트', customer_name: '홍길동' }
  };
  assert.equal(buildSheetAppendPayload(decision, { apiKey: 'secret' }), null);
});

test('buildSheetAppendPayload allows staff-confirmed unregistered reservations without a new customer turn', () => {
  const decision = {
    should_write_to_sheet: true,
    classification: 'already_answered',
    customer: { name: '문치호' },
    reservation_inquiry: {
      is_reservation_inquiry: true,
      confirmed: true,
      already_registered: false,
      rental_start: '2026-06-06',
      pickup_time: '09:00',
      rental_end: '2026-06-07',
      return_time: '18:00',
      discount_type: '일반',
      equipment_requested: [
        { raw_text: 'FX3 바디세트', exact_name_from_set_master: '소니 FX3 바디세트', quantity: 1 }
      ]
    },
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      exact_equipment_name_verified_from_set_master: true,
      duplicate_checked_contract_master: true,
      duplicate_checked_schedule_detail: true,
      duplicate_checked_request_sheet: true,
      latest_customer_message_after_last_staff_reply: false,
      no_auto_reply_sent: true
    },
    sheet_row_candidate: {
      customer_name: '문치호',
      phone: '010-1111-2222',
      memo: '재형님 카톡 확정 후 시트 미입력'
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });

  assert.equal(payload.func, 'insertAndCheckRequest');
  assert.deepEqual(payload.args.장비, [{ 이름: '소니 FX3 바디세트', 수량: 1 }]);
  assert.equal(payload.args.예약자명, '문치호');
  assert.equal(payload.args.비고, '');
});

test('buildSheetAppendPayload returns null when AI says not to write', () => {
  const decision = {
    should_write_to_sheet: false,
    sheet_row_candidate: { customer_name: '최재형' }
  };
  assert.equal(buildSheetAppendPayload(decision, { apiKey: 'k' }), null);
});

test('buildSheetAppendPayload refuses confirmation-request writes without a usable phone', () => {
  const decision = {
    should_write_to_sheet: true,
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      exact_equipment_name_verified_from_set_master: true,
      duplicate_checked_contract_master: true,
      duplicate_checked_schedule_detail: true,
      duplicate_checked_request_sheet: true,
      latest_customer_message_after_last_staff_reply: true,
      no_auto_reply_sent: true
    },
    customer: { name: '찬승' },
    sheet_row_candidate: {
      start_date: '2026-06-27',
      pickup_time: '23:00',
      end_date: '2026-06-29',
      return_time: '23:00',
      equipment: [{ item: '소니 BURANO 베이직세트', quantity: 1 }],
      customer_name: '찬승',
      phone: '',
      memo: '카카오 닉네임만 있고 예약자명/연락처 없음'
    }
  };

  assert.equal(buildSheetAppendPayload(decision, { apiKey: 'k' }), null);
});

test('buildSheetAppendPayload maps AI-decided fields into insertAndCheckRequest payload', () => {
  const decision = {
    should_write_to_sheet: true,
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      exact_equipment_name_verified_from_set_master: true,
      duplicate_checked_contract_master: true,
      duplicate_checked_schedule_detail: true,
      duplicate_checked_request_sheet: true,
      latest_customer_message_after_last_staff_reply: true,
      no_auto_reply_sent: true
    },
    sheet_row_candidate: {
      start_date: '2026-06-01',
      pickup_time: '10:00',
      end_date: '2026-06-02',
      return_time: '18:00',
      equipment: [
        { item: '소니 FX6 바디세트', quantity: 1 },
        { item: '소니 GM 24-70mm II', quantity: 2 }
      ],
      customer_name: '홍길동',
      phone: '010-0000-0000',
      discount_type: '학생',
      memo: 'AI 검토 필요',
      extra_request: '렌즈 포함'
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });

  assert.equal(payload.key, 'secret');
  assert.equal(payload.action, 'run');
  assert.equal(payload.func, 'insertAndCheckRequest');
  assert.deepEqual(payload.args, {
    반출일: '2026-06-01',
    반출시간: '10:00',
    반납일: '2026-06-02',
    반납시간: '18:00',
    예약자명: '홍길동',
    연락처: '010-0000-0000',
    할인유형: '학생',
    비고: '',
    추가요청: '렌즈 포함',
    장비: [
      { 이름: '소니 FX6 바디세트', 수량: 1 },
      { 이름: '소니 GM 24-70mm II', 수량: 2 }
    ]
  });
  assert.equal(JSON.stringify(payload).includes('AI-'), false);
});

test('buildSheetAppendPayload rejects an AI equipment rewrite unrelated to the customer raw text', () => {
  const decision = {
    should_write_to_sheet: true,
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    reservation_inquiry: {
      equipment_requested: [
        { raw_text: '시그마 아트 18-35', normalized_guess: 'H&Y VND-CPL 67-82mm 가변 ND', quantity: 1 }
      ]
    },
    sheet_row_candidate: {
      start_date: '2026-07-15',
      pickup_time: '10:00',
      end_date: '2026-07-16',
      return_time: '10:00',
      customer_name: '원영상',
      phone: '010-6687-1945',
      equipment: [{ item: 'H&Y VND-CPL 67-82mm 가변 ND', quantity: 1 }]
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });
  assert.deepEqual(payload.args.장비, [{ 이름: '시그마 아트 18-35', 수량: 1 }]);
});

test('buildSheetAppendPayload rejects a same-brand rewrite to a different lens model', () => {
  const decision = {
    should_write_to_sheet: true,
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    reservation_inquiry: {
      equipment_requested: [
        { raw_text: '시그마 아트 18-35', normalized_guess: '시그마 아트 50-100mm', quantity: 1 }
      ]
    },
    sheet_row_candidate: {
      start_date: '2026-07-15', pickup_time: '10:00', end_date: '2026-07-16', return_time: '10:00',
      customer_name: '원영상', phone: '010-6687-1945',
      equipment: [{ item: '시그마 아트 50-100mm', quantity: 1 }]
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });
  assert.deepEqual(payload.args.장비, [{ 이름: '시그마 아트 18-35', 수량: 1 }]);
});

test('buildSheetAppendPayload prefers an explicitly written booking identity over the Kakao profile', () => {
  const decision = {
    should_write_to_sheet: true,
    latest_customer_message_cluster: '예약자 원영상/010-6687-1945로 부탁드립니다.',
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    reservation_inquiry: {
      equipment_requested: [{ raw_text: 'FX3', normalized_guess: '소니 FX3 바디세트', quantity: 1 }]
    },
    customer: { name: '설용수' },
    sheet_row_candidate: {
      start_date: '2026-07-15', pickup_time: '22:00', end_date: '2026-07-16', return_time: '22:00',
      customer_name: '설용수', phone: '', equipment: [{ item: '소니 FX3 바디세트', quantity: 1 }]
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });
  assert.equal(payload.args.예약자명, '원영상');
  assert.equal(payload.args.연락처, '010-6687-1945');
});

test('buildSheetAppendPayload keeps a grounded canonical alias rewrite', () => {
  const decision = {
    should_write_to_sheet: true,
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    reservation_inquiry: {
      equipment_requested: [
        { raw_text: 'solid 4s', exact_name_from_set_master: '홀리랜드 솔리드컴 4S', quantity: 1 }
      ]
    },
    sheet_row_candidate: {
      start_date: '2026-07-15',
      pickup_time: '10:00',
      end_date: '2026-07-16',
      return_time: '10:00',
      customer_name: '원영상',
      phone: '010-6687-1945',
      equipment: [{ item: '홀리랜드 솔리드컴 4S', quantity: 1 }]
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });
  assert.deepEqual(payload.args.장비, [{ 이름: '홀리랜드 솔리드컴 4S', 수량: 1 }]);
});

test('buildHermesPrompt prioritizes explicit booking identity and keeps RAG out of extraction', () => {
  const prompt = buildHermesPrompt({ id: 'identity-guard', preview_text: '예약자 원영상 010-6687-1945' }, {
    ragContext: buildReadOnlyRagContext({ villageAiUrl: 'https://village-ai.example' })
  });

  assert.match(prompt, /예약 메시지에 명시된 예약자명.*프로필명보다 우선/s);
  assert.match(prompt, /RAG.*장비명 정규화.*예약자명.*연락처.*사용 금지/s);
});

test('buildSheetAppendPayload does not leak AI reasons or review actions into confirmation request memo fields', () => {
  const decision = {
    should_write_to_sheet: true,
    reason: '카카오 실제 대화에서 예약형식이라 판단했고 가용확인 후 고객 안내 필요',
    suggested_human_review_action: '확인요청 가용확인 결과를 확인한 뒤 고객에게 안내하세요',
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      exact_equipment_name_verified_from_set_master: true,
      duplicate_checked_contract_master: true,
      duplicate_checked_schedule_detail: true,
      duplicate_checked_request_sheet: true,
      latest_customer_message_after_last_staff_reply: true,
      no_auto_reply_sent: true
    },
    sheet_row_candidate: {
      start_date: '2026-06-01',
      pickup_time: '10:00',
      end_date: '2026-06-02',
      return_time: '18:00',
      equipment: [{ item: '소니 FX3 바디세트', quantity: 1 }],
      customer_name: '홍길동',
      phone: '010-0000-0000',
      memo: '카카오 예약형식 메시지에서 접수. 고객 원문 장비명: FX3',
      extra_request: '가용확인 후 고객 안내 필요'
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });

  assert.equal(payload.args.비고, '');
  assert.equal(payload.args.추가요청, '');
});

test('buildSheetAppendPayload floors minute-level confirm request times to whole hours', () => {
  const decision = {
    should_write_to_sheet: true,
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      exact_equipment_name_verified_from_set_master: true,
      duplicate_checked_contract_master: true,
      duplicate_checked_schedule_detail: true,
      duplicate_checked_request_sheet: true,
      latest_customer_message_after_last_staff_reply: true,
      no_auto_reply_sent: true
    },
    sheet_row_candidate: {
      start_date: '2026-06-01',
      pickup_time: '12:30',
      end_date: '2026-06-02',
      return_time: '18:45',
      equipment: [{ item: '소니 FX3 바디세트', quantity: 1 }],
      customer_name: '홍길동',
      phone: '010-2222-3333'
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });

  assert.equal(normalizeConfirmRequestTimeForSheet('7시30분'), '07:00');
  assert.equal(payload.args.반출시간, '12:00');
  assert.equal(payload.args.반납시간, '18:00');
});

test('buildSheetAppendPayload normalizes relative/korean dates and 24시 to API-safe range', () => {
  const now = new Date('2026-06-06T07:54:00+09:00');
  const decision = {
    should_write_to_sheet: true,
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      exact_equipment_name_verified_from_set_master: true,
      duplicate_checked_contract_master: true,
      duplicate_checked_schedule_detail: true,
      duplicate_checked_request_sheet: true,
      latest_customer_message_after_last_staff_reply: true,
      no_auto_reply_sent: true
    },
    sheet_row_candidate: {
      start_date: '오늘',
      pickup_time: '10시',
      end_date: '6월 6일',
      return_time: '24시',
      equipment: [{ item: '소니 A7S3 바디세트', quantity: 1 }],
      customer_name: '이규직',
      phone: '01022500612'
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret', now });

  assert.equal(normalizeConfirmRequestDateForSheet('오늘', { now }), '2026-06-06');
  assert.equal(normalizeConfirmRequestTimeForSheet('24시'), '00:00');
  assert.equal(payload.args.반출일, '2026-06-06');
  assert.equal(payload.args.반출시간, '10:00');
  assert.equal(payload.args.반납일, '2026-06-07');
  assert.equal(payload.args.반납시간, '00:00');
});

test('buildSheetAppendPayload allows reservation-format writes when non-blocking checks are incomplete', () => {
  const decision = {
    should_write_to_sheet: true,
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      exact_equipment_name_verified_from_set_master: false,
      duplicate_checked_contract_master: false,
      duplicate_checked_schedule_detail: false,
      duplicate_checked_request_sheet: false,
      latest_customer_message_after_last_staff_reply: true,
      no_auto_reply_sent: false
    },
    sheet_row_candidate: { item: 'FX6', customer_name: '홍길동', phone: '010-4444-5555', memo: '장비명/중복 검증 필요' }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });
  assert.equal(payload.action, 'run');
  assert.equal(payload.func, 'insertAndCheckRequest');
  assert.deepEqual(payload.args.장비, [{ 이름: 'FX6', 수량: 1 }]);
  assert.equal(payload.args.예약자명, '홍길동');
  assert.equal(payload.args.비고, '');
});

test('buildSheetAppendPayload falls back to reservation equipment array instead of joining items into one row', () => {
  const decision = {
    should_write_to_sheet: true,
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    customer: { name: '김성윤' },
    reservation_inquiry: {
      rental_start: '2026-05-28',
      rental_end: '2026-05-28',
      pickup_time: '07:00',
      return_time: '23:00',
      discount_type: '개인사업자/프리랜서',
      equipment_requested: [
        { raw_text: '셔틀러에이스 2개', normalized_guess: '셔틀러 에이스', quantity: 2 },
        { raw_text: 'a7s3 바디세트 2개', exact_name_from_set_master: '소니 A7S3 바디세트', quantity: 2 },
        { raw_text: '2470gm2 2개', exact_name_from_set_master: '소니 GM 24-70mm II', quantity: 2 }
      ]
    },
    sheet_row_candidate: {
      customer_name: '김성윤',
      phone: '010-7777-8888',
      item: '셔틀러 에이스 2개, 소니 A7S3 바디세트 2개, 소니 GM 24-70mm II 2개',
      memo: 'fallback should prefer structured reservation equipment'
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });
  assert.deepEqual(payload.args.장비, [
    { 이름: '셔틀러 에이스', 수량: 2 },
    { 이름: '소니 A7S3 바디세트', 수량: 2 },
    { 이름: '소니 GM 24-70mm II', 수량: 2 }
  ]);
});

test('appendToSheet calls insertAndCheckRequest with the Claude coworker GET contract', async () => {
  const payload = {
    key: 'secret',
    action: 'run',
    func: 'insertAndCheckRequest',
    args: {
      반출일: '2026-06-01',
      반출시간: '10:00',
      반납일: '2026-06-02',
      반납시간: '18:00',
      예약자명: '홍길동',
      장비: [
        { 이름: '소니 FX6 바디세트', 수량: 1 },
        { 이름: '소니 GM 24-70mm II', 수량: 2 }
      ]
    }
  };
  let calledUrl;
  let calledInit;
  const fetchImpl = async (url, init) => {
    calledUrl = new URL(String(url));
    calledInit = init;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, reqID: 'RQ-260601-001', results: [] })
    };
  };

  const result = await appendToSheet({
    gasApiUrl: 'https://gas.example/exec',
    sheetApiKey: 'secret',
    fetchImpl
  }, payload);

  assert.equal(calledInit, undefined);
  assert.equal(calledUrl.origin + calledUrl.pathname, 'https://gas.example/exec');
  assert.equal(calledUrl.searchParams.get('key'), 'secret');
  assert.equal(calledUrl.searchParams.get('action'), 'run');
  assert.equal(calledUrl.searchParams.get('func'), 'insertAndCheckRequest');
  assert.deepEqual(JSON.parse(calledUrl.searchParams.get('args')), payload.args);
  assert.equal(result.reqID, 'RQ-260601-001');
});

test('appendToSheet returns structured GAS business errors instead of crashing the worker', async () => {
  const result = await appendToSheet({
    gasApiUrl: 'https://gas.example/exec',
    sheetApiKey: 'secret',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ error: '셀 B52에 입력한 데이터가 이 셀에 설정된 데이터 확인 규칙을 위반했습니다.' })
    })
  }, {
    action: 'run',
    func: 'insertAndCheckRequest',
    args: { 반출일: '2026-04-31', 예약자명: '박정민', 장비: [{ 이름: '어퓨쳐 600C', 수량: 2 }] }
  });

  assert.equal(result.success, false);
  assert.equal(result.error_type, 'sheet_validation');
  assert.equal(result.recoverable, false);
  assert.match(result.error, /데이터 확인 규칙/);
});

test('appendToSheet classifies missing contact rejections as no_contact', async () => {
  const result = await appendToSheet({
    gasApiUrl: 'https://gas.example/exec',
    sheetApiKey: 'secret',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ error: 'NO_CONTACT: 연락처가 없으면 예약 등록이 불가능합니다. 고객DB에서 연락처 없음 — 고객에게 연락처부터 요청하세요.' })
    })
  }, {
    action: 'run',
    func: 'insertAndCheckRequest',
    args: { 예약자명: '홍길동', 장비: [{ 이름: 'FX6', 수량: 1 }] }
  });

  assert.equal(result.success, false);
  assert.equal(result.error_type, 'no_contact');
  assert.match(result.error, /예약 등록이 불가능/);
});

test('appendToSheet preserves duplicate insertAndCheckRequest availability results', async () => {
  const result = await appendToSheet({
    gasApiUrl: 'https://gas.example/exec',
    sheetApiKey: 'secret',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        duplicate: true,
        reqID: 'RQ-260531-003',
        message: '중복 요청: 동일한 예약자/반출일시/장비 조합이 이미 존재합니다 (RQ-260531-003)',
        results: [
          { 장비명: '소니 캠 AX-700', 수량: '1', 결과: '✅ 가용1', 상세: '예약 가능' }
        ]
      })
    })
  }, {
    action: 'run',
    func: 'insertAndCheckRequest',
    args: { 반출일: '2026-05-30', 예약자명: '최재원', 장비: [{ 이름: '소니 캠 AX-700', 수량: 1 }] }
  });

  assert.equal(result.success, true);
  assert.equal(result.duplicate, true);
  assert.equal(result.reqID, 'RQ-260531-003');
  assert.deepEqual(result.results, [
    { equipment: '소니 캠 AX-700', quantity: '1', result: '✅ 가용1', detail: '예약 가능' }
  ]);
});

test('buildSheetAvailabilityReport turns GAS results into availability-based action text', () => {
  const report = buildSheetAvailabilityReport({
    reqID: 'RQ-260531-003',
    duplicate: true,
    results: [
      { 장비명: '소니 캠 AX-700', 수량: '1', 결과: '✅ 가용1', 상세: '예약 가능' }
    ]
  }, {
    args: {
      예약자명: '최재원',
      장비: [{ 이름: '소니 캠 AX-700', 수량: 1 }]
    }
  });

  assert.equal(report.status, 'available');
  assert.match(report.summary, /기존 중복 RQ/);
  assert.match(report.recommendedAction, /결과가 가용/);
  assert.match(report.suggestedReplyDraft, /예약 가능하십니다/);

  const blocked = buildSheetAvailabilityReport({
    reqID: 'RQ-260531-004',
    results: [
      { 장비명: '소니 캠 AX-700', 수량: '1', 결과: '⚠️ 겹침(가용0)', 상세: '동일 시간 예약 있음' }
    ]
  }, {
    args: {
      예약자명: '최재원',
      장비: [{ 이름: '소니 캠 AX-700', 수량: 1 }]
    }
  });

  assert.equal(blocked.status, 'unavailable');
  assert.match(blocked.recommendedAction, /가능하다고 안내하지 말고/);
  assert.doesNotMatch(blocked.suggestedReplyDraft, /예약 가능하십니다|예약 가능/);
});

test('fetchExistingConfirmRequestResultForDecision reads RQ result rows from 확인요청 search', async () => {
  const requested = [];
  const result = await fetchExistingConfirmRequestResultForDecision({
    gasApiUrl: 'https://gas.example/exec',
    sheetApiKey: 'secret',
    fetchImpl: async (url) => {
      requested.push(new URL(String(url)));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          sheet: '확인요청',
          query: 'RQ-260531-003',
          headers: ['요청ID', '반출일', '반출시간', '반납일', '반납시간', '장비or세트명', '수량', '확인', '결과', '상세'],
          count: 1,
          results: [{
            row: 12,
            data: ['RQ-260531-003', '2026-05-30', '23:00', '2026-05-31', '23:00', '소니 캠 AX-700', '1', '', '✅ 가용1', '예약 가능']
          }]
        })
      };
    }
  }, {
    reason: '기존 RQ 발견으로 중복 입력 방지: RQ-260531-003'
  }, []);

  assert.equal(requested[0].searchParams.get('action'), 'search');
  assert.equal(requested[0].searchParams.get('sheet'), '확인요청');
  assert.equal(requested[0].searchParams.get('col'), 'A');
  assert.equal(requested[0].searchParams.get('query'), 'RQ-260531-003');
  assert.equal(result.reqID, 'RQ-260531-003');
  assert.equal(result.duplicate, true);
  assert.deepEqual(result.results, [
    { equipment: '소니 캠 AX-700', quantity: '1', result: '✅ 가용1', detail: '예약 가능' }
  ]);
});

test('enrichFollowUpRowsWithSheetAvailability replaces inspect-RQ card with result-based report', () => {
  const rows = buildFollowUpRows({
    classification: 'reservation',
    confidence: 'high',
    customer: { name: '최재원' },
    follow_up_items: [{
      type: 'sheet_duplicate_check',
      priority: 'urgent',
      status: 'open',
      title: '최재원 AX-700 예약 가능 문의 응답 필요',
      customer_name: '최재원',
      summary: '확인요청 시트에는 이미 동일 고객/동일 반출일/동일 장비 RQ가 존재합니다.',
      recommended_action: '기존 확인요청 RQ의 확인 결과를 검토한 뒤 고객에게 가능 여부를 안내하세요.',
      suggested_reply_draft: '확인해보니 소니 캠 AX-700 해당 일정 예약 가능하십니다.',
      evidence: ['기존 RQ 발견']
    }]
  }, {
    id: '11111111-1111-4111-8111-111111111111',
    room_key: 'preview:choi'
  });

  const enriched = enrichFollowUpRowsWithSheetAvailability(rows, {
    reqID: 'RQ-260531-003',
    duplicate: true,
    results: [
      { 장비명: '소니 캠 AX-700', 수량: '1', 결과: '⚠️ 겹침(가용0)', 상세: '기존 예약과 겹침' }
    ]
  }, {
    args: {
      예약자명: '최재원',
      반출일: '2026-05-30',
      반출시간: '23:00',
      반납일: '2026-05-31',
      반납시간: '23:00',
      장비: [{ 이름: '소니 캠 AX-700', 수량: 1 }]
    }
  }, { classification: 'reservation', confidence: 'high', customer: { name: '최재원' } }, {
    id: '11111111-1111-4111-8111-111111111111',
    room_key: 'preview:choi'
  });

  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].type, 'reservation_review');
  assert.match(enriched[0].summary, /RQ-260531-003/);
  assert.match(enriched[0].recommended_action, /가능하다고 안내하지 말고/);
  assert.match(enriched[0].evidence.join('\n'), /⚠️ 겹침\(가용0\)/);
  assert.doesNotMatch(enriched[0].suggested_reply_draft, /예약 가능하십니다|예약 가능/);
});

test('enrichFollowUpRowsWithSheetAvailability handles duplicate RQ result without sheet payload', () => {
  const enriched = enrichFollowUpRowsWithSheetAvailability([], {
    reqID: 'RQ-260601-001',
    duplicate: true,
    results: [
      { 장비명: '소니 FX3 바디세트', 수량: '1', 결과: '✅ 가용1', 상세: '예약 가능' }
    ]
  }, null, { classification: 'reservation', confidence: 'high', customer: { name: '정민주' } }, {
    id: '22222222-2222-4222-8222-222222222222',
    room_key: 'preview:jung'
  });

  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].customer_name, '정민주');
  assert.match(enriched[0].summary, /RQ-260601-001/);
  assert.match(enriched[0].evidence.join('\n'), /✅ 가용1/);
  assert.equal(enriched[0].payload.sheet_request, null);
});

test('extractConfirmRequestIds finds unique RQ ids in AI decisions and rows', () => {
  assert.deepEqual(extractConfirmRequestIds({
    reason: '기존 RQ-260531-003 발견',
    rows: [{ summary: '다시 RQ-260531-003 / 다른 RQ-260601-001' }]
  }), ['RQ-260531-003', 'RQ-260601-001']);
});

test('buildSheetFailureFollowUpRows creates actionable cards for validation errors and suppresses duplicates', () => {
  const decision = {
    classification: 'reservation',
    customer: { name: '박정민' }
  };
  const job = {
    id: '11111111-1111-4111-8111-111111111111',
    room_key: 'preview:park'
  };
  const sheetPayload = {
    args: {
      반출일: '2026-04-31',
      반출시간: '12:30',
      반납일: '2026-05-01',
      반납시간: '12:30',
      예약자명: '박정민',
      장비: [{ 이름: '어퓨쳐 600C', 수량: 2 }]
    }
  };
  const rows = buildSheetFailureFollowUpRows(decision, job, {
    success: false,
    error_type: 'sheet_validation',
    error: '셀 B52에 입력한 데이터가 이 셀에 설정된 데이터 확인 규칙을 위반했습니다.'
  }, sheetPayload);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'reservation_review');
  assert.equal(rows[0].priority, 'urgent');
  assert.equal(rows[0].decision_classification, 'sheet_write_rejected');
  assert.match(rows[0].summary, /GAS가 확인요청 입력을 거절/);
  assert.match(rows[0].evidence.join('\n'), /2026-04-31/);

  assert.deepEqual(buildSheetFailureFollowUpRows(decision, job, {
    success: false,
    error_type: 'duplicate_request',
    error: '중복 요청: 동일 건이 이미 예약 등록되어 있습니다'
  }, sheetPayload), []);
});

test('buildFollowUpRows maps AI-decided follow-up items for remote dashboard', () => {
  const rows = buildFollowUpRows({
    classification: 'price',
    confidence: 'medium',
    customer: { name: '홍길동' },
    latest_customer_message_cluster: '견적서 받을 수 있을까요?',
    visible_messages_used: [
      { sender: '홍길동', message: '견적서 받을 수 있을까요?', time: '오후 3:10' }
    ],
    follow_up_items: [{
      type: 'quote_send',
      priority: 'high',
      status: 'open',
      title: 'FX3 견적서 발송',
      summary: '고객이 FX3 견적서를 요청함',
      recommended_action: '스케줄과 가격 확인 후 견적서 발송',
      suggested_reply_draft: '감독님, 확인 후 견적서 보내드리겠습니다.',
      evidence: ['고객: 견적서 받을 수 있을까요?'],
      due_hint: 'today'
    }]
  }, { id: '11111111-1111-4111-8111-111111111111', room_key: 'room-label:홍길동' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'quote_send');
  assert.equal(rows[0].priority, 'high');
  assert.equal(rows[0].customer_name, '홍길동');
  assert.equal(rows[0].job_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(rows[0].decision_classification, 'price');
  assert.deepEqual(rows[0].evidence, ['고객: 견적서 받을 수 있을까요?']);
  assert.equal(rows[0].payload.latest_customer_message_cluster, '견적서 받을 수 있을까요?');
  assert.equal(rows[0].payload.visible_messages_used[0].message, '견적서 받을 수 있을까요?');
  assert.match(rows[0].follow_up_key, /^room-label:홍길동:홍길동:quote_send:/);
});

test('routeFollowUpToSlack maps follow-up types to the agent channels', () => {
  assert.deepEqual(routeFollowUpToSlack({ type: 'reservation_review' }), { route: 'schedule', channel: '스케쥴-agent' });
  assert.deepEqual(routeFollowUpToSlack({ type: 'quote_send' }), { route: 'document', channel: '서류발송-agent' });
  assert.deepEqual(routeFollowUpToSlack({ type: 'payment_check' }), { route: 'settlement', channel: '정산-agent' });
  assert.deepEqual(routeFollowUpToSlack({ type: 'reply_needed' }), { route: 'other', channel: '기타문의' });
  assert.deepEqual(routeFollowUpToSlack({ type: 'damage_repair' }), { route: 'inventory', channel: '재고관리-agent' });
});

test('routeFollowUpToSlack keeps operational follow-ups out of document channel despite document words', () => {
  assert.deepEqual(routeFollowUpToSlack({
    type: 'damage_repair',
    title: '이기욱 파손 건 및 견적서 확인 후속',
    summary: '파손 확인과 견적서 금액 대조가 함께 필요합니다.'
  }), { route: 'inventory', channel: '재고관리-agent' });

  assert.deepEqual(routeFollowUpToSlack({
    type: 'completed_log',
    title: '박정우 6/10 예약 확정 건 확인요청 입력 필요',
    summary: '확인요청 입력 후 처리 완료 기록'
  }), { route: 'schedule', channel: '스케쥴-agent' });

  assert.deepEqual(routeFollowUpToSlack({
    type: 'completed_log',
    title: '이기욱 파손 건 및 견적서 확인 후속',
    summary: '파손 확인 후 완료 기록'
  }), { route: 'inventory', channel: '재고관리-agent' });

  assert.deepEqual(routeFollowUpToSlack({
    type: 'price_review',
    title: '박용배 견적 및 방문시간 답변 필요',
    summary: '고객이 방문 준비물과 금액을 물었습니다.'
  }), { route: 'other', channel: '기타문의' });
});

test('routeFollowUpToSlack routes explicit document requests from generic cards to document channel', () => {
  assert.deepEqual(routeFollowUpToSlack({
    type: 'reply_needed',
    title: '하현준 사업자등록증·통장사본 전달 요청',
    summary: '고객이 사업자등록증과 통장사본 전달을 요청했습니다.'
  }), { route: 'document', channel: '서류발송-agent' });
});

test('routeFollowUpToSlack sends reservation-like reply cards to schedule agent', () => {
  assert.deepEqual(routeFollowUpToSlack({
    type: 'reply_needed',
    title: '이기욱 예약 후보 확인 필요',
    summary: '고객이 6/3~6/4 장비 예약 진행을 요청했습니다.'
  }), { route: 'schedule', channel: '스케쥴-agent' });
});

test('routeFollowUpToSlack keeps target Kakao mismatch diagnostics out of settlement despite payment preview text', () => {
  assert.deepEqual(routeFollowUpToSlack({
    type: 'reply_needed',
    title: '대상 카카오 대화 확인 불가',
    summary: "고객 요청: 헉 저는 최근에 메모리 빌린적이 없습니다. 잡 프리뷰는 '입금드릴게요!! 오전09:34'였지만 현재 열린 카카오 대화는 김나영 채팅이며 해당 메시지가 보이지 않았습니다.",
    recommended_action: '짧게 답변',
    evidence: [
      '고객: 헉 저는 최근에 메모리 빌린적이 없습니다',
      '직원: 죄송합니다. 감독님! 동명이인이어서 잘못 연락 드렸습니다!'
    ]
  }), { route: 'other', channel: '기타문의' });
});

test('routeFollowUpToSlack keeps reservation cards in schedule route even when evidence mentions 계약마스터', () => {
  assert.deepEqual(routeFollowUpToSlack({
    type: 'reservation_review',
    title: '김정혜 DJI 무선마이크 당일 예약 확인요청 입력 및 18시 수령 안내',
    summary: '확인요청 RQ-260609-004 가용확인 결과: DJI 마이크 미니2 x1: 세트',
    recommended_action: '기존 RQ 기준으로 처리하고 내부 등록/가용확인 상태를 확인하세요.',
    evidence: [
      '카카오 화면: 고객이 DJI 무선마이크 예약 정보를 제공',
      '계약마스터 조회: 거래ID 260609-005, 김정혜, 예약 상태',
      '스케줄상세 조회: 거래ID 260609-005, DJI 마이크 미니2, 상태 대기'
    ]
  }), { route: 'schedule', channel: '스케쥴-agent' });
});

test('buildSlackFollowUpMessage includes action buttons and deduplicated automation-style summary', () => {
  const message = buildSlackFollowUpMessage({
    id: 'follow-1',
    type: 'reservation_review',
    priority: 'urgent',
    status: 'open',
    title: '최재원 AX-700 예약 가능 문의',
    customer_name: '최재원',
    summary: '고객이 5/30 23:00~5/31 23:00 AX-700 가능 여부를 문의했습니다.',
    recommended_action: '확인요청 결과가 ✅ 가용이면 가능 안내 후 예약 진행 여부를 확인하세요.',
    suggested_reply_draft: '확인해보니 해당 일정 예약 가능하십니다.',
    evidence: ['확인요청 RQ-260531-003: ✅ 가용1'],
    payload: {
      sheet_request: {
        반출일: '2026-05-30',
        반출시간: '23:00',
        반납일: '2026-05-31',
        반납시간: '23:00',
        장비: [{ 이름: '소니 캠 AX-700', 수량: 1 }]
      },
      sheet_availability: {
        reqID: 'RQ-260531-003',
        status: 'available',
        duplicate: true,
        results: [{ equipment: '소니 캠 AX-700', quantity: '1', result: '✅ 가용1', detail: '예약 가능' }]
      },
      visible_messages_used: [
        { sender: '최재원', message: '소니 캠 AX-700 5월30일 밤부터 31일 밤까지 가능할까요?', time: '오후 5:01' },
        { sender: '빌리지님', message: '확인해보겠습니다.', time: '오후 5:02' }
      ]
    }
  });

  assert.equal(message.channel, '스케쥴-agent');
  assert.match(JSON.stringify(message.blocks), /village_followup_send/);
  assert.match(JSON.stringify(message.blocks), /village_followup_edit_send/);
  assert.match(JSON.stringify(message.blocks), /village_followup_status_done/);
  assert.match(JSON.stringify(message.blocks), /처리 요약/);
  assert.match(JSON.stringify(message.blocks), /⚠️ 분류\/상태/);
  assert.match(JSON.stringify(message.blocks), /🧩 문제/);
  assert.match(JSON.stringify(message.blocks), /🎒 장비 \/ 📅 기간/);
  assert.match(JSON.stringify(message.blocks), /➡️ 다음/);
  assert.match(JSON.stringify(message.blocks), /최근 대화/);
  assert.doesNotMatch(JSON.stringify(message.blocks), /근거/);
  assert.doesNotMatch(JSON.stringify(message.blocks), /추천 조치/);
  assert.doesNotMatch(JSON.stringify(message.blocks), /라우팅/);
  assert.doesNotMatch(JSON.stringify(message.blocks), /Agent 호출/);
  assert.doesNotMatch(JSON.stringify(message.blocks), /헤이빌리/);
  assert.match(JSON.stringify(message.blocks), /RQ-260531-003/);
  assert.match(JSON.stringify(message.blocks), /소니 캠 AX-700 x1: ✅ 가용1/);
  assert.match(JSON.stringify(message.blocks), /가능 안내 후 예약 진행 여부 확인/);
  assert.equal((JSON.stringify(message.blocks).match(/최재원/g) || []).length, 1);
  assert.equal((JSON.stringify(message.blocks).match(/예약 후보 확인/g) || []).length, 1);
  assert.equal((JSON.stringify(message.blocks).match(/RQ-260531-003/g) || []).length, 1);
  assert.doesNotMatch(JSON.stringify(message.blocks), /버튼 동작/);
  assert.doesNotMatch(JSON.stringify(message.blocks), /현재 초안으로 카카오 발송 요청/);
  assert.doesNotMatch(JSON.stringify(message.blocks), /대시보드/);
  assert.doesNotMatch(JSON.stringify(message.blocks), /\\n  /);
});

test('buildSlackFollowUpMessage keeps warning availability cards actionable', () => {
  const message = buildSlackFollowUpMessage({
    id: 'follow-lee',
    type: 'reservation_review',
    priority: 'urgent',
    status: 'open',
    title: '이기욱 INSIDE FILM 예약 가용 확인 결과',
    customer_name: '이기욱 INSIDE FILM',
    summary: '기존 중복 RQ에서 읽은 결과입니다.',
    recommended_action: '확인요청 RQ-260601-010 결과에 경고가 있습니다.',
    suggested_reply_draft: '감독님, 확인 후 바로 안내드리겠습니다.',
    payload: {
      sheet_request: {
        반출일: '2026-06-03',
        반출시간: '05:30',
        반납일: '2026-06-04',
        반납시간: '05:30',
        장비: [{ 이름: 'Fx3 소니 GM 렌즈 세트', 수량: 1 }]
      },
      sheet_availability: {
        reqID: 'RQ-260601-010',
        status: 'warning',
        duplicate: true,
        results: [
          { equipment: 'Fx3 소니 GM 렌즈 세트', quantity: '1', result: '⚠️ 겹침', detail: '일부 구성 확인 필요' },
          { equipment: '솔리드컴 C1 PRO 7구', quantity: '1', result: '✅ 가용1', detail: '대체 가능' }
        ]
      }
    }
  });
  const blocks = JSON.stringify(message.blocks);

  assert.match(blocks, /요청/);
  assert.match(blocks, /RQ-260601-010/);
  assert.match(blocks, /기존 중복/);
  assert.match(blocks, /기존 확인요청에서 읽은 가용확인 결과입니다/);
  assert.match(blocks, /Fx3 소니 GM 렌즈 세트 x1: ⚠️ 겹침/);
  assert.match(blocks, /경고\/부족 항목 확인 후 대안 또는 추가확인 안내/);
  assert.doesNotMatch(blocks, /가용 결과 확인 후 답변/);
  assert.doesNotMatch(blocks, /Agent 호출/);
  assert.doesNotMatch(blocks, /헤이빌리/);
  assert.equal((blocks.match(/RQ-260601-010/g) || []).length, 1);
  assert.doesNotMatch(blocks, /\\n\\n•/);
});

test('enrichFollowUpRowWithOperationalCalculations calculates contract and RQ document amounts', async () => {
  const gvizBody = `/*O_o*/\ngoogle.visualization.Query.setResponse({"version":"0.6","status":"ok","table":{"cols":[{"label":"요청ID"},{"label":"반출일"},{"label":"반출시간"},{"label":"반납일"},{"label":"반납시간"},{"label":"장비or세트명"},{"label":"수량"},{"label":"결과"},{"label":"상세"},{"label":"예약자명"},{"label":"연락처"},{"label":"할인유형"},{"label":"비고"},{"label":"추가요청"}],"rows":[{"c":[{"v":"RQ-260531-007"},{"v":"Date(2026,5,1)","f":"2026. 6. 1"},{"v":"Date(1899,11,30,8,0,0)","f":"8:00"},{"v":"Date(2026,5,3)","f":"2026. 6. 3"},{"v":"Date(1899,11,30,23,59,0)","f":"23:59"},{"v":"V마운트 셋업"},{"v":3,"f":"3"},{"v":"❓ 미등록 장비"},{"v":"장비마스터/세트마스터에 없음"},{"v":"최민석"},{"v":"010-4506-6615"},{"v":"일반"},{"v":"마운드미디어"},{"v":"V마운트 확인"}]},{"c":[{"v":"RQ-260531-007"},null,null,null,null,{"v":"V마운트 배터리"},{"v":10,"f":"10"},{"v":"✅ 가용40"},{"v":"보유56"},null,null,null,null,null]},{"c":[{"v":"RQ-260531-007"},null,null,null,null,{"v":"V마운트 배터리 충전기"},{"v":1,"f":"1"},{"v":"✅ 가용6"},{"v":"보유10"},null,null,null,null,null]}]}});`;
  const config = {
    gasApiUrl: 'https://gas.example/exec',
    sheetApiKey: 'key',
    fetchImpl: async (url) => {
      const u = new URL(String(url));
      if (u.hostname === 'docs.google.com') {
        return { ok: true, status: 200, text: async () => gvizBody };
      }
      const sheet = u.searchParams.get('sheet');
      const query = u.searchParams.get('query');
      if (sheet === '계약마스터' && query === '260530-003') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ data: ['260530-003', '최민석', '010-4506-6615', '', '', '', '', '', 3, '예약', '제휴', ''] }] }) };
      }
      if (sheet === '스케줄상세' && query === '260530-003') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ results: [
          { data: ['260530-003-01', '260530-003', '소니 A7S3 바디세트', '소니 A7S3 바디세트', 1, '2026-06-01', '8:00', '2026-06-03', '23:00', '대기', '', 40000, '최민석'] },
          { data: ['260530-003-02', '260530-003', '소니 A7S3 바디세트', '소니 A7S3 바디(케이지)', 1, '2026-06-01', '8:00', '2026-06-03', '23:00', '대기', '', 0, '최민석'] },
          { data: ['260530-003-07', '260530-003', '소니 GM 70-200mm II', '소니 GM 70-200mm II', 1, '2026-06-01', '8:00', '2026-06-03', '23:00', '대기', '', 30000, '최민석'] },
          { data: ['260530-003-08', '260530-003', '셔틀러에이스 M (75볼)', '셔틀러에이스 M (75볼)', 1, '2026-06-01', '8:00', '2026-06-03', '23:00', '대기', '', 10000, '최민석'] }
        ] }) };
      }
      if (sheet === '세트마스터') {
        const price = query === 'V마운트 배터리' || query === 'V마운트 배터리 충전기' ? 5000 : 0;
        return { ok: true, status: 200, text: async () => JSON.stringify({ results: price ? [{ data: [query, '', '', '', '', '', price] }] : [] }) };
      }
      throw new Error(`unexpected URL ${url}`);
    }
  };

  const row = await enrichFollowUpRowWithOperationalCalculations(config, {
    id: 'follow-doc',
    type: 'contract_document',
    title: '최민석 2건 계약서 파일 발송 요청',
    customer_name: '최민석',
    summary: '계약마스터 260530-003 및 확인요청 RQ-260531-007 관련 서류 요청',
    recommended_action: '계약서 파일 2건을 발송하세요.',
    evidence: ['계약마스터 조회: 260530-003', '확인요청 조회: RQ-260531-007']
  });

  assert.match(row.recommended_action, /135,170원/);
  assert.match(row.recommended_action, /145,200원/);
  assert.match(row.recommended_action, /V마운트 셋업 x3/);
  assert.equal(row.payload.operational_calculation.totalVatIncluded, 280370);
});

test('enrichFollowUpRowWithOperationalCalculations does not price expanded components as another parent set', async () => {
  const gvizBody = `/*O_o*/\ngoogle.visualization.Query.setResponse({"version":"0.6","status":"ok","table":{"cols":[{"label":"요청ID"},{"label":"반출일"},{"label":"반출시간"},{"label":"반납일"},{"label":"반납시간"},{"label":"장비or세트명"},{"label":"수량"},{"label":"결과"},{"label":"상세"},{"label":"예약자명"},{"label":"연락처"},{"label":"할인유형"},{"label":"비고"},{"label":"추가요청"}],"rows":[{"c":[{"v":"RQ-260608-003"},{"v":"Date(2026,5,12)","f":"2026. 6. 12"},{"v":"Date(1899,11,30,9,0,0)","f":"9:00"},{"v":"Date(2026,5,12)","f":"2026. 6. 12"},{"v":"Date(1899,11,30,19,0,0)","f":"19:00"},{"v":"메모리*1 / 배터리*2 / 앞캡 / 렌즈 후드"},{"v":1,"f":"1"},{"v":"❓ 미등록 장비"},{"v":"장비마스터/세트마스터에 없음"},{"v":"조아현"},{"v":"010-6559-6771"},{"v":"일반"},null,null]},{"c":[{"v":"RQ-260608-003"},null,null,null,null,{"v":"소니 Z90"},{"v":1,"f":"1"},{"v":"✅ 가용1"},{"v":"세트"},null,null,null,null,null]}]}});`;
  const config = {
    gasApiUrl: 'https://gas.example/exec',
    sheetApiKey: 'key',
    fetchImpl: async (url) => {
      const u = new URL(String(url));
      if (u.hostname === 'docs.google.com') {
        return { ok: true, status: 200, text: async () => gvizBody };
      }
      const sheet = u.searchParams.get('sheet');
      const query = u.searchParams.get('query');
      if (sheet === '세트마스터' && query === '소니 Z90') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ data: ['소니 Z90', '메모리*1 / 배터리*2 / 앞캡 / 렌즈 후드', 1, '', '', 'Y', 50000] }] }) };
      }
      if (sheet === '세트마스터' && query === '메모리*1 / 배터리*2 / 앞캡 / 렌즈 후드') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ data: ['소니 Z90', '메모리*1 / 배터리*2 / 앞캡 / 렌즈 후드', 1, '', '', 'Y', 50000] }] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
    }
  };

  const row = await enrichFollowUpRowWithOperationalCalculations(config, {
    id: 'follow-z90',
    type: 'tax_invoice',
    title: '조아현 세금계산서 요청',
    customer_name: '조아현',
    summary: '확인요청 RQ-260608-003 관련 서류 요청',
    recommended_action: '금액 확인',
    evidence: ['확인요청 조회: RQ-260608-003']
  });

  assert.match(row.recommended_action, /VAT 포함 55,000원/);
  assert.doesNotMatch(row.recommended_action, /110,000원|110,010원/);
  assert.equal(row.payload.operational_calculation.totalVatIncluded, 55000);
  assert.deepEqual(row.payload.operational_calculation.unresolved, ['메모리*1 / 배터리*2 / 앞캡 / 렌즈 후드 x1']);
});

test('resolveSlackChannelId searches Slack channel names and caches the id', async () => {
  let calls = 0;
  const config = {
    slackBotToken: 'xoxb-test',
    slackFetchImpl: async (url, init) => {
      calls += 1;
      assert.match(String(url), /conversations\.list/);
      assert.equal(init.headers.authorization, 'Bearer xoxb-test');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          channels: [{ id: 'C123SCHEDULE', name: '스케쥴-agent' }]
        })
      };
    }
  };

  assert.equal(await resolveSlackChannelId('스케쥴-agent', config), 'C123SCHEDULE');
  assert.equal(await resolveSlackChannelId('스케쥴-agent', config), 'C123SCHEDULE');
  assert.equal(calls, 1);
});

test('resolveSlackChannelId resolves the document-send agent channel name', async () => {
  const config = {
    slackBotToken: 'xoxb-test',
    slackFetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        channels: [{ id: 'C123DOCS', name: '서류발송-agent' }]
      })
    })
  };

  assert.equal(await resolveSlackChannelId('서류발송-agent', config), 'C123DOCS');
});

test('deliverSlackFollowUpRows suppresses Daily audit automation report rows', async () => {
  const requests = [];
  const result = await deliverSlackFollowUpRows({
    slackFollowUpEnabled: true,
    slackBotToken: 'xoxb-test',
    slackFetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return { ok: true, status: 200, text: async () => JSON.stringify([]) };
    }
  }, [{
    id: 'daily-audit-1',
    source: 'daily_audit',
    type: 'ops_issue',
    status: 'open',
    title: 'Daily audit worker timeout/skipped 이력 점검 필요',
    customer_name: '시스템',
    payload: { daily_audit_20260607: true }
  }]);

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'automation_audit_rows');
  assert.equal(requests.length, 0);
});


test('deliverSlackFollowUpRows delivers real DOM watcher task rows even when audit metadata exists', async () => {
  const requests = [];
  const config = {
    slackFollowUpEnabled: true,
    slackBotToken: 'xoxb-test',
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    slackFetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('conversations.list')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, channels: [{ id: 'C123SCHEDULE', name: '스케쥴-agent' }] })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, channel: 'C123SCHEDULE', ts: '171111.000200', message: { thread_ts: '171111.000200' } })
      };
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        text: async () => init?.method === 'PATCH'
          ? JSON.stringify([{ id: 'follow-real-task', payload: { slack_delivery: { status: 'delivered' } } }])
          : JSON.stringify([{ payload: { daily_audit_20260608: { seen: true } } }])
      };
    }
  };

  const result = await deliverSlackFollowUpRows(config, [{
    id: 'follow-real-task',
    source: 'kakao_dom_bridge',
    type: 'reservation_review',
    status: 'open',
    priority: 'high',
    title: '최승식 예약 변경 확인 필요',
    customer_name: '최승식',
    summary: 'DOM watcher 실시간 고객 태스크',
    payload: { daily_audit_20260608: { discovered_by: 'audit' } }
  }]);

  assert.equal(result.skipped, false);
  assert.equal(result.results[0].ok, true);
  assert.ok(requests.some((r) => r.url.includes('chat.postMessage')));
});


test('deliverSlackFollowUpRows posts new rows once and writes delivery metadata', async () => {
  const requests = [];
  const config = {
    slackFollowUpEnabled: true,
    slackBotToken: 'xoxb-test',
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    slackFetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('conversations.list')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, channels: [{ id: 'C123SCHEDULE', name: '스케쥴-agent' }] })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, channel: 'C123SCHEDULE', ts: '171111.000100', message: { thread_ts: '171111.000100' } })
      };
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      assert.match(String(url), /ai_follow_up_items\?/);
      assert.match(String(url), /id=eq\.follow-1/);
      return {
        ok: true,
        status: 200,
        text: async () => init?.method === 'PATCH'
          ? JSON.stringify([{ id: 'follow-1', payload: { slack_delivery: { status: 'delivered' } } }])
          : JSON.stringify([{ payload: {} }])
      };
    }
  };

  const result = await deliverSlackFollowUpRows(config, [{
    id: 'follow-1',
    type: 'reservation_review',
    status: 'open',
    priority: 'high',
    title: '예약 확인',
    customer_name: '홍길동',
    summary: '요약'
  }]);

  assert.equal(result.skipped, false);
  assert.equal(result.results[0].ok, true);
  assert.ok(requests.some((r) => r.url.includes('chat.postMessage')));
  const patch = requests.find((r) => r.url.includes('supabase.example') && r.init?.method === 'PATCH');
  assert.equal(JSON.parse(patch.init.body).payload.slack_delivery.message_ts, '171111.000100');
});

test('deliverSlackFollowUpRows posts same-conversation follow-ups as thread replies when enabled', async () => {
  const requests = [];
  const config = {
    slackFollowUpEnabled: true,
    slackThreadFollowUpsEnabled: true,
    slackBotToken: 'xoxb-test',
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    slackFetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('conversations.list')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, channels: [{ id: 'C123SCHEDULE', name: '스케쥴-agent' }] })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, channel: 'C123SCHEDULE', ts: '171111.000300', message: { thread_ts: '171111.000100' } })
      };
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      const href = String(url);
      if (href.includes('select=id%2Croom_key') || href.includes('select=id,room_key')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([{
          id: 'parent-1',
          room_key: 'kakao:park',
          customer_name: '박정우',
          type: 'reservation_review',
          status: 'open',
          payload: { slack_delivery: { status: 'delivered', channel_id: 'C123SCHEDULE', message_ts: '171111.000100', thread_ts: '171111.000100' } }
        }]) };
      }
      return {
        ok: true,
        status: 200,
        text: async () => init?.method === 'PATCH'
          ? JSON.stringify([{ id: 'child-1', payload: { slack_delivery: { status: 'delivered', is_thread_reply: true } } }])
          : JSON.stringify([{ payload: {} }])
      };
    }
  };

  const result = await deliverSlackFollowUpRows(config, [{
    id: 'child-1',
    room_key: 'kakao:park',
    type: 'completed_log',
    status: 'open',
    priority: 'normal',
    title: '박정우 6/10 예약 확정 건 확인요청 입력 필요',
    customer_name: '박정우',
    summary: '확인요청 입력 후속'
  }]);

  assert.equal(result.results[0].ok, true);
  const post = requests.find((r) => r.url.includes('chat.postMessage'));
  const body = JSON.parse(post.init.body);
  assert.equal(body.thread_ts, '171111.000100');
  const patch = requests.find((r) => r.url.includes('supabase.example') && r.init?.method === 'PATCH');
  const payload = JSON.parse(patch.init.body).payload.slack_delivery;
  assert.equal(payload.is_thread_reply, true);
  assert.equal(payload.parent_follow_up_id, 'parent-1');
});

test('deliverSlackFollowUpRows updates an existing delivered Slack card instead of reposting', async () => {
  const requests = [];
  const config = {
    slackFollowUpEnabled: true,
    slackBotToken: 'xoxb-test',
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    slackFetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, channel: 'C123DOC', ts: '171111.000100' })
      };
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        text: async () => init?.method === 'PATCH'
          ? JSON.stringify([{ id: 'follow-1', payload: { slack_delivery: { status: 'delivered', refreshed_at: 'now' } } }])
          : JSON.stringify([{ payload: { slack_delivery: { status: 'delivered', channel_id: 'C123DOC', message_ts: '171111.000100' } } }])
      };
    }
  };

  const result = await deliverSlackFollowUpRows(config, [{
    id: 'follow-1',
    type: 'contract_document',
    status: 'open',
    priority: 'high',
    title: '서류 발송',
    customer_name: '홍길동',
    summary: '요약',
    payload: {
      slack_delivery: {
        status: 'delivered',
        channel_id: 'C123DOC',
        message_ts: '171111.000100'
      }
    }
  }]);

  assert.equal(result.results[0].updatedSlack, true);
  assert.ok(requests.some((r) => r.url.includes('chat.update')));
  assert.ok(!requests.some((r) => r.url.includes('chat.postMessage')));
});

test('upsertFollowUpRows merges same conversation into an active row instead of inserting a duplicate', async () => {
  const requests = [];
  const existing = {
    id: 'existing-1',
    follow_up_key: 'preview:min:최민석:contract_document:payment_docs',
    room_key: 'preview:min',
    customer_name: '최민석',
    type: 'contract_document',
    status: 'open',
    priority: 'high',
    title: '최민석 계약서 파일 발송 요청',
    summary: '고객이 계약서 파일 발송을 요청했습니다.',
    recommended_action: '계약서를 확인하세요.',
    evidence: ['최신 고객 메시지: 계약서 보내주세요'],
    payload: { slack_delivery: { status: 'delivered', channel_id: 'C123DOC', message_ts: '171111.000100' } }
  };
  const config = {
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('status=in.(done,dismissed)')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([]) };
      }
      if (String(url).includes('status=not.in.(done,dismissed)')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([existing]) };
      }
      if (init.method === 'PATCH') {
        const patch = JSON.parse(init.body);
        return { ok: true, status: 200, text: async () => JSON.stringify([{ ...existing, ...patch }]) };
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${url}`);
    }
  };

  const result = await upsertFollowUpRows(config, [{
    follow_up_key: 'preview:min:최민석:payment_check:payment_check',
    room_key: 'preview:min',
    customer_name: '최민석',
    type: 'payment_check',
    status: 'open',
    priority: 'high',
    title: '최민석 V마운트 카드결제 확인',
    summary: '고객이 V마운트는 카드결제하겠다고 전달했습니다.',
    recommended_action: '카드결제 상태를 확인하세요.',
    evidence: ['카카오 최신 고객 메시지: 사장님 V마운트는 카드결제할게용'],
    payload: { latest_customer_message_cluster: '사장님 V마운트는 카드결제할게용' }
  }]);

  assert.equal(result.mergedActive, 1);
  assert.equal(result.rows[0].id, 'existing-1');
  assert.equal(result.rows[0].type, 'contract_document');
  assert.match(result.rows[0].summary, /카드결제/);
  assert.ok(!requests.some((r) => r.init?.method === 'POST'));
});

test('upsertFollowUpRows merges same room when customer name has message or company suffix', async () => {
  const requests = [];
  const existing = {
    id: 'existing-lee',
    follow_up_key: 'preview:lee:이기욱:reservation_review:2026-06-03',
    room_key: 'preview:lee',
    customer_name: '이기욱',
    type: 'reservation_review',
    status: 'open',
    priority: 'high',
    title: '이기욱 예약 확인요청 입력 완료',
    summary: '기존 RQ 입력 완료',
    recommended_action: 'RQ를 확인하세요.',
    evidence: ['기존 메시지'],
    payload: {}
  };
  const config = {
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('status=in.(done,dismissed)')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([]) };
      }
      if (String(url).includes('status=not.in.(done,dismissed)')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([existing]) };
      }
      if (init.method === 'PATCH') {
        const patch = JSON.parse(init.body);
        return { ok: true, status: 200, text: async () => JSON.stringify([{ ...existing, ...patch }]) };
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${url}`);
    }
  };

  const result = await upsertFollowUpRows(config, [{
    follow_up_key: 'preview:lee:이기욱 inside film:reservation_review:2026-06-03',
    room_key: 'preview:lee',
    customer_name: '이기욱 INSIDE FILM 넵 그럴게 부탁드리겠습니다 !',
    type: 'reservation_review',
    status: 'open',
    priority: 'high',
    title: '이기욱 INSIDE FILM 예약 가용 확인 결과',
    summary: '고객이 6/3~6/4 장비 예약 진행을 요청했습니다.',
    recommended_action: '기존 RQ와 대조하세요.',
    evidence: ['최신 고객 메시지: 넵 그럴게 부탁드리겠습니다 !']
  }]);

  assert.equal(result.mergedActive, 1);
  assert.equal(result.rows[0].id, 'existing-lee');
  assert.match(result.rows[0].summary, /6\/3~6\/4/);
  assert.ok(!requests.some((r) => r.init?.method === 'POST'));
});

test('filterFollowUpRowsAfterAutoReply suppresses reply card after successful auto-send', () => {
  const rows = [
    { type: 'reply_needed', title: '위치 문의 답변' },
    { type: 'price_review', title: '가격 확인' }
  ];

  assert.deepEqual(filterFollowUpRowsAfterAutoReply(rows, { sent: true }), [
    { type: 'price_review', title: '가격 확인' }
  ]);
  assert.equal(filterFollowUpRowsAfterAutoReply(rows, { sent: false }).length, 2);
});

test('buildFollowUpRows keeps local DOM job ids out of UUID job_id column', () => {
  const rows = buildFollowUpRows({
    classification: 'faq',
    confidence: 'high',
    customer: { name: '한이솔' },
    follow_up_items: [{
      type: 'contract_document',
      title: '거래명세서 발급 요청',
      summary: '고객이 거래명세서 금액을 알려줌'
    }]
  }, { jobId: 'dom-072d40c56a4cabdf', roomKey: 'preview:21d6b164a492d90e' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].job_id, null);
  assert.match(rows[0].follow_up_key, /^preview:21d6b164a492d90e:한이솔:contract_document:/);
});

test('buildFollowUpRows suppresses no-match manual-confirmation noise cards', () => {
  const rows = buildFollowUpRows({
    classification: 'unclear',
    confidence: 'high',
    reason: 'matching Kakao conversation not visible within budget',
    safety_checks: {
      kakao_conversation_opened: false
    },
    customer: { name: 'hellodesk' },
    follow_up_items: [{
      type: 'reply_needed',
      title: 'Kakao 대화방 수동 확인 필요',
      customer_name: 'hellodesk',
      summary: '작업 증거의 navigation hint는 hellodesk였으나 Kakao Channel Manager 현재 채팅 목록/검색에서 해당 대화방을 확인하지 못했습니다.',
      recommended_action: '카카오 채널 관리자에서 hellodesk 대화방을 수동으로 찾으세요.',
      blocking_reason: 'matching Kakao conversation not visible within budget'
    }]
  }, { jobId: 'dom-no-match', roomKey: 'preview:03e2dc74d0122490' });

  assert.deepEqual(rows, []);
});

test('buildFollowUpRows uses a stable semantic key for same customer task across repeated jobs', () => {
  const first = buildFollowUpRows({
    classification: 'faq',
    confidence: 'high',
    customer: { name: '정시온' },
    follow_up_items: [{
      type: 'contract_document',
      priority: 'high',
      title: '정시온 고객 37만원 결제 서류 준비',
      summary: '고객이 오늘 37만원 결제 관련 서류 수령 가능 여부를 문의했습니다.',
      recommended_action: '부가세 포함 37만원 기준으로 필요한 결제/계약/정산 서류를 준비해 전달하세요.',
      evidence: ['37만원 결제 관련 서류 문의']
    }]
  }, { jobId: 'dom-first', roomKey: 'preview:jung-si-on' });
  const second = buildFollowUpRows({
    classification: 'faq',
    confidence: 'high',
    customer: { name: '정시온' },
    follow_up_items: [{
      type: 'contract_document',
      priority: 'high',
      title: '정시온 37만원 결제 서류 전달 요청',
      summary: '고객이 전화로 안내받았던 37만원 결제 관련 서류를 요청했습니다. 이전 대화상 계약서 PDF 맥락이 있습니다.',
      recommended_action: '기존 260502-004 정시온 계약/견적/결제 내역을 확인한 뒤 고객에게 필요한 결제 서류 또는 정산서를 전달하세요.',
      evidence: ['37만원 결제 관련 서류 요청']
    }]
  }, { jobId: 'dom-second', roomKey: 'preview:jung-si-on' });

  assert.equal(first[0].follow_up_key, second[0].follow_up_key);
  assert.match(first[0].follow_up_key, /^preview:jung-si-on:정시온:contract_document:/);
});

test('buildFollowUpRows uses topic anchors for repeated FAQ follow-ups without amounts or dates', () => {
  const first = buildFollowUpRows({
    classification: 'price',
    confidence: 'high',
    customer: { name: '최재형' },
    follow_up_items: [{
      type: 'price_review',
      title: '학생 할인율 문의 답변 검토',
      summary: '고객이 학생 할인율이 몇 퍼센트인지 문의했습니다.'
    }]
  }, { jobId: 'dom-first', roomKey: 'preview:choi' });
  const second = buildFollowUpRows({
    classification: 'price',
    confidence: 'high',
    customer: { name: '최재형' },
    follow_up_items: [{
      type: 'price_review',
      title: '최재형님 학생할인 비율 문의 확인',
      summary: '고객이 학생할인이 몇 프로인지 문의했습니다.'
    }]
  }, { jobId: 'dom-second', roomKey: 'preview:choi' });

  assert.equal(first[0].follow_up_key, second[0].follow_up_key);
  assert.match(first[0].follow_up_key, /discount_policy/);
});

test('filterFollowUpRowsAgainstClosedHistory suppresses already dismissed topic tasks', () => {
  const rows = buildFollowUpRows({
    classification: 'price',
    confidence: 'high',
    customer: { name: '최재형' },
    follow_up_items: [
      {
        type: 'price_review',
        title: '최재형님 학생 할인율 문의 답변 확인',
        summary: '고객이 위치 안내를 받은 뒤 학생 할인율이 몇 프로인지 문의했습니다.'
      },
      {
        type: 'reply_needed',
        title: '최재형 고객 할인 문의 답장 필요',
        summary: '최신 고객 메시지가 직원 답변 이후 발생한 할인 문의입니다.'
      }
    ]
  }, { jobId: 'dom-second', roomKey: 'preview:choi' });
  const history = [{
    customer_name: '최재형',
    type: 'reply_needed',
    status: 'dismissed',
    title: '학생 할인 문의 답장 필요',
    summary: '직원 답변 이후 고객이 새 할인 문의를 남겼습니다.'
  }];

  assert.equal(rows.length, 2);
  assert.deepEqual(filterFollowUpRowsAgainstClosedHistory(rows, history), []);
});

test('mergeFollowUpRowsByTopic keeps one card for one operational customer update', () => {
  const rows = buildFollowUpRows({
    classification: 'reservation',
    confidence: 'medium',
    customer: { name: '박재인' },
    follow_up_items: [
      {
        type: 'reply_needed',
        title: '반납 및 다음 회차 메모 확인 답장',
        summary: '고객의 반납 완료 및 다음 회차 일정 공유에 대해 짧은 확인 답장이 유용합니다.',
        recommended_action: '확인 답장을 보내세요.',
        suggested_reply_draft: '확인했습니다. 체크해두겠습니다.'
      },
      {
        type: 'damage_repair',
        title: '경고 메시지 뜬 소니 배터리 확인 필요',
        summary: '고객이 애플박스 위에 둔 소니 배터리가 경고 메시지 발생 배터리라고 설명했습니다.',
        recommended_action: '배터리 상태를 확인하세요.'
      },
      {
        type: 'schedule_check',
        title: '다음 회차 6/1-6/2 및 5/31 밤 픽업 메모 확인',
        summary: '고객이 다음 회차 일정과 픽업 예정 시간을 전달했습니다.',
        recommended_action: '다음 회차 일정을 확인하세요.'
      }
    ]
  }, { jobId: 'dom-park', roomKey: 'preview:park' });

  const merged = mergeFollowUpRowsByTopic(rows);
  assert.equal(rows.length, 3);
  assert.equal(merged.length, 1);
  assert.match(merged[0].recommended_action, /배터리 상태/);
  assert.match(merged[0].recommended_action, /다음 회차 일정/);
  assert.equal(merged[0].suggested_reply_draft, '확인했습니다. 체크해두겠습니다.');
});

test('buildFollowUpRows keeps one stable key for one reservation split by secondary topics', () => {
  const discount = buildFollowUpRows({
    classification: 'reservation',
    confidence: 'medium',
    customer: { name: '홍지수' },
    follow_up_items: [{
      type: 'reservation_review',
      priority: 'high',
      title: '홍지수님 6/6-6/7 브라노 풀세트 및 모비 문의 확인',
      summary: '고객이 6월 6-7일 브라노 풀세트 대여 가능 여부, 비학생 학생가 가능 여부, 모비 보유 여부를 문의함.',
      recommended_action: '기존 확인요청 건을 기준으로 재고 확인 및 가격 검토를 진행하세요.'
    }]
  }, { jobId: 'dom-hong-a', roomKey: 'preview:hong' });
  const operations = buildFollowUpRows({
    classification: 'reservation',
    confidence: 'medium',
    customer: { name: '홍지수' },
    follow_up_items: [{
      type: 'reservation_review',
      priority: 'high',
      title: '홍지수님 6/6-6/7 브라노 풀세트 + 모비 대여 가능 여부 및 학생가 문의',
      summary: '고객이 2026년 6월 6-7일 브라노 풀세트 대여 가능 여부와 비학생 학생가 적용 가능 여부를 문의했습니다.',
      recommended_action: '반출/반납 시간과 연락처를 요청하고 모비 보유 여부를 직원 확인 후 안내하세요.'
    }]
  }, { jobId: 'dom-hong-b', roomKey: 'preview:hong' });

  assert.equal(discount[0].follow_up_key, operations[0].follow_up_key);
  assert.match(discount[0].follow_up_key, /reservation_review/);
});

test('buildFollowUpTopicKey collapses equipment availability split across schedule and reply cards', () => {
  const rows = buildFollowUpRows({
    classification: 'faq',
    confidence: 'medium',
    customer: { name: '이유찬' },
    follow_up_items: [
      {
        type: 'schedule_check',
        title: '인터컴 대여 가능 여부 배터리 상태 확인',
        summary: '고객이 인터콤 대여 가능 여부를 문의했고, 직원이 복귀 후 배터리 상태 확인이 필요하다고 답변한 상태입니다.'
      },
      {
        type: 'reply_needed',
        title: '인터콤 대여 가능 여부 문의 답변',
        summary: '고객이 인터콤도 대여 가능한지 문의했습니다.'
      }
    ]
  }, { jobId: 'dom-lee', roomKey: 'preview:lee' });

  const merged = mergeFollowUpRowsByTopic(rows);
  assert.equal(rows[0].follow_up_key, rows[1].follow_up_key);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].type, 'schedule_check');
});

test('mergeFollowUpRowsByTopic normalizes customer aliases with issue suffixes', () => {
  const rows = [
    {
      follow_up_key: 'a',
      customer_name: '한시우',
      type: 'damage_repair',
      priority: 'normal',
      title: '한시우 미반납/파손 관련 반납 예정 확인',
      summary: '고객이 미반납 물품을 확인 후 가져다 드리겠다고 답변함.'
    },
    {
      follow_up_key: 'b',
      customer_name: '한시우/60x 파손',
      type: 'damage_repair',
      priority: 'normal',
      title: '한시우 미반납/파손 관련 반납 확인 필요',
      summary: '고객이 미반납/확인 대상 물품을 확인 후 가져다 드리겠다고 답변함.'
    }
  ];

  assert.equal(mergeFollowUpRowsByTopic(rows).length, 1);
});

test('closeKakaoConversationWindow targets only the opened Kakao customer popup', async () => {
  const script = buildCloseKakaoConversationWindowAppleScript();
  assert.match(script, /close window w/);
  assert.match(script, / - 빌리지 - 카카오비즈니스/);

  let command;
  let args;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const spawnImpl = (cmd, nextArgs) => {
    command = cmd;
    args = nextArgs;
    return child;
  };

  const resultPromise = closeKakaoConversationWindow({ title: '정시온 - 빌리지 - 카카오비즈니스 파트너센터' }, { spawnImpl, timeoutMs: 1000 });
  child.stdout.write('closed_conversation_window\n');
  child.emit('close', 0);

  assert.deepEqual(await resultPromise, { status: 'closed_conversation_window' });
  assert.equal(command, 'osascript');
  assert.equal(args[0], '-e');
  assert.equal(args[2], '정시온 - 빌리지 - 카카오비즈니스 파트너센터');
  assert.equal(args[3], '정시온');
});

test('closeKakaoConversationTargetViaDevtools closes only the target id', async () => {
  let requestedUrl = '';
  const result = await closeKakaoConversationTargetViaDevtools({ id: 'target-1' }, {
    cdpBaseUrl: 'http://127.0.0.1:9223',
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return { ok: true, status: 200, text: async () => 'Target is closing' };
    }
  });

  assert.equal(result.status, 'closed_conversation_target');
  assert.match(requestedUrl, /\/json\/close\/target-1$/);
});

test('canAutoSendCustomerAnswer only allows high-confidence AI-approved safe replies', () => {
  const baseDecision = {
    confidence: 'high',
    kill_switch_observed: 'active',
    suggested_reply_draft: '네, 확인 후 안내드리겠습니다.',
    reply_decision: {
      replyMode: 'auto_send',
      confidence: 'high',
      text: '네, 확인 후 안내드리겠습니다.'
    },
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    }
  };

  assert.equal(canAutoSendCustomerAnswer(baseDecision, { autoSendEnabled: false }).allowed, false);
  assert.deepEqual(canAutoSendCustomerAnswer(baseDecision, { autoSendEnabled: true }), {
    allowed: true,
    reason: 'allowed',
    text: '네, 확인 후 안내드리겠습니다.',
    replyMode: 'auto_send',
    confidence: 'high'
  });
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, reply_decision: { ...baseDecision.reply_decision, replyMode: 'draft_only' } }, { autoSendEnabled: true }).allowed, false);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, confidence: 'medium', reply_decision: { ...baseDecision.reply_decision, confidence: 'medium' } }, { autoSendEnabled: true }).allowed, false);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, suggested_reply_draft: '예약 확정됐습니다', reply_decision: { ...baseDecision.reply_decision, text: '예약 확정됐습니다' } }, { autoSendEnabled: true }).allowed, false);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, classification: 'price' }, { autoSendEnabled: true }).allowed, false);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, classification: 'reservation_review' }, { autoSendEnabled: true }).allowed, false);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, classification: 'reservation' }, { autoSendEnabled: true }).allowed, true);
  assert.equal(canAutoSendCustomerAnswer({
    ...baseDecision,
    classification: 'reservation',
    reply_decision: {
      ...baseDecision.reply_decision,
      text: '재학증명서 확인했습니다! 6월 2일 19시 30분에 방문해 주시면 됩니다. 감사합니다.'
    }
  }, { autoSendEnabled: true }).allowed, true);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, owner_review_required: true }, { autoSendEnabled: true }).allowed, false);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, reply_decision: { ...baseDecision.reply_decision, text: '네 대여 가능합니다.' } }, { autoSendEnabled: true }).allowed, false);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, classification: 'reservation', reply_decision: { ...baseDecision.reply_decision, text: '네 예약 가능합니다.' } }, { autoSendEnabled: true }).allowed, false);
  assert.deepEqual(canAutoSendCustomerAnswer({
    ...baseDecision,
    classification: 'reservation',
    latest_customer_message_cluster: '그럼 이렇게 부탁드립니다',
    latest_staff_message: '네 감독님, 해당 구성 예약 가능합니다.',
    visible_messages_used: [
      { sender: '빌리지님', message: '네 감독님, 해당 구성 예약 가능합니다.', time: '오후 1:00' },
      { sender: '김채현', message: '그럼 이렇게 부탁드립니다', time: '오후 1:01' }
    ],
    reply_decision: {
      ...baseDecision.reply_decision,
      text: '네 감독님, 말씀 주신 구성으로 예약 확정해드렸습니다.'
    }
  }, { autoSendEnabled: true }), {
    allowed: true,
    reason: 'staff_confirmed_reservation_acceptance',
    text: '네 감독님, 말씀 주신 구성으로 예약 확정해드렸습니다.',
    replyMode: 'auto_send',
    confidence: 'high'
  });
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, classification: 'faq', kill_switch_observed: 'price_paused' }, { autoSendEnabled: true }).allowed, true);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, classification: 'price', kill_switch_observed: 'price_paused' }, { autoSendEnabled: true }).reason, 'kill_switch_price_paused');
});

test('live quote re-request guidance can auto-send without treating it as a new quote task', () => {
  const reply = '감독님, 최초에 보내드린 내 예약 링크에서 최신 견적서를 확인하실 수 있습니다. 장비/일정이 수정되면 그 링크의 견적서도 최신 내용으로 다시 계산됩니다.';
  const decision = {
    classification: 'faq',
    confidence: 'high',
    kill_switch_observed: 'active',
    latest_customer_message_cluster: '장비 수정했는데 견적서 다시 보내주실 수 있나요?',
    visible_messages_used: [
      { sender: '고객', message: '장비 수정했는데 견적서 다시 보내주실 수 있나요?', time: '오후 2:00' }
    ],
    reply_decision: { replyMode: 'auto_send', confidence: 'high', text: reply },
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    }
  };

  assert.deepEqual(canAutoSendCustomerAnswer(decision, { autoSendEnabled: true }), {
    allowed: true,
    reason: 'live_quote_recheck_info',
    text: reply,
    replyMode: 'auto_send',
    confidence: 'high'
  });
  assert.deepEqual(autoReplyRequiresRagSupport(decision, reply), {
    required: false,
    reason: 'live_quote_recheck_info'
  });
});

test('autoReplyRequiresRagSupport skips RAG for pre-approved bankbook/business-registration file handoff', () => {
  assert.deepEqual(autoReplyRequiresRagSupport({
    classification: 'faq',
    latest_customer_message_cluster: '통장 사본이랑 사업자등록증 보내주세요'
  }, '요청하신 통장 사본과 사업자등록증 전달드립니다.'), {
    required: false,
    reason: 'standard_customer_document_assets'
  });
});

test('standard document auto-send only triggers from latest customer request, not old history', () => {
  const decision = {
    classification: 'faq',
    kill_switch_observed: 'active',
    latest_customer_message_cluster: '감사합니다! podong@dodam.media 으로 세금계산서 발행해주시면 입금진행하겠습니다',
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    visible_messages_used: [
      { sender: '김예지', message: '또, 빌리지렌탈샵의 사업자 / 통장사본도 부탁드립니다' },
      { sender: '빌리지님', message: '안녕하세요 빌리지입니다. 요청하신 통장 사본과 사업자등록증 보내드립니다.' },
      { sender: '김예지', message: '감사합니다! podong@dodam.media 으로 세금계산서 발행해주시면 입금진행하겠습니다' }
    ]
  };

  assert.equal(isCustomerDocumentAssetRequest(decision), false);
  assert.equal(canAutoSendCustomerDocumentAssets(decision, { autoSendEnabled: true }).reason, 'not_latest_customer_document_request');
});

test('standard document auto-send is blocked after a staff document delivery message', () => {
  const decision = {
    classification: 'faq',
    kill_switch_observed: 'active',
    latest_customer_message_cluster: '사업자등록증이랑 통장 사본 부탁드립니다',
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    visible_messages_used: [
      { sender: '김예지', message: '사업자등록증이랑 통장 사본 부탁드립니다' },
      { sender: '빌리지님', message: '요청하신 통장 사본과 사업자등록증 전달드립니다.' }
    ]
  };

  assert.equal(customerDocumentAssetsAlreadySent(decision), true);
  assert.equal(canAutoSendCustomerDocumentAssets(decision, { autoSendEnabled: true }).reason, 'customer_document_assets_already_sent');
});

test('standard document auto-send does not treat customer tax-invoice business-registration upload as Village document request', () => {
  const decision = {
    classification: 'ignore',
    kill_switch_observed: 'active',
    latest_customer_message_cluster: '알티스트레이블 사업자등록증 (1) (1).pdf, ivan@rtstlabel.com, 여기로 세금계산서 발행해 주시면 감사하겠습니다!, 발행해주시고 말씀한번 해주시면 감사하겠습니다',
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    visible_messages_used: [
      { sender: '하현준', message: '세금계산서 발급받고 싶습니다. 사업자등록증좀 전달해주시면 감사하겠습니다' },
      { sender: '빌리지님', message: '세금계산서 발급하실 거면 저희가 아니라 감독님 사업자등록증 보내주셔야되는데 확인 되실까요?' },
      { sender: '하현준', message: '알티스트레이블 사업자등록증 (1) (1).pdf' },
      { sender: '하현준', message: 'ivan@rtstlabel.com' },
      { sender: '하현준', message: '여기로 세금계산서 발행해 주시면 감사하겠습니다!' },
      { sender: '하현준', message: '발행해주시고 말씀한번 해주시면 감사하겠습니다' }
    ]
  };

  assert.equal(isCustomerDocumentAssetRequest(decision), false);
  assert.equal(canAutoSendCustomerDocumentAssets(decision, { autoSendEnabled: true }).reason, 'classification_not_customer_document_faq');
});

test('standard document auto-send allows explicit Village bankbook/business-registration request in latest turn', () => {
  const decision = {
    classification: 'faq',
    kill_switch_observed: 'active',
    latest_customer_message_cluster: '빌리지렌탈샵의 사업자 / 통장사본도 부탁드립니다',
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    visible_messages_used: [
      { sender: '김예지', message: '빌리지렌탈샵의 사업자 / 통장사본도 부탁드립니다' }
    ]
  };

  assert.equal(isCustomerDocumentAssetRequest(decision), true);
  assert.equal(canAutoSendCustomerDocumentAssets(decision, {
    autoSendEnabled: true,
    customerDocumentAssetPaths: [
      '/Users/village6k/.hermes/village-documents/customer-request-docs/village_woori_bankbook_copy.jpeg',
      '/Users/village6k/.hermes/village-documents/customer-request-docs/village_business_registration_certificate.jpeg'
    ]
  }).reason, 'standard_customer_document_assets');
});

test('autoReplyRequiresRagSupport marks FAQ and policy/procedure replies for RAG verification', () => {
  assert.deepEqual(autoReplyRequiresRagSupport({ classification: 'faq' }, '네, 주소 안내드릴게요.'), {
    required: true,
    reason: 'classification_faq'
  });
  assert.deepEqual(autoReplyRequiresRagSupport({ classification: 'reservation' }, '네, 확인했습니다.'), {
    required: false,
    reason: 'not_policy_or_faq_auto_reply'
  });
  assert.deepEqual(autoReplyRequiresRagSupport({ classification: 'reservation' }, '방문 수령 절차 안내드리겠습니다.'), {
    required: true,
    reason: 'policy_or_procedure_terms'
  });
});

test('autoReplyRequiresRagSupport marks mutable policy FAQ for current-policy or RAG verification', () => {
  assert.deepEqual(mutablePolicyAutoReplyRisk({
    latest_customer_message_cluster: '학생할인 몇 프로인가요?'
  }, '학생 할인은 30%입니다.'), {
    mutable: true,
    reason: 'mutable_policy_terms'
  });
  assert.deepEqual(autoReplyRequiresRagSupport({
    classification: 'faq',
    latest_customer_message_cluster: '비학생인데 학생가 적용 가능한가요?'
  }, '학생가는 적용 어렵습니다.'), {
    required: true,
    reason: 'mutable_policy_terms',
    mutablePolicy: true
  });
});

test('currentConfirmedPolicyAutoReplySupport allows owner-confirmed latest discount facts', () => {
  assert.deepEqual(currentConfirmedPolicyAutoReplySupport({
    latest_customer_message_cluster: '학생할인 몇 프로인가요?'
  }, '학생 할인은 30%입니다.'), {
    applicable: true,
    allowed: true,
    reason: 'current_confirmed_policy_match',
    topics: ['student_discount_rate'],
    failedTopics: []
  });
  assert.equal(currentConfirmedPolicyAutoReplySupport({
    latest_customer_message_cluster: '학생할인 몇 프로인가요?'
  }, '학생 할인은 40%입니다.').allowed, false);
  assert.equal(currentConfirmedPolicyAutoReplySupport({
    latest_customer_message_cluster: '보증금 있나요?'
  }, '보증금은 없습니다.').reason, 'policy_not_in_current_confirmed_set_use_rag');
  assert.deepEqual(currentConfirmedPolicyAutoReplySupport({
    latest_customer_message_cluster: '영업시간이 어떻게 되나요?'
  }, '저희는 24시간 운영하고 있습니다.'), {
    applicable: true,
    allowed: true,
    reason: 'current_confirmed_policy_match',
    topics: ['business_hours_policy'],
    failedTopics: []
  });
});

test('buildAutoReplyRagQuestion includes current Kakao context and proposed reply without asking current stock truth', () => {
  const question = buildAutoReplyRagQuestion({
    decision: {
      classification: 'faq',
      customer: { name: '박정병' },
      latest_customer_message_cluster: '혹시 코모도 x도 보유중이신가요?',
      visible_messages_used: [
        { sender: '박정병', message: '혹시 코모도 x도 보유중이신가요?' },
        { sender: '빌리지님', message: '확인해보겠습니다.' }
      ]
    },
    replyText: '안녕하세요 감독님! 코모도 X는 현재 보유 목록에서 확인이 안 됩니다.'
  });

  assert.match(question, /박정병/);
  assert.match(question, /혹시 코모도 x도 보유중/);
  assert.match(question, /AI가 보내려는 답변 초안/);
  assert.match(question, /현재 재고\/예약 가능 여부\/스케줄 확정은 판단하지 말고/);
});

test('buildAutoReplyRagQuestion tells RAG current confirmed policy wins over older history', () => {
  const question = buildAutoReplyRagQuestion({
    decision: {
      classification: 'faq',
      customer: { name: '최재형' },
      latest_customer_message_cluster: '학생 할인율이 몇 퍼센트인가요?'
    },
    replyText: '학생 할인은 30%입니다.'
  });

  assert.match(question, /현재 확정 정책/);
  assert.match(question, /학생30%/);
  assert.match(question, /확정 정책에 없는 보증금\/환불\/계좌\/증빙/);
});

test('evaluateAutoReplyRagSupport allows owner-confirmed current policy FAQ without RAG', async () => {
  let called = false;
  const supported = await evaluateAutoReplyRagSupport({
    config: {},
    decision: {
      classification: 'faq',
      customer: { name: '최필립' },
      latest_customer_message_cluster: '안녕하세요. 영업시간이 어떻게 되나요?'
    },
    replyText: '안녕하세요! 빌리지는 24시간 운영합니다.',
    askImpl: async () => {
      called = true;
      throw new Error('RAG should not be called for current confirmed business hours');
    }
  });

  assert.equal(supported.allowed, true);
  assert.equal(supported.reason, 'current_confirmed_policy_match');
  assert.deepEqual(supported.currentPolicy.topics, ['business_hours_policy']);
  assert.equal(called, false);
});

test('evaluateAutoReplyRagSupport requires high-confidence retrieved RAG for FAQ auto-send', async () => {
  const base = {
    config: { villageAiUrl: 'https://village-ai.example', ragTimeoutMs: 1000 },
    decision: {
      classification: 'faq',
      customer: { name: '홍길동' },
      latest_customer_message_cluster: '위치가 어디인가요?'
    },
    job: { preview_text: '홍길동 위치가 어디인가요? 오후 2:30' },
    replyText: '빌리지는 서울 마포구 동교로 23길 32, 2층입니다.'
  };
  const supported = await evaluateAutoReplyRagSupport({
    ...base,
    askImpl: async (payload) => ({
      text: `근거 있음: ${payload.question.slice(0, 20)}`,
      confidence: 'high',
      knowledgeSource: 'retrieved',
      ownerReview: false,
      usedSources: [{ id: 'source-1' }],
      logId: 'rag-1'
    })
  });
  const weak = await evaluateAutoReplyRagSupport({
    ...base,
    askImpl: async () => ({ text: '일반 답변', confidence: 'high', knowledgeSource: 'general', ownerReview: false })
  });

  assert.equal(supported.allowed, true);
  assert.equal(supported.reason, 'rag_high_confidence_retrieved');
  assert.equal(supported.logId, 'rag-1');
  assert.equal(weak.allowed, false);
  assert.equal(weak.reason, 'rag_not_strong_enough_for_auto_send');
});

test('evaluateAutoReplyRagSupport allows owner-confirmed current policy auto-send without RAG', async () => {
  let called = false;
  const supported = await evaluateAutoReplyRagSupport({
    config: { villageAiUrl: 'https://village-ai.example', ragTimeoutMs: 1000 },
    decision: {
      classification: 'faq',
      customer: { name: '최재형' },
      latest_customer_message_cluster: '학생 할인은 몇 프로예요?'
    },
    replyText: '학생 할인은 30%입니다.',
    askImpl: async () => {
      called = true;
      return {
        text: '학생 할인은 과거에 30%로 안내했습니다.',
        confidence: 'high',
        knowledgeSource: 'retrieved',
        ownerReview: false
      };
    }
  });

  assert.equal(supported.allowed, true);
  assert.equal(supported.reason, 'current_confirmed_policy_match');
  assert.equal(called, false);
  assert.deepEqual(supported.currentPolicy.topics, ['student_discount_rate']);
});

test('evaluateAutoReplyRagSupport blocks current policy mismatch and uses RAG for unconfirmed policy FAQ', async () => {
  const mismatch = await evaluateAutoReplyRagSupport({
    config: { villageAiUrl: 'https://village-ai.example', ragTimeoutMs: 1000 },
    decision: {
      classification: 'faq',
      customer: { name: '최재형' },
      latest_customer_message_cluster: '학생 할인은 몇 프로예요?'
    },
    replyText: '학생 할인은 40%입니다.',
    askImpl: async () => {
      throw new Error('RAG should not be called for current-policy mismatch');
    }
  });
  let called = false;
  const unknown = await evaluateAutoReplyRagSupport({
    config: { villageAiUrl: 'https://village-ai.example', ragTimeoutMs: 1000 },
    decision: {
      classification: 'faq',
      customer: { name: '홍길동' },
      latest_customer_message_cluster: '보증금 있나요?'
    },
    replyText: '보증금 안내드리겠습니다.',
    askImpl: async () => {
      called = true;
      return {
        text: '보증금 정책 근거 있음',
        confidence: 'high',
        knowledgeSource: 'retrieved',
        ownerReview: false,
        logId: 'rag-deposit'
      };
    }
  });

  assert.equal(mismatch.allowed, false);
  assert.equal(mismatch.reason, 'current_policy_mismatch_requires_review');
  assert.equal(unknown.allowed, true);
  assert.equal(unknown.reason, 'rag_high_confidence_retrieved');
  assert.equal(unknown.logId, 'rag-deposit');
  assert.equal(called, true);
});

test('isAutoSendEligibleLiveJob allows unread same-day rows and blocks dated/backfill rows from auto-send', () => {
  const now = new Date('2026-06-02T06:50:00.000Z'); // 2026-06-02 15:50 KST
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: '중요 홍길동 네 감사합니다 오후 3:45',
    events: [{ reason: 'top_row_changed' }]
  }, { now }), {
    eligible: true,
    reason: 'top_row_live_time_format'
  });
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: '중요 홍길동 네 감사합니다 오후 3:45',
    events: [{ reason: 'top_row_changed' }]
  }, { now: new Date('2026-06-02T08:00:00.000Z') }), {
    eligible: false,
    reason: 'top_row_time_outside_live_window'
  });
  assert.equal(isAutoSendEligibleLiveJob({ preview_text: '중요 홍길동 네 감사합니다 오후 3:45', events: [{ reason: 'mutation' }] }, { now }).eligible, false);
  assert.equal(isAutoSendEligibleLiveJob({ payload: { previewText: '중요 홍길동 네 감사합니다 오후 3:45', events: [{ reason: 'top_row_changed' }] } }, { now }).eligible, true);
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: '중요 홍길동 3 네 감사합니다 오후 3:45',
    unread_count: 3,
    events: [{ reason: 'top_rows_backstop' }]
  }, { now }), {
    eligible: true,
    reason: 'top_row_unread'
  });
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: '중요 홍길동 네 감사합니다 오후 3:45',
    unread_count: null,
    events: [{ reason: 'top_rows_backstop', unreadCount: 3 }]
  }, { now }), {
    eligible: true,
    reason: 'top_row_unread'
  });
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: '중요 홍길동 3 네 감사합니다 6월 2일',
    unread_count: 3,
    events: [{ reason: 'top_rows_backstop' }]
  }, { now }), {
    eligible: true,
    reason: 'top_row_unread'
  });
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: '중요 홍길동 안녕하세요. 영업시간이 어떻게 되나요? 6월 2일',
    events: [{ reason: 'top_row_changed' }]
  }, { now }), {
    eligible: true,
    reason: 'top_row_current_date_label'
  });
  assert.equal(isAutoSendEligibleLiveJob({
    preview_text: '중요 홍길동 3 네 감사합니다 5월 26일',
    unread_count: 3,
    events: [{ reason: 'top_rows_backstop' }]
  }, { now }).eligible, false);
  assert.equal(isAutoSendEligibleLiveJob({ preview_text: '중요 홍길동 네 감사합니다 오후 3:45', events: [{ reason: 'top_rows_backstop' }] }, { now }).eligible, false);
  assert.equal(isAutoSendEligibleLiveJob({ preview_text: '중요 한시우/60x 파손 video 5월 25일', events: [{ reason: 'top_row_changed' }] }, { now }).eligible, false);
  assert.equal(isAutoSendEligibleLiveJob({ preview_text: '중요 배성문 1월 15일 건은 4만원입니다. 오후 3:45', events: [{ reason: 'top_row_changed' }] }, { now }).eligible, false);
});

test('auto reply dedupe key uses customer message and outgoing text', () => {
  const key = buildAutoReplyDedupeKey({
    job: { preview_text: '최재형 1 빌리지 위치가 어떻게 되나요? 오전 2:29' },
    decision: {
      customer: { name: '최재형' },
      visible_messages_used: [
        { sender: '빌리지님', message: '이전 답변' },
        { sender: '최재형', message: '빌리지 위치가 어떻게 되나요?' }
      ],
      reply_decision: { text: '빌리지는 서울 마포구 동교로 23길 32, 2층입니다.' }
    }
  });

  assert.match(key, /최재형/);
  assert.match(key, /빌리지 위치가 어떻게 되나요/);
  assert.match(key, /동교로 23길 32/);
});

test('auto reply dedupe key prefers stable room key over inconsistent customer label', () => {
  const first = buildAutoReplyDedupeKey({
    job: { roomKey: 'preview:cd489b98fab6669f', preview_text: '김예지2 감사합니다 오후 11:11' },
    decision: {
      customer: { name: '김예지2' },
      visible_messages_used: [{ sender: '김예지', message: '감사합니다! podong@dodam.media 으로 세금계산서 발행해주시면 입금진행하겠습니다' }],
      reply_decision: { text: '요청하신 통장 사본과 사업자등록증 전달드립니다.' }
    }
  });
  const second = buildAutoReplyDedupeKey({
    job: { room_key: 'preview:cd489b98fab6669f', preview_text: '김예지2 감사합니다 오후 11:11' },
    decision: {
      customer: { name: '김예지' },
      visible_messages_used: [{ sender: '김예지', message: '감사합니다! podong@dodam.media 으로 세금계산서 발행해주시면 입금진행하겠습니다' }],
      reply_decision: { text: '요청하신 통장 사본과 사업자등록증 전달드립니다.' }
    }
  });

  assert.equal(first, second);
  assert.match(first, /^preview:cd489b98fab6669f\|/);
});

test('hasRecentSentAutoReply blocks duplicate sent replies only inside window', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-auto-replies-'));
  const logPath = path.join(tmpDir, 'auto-replies.ndjson');
  const now = new Date('2026-05-26T17:40:00.000Z');
  const key = '최재형|빌리지 위치가 어떻게 되나요?|동교로 23길 32';
  fs.writeFileSync(logPath, [
    JSON.stringify({ at: '2026-05-26T17:20:00.000Z', dedupeKey: key, result: { sent: true } }),
    JSON.stringify({ at: '2026-05-26T16:00:00.000Z', dedupeKey: 'other', result: { sent: true } })
  ].join('\n'));

  assert.equal(hasRecentSentAutoReply({ autoSendLogPath: logPath }, key, { now, windowMs: 30 * 60 * 1000 }), true);
  assert.equal(hasRecentSentAutoReply({ autoSendLogPath: logPath }, key, { now, windowMs: 5 * 60 * 1000 }), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('findKakaoMessageInputElementIndex finds the Kakao message input field', () => {
  const tree = `
- [10] AXStaticText = "한이솔"
- [41] AXTextArea "채팅 메시지 입력 폼" value=""
- [42] AXButton "전송"
`;
  assert.equal(findKakaoMessageInputElementIndex(tree), 41);
  assert.equal(findKakaoSendButtonElementIndex(tree), 42);
  assert.equal(kakaoConversationContainsMessage('- [20] AXStaticText = "네 확인했습니다."', '네 확인했습니다.'), true);
});

test('findKakaoMessageInputElementIndex uses Kakao input form context instead of address bar', () => {
  const tree = `
- [4] AXGroup actions=[AXShowMenu]
  - [6] AXTextField = "business.kakao.com/_xhPMls/chats/4925133758027996" (주소창 및 검색창)
- [681] AXGroup
  - [682] AXGroup (채팅 메시지 입력 폼)
    - [684] AXStaticText = "채팅 메시지 입력 폼"
    - [685] AXTextArea actions=[AXShowMenu, AXScrollToVisible]
    - [693] AXGroup
      - [694] AXButton actions=[AXShowMenu, AXScrollToVisible]
  - [695] AXButton "전송" DISABLED actions=[AXShowMenu, AXScrollToVisible]
`;
  assert.equal(findKakaoMessageInputElementIndex(tree), 685);
  assert.equal(findKakaoSendButtonElementIndex(tree), 695);
});

test('sendKakaoMessageViaChrome clicks send button and verifies sent bubble', async () => {
  const calls = [];
  let stateCalls = 0;
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (cmd === 'osascript') {
        child.stdout.end('');
      } else if (args[1] === 'get_window_state') {
        stateCalls += 1;
        child.stdout.end(JSON.stringify({
          tree_markdown: stateCalls === 1
            ? '- [41] AXTextArea "채팅 메시지 입력 폼" value=""\n- [42] AXButton "전송"'
            : stateCalls === 2
              ? '- [41] AXTextArea "채팅 메시지 입력 폼" value="네 확인했습니다."\n- [42] AXButton "전송"'
              : '- [20] AXStaticText = "네 확인했습니다."\n- [41] AXTextArea "채팅 메시지 입력 폼" value=""'
        }));
      } else {
        child.stdout.end('{}');
      }
      child.emit('close', 0);
    });
    return child;
  };

  const result = await sendKakaoMessageViaChrome('네 확인했습니다.', {
    conversation_window: { pid: 123, window_id: 456, title: '고객 - 빌리지 - 카카오비즈니스 파트너센터' }
  }, { spawnImpl });

  assert.equal(result.sent, true);
  assert.equal(result.reason, 'sent_via_chrome_verified');
  assert.equal(calls[0].cmd, 'osascript');
  assert.equal(calls[1].args[1], 'get_window_state');
  assert.equal(calls[2].args[1], 'type_text');
  assert.match(calls[2].args[2], /네 확인했습니다/);
  assert.equal(calls[4].args[1], 'get_window_state');
  assert.equal(calls[5].args[1], 'click');
  assert.equal(calls[7].args[1], 'get_window_state');
});

test('sendKakaoMessageViaChrome falls back to DevTools target when AX window is unavailable', async () => {
  const evalCalls = [];
  const result = await sendKakaoMessageViaChrome('확인했습니다.', {
    conversation_target: {
      id: 'chat',
      title: '오래된고객 - 빌리지 - 카카오비즈니스 파트너센터',
      url: 'https://business.kakao.com/_xhPMls/chats/123',
      webSocketDebuggerUrl: 'ws://chat'
    }
  }, {
    evaluateImpl: async (target, expression) => {
      evalCalls.push({ target, expression });
      return { sent: true, reason: 'sent_via_devtools_verified', window_title: target.title };
    }
  });

  assert.equal(result.sent, true);
  assert.equal(result.reason, 'sent_via_devtools_verified');
  assert.equal(result.via_devtools, true);
  assert.ok(evalCalls[0].expression.includes('textarea[placeholder*="메시지"]'));
});

test('sendKakaoMessageViaDevtools refuses sent=true without a conversation target', async () => {
  assert.deepEqual(await sendKakaoMessageViaDevtools('확인했습니다.', {}), {
    sent: false,
    reason: 'conversation_target_missing'
  });
});

test('sendKakaoMessageViaDevtools attaches local files through Chrome DevTools after text send', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakao-attach-'));
  const bankbookPath = path.join(dir, 'bankbook.jpeg');
  const businessPath = path.join(dir, 'business.jpeg');
  fs.writeFileSync(bankbookPath, 'bankbook');
  fs.writeFileSync(businessPath, 'business');
  const cdpCalls = [];
  const evalExpressions = [];

  const result = await sendKakaoMessageViaDevtools('요청하신 통장 사본과 사업자등록증 전달드립니다.', {
    conversation_target: {
      id: 'chat',
      title: '최재형 - 빌리지 - 카카오비즈니스 파트너센터',
      webSocketDebuggerUrl: 'ws://example.test/devtools/page/chat'
    }
  }, {
    attachmentPaths: [bankbookPath, businessPath],
    evaluateImpl: async (_target, expression) => {
      evalExpressions.push(expression);
      if (expression.includes('kakaoSendMessage')) {
        return { sent: true, reason: 'sent_via_devtools_verified', window_title: '최재형' };
      }
      return { sendClicked: true, selectedFileCount: 2, window_title: '최재형' };
    },
    cdpCallImpl: async (_target, method, params) => {
      cdpCalls.push({ method, params });
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 42 };
      if (method === 'DOM.setFileInputFiles') return {};
      return {};
    }
  });

  assert.equal(result.sent, true);
  assert.equal(result.attachments.attached, true);
  assert.deepEqual(cdpCalls.find((call) => call.method === 'DOM.setFileInputFiles').params.files, [bankbookPath, businessPath]);
  assert.equal(evalExpressions.some((expression) => expression.includes('kakaoSendPendingAttachments')), true);
});

test('sendKakaoMessageViaChrome reactivates target window and retries disabled send button', async () => {
  const calls = [];
  let stateCalls = 0;
  let clickCalls = 0;
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (cmd === 'osascript') {
        child.stdout.end('');
        child.emit('close', 0);
      } else if (args[1] === 'get_window_state') {
        stateCalls += 1;
        const tree = stateCalls >= 4
          ? '- [20] AXStaticText = "네 확인했습니다."\n- [41] AXTextArea "채팅 메시지 입력 폼" value=""'
          : '- [41] AXTextArea "채팅 메시지 입력 폼" value="네 확인했습니다."\n- [42] AXButton "전송"';
        child.stdout.end(JSON.stringify({ tree_markdown: tree }));
        child.emit('close', 0);
      } else if (args[1] === 'click') {
        clickCalls += 1;
        if (clickCalls === 1) {
          child.stderr.end('AXButton "전송" is disabled (AXEnabled = false)');
          child.emit('close', 1);
        } else {
          child.stdout.end('{}');
          child.emit('close', 0);
        }
      } else {
        child.stdout.end('{}');
        child.emit('close', 0);
      }
    });
    return child;
  };

  const result = await sendKakaoMessageViaChrome('네 확인했습니다.', {
    conversation_window: { pid: 123, window_id: 456, title: '고객 - 빌리지 - 카카오비즈니스 파트너센터' }
  }, { spawnImpl });

  assert.equal(result.sent, true);
  assert.equal(result.retried_after_frontmost_activation, true);
  assert.equal(clickCalls, 2);
  assert.ok(calls.filter((call) => call.cmd === 'osascript').length >= 3);
});

test('sendKakaoMessageViaChrome treats Chrome activation failure as non-fatal and verifies send', async () => {
  let stateCalls = 0;
  const spawnImpl = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (cmd === 'osascript') {
        child.stderr.end('not authorised to send Apple events');
        child.emit('close', 1);
      } else if (args[1] === 'get_window_state') {
        stateCalls += 1;
        child.stdout.end(JSON.stringify({
          tree_markdown: stateCalls >= 3
            ? '- [20] AXStaticText = "네 확인했습니다."\n- [41] AXTextArea "채팅 메시지 입력 폼" value=""'
            : '- [41] AXTextArea "채팅 메시지 입력 폼" value="네 확인했습니다."\n- [42] AXButton "전송"'
        }));
        child.emit('close', 0);
      } else {
        child.stdout.end('{}');
        child.emit('close', 0);
      }
    });
    return child;
  };

  const result = await sendKakaoMessageViaChrome('네 확인했습니다.', {
    conversation_window: { pid: 123, window_id: 456, title: '고객 - 빌리지 - 카카오비즈니스 파트너센터' }
  }, { spawnImpl });

  assert.equal(result.sent, true);
  assert.equal(result.reason, 'sent_via_chrome_verified');
});

test('sendKakaoMessageViaChrome refuses sent=true when Kakao bubble is not verified', async () => {
  const spawnImpl = (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args[0] === '-e') {
        child.stdout.end('');
      } else if (args[1] === 'get_window_state') {
        child.stdout.end(JSON.stringify({
          tree_markdown: '- [41] AXTextArea "채팅 메시지 입력 폼" value=""\n- [42] AXButton "전송"'
        }));
      } else {
        child.stdout.end('{}');
      }
      child.emit('close', 0);
    });
    return child;
  };

  const result = await sendKakaoMessageViaChrome('네 확인했습니다.', {
    conversation_window: { pid: 123, window_id: 456, title: '고객 - 빌리지 - 카카오비즈니스 파트너센터' }
  }, { spawnImpl });

  assert.equal(result.sent, false);
  assert.equal(result.reason, 'send_not_verified_in_conversation');
});

test('mapDecisionToStatusPatch routes write and no-write decisions to review states', () => {
  assert.deepEqual(mapDecisionToStatusPatch({ should_write_to_sheet: true }, { sheetResult: { success: true } }), {
    status: 'needs_human_review',
    error_message: null
  });
  assert.deepEqual(mapDecisionToStatusPatch({ should_write_to_sheet: true }, {
    sheetResult: {
      success: false,
      error_type: 'sheet_validation',
      error: '셀 B52에 입력한 데이터가 이 셀에 설정된 데이터 확인 규칙을 위반했습니다.'
    }
  }), {
    status: 'needs_human_review',
    error_message: 'GAS sheet write rejected: 셀 B52에 입력한 데이터가 이 셀에 설정된 데이터 확인 규칙을 위반했습니다.'
  });
  assert.deepEqual(mapDecisionToStatusPatch({ should_write_to_sheet: true }, {
    sheetResult: {
      success: false,
      error_type: 'duplicate_request',
      error: '중복 요청: 동일 건이 이미 예약 등록되어 있습니다'
    }
  }), {
    status: 'ai_skipped_needs_review',
    error_message: 'GAS duplicate skipped: 중복 요청: 동일 건이 이미 예약 등록되어 있습니다'
  });
  assert.deepEqual(mapDecisionToStatusPatch({ should_write_to_sheet: false, reason: '정보부족' }), {
    status: 'ai_skipped_needs_review',
    error_message: '정보부족'
  });
});
