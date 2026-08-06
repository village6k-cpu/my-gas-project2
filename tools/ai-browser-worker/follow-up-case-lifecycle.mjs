import { createHash } from 'node:crypto';

const clean = (value) => String(value ?? '').normalize('NFKC').trim();

function stableHash(value) {
  return createHash('sha256').update(clean(value)).digest('hex').slice(0, 20);
}

export function buildFollowUpCaseLifecycle({ conversationKey = '', requestGroupKey = '', rows = [], requiresReply = false } = {}) {
  const steps = rows
    .filter((row) => clean(row?.payload?.action_family))
    .map((row, index) => ({
      step_key: clean(row.follow_up_key) || `${clean(row.payload.action_family)}:${index}`,
      action_family: clean(row.payload.action_family),
      business_object_key: clean(row.payload.business_object_key || row.payload.business_key),
      action: clean(row.recommended_action),
      status: 'pending'
    }));
  const ownerChannel = steps.length ? 'follow_up' : 'inquiry';
  const objectKeys = [...new Set(steps.map((step) => step.business_object_key).filter(Boolean))].sort();
  const identity = requestGroupKey || objectKeys.join('|') || 'conversation';
  return {
    case_key: `case:${stableHash(`${conversationKey}|${identity}`)}`,
    owner_channel: ownerChannel,
    phase: steps.length ? 'internal_action' : 'customer_reply',
    state_version: 1,
    steps,
    requires_reply: Boolean(requiresReply)
  };
}

function decisionContentSnapshot(payload = {}, content = {}) {
  return {
    latest_customer_message_cluster: clean(payload.latest_customer_message_cluster),
    suggested_reply_draft: clean(content.suggested_reply_draft ?? payload.suggested_reply_draft),
    summary: clean(content.summary ?? payload.summary),
    recommended_action: clean(content.recommended_action ?? payload.recommended_action),
    evidence: Array.isArray(content.evidence ?? payload.evidence) ? (content.evidence ?? payload.evidence) : [],
    ai_judgment: clean(payload.ai_judgment),
    core_facts: Array.isArray(payload.core_facts) ? payload.core_facts : [],
    reply_intent: clean(payload.reply_intent),
    requires_reply: Boolean(payload.requires_reply),
    phase: clean(payload.phase),
    steps: Array.isArray(payload.steps) ? payload.steps : []
  };
}

export function mergeFollowUpCaseLifecycle(existing = {}, incoming = {}, {
  existingContent = {},
  incomingContent = {}
} = {}) {
  const priorSteps = Array.isArray(existing.steps) ? existing.steps : [];
  const nextSteps = Array.isArray(incoming.steps) ? incoming.steps : [];
  const priorByKey = new Map(priorSteps.map((step) => [step.step_key, step]));
  const mergedSteps = nextSteps.map((step) => ({
    ...step,
    status: priorByKey.get(step.step_key)?.status === 'done' ? 'done' : step.status
  }));
  for (const step of priorSteps) {
    if (step.status === 'done' && !mergedSteps.some((candidate) => candidate.step_key === step.step_key)) {
      mergedSteps.push(step);
    }
  }
  const ownerChannel = existing.owner_channel || incoming.owner_channel;
  const requiresReply = Object.hasOwn(incoming, 'requires_reply')
    ? Boolean(incoming.requires_reply)
    : Boolean(existing.requires_reply);
  const phase = mergedSteps.some((step) => step.status === 'pending')
    ? 'internal_action'
    : requiresReply ? 'customer_reply' : 'completed';
  const merged = {
    ...incoming,
    ...(existing.case_id ? { case_id: existing.case_id } : {}),
    ...(existing.case_key ? { case_key: existing.case_key } : {}),
    ...(existing.slack_delivery ? { slack_delivery: existing.slack_delivery } : {}),
    owner_channel: ownerChannel,
    requires_reply: requiresReply,
    phase,
    steps: mergedSteps
  };
  const before = JSON.stringify(decisionContentSnapshot(existing, existingContent));
  const after = JSON.stringify(decisionContentSnapshot(merged, incomingContent));
  merged.state_version = Number(existing.state_version || 1) + (before === after ? 0 : 1);
  return merged;
}

export function validateFollowUpCaseAction(payload = {}, actionId = '', { expectedStateVersion } = {}) {
  const currentStateVersion = Number(payload.state_version || 1);
  if (!Number.isInteger(expectedStateVersion)) {
    throw new Error('expected state version must be an integer');
  }
  if (expectedStateVersion !== currentStateVersion) {
    throw new Error('stale state version');
  }
  const internalActions = new Set([
    'village_followup_status_in_progress',
    'village_followup_status_dismissed',
    'village_followup_step_done'
  ]);
  const replyActions = new Set([
    'village_followup_send',
    'village_followup_edit_send',
    'village_followup_edit_send_submit',
    'village_followup_reply_not_needed'
  ]);
  if (internalActions.has(actionId) && payload.phase !== 'internal_action') {
    throw new Error(`${actionId} requires internal_action phase`);
  }
  if (replyActions.has(actionId) && payload.phase !== 'customer_reply') {
    throw new Error(`${actionId} requires customer_reply phase`);
  }
  if (!internalActions.has(actionId) && !replyActions.has(actionId)) {
    throw new Error(`unsupported case action: ${actionId}`);
  }
  return { currentStateVersion };
}

export function applyFollowUpCaseAction(payload = {}, actionId = '', { expectedStateVersion } = {}) {
  const next = structuredClone(payload);
  const { currentStateVersion } = validateFollowUpCaseAction(next, actionId, { expectedStateVersion });
  let rowStatus = 'in_progress';
  if (actionId === 'village_followup_step_done') {
    const index = (next.steps || []).findIndex((step) => step.status === 'pending');
    if (index < 0) throw new Error('no pending step');
    next.steps[index] = { ...next.steps[index], status: 'done' };
    const hasPending = next.steps.some((step) => step.status === 'pending');
    next.phase = hasPending ? 'internal_action' : next.requires_reply ? 'customer_reply' : 'completed';
  } else if (actionId === 'village_followup_reply_not_needed') {
    next.phase = 'completed';
    rowStatus = 'done';
  } else if (actionId === 'village_followup_status_dismissed') {
    next.phase = 'dismissed';
    rowStatus = 'dismissed';
  } else if (actionId === 'village_followup_edit_send') {
    throw new Error('edit modal open does not mutate case state');
  }
  next.state_version = currentStateVersion + 1;
  if (next.phase === 'completed') rowStatus = 'done';
  return { payload: next, rowStatus };
}
