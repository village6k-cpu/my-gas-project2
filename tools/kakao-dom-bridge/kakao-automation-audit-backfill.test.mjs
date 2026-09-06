import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  runKakaoAutomationAuditBackfill,
  scanKakaoAutomationAuditHistory,
} from '../../scripts/windows/backfill-kakao-automation-audit.mjs';

function replyJob({ jobId = 'job-history-1', roomRevision = 1, customerLabel = '테스트 고객', suffix = 'a' } = {}) {
  const text = '네, 가능합니다.';
  return {
    job_id: jobId,
    room_key: `room-${suffix}`,
    room_revision: roomRevision,
    event: { detected_at: '2026-09-06T00:00:00.000Z' },
    tool_operation: null,
    tool_receipts: [],
    local_context: { job: { customerName: customerLabel } },
    application: {
      state: 'finalized',
      applied_audit: {
        auto_reply_readback: {
          schema: 'kakao-auto-reply-readback/v1',
          receipt_id: `reply-readback-${suffix.repeat(64)}`,
          confirmed_at: '2026-09-06T00:01:00.000Z',
          text,
          text_sha256: createHash('sha256').update(text).digest('hex'),
          readback_confirmed: true,
          customer_label: customerLabel,
          source_message_at: '2026-09-06T00:00:00.000Z',
        },
      },
    },
  };
}

function confirmationJob() {
  const jobId = 'job-history-confirmation';
  const roomKey = 'room-history-confirmation';
  const leaseId = '11111111-1111-4111-8111-111111111111';
  const operationId = '22222222-2222-4222-8222-222222222222';
  const requestDigest = 'd'.repeat(64);
  const receipt = {
    schema: 'village-confirmation-receipt/v1',
    receipt_id: 'receipt-history-confirmation',
    status: 'ok',
    availability_report: [],
    authoritative_sheet_result: { success: true, reqID: 'RQ-260906-001', replacedReqIDs: [] },
    error: null,
    job_id: jobId,
    room_key: roomKey,
    room_revision: 2,
    lease_id: leaseId,
    request_digest: requestDigest,
    operation_id: operationId,
    created_at: '2026-09-06T01:00:01.000Z',
  };
  return {
    job_id: jobId,
    room_key: roomKey,
    room_revision: 2,
    event: { detected_at: '2026-09-06T01:00:00.000Z' },
    local_context: { job: { customerName: '테스트 고객' } },
    tool_operation: {
      schema: 'village-tool-operation-reservation/v1',
      tool: 'confirmation_request',
      job_id: jobId,
      room_key: roomKey,
      room_revision: 2,
      lease_id: leaseId,
      request_digest: requestDigest,
      operation_id: operationId,
      state: 'completed',
      receipt_id: receipt.receipt_id,
      created_at: '2026-09-06T01:00:00.500Z',
      completed_at: '2026-09-06T01:00:02.000Z',
    },
    tool_receipts: [receipt],
    application: null,
  };
}

async function queue() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kakao-audit-backfill-'));
  const directory = path.join(root, 'hermes-gateway');
  await mkdir(directory);
  return { root, directory };
}

async function jobFile(directory, hex, value) {
  await writeFile(path.join(directory, `${hex.repeat(64)}.json`), JSON.stringify(value), 'utf8');
}

test('history scan reads only hashed regular job files and extracts exact trusted effects', async () => {
  const { root, directory } = await queue();
  await jobFile(directory, 'a', replyJob());
  await jobFile(directory, 'b', confirmationJob());
  await jobFile(directory, 'c', { job_id: 'unprovable', room_revision: 1, tool_operation: null, tool_receipts: [] });
  await writeFile(path.join(directory, `${'d'.repeat(64)}.json`), '{bad json', 'utf8');
  await writeFile(path.join(directory, 'not-a-hash.json'), JSON.stringify(replyJob({ suffix: 'e' })), 'utf8');
  await mkdir(path.join(directory, `${'f'.repeat(64)}.json`));

  const result = await scanKakaoAutomationAuditHistory({ queueDir: root, maxFiles: 20, maxEvents: 20 });
  assert.deepEqual(result.summary, {
    scannedFiles: 4,
    provableFiles: 2,
    provableEvents: 2,
    skippedUnprovable: 1,
    skippedInvalid: 1,
    skippedDuplicate: 0,
    capped: false,
  });
  assert.equal(result.events.every((event) => event.historical_import === true), true);
  assert.deepEqual(result.events.map(({ effect_type }) => effect_type).sort(), ['auto_reply', 'confirmation_request']);
  assert.equal(JSON.stringify(result.events).includes('local_context'), false);
  assert.equal(JSON.stringify(result.events).includes('tool_receipts'), false);
});

test('history scan enforces deterministic file and event caps', async () => {
  const { root, directory } = await queue();
  await jobFile(directory, 'a', replyJob({ jobId: 'first', suffix: 'a' }));
  await jobFile(directory, 'b', replyJob({ jobId: 'second', suffix: 'b' }));
  const oneFile = await scanKakaoAutomationAuditHistory({ queueDir: root, maxFiles: 1, maxEvents: 10 });
  assert.equal(oneFile.summary.scannedFiles, 1);
  assert.equal(oneFile.summary.provableEvents, 1);
  assert.equal(oneFile.summary.capped, true);
  const oneEvent = await scanKakaoAutomationAuditHistory({ queueDir: root, maxFiles: 10, maxEvents: 1 });
  assert.equal(oneEvent.events.length, 1);
  assert.equal(oneEvent.summary.capped, true);
});

test('CLI defaults to aggregate-only dry-run and never initializes a writer', async () => {
  const { root, directory } = await queue();
  await jobFile(directory, 'a', replyJob());
  let stores = 0;
  const lines = [];
  const result = await runKakaoAutomationAuditBackfill({
    argv: ['--queue-dir', root, '--max-files', '5', '--max-events', '5'],
    env: {},
    stdout: (line) => lines.push(line),
    storeFactory: () => { stores += 1; throw new Error('must not initialize'); },
  });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.provableEvents, 1);
  assert.equal(stores, 0);
  assert.equal(lines.length, 1);
  const printed = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(printed).sort(), [
    'capped', 'inserted', 'mode', 'provableEvents', 'provableFiles', 'scannedFiles',
    'skippedDuplicate', 'skippedInvalid', 'skippedUnprovable',
  ].sort());
  assert.equal(JSON.stringify(printed).includes(root), false);
  assert.equal(JSON.stringify(printed).includes('테스트 고객'), false);
});

test('apply requires explicit service-role config and inserts bounded historical batches only', async () => {
  const { root, directory } = await queue();
  await jobFile(directory, 'a', replyJob());
  await assert.rejects(
    runKakaoAutomationAuditBackfill({ argv: ['--queue-dir', root, '--apply'], env: {}, stdout: () => {} }),
    /service role configuration is required/,
  );

  const batches = [];
  const result = await runKakaoAutomationAuditBackfill({
    argv: ['--queue-dir', root, '--apply', '--max-files', '5', '--max-events', '5'],
    env: { SUPABASE_URL: 'https://unit.test', SUPABASE_SERVICE_ROLE_KEY: 'service-role' },
    stdout: () => {},
    storeFactory: ({ supabaseUrl, serviceRoleKey }) => {
      assert.equal(supabaseUrl, 'https://unit.test');
      assert.equal(serviceRoleKey, 'service-role');
      return { async insertAndReadback(events) { batches.push(events); return { inserted: events.length, existing: 0, events }; } };
    },
  });
  assert.equal(result.mode, 'apply');
  assert.equal(result.inserted, 1);
  assert.equal(batches.length, 1);
  assert.equal(batches[0][0].historical_import, true);
});

test('backfill source has no business executor, messaging, browser, or worker dependency', async () => {
  const source = await readFile(path.resolve('scripts/windows/backfill-kakao-automation-audit.mjs'), 'utf8');
  for (const forbidden of [
    'worker.mjs', 'server.mjs', 'checkAvailability', 'sheetAPI', 'playwright', 'puppeteer',
    'sendKakao', 'sendSlack', 'appendToSheet', 'executeVillage', 'prepareKakao',
  ]) assert.equal(source.includes(forbidden), false, `unsafe backfill dependency: ${forbidden}`);
  assert.match(source, /lstat/);
  assert.match(source, /isSymbolicLink/);
  assert.match(source, /\^\[0-9a-f\]\{64\}\\\.json\$/);
});
