'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeConfirmedReservationCommit } = require('../scripts/windows/village-confirm-request.js');

async function fixture(memo = '010-0000-0002') {
  const { createImmutableKakaoRoomSnapshot } = await import('../tools/ai-browser-worker/worker.mjs');
  const snapshot = createImmutableKakaoRoomSnapshot({
    job: { jobId: 'memo-contact', roomKey: 'chat:memo-contact', roomRevision: 7 },
    navigationContext: { conversation_evidence: {
      title: '김지윤', hint_matched: true, room_memo: memo,
      visible_static_text_tail: '김지윤: 카메라 예약 부탁드립니다. 직원: 네 잡아드리겠습니다.',
      messages: [
        { message_id: 'customer', role: 'customer', text: '김지윤: 카메라 예약 부탁드립니다.' },
        { message_id: 'staff', role: 'staff', text: '네 잡아드리겠습니다.' }
      ]
    } }
  });
  const source = {
    customer_request: snapshot.navigation.conversation_evidence.messages[0].text,
    staff_confirmation: snapshot.navigation.conversation_evidence.messages[1].text,
    conversation_revision: 7, conversation_evidence_hash: snapshot.evidenceHash,
    customer_message_ids: ['customer'], staff_message_ids: ['staff'], room_memo: memo
  };
  const registration = {
    confirmed: true, target_scope: 'pending_request', request_id: 'RQ-260913-001',
    source_evidence: source, expected_before: [{ name: '카메라', quantity: 1 }],
    desired_after: [{ name: '카메라', quantity: 1 }], expected_set_components: [], set_component_selections: [],
    expected_period: { start_date: '2026-09-15', start_time: '20:00', end_date: '2026-09-16', end_time: '20:00' },
    desired_period: { start_date: '2026-09-15', start_time: '20:00', end_date: '2026-09-16', end_time: '20:00' },
    customer_identity_update: { expected_name: '김지윤', expected_phone: '', name: '김지윤', phone: '010-0000-0002' }
  };
  return { snapshot, source, registration };
}

test('the immutable room snapshot binds the separate memo without making it a message', async () => {
  const a = await fixture(), b = await fixture('010-0000-0003');
  assert.equal(a.snapshot.navigation.conversation_evidence.room_memo, '010-0000-0002');
  assert.equal(a.snapshot.navigation.conversation_evidence.messages.length, 2);
  assert.notEqual(a.snapshot.evidenceHash, b.snapshot.evidenceHash);
});

test('same-room memo contact survives registration validation, runner and GAS normalization', async () => {
  const { snapshot, registration } = await fixture();
  const { validateStaffConfirmedRegistration } = await import('../tools/ai-browser-worker/staff-confirmed-registration.mjs');
  assert.deepEqual(validateStaffConfirmedRegistration(registration, { roomRevision: 7, roomSnapshot: snapshot }), { valid: true, errors: [] });
  const normalized = normalizeConfirmedReservationCommit(registration);
  const gas = { console };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../checkAvailability.js'), 'utf8'), gas);
  const result = gas._normalizeConfirmedReservationCommit_(normalized);
  assert.equal(result.source_evidence.room_memo, '010-0000-0002');
  assert.equal(result.customer_identity_update.phone, '010-0000-0002');
});

test('a memo cannot change an existing different phone, substitute for approval, or escape snapshot binding', async () => {
  const { snapshot, registration } = await fixture();
  const { validateStaffConfirmedRegistration } = await import('../tools/ai-browser-worker/staff-confirmed-registration.mjs');
  for (const change of [
    r => { r.source_evidence.room_memo = '010-0000-9999'; r.customer_identity_update.phone = '010-0000-9999'; },
    r => { r.customer_identity_update.expected_phone = '010-0000-9999'; },
    r => { r.source_evidence.staff_message_ids = ['customer']; },
    r => { r.source_evidence.customer_request += '\n010-0000-0002'; }
  ]) {
    const changed = structuredClone(registration); change(changed);
    assert.equal(validateStaffConfirmedRegistration(changed, { roomRevision: 7, roomSnapshot: snapshot }).valid, false);
  }
  const changedSnapshot = structuredClone(snapshot);
  changedSnapshot.navigation.conversation_evidence.room_memo = '010-0000-9999';
  assert.equal(validateStaffConfirmedRegistration(registration, { roomRevision: 7, roomSnapshot: changedSnapshot }).valid, false);
});

test('pending inquiry contact completion uses the same bound memo evidence', async () => {
  const { snapshot, source, registration } = await fixture();
  const { validatePendingInquiryRevision } = await import('../tools/ai-browser-worker/inquiry-lifecycle.mjs');
  const { staff_confirmation, staff_message_ids, ...inquirySource } = source;
  const decision = {
    should_write_to_sheet: true, existing_confirm_request_ids: [registration.request_id],
    reservation_inquiry: { already_registered: false },
    sheet_row_candidate: { equipment_write_mode: 'replace_full_plan', customer_name: '김지윤', phone: '010-0000-0002' },
    customer_requested_pending_revision: {
      target_scope: 'pending_request', request_id: registration.request_id,
      source_evidence: inquirySource, expected_before: registration.expected_before,
      expected_period: registration.expected_period, expected_set_components: [],
      customer_identity_update: registration.customer_identity_update
    }
  };
  assert.deepEqual(validatePendingInquiryRevision(decision, { roomRevision: 7, roomSnapshot: snapshot }), []);
});
