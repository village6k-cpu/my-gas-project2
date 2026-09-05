import assert from 'node:assert/strict';
import test from 'node:test';

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

function reportItem(index = 0, overrides = {}) {
  const fixtures = [
    ['schedule', 'schedule_check', '스케줄 확인'],
    ['quote', 'quote_send', '견적서 발송'],
    ['settlement', 'tax_invoice', '세금계산서 발행'],
    ['customer', 'reply_needed', '고객 답변 필요'],
    ['operations', 'human_review', '기타 사람 확인']
  ];
  const [category, workType, workTypeLabel] = fixtures[index % fixtures.length];
  return {
    id: UUIDS[index],
    version: index + 1,
    category,
    workType,
    workTypeLabel,
    priority: index === 0 ? 'p0' : index === 1 ? 'urgent' : 'normal',
    state: 'open',
    title: `대표 업무 ${index + 1}`,
    summary: `직원이 정리한 내용 ${index + 1}`,
    recommendedAction: `헤이빌리에서 처리 ${index + 1}`,
    dueAt: null,
    snoozedUntil: null,
    firstOpenedAt: '2026-08-29T05:00:00.000Z',
    updatedAt: '2026-08-29T05:30:00.000Z',
    ...overrides
  };
}

function reportSummary(overrides = {}) {
  return {
    now: 5,
    snoozed: 0,
    completed: 9,
    p0: 1,
    byCategory: { schedule: 1, quote: 1, settlement: 1, customer: 1, operations: 1 },
    ...overrides
  };
}

function reportConfig(overrides = {}) {
  return {
    now: NOW,
    dashboardUrl: 'https://heybilli.example/follow-ups',
    summary: reportSummary(),
    ...overrides
  };
}

test('digest keeps only explicit semantic owner actions and never classifies customer text', () => {
  const selected = selectDigestItems([
    workItem({ id: UUIDS[0], work_type: 'schedule_register', title: '견적과 세금계산서도 언급된 일정 등록' }),
    workItem({ id: UUIDS[1], work_type: 'schedule_change' }),
    workItem({ id: UUIDS[2], work_type: 'human_review', title: '견적 세금계산서 스케줄' }),
    workItem({ id: UUIDS[3], work_type: 'completed_log' }),
    workItem({ id: UUIDS[4], work_type: 'automation_error_review' }),
    workItem({ id: UUIDS[5], payload: { requires_human_action: false } })
  ], NOW);

  assert.deepEqual(selected.map(({ id, workType }) => [id, workType]), [
    [UUIDS[0], 'schedule_register'],
    [UUIDS[1], 'schedule_change'],
    [UUIDS[2], 'human_review']
  ]);
});

test('section precedence and deterministic due-age-UUID ordering place every eligible row once', () => {
  const selected = selectDigestItems([
    workItem({ id: UUIDS[5], priority: 'normal', first_opened_at: NOW }),
    workItem({ id: UUIDS[4], priority: 'urgent', first_opened_at: NOW }),
    workItem({ id: UUIDS[3], consecutive_unhandled_digests: 2, first_opened_at: NOW }),
    workItem({ id: UUIDS[2], first_opened_at: '2026-08-28T05:59:59.999Z' }),
    workItem({ id: UUIDS[1], priority: 'p0', payload: { requires_human_action: true, p0_acknowledged_at: NOW } }),
    workItem({ id: UUIDS[0], priority: 'urgent', due_at: '2026-08-29T05:30:00.000Z', first_opened_at: NOW })
  ], NOW);

  assert.deepEqual(selected.map(({ id, section }) => [id, section]), [
    [UUIDS[1], 'p0'],
    [UUIDS[2], 'overdue'],
    [UUIDS[0], 'urgent'],
    [UUIDS[4], 'urgent'],
    [UUIDS[3], 'carry_over'],
    [UUIDS[5], 'actionable']
  ]);
  assert.equal(new Set(selected.map(({ id }) => id)).size, selected.length);
});

test('daily reminder selection boundaries remain deterministic for finalization metadata', () => {
  assert.equal(selectedItem({ first_opened_at: '2026-08-26T06:00:00.001Z' }).dailyReminderDue, false);
  assert.equal(selectedItem({ first_opened_at: '2026-08-26T06:00:00.000Z' }).dailyReminderDue, true);
  assert.equal(selectedItem({ next_reminder_at: '2026-08-29T06:00:00.001Z' }).dailyReminderDue, false);
  assert.equal(selectedItem({ next_reminder_at: NOW }).dailyReminderDue, true);
});

test('legacy selection snapshot stays an exact ordered content-free allowlist', () => {
  const selected = selectDigestItems([
    workItem({ id: UUIDS[0], priority: 'p0', payload: { requires_human_action: true, p0_acknowledged_at: NOW } }),
    workItem({ id: UUIDS[1], first_opened_at: '2026-08-20T00:00:00.000Z' })
  ], NOW);
  assert.deepEqual(buildDigestSnapshot(selected), [
    { id: UUIDS[0], version: 4, inclusionReason: 'p0', priority: 'p0' },
    { id: UUIDS[1], version: 4, inclusionReason: 'daily_reminder', priority: 'normal' }
  ]);
  assert.deepEqual(Object.keys(buildDigestSnapshot(selected)[0]), ['id', 'version', 'inclusionReason', 'priority']);
});

test('owner report renders one buttonless Slack summary with five highlights and exact counts', () => {
  const highlights = Array.from({ length: 5 }, (_, index) => reportItem(index));
  const summary = reportSummary({
    now: 123,
    snoozed: 4,
    p0: 2,
    byCategory: { schedule: 30, quote: 25, settlement: 24, customer: 23, operations: 25 }
  });
  const rendered = buildDigestSlackMessage(highlights, reportConfig({ summary }));

  assert.deepEqual({
    selectedCount: rendered.selectedCount,
    renderedCount: rendered.renderedCount,
    dailyReminderCount: rendered.dailyReminderCount,
    ordinaryCount: rendered.ordinaryParts.length,
    reminderCount: rendered.dailyReminderParts.length
  }, {
    selectedCount: 123,
    renderedCount: 5,
    dailyReminderCount: 0,
    ordinaryCount: 1,
    reminderCount: 0
  });
  assert.deepEqual(rendered.ordinaryParts[0].itemIds, highlights.map(({ id }) => id));
  assert.equal(rendered.ordinaryParts[0].kind, 'ordinary');
  assert.equal(rendered.ordinaryParts[0].blocks.length, 4);
  assert.deepEqual(rendered.ordinaryParts[0].blocks.map(({ type }) => type), ['header', 'section', 'section', 'context']);
  const serialized = JSON.stringify(rendered);
  for (const forbidden of ['"type":"actions"', '"type":"button"', 'action_id', 'village_work_v2_', 'automation_error_review', 'reservation_review_timeout']) {
    assert.equal(serialized.includes(forbidden), false, `report leaked ${forbidden}`);
  }
  assert.match(rendered.ordinaryParts[0].text, /오늘 처리할 일 요약/);
  assert.match(rendered.ordinaryParts[0].text, /나머지 118건/);
  assert.match(serialized, /예약·스케줄 30/);
  assert.match(serialized, /헤이빌리 후속조치에서 처리/);
});

test('zero current work returns the exact no-send result', () => {
  assert.deepEqual(buildDigestSlackMessage([], reportConfig({
    summary: reportSummary({
      now: 0, snoozed: 0, p0: 0,
      byCategory: { schedule: 0, quote: 0, settlement: 0, customer: 0, operations: 0 }
    })
  })), {
    selectedCount: 0,
    renderedCount: 0,
    dailyReminderCount: 0,
    ordinaryParts: [],
    dailyReminderParts: []
  });
});

test('report text is escaped, bounded, deterministic, and does not consult ambient Date.now', () => {
  const highlights = [
    reportItem(0, {
      title: '<@UATTACK> & *unsafe*',
      summary: 's'.repeat(2000),
      recommendedAction: 'a'.repeat(1200)
    })
  ];
  const summary = reportSummary({
    now: 1,
    snoozed: 0,
    p0: 1,
    byCategory: { schedule: 1, quote: 0, settlement: 0, customer: 0, operations: 0 }
  });
  const input = structuredClone(highlights);
  const originalNow = Date.now;
  Date.now = () => { throw new Error('ambient time used'); };
  try {
    const first = buildDigestSlackMessage(highlights, reportConfig({ summary }));
    const second = buildDigestSlackMessage(highlights, reportConfig({ summary }));
    assert.deepEqual(first, second);
    assert.deepEqual(highlights, input);
    const serialized = JSON.stringify(first);
    assert.equal(serialized.includes('<@UATTACK>'), false);
    assert.match(serialized, /&lt;@UATTACK&gt;/);
    assert.ok(first.ordinaryParts[0].blocks.every((block) => block.type !== 'section' || block.text.text.length <= 3000));
    assert.ok(first.ordinaryParts[0].text.length <= 4000);
  } finally {
    Date.now = originalNow;
  }
});

test('report and report snapshot reject malformed, duplicate, private, and inconsistent inputs generically', async (t) => {
  const valid = reportItem(0);
  const summary = reportSummary({
    now: 1,
    byCategory: { schedule: 1, quote: 0, settlement: 0, customer: 0, operations: 0 }
  });
  const invalidCases = [
    [[{ ...valid, id: 'PRIVATE invalid' }], reportConfig({ summary })],
    [[{ ...valid, privateTranscript: 'PRIVATE' }], reportConfig({ summary })],
    [[{ ...valid, workType: 'automation_error_review' }], reportConfig({ summary })],
    [[valid, structuredClone(valid)], reportConfig({ summary: reportSummary({ now: 2, byCategory: { schedule: 2, quote: 0, settlement: 0, customer: 0, operations: 0 } }) })],
    [[valid], reportConfig({ dashboardUrl: 'http://heybilli.example/follow-ups', summary })],
    [[valid], reportConfig({ summary: { ...summary, now: 2 } })],
    [[valid], reportConfig({ summary: { ...summary, extra: 1 } })]
  ];
  for (const [index, [items, config]] of invalidCases.entries()) {
    await t.test(String(index), () => assert.throws(
      () => buildDigestSlackMessage(items, config),
      /invalid digest (input|config)/
    ));
  }
  assert.throws(() => digestModule.buildReportDigestSnapshot([{ ...valid, extra: true }], NOW), {
    message: 'invalid digest input'
  });
});

test('report snapshot records only five displayed IDs with finalization-safe inclusion reasons', () => {
  const highlights = [
    reportItem(0),
    reportItem(1, { firstOpenedAt: '2026-08-20T00:00:00.000Z' }),
    reportItem(2, { priority: 'urgent', firstOpenedAt: NOW }),
    reportItem(3, { priority: 'normal', firstOpenedAt: NOW })
  ];
  assert.deepEqual(digestModule.buildReportDigestSnapshot(highlights, NOW), [
    { id: UUIDS[0], version: 1, inclusionReason: 'p0', priority: 'p0' },
    { id: UUIDS[1], version: 2, inclusionReason: 'overdue', priority: 'urgent' },
    { id: UUIDS[2], version: 3, inclusionReason: 'urgent', priority: 'urgent' },
    { id: UUIDS[3], version: 4, inclusionReason: 'actionable', priority: 'normal' }
  ]);
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
