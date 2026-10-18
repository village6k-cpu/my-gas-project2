import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHermesGatewayChannel } from './hermes-gateway-channel.mjs';

test('failed capture survives repeated sweeps and resumes exactly once without a new customer message', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'village-capture-lifecycle-'));
  const job = { jobId: 'dom-lifecycle', eventHash: 'dom-lifecycle', roomKey: 'chat:lifecycle', roomRevision: 1,
    detectedAt: '2026-10-18T00:00:00.000Z', previewText: '예약 확정했습니다', events: [] };
  let row = { id: 'source-row', event_hash: job.jobId, room_key: job.roomKey, status: 'ready_for_ai_worker',
    created_at: '2026-08-01T00:00:00.000Z', updated_at: new Date().toISOString(), payload: job };
  const queries = [];
  let loseClaim = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); queries.push({ method: req.method, query: url.searchParams });
    let result = [];
    if (req.method === 'PATCH') {
      let body = ''; for await (const chunk of req) body += chunk;
      const patch = JSON.parse(body);
      const matches = ['id', 'status', 'updated_at'].every(key => !url.searchParams.has(key) || url.searchParams.get(key) === `eq.${row[key]}`);
      if (matches && !(loseClaim && patch.claimed_at)) { row = { ...row, ...patch, updated_at: new Date().toISOString() }; result = [row]; }
    } else if (req.method === 'GET') {
      const statuses = (url.searchParams.get('status') || '').slice(4, -1).split(',');
      const pending = !url.searchParams.has('payload->capture_retry->>state') || row.payload.capture_retry?.state === 'pending';
      const cutoff = url.searchParams.get('created_at');
      if (statuses.includes(row.status) && pending && (!cutoff || Date.parse(row.created_at) >= Date.parse(cutoff.slice(4)))) result = [row];
    }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  Object.assign(process.env, { KAKAO_DOM_BRIDGE_NO_LISTEN: '1', KAKAO_HERMES_TRANSPORT: 'gateway',
    KAKAO_HERMES_BRIDGE_TOKEN: 'test-only-token', QUEUE_DIR: directory, SUPABASE_TABLE: 'ai_processing_events',
    SUPABASE_URL: `http://127.0.0.1:${server.address().port}`, SUPABASE_SERVICE_ROLE_KEY: 'test-only',
    VILLAGE_AI_WORKER_CMD: 'not-executed' });
  try {
    const api = await import('./server.mjs');
    assert.equal(typeof api.runSupabaseRecoverySweep, 'function');
    assert.equal(typeof api.dispatchAiJob, 'function');
    let available = false, captures = 0, invalidateCaptureClaim = false;
    const channel = createHermesGatewayChannel({ directory: path.join(directory, 'isolated-channel') });
    const dispatcher = api.createAiJobDispatcher({ transport: 'gateway', channel,
      capture: async () => {
        captures++;
        if (invalidateCaptureClaim) row = { ...row, status: 'ai_skipped_needs_review', updated_at: '2026-10-18T23:59:59.000Z', payload: { authoritative: true } };
        return { snapshot: { navigation: { status: available ? 'ok' : 'unavailable' } } };
      },
      buildTurn: async ({ job: current }) => {
        if (!available) throw Object.assign(Error('body not rendered'), { code: 'kakao_conversation_evidence_unavailable' });
        return { event: { schema: 'village-kakao-gateway-event/v1', job_id: current.jobId, room_key: current.roomKey,
          room_revision: current.roomRevision, prompt: 'fresh conversation and current ledger lookup', detected_at: current.detectedAt, raw: {} },
        internal: { snapshot: {} } };
      }, runLegacy: () => assert.fail('no legacy execution') });
    const dispatch = (input, context) => api.dispatchAiJob(input, context, dispatcher);
    const first = await dispatch(job, {});
    assert.equal(first.retryable, true, JSON.stringify({ first, queries: queries.map(q => ({method:q.method,query:String(q.query)})), row }));
    assert.equal(row.payload.capture_retry.state, 'pending');
    assert.equal(row.completed_at, null);
    for (let attempt = 1; attempt <= 3; attempt++) {
      row = JSON.parse(JSON.stringify(row)); // persisted/restarted source, not process memory
      row.payload.capture_retry.next_attempt_at = '2026-08-01T00:00:00.000Z';
      const result = await api.runSupabaseRecoverySweep('test', { dispatch });
      assert.equal(result.replayed, 1);
      assert.equal(row.payload.bridge_recovery.attempts, attempt);
      assert.equal(row.status, 'ai_worker_error');
      assert.equal(row.payload.capture_retry.state, 'pending');
    }
    row.payload.capture_retry.next_attempt_at = '2026-08-01T00:00:00.000Z';
    const pendingForCrash = structuredClone(row);
    loseClaim = true;
    const beforeConflict = captures;
    await api.runSupabaseRecoverySweep('test', { dispatch });
    assert.equal(captures, beforeConflict, 'a lost conditional claim must never dispatch');
    loseClaim = false; invalidateCaptureClaim = true;
    await api.runSupabaseRecoverySweep('test', { dispatch });
    assert.equal(row.status, 'ai_skipped_needs_review', 'late capture failure must not overwrite newer source ownership');
    assert.deepEqual(row.payload, { authoritative: true });
    invalidateCaptureClaim = false; row = structuredClone(pendingForCrash);
    loseClaim = false; available = true;
    const recovered = await api.runSupabaseRecoverySweep('test', { dispatch });
    assert.equal(recovered.replayed, 1);
    assert.equal(row.payload.capture_retry.state, 'handed_off');
    assert.equal(row.payload.gateway_dispatch.state, 'ready');
    assert.equal((await channel.get(job.jobId)).state, 'ready');
    const afterRecovery = captures;
    await api.runSupabaseRecoverySweep('test', { dispatch });
    assert.equal(captures, afterRecovery);
    assert.ok(queries.some(x => x.method === 'PATCH' && x.query.get('id') === 'eq.source-row' && x.query.has('updated_at')));
    const restarted = createHermesGatewayChannel({ directory: path.join(directory, 'isolated-channel') });
    assert.equal((await restarted.get(job.jobId)).state, 'ready');
    for (const state of ['completed', 'superseded', 'retry_wait']) {
      row = structuredClone(pendingForCrash);
      const knownDispatcher = api.createAiJobDispatcher({ transport: 'gateway',
        channel: { get: async () => ({job_id:job.jobId,room_key:job.roomKey,room_revision:1,state}), enqueue() { assert.fail('no replay'); } },
        capture() { assert.fail('no recapture of durable work'); }, buildTurn() { assert.fail('no re-interpretation'); }, runLegacy() {} });
      await api.runSupabaseRecoverySweep('test', { dispatch: (j, c) => api.dispatchAiJob(j, c, knownDispatcher) });
      assert.equal(row.payload.capture_retry.state, 'handed_off');
      assert.equal(row.payload.gateway_dispatch.state, state);
      assert.equal(api.shouldRecoverSupabaseRow(row), false);
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
