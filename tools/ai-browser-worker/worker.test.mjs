import test from 'node:test';
import assert from 'node:assert/strict';
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
  buildKakaoTabAppleScript,
  ensureKakaoChannelManagerTab,
  pickKakaoMainListWindow,
  pickKakaoConversationWindow,
  findChatRowElementIndex,
  extractKakaoConversationEvidence,
  openKakaoTargetChatFromList,
  extractNavigationHints,
  buildCompactJobForPrompt,
  runHermes
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
  assert.ok(prompt.length < 12000, `prompt too large: ${prompt.length}`);
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
  assert.match(prompt, /자동답장 후보/s);
  assert.match(prompt, /suggested_reply_draft/s);
});

test('buildHermesPrompt prefers sheet writes for reservation-format requests', () => {
  const prompt = buildHermesPrompt({ id: 'job-3', preview_text: 'a7s3 2대 견적' });

  assert.match(prompt, /장비명은 세트마스터.*우선/s);
  assert.match(prompt, /정확 매칭이 안 되면.*고객.*써준 장비명.*그대로.*F열 item/s);
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

test('buildKakaoTabAppleScript focuses existing Kakao Channel Manager tabs or opens one', () => {
  const script = buildKakaoTabAppleScript();
  assert.match(script, /business\.kakao\.com/);
  assert.match(script, /center-pf\.kakao\.com/);
  assert.match(script, / - 빌리지 - 카카오비즈니스/);
  assert.match(script, /set URL of tab t of window w to targetUrl/);
  assert.match(script, /make new window with properties/);
  assert.match(script, /active tab index/);
  assert.match(script, /activate/);
  assert.match(script, /targetUrl/);
});

test('ensureKakaoChannelManagerTab invokes osascript with target chat URL', async () => {
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
    spawnImpl
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
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
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
  assert.equal(result.status, 'opened_target_chat');
  assert.equal(result.element_index, 171);
  assert.ok(calls.some((c) => c.args.includes('click')));
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
  }, { id: '11111111-1111-1111-1111-111111111111', room_key: 'room-label:홍길동' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'quote_send');
  assert.equal(rows[0].priority, 'high');
  assert.equal(rows[0].customer_name, '홍길동');
  assert.equal(rows[0].decision_classification, 'price');
  assert.deepEqual(rows[0].evidence, ['고객: 견적서 받을 수 있을까요?']);
  assert.match(rows[0].follow_up_key, /^11111111-1111-1111-1111-111111111111:0:/);
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
