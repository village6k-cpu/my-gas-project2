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
  mapDecisionToStatusPatch,
  buildGasReadUrl,
  buildReadOnlyRagContext,
  parseVillageAiSse,
  askVillageAi,
  buildReadOnlyLookupContext,
  buildHermesArgs,
  resolveHermesCommand,
  resolveCuaDriverCommand,
  buildKakaoTabAppleScript,
  ensureKakaoChannelManagerTabViaDevtools,
  ensureKakaoChannelManagerTab,
  kakaoDevtoolsBaseUrlFromEnv,
  pickKakaoMainListTarget,
  pickKakaoMainListWindow,
  pickKakaoConversationWindow,
  findChatRowElementIndex,
  extractKakaoConversationEvidence,
  openKakaoTargetChatFromList,
  extractNavigationHints,
  buildCompactJobForPrompt,
  canAutoSendCustomerAnswer,
  isAutoSendEligibleLiveJob,
  buildAutoReplyDedupeKey,
  hasRecentSentAutoReply,
  filterFollowUpRowsAfterAutoReply,
  filterFollowUpRowsAgainstClosedHistory,
  mergeFollowUpRowsByTopic,
  findKakaoMessageInputElementIndex,
  findKakaoSendButtonElementIndex,
  kakaoConversationContainsMessage,
  sendKakaoMessageViaChrome,
  runHermes,
  buildCloseKakaoConversationWindowAppleScript,
  closeKakaoConversationWindow
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
  assert.ok(prompt.length < 13000, `prompt too large: ${prompt.length}`);
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
  assert.match(prompt, /정규화가 애매하거나 실패했다고.*입력 자체를 막지 않는다/s);
  assert.match(prompt, /확인요청은 최종 등록이 아니라/s);
  assert.match(prompt, /FX3.*A7S3.*FX6/s);
  assert.match(prompt, /할인유형.*학생.*개인사업자\/프리랜서.*일반/s);
  assert.match(prompt, /단골.*일반/s);
  assert.match(prompt, /계약마스터.*스케줄상세.*확인요청/s);
  assert.match(prompt, /예약형식.*should_write_to_sheet=true/s);
  assert.match(prompt, /불확실한 장비명.*입력 차단 사유가 아니라/s);
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

test('buildKakaoTabAppleScript focuses existing Kakao Channel Manager tabs or opens one', () => {
  const script = buildKakaoTabAppleScript();
  assert.match(script, /business\.kakao\.com/);
  assert.match(script, /center-pf\.kakao\.com/);
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
    { id: 'main', type: 'page', url: 'https://center-pf.kakao.com/_x/chats', title: '카카오비즈니스 파트너센터' }
  ]);
  assert.equal(target.id, 'main');
});

test('ensureKakaoChannelManagerTabViaDevtools focuses automation profile tab', async () => {
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
    if (url === 'http://127.0.0.1:9223/json/activate/main-tab') {
      return { ok: true, status: 200, text: async () => 'Target activated' };
    }
    throw new Error(`unexpected request ${url}`);
  };

  const result = await ensureKakaoChannelManagerTabViaDevtools({
    cdpBaseUrl: 'http://127.0.0.1:9223',
    fetchImpl
  });

  assert.deepEqual(result, {
    status: 'focused_list_via_devtools',
    targetId: 'main-tab',
    url: 'https://center-pf.kakao.com/_x/chats'
  });
  assert.deepEqual(requests.map((request) => request.method), ['GET', 'PUT']);
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

test('findChatRowElementIndex finds AXLink row from navigation hint', () => {
  const tree = `
- [170] AXButton "중요"
- [171] AXLink (정진우 네, 장비 준비돼 있는 거 반출 하시면 됩니다 오후 8:20) actions=[AXShowMenu, AXScrollToVisible]
- [172] AXStaticText = "정진우"
`;
  assert.equal(findChatRowElementIndex(tree, ['정진우']), 171);
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

test('buildHermesPrompt requires sender separation and customer turn clustering', () => {
  const prompt = buildHermesPrompt({ id: 'job-sender', preview_text: '중요 홍길동 안녕하세요 오후 1:00' });
  assert.match(prompt, /SENDER AND TURN-TAKING POLICY/);
  assert.match(prompt, /staff\/outbound.*customer\/inbound/s);
  assert.match(prompt, /latest customer\/inbound message or a cluster/s);
  assert.match(prompt, /안녕하세요.*27일날.*fx3 가능한가요/s);
  assert.match(prompt, /latest_customer_message_after_last_staff_reply/);
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

test('buildSheetAppendPayload returns null when AI says not to write', () => {
  const decision = {
    should_write_to_sheet: false,
    sheet_row_candidate: { customer_name: '최재형' }
  };
  assert.equal(buildSheetAppendPayload(decision, { apiKey: 'k' }), null);
});

test('buildSheetAppendPayload maps AI-decided fields into 확인요청 append shape', () => {
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
      request_id: 'AI-1',
      start_date: '2026-06-01',
      pickup_time: '10:00',
      end_date: '2026-06-02',
      return_time: '18:00',
      item: '소니 FX6 바디세트',
      quantity: 1,
      customer_name: '홍길동',
      phone: '010-0000-0000',
      discount_type: '학생',
      memo: 'AI 검토 필요',
      extra_request: '렌즈 포함'
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });

  assert.equal(payload.action, 'append');
  assert.equal(payload.key, 'secret');
  assert.equal(payload.sheet, '확인요청');
  assert.equal(payload.values.length, 1);
  assert.deepEqual(payload.values[0], [
    'AI-1', '2026-06-01', '10:00', '2026-06-02', '18:00', '소니 FX6 바디세트', 1,
    '', 'AI_REVIEW', 'AI 검토 필요', '홍길동', '010-0000-0000', '학생', '',
    'AI-대기', '', 'AI가 카카오 화면을 읽고 생성한 후보 행. 사람 검토 후 확인/등록 실행.', '렌즈 포함'
  ]);
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
    sheet_row_candidate: { item: 'FX6', customer_name: '홍길동', memo: '장비명/중복 검증 필요' }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });
  assert.equal(payload.action, 'append');
  assert.equal(payload.sheet, '확인요청');
  assert.equal(payload.values[0][5], 'FX6');
  assert.equal(payload.values[0][10], '홍길동');
  assert.equal(payload.values[0][9], '장비명/중복 검증 필요');
});

test('buildFollowUpRows maps AI-decided follow-up items for remote dashboard', () => {
  const rows = buildFollowUpRows({
    classification: 'price',
    confidence: 'medium',
    customer: { name: '홍길동' },
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
  assert.match(rows[0].follow_up_key, /^room-label:홍길동:홍길동:quote_send:/);
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
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, owner_review_required: true }, { autoSendEnabled: true }).allowed, false);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, reply_decision: { ...baseDecision.reply_decision, text: '네 대여 가능합니다.' } }, { autoSendEnabled: true }).allowed, false);
});

test('isAutoSendEligibleLiveJob allows unread same-day rows and blocks dated/backfill rows from auto-send', () => {
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: '중요 홍길동 네 감사합니다 오후 3:45',
    events: [{ reason: 'top_row_changed' }]
  }), {
    eligible: true,
    reason: 'top_row_live_time_format'
  });
  assert.equal(isAutoSendEligibleLiveJob({ preview_text: '중요 홍길동 네 감사합니다 오후 3:45', events: [{ reason: 'mutation' }] }).eligible, false);
  assert.equal(isAutoSendEligibleLiveJob({ payload: { previewText: '중요 홍길동 네 감사합니다 오후 3:45', events: [{ reason: 'top_row_changed' }] } }).eligible, true);
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: '중요 홍길동 3 네 감사합니다 오후 3:45',
    unread_count: 3,
    events: [{ reason: 'top_rows_backstop' }]
  }), {
    eligible: true,
    reason: 'top_row_unread'
  });
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: '중요 홍길동 네 감사합니다 오후 3:45',
    unread_count: null,
    events: [{ reason: 'top_rows_backstop', unreadCount: 3 }]
  }), {
    eligible: true,
    reason: 'top_row_unread'
  });
  assert.equal(isAutoSendEligibleLiveJob({
    preview_text: '중요 홍길동 3 네 감사합니다 5월 26일',
    unread_count: 3,
    events: [{ reason: 'top_rows_backstop' }]
  }).eligible, false);
  assert.equal(isAutoSendEligibleLiveJob({ preview_text: '중요 홍길동 네 감사합니다 오후 3:45', events: [{ reason: 'top_rows_backstop' }] }).eligible, false);
  assert.equal(isAutoSendEligibleLiveJob({ preview_text: '중요 한시우/60x 파손 video 5월 25일', events: [{ reason: 'top_row_changed' }] }).eligible, false);
  assert.equal(isAutoSendEligibleLiveJob({ preview_text: '중요 배성문 1월 15일 건은 4만원입니다. 오후 3:45', events: [{ reason: 'top_row_changed' }] }).eligible, false);
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

test('hasRecentSentAutoReply blocks duplicate sent replies only inside window', () => {
  const logPath = path.join(os.tmpdir(), `tmp-auto-replies-${Date.now()}.ndjson`);
  const now = new Date('2026-05-26T17:40:00.000Z');
  const key = '최재형|빌리지 위치가 어떻게 되나요?|동교로 23길 32';
  fs.writeFileSync(logPath, [
    JSON.stringify({ at: '2026-05-26T17:20:00.000Z', dedupeKey: key, result: { sent: true } }),
    JSON.stringify({ at: '2026-05-26T16:00:00.000Z', dedupeKey: 'other', result: { sent: true } })
  ].join('\n'));

  assert.equal(hasRecentSentAutoReply({ autoSendLogPath: logPath }, key, { now, windowMs: 30 * 60 * 1000 }), true);
  assert.equal(hasRecentSentAutoReply({ autoSendLogPath: logPath }, key, { now, windowMs: 5 * 60 * 1000 }), false);
  fs.unlinkSync(logPath);
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
  assert.deepEqual(mapDecisionToStatusPatch({ should_write_to_sheet: false, reason: '정보부족' }), {
    status: 'ai_skipped_needs_review',
    error_message: '정보부족'
  });
});
