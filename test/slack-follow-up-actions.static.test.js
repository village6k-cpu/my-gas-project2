import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const worker = fs.readFileSync('tools/ai-browser-worker/worker.mjs', 'utf8');
const bridge = fs.readFileSync('tools/kakao-dom-bridge/server.mjs', 'utf8');
const schema = fs.readFileSync('tools/kakao-dom-bridge/supabase-schema.sql', 'utf8');
const slackActions = fs.readFileSync('apps/follow-up-dashboard/api/slack-actions.js', 'utf8');
const kakaoAutomation = fs.readFileSync('scripts/kakao-automation', 'utf8');
const hermesPatch = fs.readFileSync('scripts/patch-hermes-village-followup-slack', 'utf8');

test('Slack follow-up agent-card delivery is opt-in only', () => {
  assert.match(worker, /스케쥴-agent/);
  assert.match(worker, /서류발송-agent/);
  assert.match(worker, /정산-agent/);
  assert.match(worker, /기타문의/);
  assert.match(worker, /routeFollowUpToSlack/);
  assert.match(worker, /chat\.postMessage/);
  assert.match(worker, /SLACK_AGENT_CARD_DELIVERY_ENABLED/);
  assert.doesNotMatch(worker, /slackFollowUpEnabled:\s*process\.env\.SLACK_FOLLOW_UP_ENABLED\s*===\s*'1'/);
});

test('Live worker loads Hermes Slack token before delivering follow-up cards', () => {
  const processOneJob = worker.match(/export async function processOneJob[\s\S]*?const config = requireConfig\(\);/)?.[0] || '';
  assert.match(processOneJob, /\.hermes\/\.env/);
  assert.match(processOneJob, /\.\.\/kakao-dom-bridge\/\.env/);
});

test('Slack follow-up schema has delivery and action columns', () => {
  assert.match(schema, /slack_delivery_status/);
  assert.match(schema, /slack_action_status/);
  assert.match(schema, /slack_draft_override/);
  assert.match(schema, /ai_follow_up_items_slack_action_idx/);
});

test('Slack interaction endpoint verifies signatures and supports send modal flow', () => {
  assert.match(slackActions, /verifySlackSignature/);
  assert.match(slackActions, /village_followup_send/);
  assert.match(slackActions, /village_followup_edit_send/);
  assert.match(slackActions, /views\.open/);
  assert.match(slackActions, /slack_action:\s*\{/);
  assert.match(slackActions, /status:\s*'pending'/);
  assert.match(slackActions, /slack_draft_override/);
});

test('Local bridge polls Slack send requests and uses the existing manual-send path', () => {
  assert.match(bridge, /SLACK_ACTION_POLL_ENABLED/);
  assert.match(bridge, /fetchPendingSlackActionRows/);
  assert.match(bridge, /enqueueManualSend/);
  assert.match(bridge, /payload\?\.slack_action\?\.status === 'pending'/);
  assert.match(bridge, /mergeFollowUpPayloadById/);
  assert.match(bridge, /\/slack\/actions/);
  assert.match(bridge, /village_followup_edit_send_submit/);
});

test('Local bridge replaces Slack follow-up cards after button actions', () => {
  assert.match(bridge, /loadSelectedEnvFile\(path\.resolve\(process\.env\.HOME \|\| '', '\.hermes\/\.env'\), \['SLACK_BOT_TOKEN'\]\)/);
  assert.match(bridge, /buildResolvedSlackFollowUpMessage/);
  assert.match(bridge, /replaceSlackFollowUpCard/);
  assert.match(bridge, /chat\.update/);
  assert.match(bridge, /tryReplaceSlackFollowUpCard\(updated \|\| row/);
  assert.match(bridge, /kind:\s*'send_pending'/);
  assert.match(bridge, /kind:\s*sendResult\.sent \? 'send_done' : 'send_error'/);
  assert.doesNotMatch(bridge.match(/function buildResolvedSlackFollowUpMessage[\s\S]*?async function slackApi/)?.[0] || '', /type:\s*'actions'/);
});

test('Manual Slack send may search old Kakao rooms even when background worker search is disabled', () => {
  const processManualSend = worker.match(/export async function processManualSend[\s\S]*?return result;/)?.[0] || '';
  assert.match(worker, /searchTargetChat:\s*process\.env\.KAKAO_WORKER_SEARCH_TARGET_CHAT !== '0'/);
  assert.match(processManualSend, /allowSearch:\s*true/);
});

test('Local manual-send suppresses duplicate same customer/text requests', () => {
  assert.match(bridge, /manualSendDedupeWindowMs/);
  assert.match(bridge, /manualSendDedupeKey/);
  assert.match(bridge, /manualSendInFlight/);
  assert.match(bridge, /duplicate_manual_send_suppressed_inflight/);
  assert.match(bridge, /duplicate_manual_send_suppressed_recent_success/);
});

test('Kakao automation applies the Hermes Socket Mode Slack follow-up patch', () => {
  assert.match(kakaoAutomation, /patch-hermes-village-followup-slack/);
  assert.match(hermesPatch, /village_followup_send/);
  assert.match(hermesPatch, /village_followup_edit_send_submit/);
  assert.match(hermesPatch, /VILLAGE_FOLLOWUP_ACTION_URL/);
});
