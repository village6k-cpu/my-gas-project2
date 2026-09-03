import assert from 'node:assert/strict';
import test from 'node:test';

import { decodeWorkActionValue } from './work-items.mjs';
import { decodeWorkActionContext } from './work-actions.mjs';

const digestModule = await import('./digests.mjs').catch(() => ({}));
const missing = (name) => () => assert.fail(`${name} is not implemented`);
const selectDigestItems = digestModule.selectDigestItems ?? missing('selectDigestItems');
const buildDigestSnapshot = digestModule.buildDigestSnapshot ?? missing('buildDigestSnapshot');
const buildDigestSlackMessage = digestModule.buildDigestSlackMessage ?? missing('buildDigestSlackMessage');
const nextDigestScheduledAt = digestModule.nextDigestScheduledAt ?? missing('nextDigestScheduledAt');

const NOW = '2026-08-29T06:00:00.000Z'; // 2026-08-29 15:00 KST
const UUIDS = Object.freeze([
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  '00000000-0000-4000-8000-000000000003',
  '00000000-0000-4000-8000-000000000004',
  '00000000-0000-4000-8000-000000000005',
  '00000000-0000-4000-8000-000000000006',
  '00000000-0000-4000-8000-000000000007',
  '00000000-0000-4000-8000-000000000008'
]);

function workItem(overrides = {}) {
  return {
    id: UUIDS[0],
    work_key: 'room:1:payment',
    room_key: 'room:1',
    title: 'Payment review',
    summary: 'Verify the typed payment outcome.',
    work_type: 'payment_check',
    priority: 'normal',
    state: 'open',
    owner_id: 'owner-primary',
    actionable_at: '2026-08-29T05:00:00.000Z',
    due_at: null,
    snoozed_until: null,
    first_opened_at: '2026-08-29T05:00:00.000Z',
    last_activity_at: '2026-08-29T05:30:00.000Z',
    digest_inclusion_count: 0,
    consecutive_unhandled_digests: 0,
    last_digest_at: null,
    next_reminder_at: null,
    version: 4,
    payload: {
      requires_human_action: true,
      recommended_action: '정산 원장을 확인하고 필요한 처리를 완료하세요.'
    },
    ...overrides
  };
}

function selectedItem(overrides = {}) {
  return selectDigestItems([workItem(overrides)], NOW)[0];
}

const renderConfig = Object.freeze({
  now: NOW,
  ownerSlackIds: Object.freeze({ 'owner-primary': 'UOWNER1' })
});

function itemSections(result) {
  return result.ordinaryParts.flatMap((part) => part.blocks.filter((block) => block.type === 'section'));
}

function actionBlocks(result) {
  return result.ordinaryParts.flatMap((part) => part.blocks.filter((block) => block.type === 'actions'));
}

function decodedActions(block) {
  return block.elements
    .map((element) => ({
      actionId: element.action_id,
      decoded: element.action_id === 'village_work_v2_snooze_custom'
        ? { ...decodeWorkActionContext(element.value), action: { type: 'snooze_custom' } }
        : decodeWorkActionValue(element.value)
    }));
}

test('digest module exports the four required pure interfaces', () => {
  assert.equal(typeof digestModule.selectDigestItems, 'function');
  assert.equal(typeof digestModule.buildDigestSnapshot, 'function');
  assert.equal(typeof digestModule.buildDigestSlackMessage, 'function');
  assert.equal(typeof digestModule.nextDigestScheduledAt, 'function');
});

test('snooze and actionable boundaries are inclusive only at their exact expiry', async (t) => {
  const cases = [
    {
      name: 'snoozed before expiry',
      item: workItem({
        state: 'snoozed',
        actionable_at: '2026-08-29T06:00:00.001Z',
        snoozed_until: '2026-08-29T06:00:00.001Z'
      }),
      expected: []
    },
    {
      name: 'snoozed at expiry',
      item: workItem({ state: 'snoozed', actionable_at: NOW, snoozed_until: NOW }),
      expected: [UUIDS[0]]
    },
    {
      name: 'open before actionable boundary',
      item: workItem({ actionable_at: '2026-08-29T06:00:00.001Z' }),
      expected: []
    },
    {
      name: 'open at actionable boundary',
      item: workItem({ actionable_at: NOW }),
      expected: [UUIDS[0]]
    }
  ];

  for (const fixture of cases) {
    await t.test(fixture.name, () => {
      assert.deepEqual(selectDigestItems([fixture.item], NOW).map(({ id }) => id), fixture.expected);
    });
  }
});

test('terminal and unacknowledged P0 rows are omitted while malformed active rows fail generically', () => {
  const acknowledged = workItem({
    id: UUIDS[3],
    priority: 'p0',
    payload: { requires_human_action: true, p0_acknowledged_at: '2026-08-29T05:59:59.000Z' }
  });
  const selected = selectDigestItems([
    workItem({ id: UUIDS[0], state: 'resolved' }),
    workItem({ id: UUIDS[1], state: 'dismissed' }),
    workItem({ id: UUIDS[2], priority: 'p0' }),
    workItem({ id: UUIDS[4], priority: 'p0', payload: { p0_acknowledged_at: 'not-a-time' } }),
    acknowledged
  ], NOW);

  assert.deepEqual(selected.map(({ id }) => id), [UUIDS[3]]);
  assert.throws(
    () => selectDigestItems([workItem({ id: 'PRIVATE invalid id', title: 'PRIVATE title' })], NOW),
    (error) => error.message === 'invalid digest input' && !error.message.includes('PRIVATE')
  );
});

test('P0 acknowledgement is canonical, present, and not later than the supplied selection clock', async (t) => {
  const cases = [
    ['missing payload', undefined, NOW, []],
    ['null payload', null, NOW, []],
    ['non-record payload', 'not-a-record', NOW, []],
    ['array payload', [], NOW, []],
    ['missing acknowledgement', { requires_human_action: true }, NOW, []],
    ['null acknowledgement', { p0_acknowledged_at: null }, NOW, []],
    ['array acknowledgement', { p0_acknowledged_at: [] }, NOW, []],
    ['malformed acknowledgement', { p0_acknowledged_at: 'not-a-time' }, NOW, []],
    ['impossible calendar date', { p0_acknowledged_at: '2026-02-30T00:00:00.000Z' }, NOW, []],
    ['year zero', { p0_acknowledged_at: '0000-01-01T00:00:00.000Z' }, NOW, []],
    ['negative extended year', { p0_acknowledged_at: '-000001-01-01T00:00:00.000Z' }, NOW, []],
    ['positive extended year', { p0_acknowledged_at: '+010000-01-01T00:00:00.000Z' }, '+010001-01-01T00:00:00.000Z', []],
    ['minimum supported year', { p0_acknowledged_at: '0001-01-01T00:00:00.000Z' }, NOW, [UUIDS[0]]],
    ['normal past acknowledgement', { p0_acknowledged_at: '2026-08-29T05:59:59.999Z' }, NOW, [UUIDS[0]]],
    ['normal boundary acknowledgement', { p0_acknowledged_at: NOW }, NOW, [UUIDS[0]]],
    ['normal future acknowledgement', { p0_acknowledged_at: '2026-08-29T06:00:00.001Z' }, NOW, []],
    ['maximum supported year', { p0_acknowledged_at: '9999-12-31T23:59:59.999Z' }, '9999-12-31T23:59:59.999Z', [UUIDS[0]]]
  ];

  for (const [name, payload, cutoff, expectedIds] of cases) {
    await t.test(name, () => {
      const ownerPayload = payload !== null && typeof payload === 'object' && !Array.isArray(payload)
        ? {
            requires_human_action: true,
            recommended_action: '즉시 확인하세요.',
            ...payload
          }
        : payload;
      const selected = selectDigestItems([workItem({ priority: 'p0', payload: ownerPayload })], cutoff);
      assert.deepEqual(selected.map(({ id }) => id), expectedIds);
    });
  }
});

test('selection returns the exact render allowlist and no caller object aliases', () => {
  const input = workItem({
    customer_name: 'PRIVATE CUSTOMER',
    source_event_keys: ['PRIVATE EVENT'],
    payload: {
      requires_human_action: true,
      recommended_action: '정산 원장을 확인하고 필요한 처리를 완료하세요.',
      secret: 'PRIVATE SECRET'
    }
  });
  const before = structuredClone(input);

  const selected = selectDigestItems([input], NOW);

  assert.deepEqual(input, before);
  assert.deepEqual(selected, [{
    id: UUIDS[0],
    version: 4,
    title: 'Payment review',
    summary: 'Verify the typed payment outcome.',
    workType: 'payment_check',
    recommendedAction: '정산 원장을 확인하고 필요한 처리를 완료하세요.',
    ownerId: 'owner-primary',
    roomKey: 'room:1',
    priority: 'normal',
    dueAt: null,
    firstOpenedAt: '2026-08-29T05:00:00.000Z',
    section: 'actionable',
    inclusionReason: 'actionable',
    ownerMentionRequired: false,
    dailyReminderDue: false
  }]);
  assert.doesNotMatch(JSON.stringify(selected), /PRIVATE|work_key|payload|customer/i);
});

test('digest keeps only explicit semantic owner actions and renders an employee handoff', () => {
  const selected = selectDigestItems([
    workItem({
      id: UUIDS[0],
      title: '견적 발송',
      summary: '고객이 최종 견적서를 요청했고 자동 발송 조건은 충족되지 않았습니다.',
      work_type: 'quote_send',
      payload: {
        requires_human_action: true,
        recommended_action: '확정 견적서를 검토한 뒤 고객에게 발송하세요.'
      }
    }),
    workItem({
      id: UUIDS[1],
      work_type: 'automation_error_review',
      summary: 'worker timeout database transport error',
      payload: { requires_human_action: true, recommended_action: '로그를 확인하세요.' }
    }),
    workItem({
      id: UUIDS[2],
      work_type: 'reservation_review_timeout',
      summary: 'automation timeout',
      payload: { requires_human_action: true, recommended_action: '재시도하세요.' }
    }),
    workItem({
      id: UUIDS[3],
      work_type: 'payment_check',
      payload: { requires_human_action: false, recommended_action: '처리하지 않음' }
    }),
    workItem({
      id: UUIDS[4],
      work_type: 'schedule_check',
      payload: { recommended_action: '명시되지 않은 작업' }
    })
  ], NOW);

  assert.deepEqual(selected.map(({ id, workType, recommendedAction }) => ({ id, workType, recommendedAction })), [{
    id: UUIDS[0],
    workType: 'quote_send',
    recommendedAction: '확정 견적서를 검토한 뒤 고객에게 발송하세요.'
  }]);

  const rendered = buildDigestSlackMessage(selected, renderConfig);
  const text = itemSections(rendered)[0].text.text;
  assert.match(text, /직원이 정리한 내용: 고객이 최종 견적서를 요청/);
  assert.match(text, /대표님이 할 일: 확정 견적서를 검토한 뒤 고객에게 발송하세요/);
  assert.doesNotMatch(text, /automation|error|timeout|worker|database/i);
});

test('renderer rejects operational work even if a caller forges the selected shape', () => {
  const selected = selectedItem();
  assert.throws(
    () => buildDigestSlackMessage([{ ...selected, workType: 'automation_error_review' }], renderConfig),
    { message: 'invalid digest input' }
  );
});

test('section precedence and deterministic due-age-UUID ordering place every eligible row exactly once', () => {
  const rows = [
    workItem({ id: UUIDS[7], first_opened_at: '2026-08-29T05:30:00.000Z' }),
    workItem({ id: UUIDS[6], consecutive_unhandled_digests: 2, first_opened_at: '2026-08-29T05:00:00.000Z' }),
    workItem({ id: UUIDS[5], priority: 'urgent', first_opened_at: '2026-08-29T05:00:00.000Z' }),
    workItem({ id: UUIDS[4], first_opened_at: '2026-08-28T06:00:00.000Z' }),
    workItem({
      id: UUIDS[3], priority: 'p0',
      payload: { requires_human_action: true, p0_acknowledged_at: '2026-08-29T05:00:00.000Z' }
    }),
    workItem({ id: UUIDS[2], due_at: '2026-08-30T01:00:00.000Z', first_opened_at: '2026-08-29T04:00:00.000Z' }),
    workItem({ id: UUIDS[1], due_at: '2026-08-29T23:00:00.000Z', first_opened_at: '2026-08-29T05:30:00.000Z' }),
    workItem({ id: UUIDS[0], due_at: '2026-08-29T23:00:00.000Z', first_opened_at: '2026-08-29T05:30:00.000Z' })
  ];

  const selected = selectDigestItems(rows, NOW);

  assert.deepEqual(selected.map(({ id, section }) => [id, section]), [
    [UUIDS[3], 'p0'],
    [UUIDS[4], 'overdue'],
    [UUIDS[5], 'urgent'],
    [UUIDS[6], 'carry_over'],
    [UUIDS[0], 'actionable'],
    [UUIDS[1], 'actionable'],
    [UUIDS[2], 'actionable'],
    [UUIDS[7], 'actionable']
  ]);
  assert.equal(new Set(selected.map(({ id }) => id)).size, rows.length);
});

test('overdue and carry-over boundaries are exact and owner mention survives higher section precedence', () => {
  const selected = selectDigestItems([
    workItem({ id: UUIDS[0], first_opened_at: '2026-08-28T06:00:00.001Z' }),
    workItem({ id: UUIDS[1], first_opened_at: '2026-08-28T06:00:00.000Z' }),
    workItem({ id: UUIDS[2], priority: 'urgent', consecutive_unhandled_digests: 1 }),
    workItem({ id: UUIDS[3], priority: 'urgent', consecutive_unhandled_digests: 2 })
  ], NOW);

  const byId = Object.fromEntries(selected.map((item) => [item.id, item]));
  assert.equal(byId[UUIDS[0]].section, 'actionable');
  assert.equal(byId[UUIDS[1]].section, 'overdue');
  assert.equal(byId[UUIDS[2]].ownerMentionRequired, false);
  assert.equal(byId[UUIDS[3]].section, 'urgent');
  assert.equal(byId[UUIDS[3]].ownerMentionRequired, true);
});

test('daily reminders become due at the first 72h and configured next-reminder boundaries', async (t) => {
  const cases = [
    ['first reminder one millisecond early', { first_opened_at: '2026-08-26T06:00:00.001Z' }, false],
    ['first reminder at 72h', { first_opened_at: '2026-08-26T06:00:00.000Z' }, true],
    ['next reminder one millisecond early', {
      first_opened_at: '2026-08-29T05:00:00.000Z', next_reminder_at: '2026-08-29T06:00:00.001Z'
    }, false],
    ['next reminder at boundary', {
      first_opened_at: '2026-08-29T05:00:00.000Z', next_reminder_at: NOW
    }, true]
  ];

  for (const [name, overrides, due] of cases) {
    await t.test(name, () => {
      const selected = selectedItem(overrides);
      assert.equal(selected.dailyReminderDue, due);
      assert.equal(selected.inclusionReason, due ? 'daily_reminder' : selected.section);
    });
  }
});

test('snapshot is an exact ordered content-free allowlist with daily reminder precedence', () => {
  const selected = selectDigestItems([
    workItem({ id: UUIDS[0], first_opened_at: '2026-08-26T06:00:00.000Z' }),
    workItem({ id: UUIDS[1], priority: 'urgent', first_opened_at: '2026-08-29T05:00:00.000Z' })
  ], NOW);

  const snapshot = buildDigestSnapshot(selected);

  assert.deepEqual(snapshot, [
    { id: UUIDS[0], version: 4, inclusionReason: 'daily_reminder', priority: 'normal' },
    { id: UUIDS[1], version: 4, inclusionReason: 'urgent', priority: 'urgent' }
  ]);
  assert.deepEqual(snapshot.map((entry) => Object.keys(entry)), [
    ['id', 'version', 'inclusionReason', 'priority'],
    ['id', 'version', 'inclusionReason', 'priority']
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /title|summary|owner|room|customer|slack|Payment/i);
  assert.throws(() => buildDigestSlackMessage(snapshot, renderConfig), /invalid digest input/);
});

test('duplicate selected IDs fail closed for snapshots and rendering', () => {
  const selected = selectedItem();
  const duplicate = [{ ...selected }, { ...selected }];

  assert.throws(() => buildDigestSnapshot(duplicate), { message: 'invalid digest input' });
  assert.throws(() => buildDigestSlackMessage(duplicate, renderConfig), { message: 'invalid digest input' });
});

test('an empty selection has the exact no-send structured result shape', () => {
  assert.deepEqual(buildDigestSlackMessage([], renderConfig), {
    selectedCount: 0,
    renderedCount: 0,
    dailyReminderCount: 0,
    ordinaryParts: [],
    dailyReminderParts: []
  });
});

test('ordinary actions reuse the versioned codec without inventing a newer version', () => {
  const selected = [selectedItem({
    priority: 'p0', version: 17,
    payload: { requires_human_action: true, p0_acknowledged_at: '2026-08-29T05:00:00.000Z' }
  })];

  const result = buildDigestSlackMessage(selected, renderConfig);
  const actions = decodedActions(actionBlocks(result)[0]);

  assert.deepEqual(actions.map(({ actionId }) => actionId), [
    'village_work_v2_progress',
    'village_work_v2_snooze_3h',
    'village_work_v2_snooze_evening',
    'village_work_v2_snooze_tomorrow',
    'village_work_v2_snooze_custom',
    'village_work_v2_request_resolve',
    'village_work_v2_dismiss'
  ]);
  assert.deepEqual(actions.map(({ decoded }) => decoded.id), Array(actions.length).fill(UUIDS[0]));
  assert.deepEqual(actions.map(({ decoded }) => decoded.version), Array(actions.length).fill(17));
  assert.deepEqual(actions.map(({ decoded }) => decoded.action.type), [
    'progress', 'snooze', 'snooze', 'snooze', 'snooze_custom', 'request_resolve', 'dismiss'
  ]);
  assert.deepEqual(actions.filter(({ decoded }) => decoded.action.type === 'snooze').map(({ decoded }) => decoded.action.snoozedUntil), [
    '2026-08-29T09:00:00.000Z',
    '2026-08-29T09:00:00.000Z',
    '2026-08-30T00:00:00.000Z'
  ]);
  for (const block of actionBlocks(result)) {
    assert.ok(block.elements.length <= 25);
    const actionIds = block.elements.map(({ action_id: actionId }) => actionId);
    assert.equal(new Set(actionIds).size, actionIds.length);
    for (const element of block.elements) {
      assert.equal(element.type, 'button');
      assert.ok(element.action_id.length >= 1 && element.action_id.length <= 255);
      assert.ok(element.text.text.length <= 75);
      assert.ok(element.value.length <= 1000);
    }
  }
});

test('ordinary digest actions never render acknowledgement, including for an acknowledged P0', () => {
  const selected = selectDigestItems([
    workItem({ id: UUIDS[0] }),
    workItem({
      id: UUIDS[1],
      priority: 'p0',
      payload: {
        requires_human_action: true,
        recommended_action: '즉시 확인하세요.',
        p0_acknowledged_at: NOW
      }
    })
  ], NOW);
  const result = buildDigestSlackMessage(selected, renderConfig);

  for (const block of actionBlocks(result)) {
    assert.equal(decodedActions(block).some(({ decoded }) => decoded.action.type === 'ack_p0'), false);
  }
});

test('today-evening snooze is offered only while the current KST 18:00 boundary is future', async (t) => {
  const cases = [
    ['before', '2026-08-29T08:59:59.999Z', true, '2026-08-29T09:00:00.000Z'],
    ['at', '2026-08-29T09:00:00.000Z', false, null],
    ['after', '2026-08-29T09:00:00.001Z', false, null]
  ];

  for (const [name, now, expectsEvening, expectedUntil] of cases) {
    await t.test(name, () => {
      const rendered = buildDigestSlackMessage([selectedItem()], { ...renderConfig, now });
      const actions = decodedActions(actionBlocks(rendered)[0]);
      const evening = actions.find(({ actionId }) => actionId === 'village_work_v2_snooze_evening');

      assert.equal(Boolean(evening), expectsEvening);
      if (evening) assert.equal(evening.decoded.action.snoozedUntil, expectedUntil);
      assert.ok(actions.some(({ actionId }) => actionId === 'village_work_v2_snooze_3h'));
      assert.ok(actions.some(({ actionId }) => actionId === 'village_work_v2_snooze_tomorrow'));
    });
  }
});

test('carry-over renders only validated owner mentions and otherwise uses a neutral unassigned marker', () => {
  const selected = selectDigestItems([
    workItem({ id: UUIDS[0], consecutive_unhandled_digests: 2, owner_id: 'owner-primary' }),
    workItem({ id: UUIDS[1], consecutive_unhandled_digests: 2, owner_id: null }),
    workItem({ id: UUIDS[2], consecutive_unhandled_digests: 2, owner_id: '<!channel><@UINJECT>' }),
    workItem({ id: UUIDS[3], consecutive_unhandled_digests: 2, owner_id: 'WROWOWNER' })
  ], NOW);

  const rendered = buildDigestSlackMessage(selected, {
    now: NOW,
    ownerSlackIds: {
      'owner-primary': 'UOWNER1',
      '<!channel><@UINJECT>': 'not-a-slack-id'
    }
  });
  const texts = itemSections(rendered).map((block) => block.text.text);

  assert.ok(texts[0].includes('<@UOWNER1>'));
  assert.ok(texts[1].includes('_담당자 미지정_'));
  assert.ok(texts[2].includes('_담당자 미지정_'));
  assert.ok(texts[3].includes('<@WROWOWNER>'));
  assert.equal(texts.join('\n').includes('<!channel>'), false);
  assert.equal(texts.join('\n').includes('<@UINJECT>'), false);
});

test('untrusted text is escaped, mention injection is neutralized, and Slack fields stay bounded', () => {
  const selected = [selectedItem({
    title: '<!channel> <@UINJECT> & *bold* _under_ ~gone~ `code` ' + 'T'.repeat(220),
    summary: '<https://evil.example|click> & ' + 'S'.repeat(1900),
    room_key: '<!here>'
  })];

  const result = buildDigestSlackMessage(selected, renderConfig);
  const json = JSON.stringify(result);
  const block = itemSections(result)[0];
  const content = block.text.text;

  assert.equal(json.includes('<!channel>'), false);
  assert.equal(json.includes('<@UINJECT>'), false);
  assert.equal(json.includes('<https://evil.example'), false);
  assert.equal(json.includes('*bold*'), false);
  assert.equal(json.includes('_under_'), false);
  assert.equal(json.includes('~gone~'), false);
  assert.equal(json.includes('`code`'), false);
  assert.ok(content.includes('&lt;!channel&gt;'));
  assert.ok(content.includes('&lt;@UINJECT&gt;'));
  assert.ok(content.length <= 3000);
  assert.ok(result.ordinaryParts[0].text.length <= 4000);
  assert.ok(result.ordinaryParts[0].blocks.length <= 50);
  assert.ok(result.ordinaryParts[0].blocks[0].text.text.length <= 150);
  assert.deepEqual(new Set(result.ordinaryParts[0].blocks.map(({ type }) => type)),
    new Set(['header', 'section', 'actions']));
});

test('worst-case bounded text truncates per field with ellipses while preserving room and due metadata', () => {
  const selected = [selectedItem({
    title: '<&>'.repeat(100),
    summary: '&'.repeat(2000),
    room_key: '<'.repeat(500),
    due_at: '2026-08-30T09:00:00.000Z',
    first_opened_at: '2026-08-26T06:00:00.000Z',
    consecutive_unhandled_digests: 2
  })];

  const result = buildDigestSlackMessage(selected, renderConfig);
  const texts = [
    result.ordinaryParts[0].blocks.find(({ type }) => type === 'section').text.text,
    result.dailyReminderParts[0].blocks.find(({ type }) => type === 'section').text.text
  ];

  for (const text of texts) {
    assert.ok(text.length <= 3000);
    assert.ok((text.match(/…/g) || []).length >= 3);
    assert.ok(text.includes('<@UOWNER1>'));
    assert.ok(text.includes('\n방 &lt;&lt;'));
    assert.ok(text.includes(' · 기한 2026-08-30T09:00:00.000Z'));
    assert.doesNotMatch(text, /&(?!amp;|lt;|gt;)/);
    assert.doesNotMatch(text, /&(?:a|am|l|g|gt|lt)…/);
  }
});

test('24/25 ordinary pagination preserves valid Block Kit limits and never truncates', async (t) => {
  for (const count of [24, 25]) {
    await t.test(String(count), () => {
      const rows = Array.from({ length: count }, (_, index) => workItem({
        id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        title: `Work ${index + 1}`
      }));
      const selected = selectDigestItems(rows, NOW);
      const rendered = buildDigestSlackMessage(selected, renderConfig);
      const ids = rendered.ordinaryParts.flatMap((part) => part.itemIds);

      assert.equal(rendered.selectedCount, count);
      assert.equal(rendered.renderedCount, count);
      assert.equal(rendered.dailyReminderCount, 0);
      assert.equal(rendered.ordinaryParts.length, count === 24 ? 1 : 2);
      assert.deepEqual(rendered.ordinaryParts.map(({ partNumber, partCount }) => [partNumber, partCount]),
        count === 24 ? [[1, 1]] : [[1, 2], [2, 2]]);
      assert.equal(ids.length, count);
      assert.equal(new Set(ids).size, count);
      assert.deepEqual(ids, selected.map(({ id }) => id));
      for (const part of rendered.ordinaryParts) {
        assert.deepEqual(Object.keys(part), ['kind', 'partNumber', 'partCount', 'itemIds', 'text', 'blocks']);
        assert.ok(part.itemIds.length <= 24);
        assert.ok(part.blocks.length <= 50);
        assert.equal(part.blocks.length, 1 + (2 * part.itemIds.length));
        assert.equal(part.blocks.filter(({ type }) => type === 'section').length, part.itemIds.length);
        assert.equal(part.blocks.filter(({ type }) => type === 'actions').length, part.itemIds.length);
        for (const block of part.blocks.filter(({ type }) => type === 'actions')) {
          const actionIds = block.elements.map(({ action_id: actionId }) => actionId);
          assert.equal(new Set(actionIds).size, actionIds.length);
          assert.ok(actionIds.every((actionId) => actionId.length >= 1 && actionId.length <= 255));
        }
      }
    });
  }
});

test('daily reminders are separate, paginated, and contain each due selected row at most once', () => {
  const rows = Array.from({ length: 25 }, (_, index) => workItem({
    id: `20000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    title: `Reminder ${index + 1}`,
    first_opened_at: '2026-08-26T06:00:00.000Z'
  }));
  const selected = selectDigestItems(rows, NOW);

  const rendered = buildDigestSlackMessage(selected, renderConfig);
  const reminderIds = rendered.dailyReminderParts.flatMap((part) => part.itemIds);

  assert.equal(rendered.selectedCount, 25);
  assert.equal(rendered.renderedCount, 25);
  assert.equal(rendered.dailyReminderCount, 25);
  assert.equal(rendered.ordinaryParts.length, 2);
  assert.equal(rendered.dailyReminderParts.length, 2);
  assert.equal(reminderIds.length, 25);
  assert.equal(new Set(reminderIds).size, 25);
  assert.deepEqual(reminderIds, selected.map(({ id }) => id));
});

test('selection and rendering are deterministic and do not mutate caller inputs or consult ambient Date.now', () => {
  const rows = [workItem(), workItem({ id: UUIDS[1], priority: 'urgent' })];
  const originalRows = structuredClone(rows);
  const originalNow = Date.now;
  Date.now = () => { throw new Error('ambient clock used'); };
  try {
    const firstSelected = selectDigestItems(rows, NOW);
    const firstSelectedBeforeRender = structuredClone(firstSelected);
    const firstRendered = buildDigestSlackMessage(firstSelected, renderConfig);
    const secondSelected = selectDigestItems(rows, NOW);
    const secondRendered = buildDigestSlackMessage(secondSelected, renderConfig);

    assert.deepEqual(secondSelected, firstSelected);
    assert.deepEqual(secondRendered, firstRendered);
    assert.deepEqual(rows, originalRows);
    assert.deepEqual(firstSelected, firstSelectedBeforeRender);
  } finally {
    Date.now = originalNow;
  }
});

test('malformed active rows and selected entries are rejected with generic errors', async (t) => {
  const invalidRows = [
    workItem({ version: 0 }),
    workItem({ priority: 'customer_urgent' }),
    workItem({ title: '' }),
    workItem({ summary: 'S'.repeat(2001) }),
    workItem({ owner_id: 'O'.repeat(201) }),
    workItem({ actionable_at: '2026-08-29 06:00:00Z' }),
    workItem({ first_opened_at: 'not-a-time' }),
    workItem({ due_at: '2099-01-01' }),
    workItem({ next_reminder_at: 'not-a-time' }),
    workItem({ state: 'snoozed', snoozed_until: null })
  ];
  for (const [index, row] of invalidRows.entries()) {
    await t.test(String(index), () => {
      assert.throws(() => selectDigestItems([row], NOW), { message: 'invalid digest input' });
    });
  }

  assert.throws(
    () => buildDigestSlackMessage([{ ...selectedItem(), title: undefined }], renderConfig),
    { message: 'invalid digest input' }
  );
  assert.throws(
    () => buildDigestSlackMessage([selectedItem()], { now: 'not-a-time' }),
    { message: 'invalid digest config' }
  );
  assert.throws(
    () => buildDigestSlackMessage([selectedItem()], { now: '+275760-09-13T00:00:00.000Z' }),
    { message: 'invalid digest config' }
  );
});

test('next scheduled time adds the exact validated interval to a canonical prior boundary', () => {
  assert.equal(nextDigestScheduledAt('2026-08-29T06:00:00.000Z', 180), '2026-08-29T09:00:00.000Z');
  assert.equal(nextDigestScheduledAt('2026-12-31T23:59:00.000Z', 1), '2027-01-01T00:00:00.000Z');
});

test('schedule calculation rejects noncanonical or non-finite boundaries and unbounded intervals', async (t) => {
  const invalid = [
    ['2026-08-29 06:00:00Z', 180],
    ['not-a-time', 180],
    ['+275760-09-13T00:00:00.000Z', 1],
    [NOW, 0],
    [NOW, -1],
    [NOW, 1.5],
    [NOW, Number.POSITIVE_INFINITY],
    [NOW, 10_081]
  ];
  for (const [value, interval] of invalid) {
    await t.test(`${value}/${interval}`, () => {
      assert.throws(() => nextDigestScheduledAt(value, interval), { message: 'invalid digest schedule' });
    });
  }
});
