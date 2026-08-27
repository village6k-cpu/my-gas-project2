import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { adaptSlackAppMention } from '../tools/local-cua-clerk/gate3/slack-socket-connector.mjs';

const contractPath = new URL('../scripts/windows/hermes-profile-overlay/skills/productivity/village-operations/references/local-studio-mac-handoff.md', import.meta.url);

test('the documented HeyBilly readiness template is PII-free and accepted by the production parser', async () => {
  const contract = await readFile(contractPath, 'utf8');
  const template = [...contract.matchAll(/```text\n([\s\S]*?)\n```/gu)]
    .map(match => match[1])
    .find(block => block.includes('task_type: studio_mac_cua_readiness'));
  assert.equal(typeof template, 'string');
  assert.deepEqual(template.split('\n').slice(1, -1).map(line => line.split(':')[0]), [
    '[MAC_AGENT_READINESS_V1]',
    'handoff_id',
    'task_type',
    'authorization',
  ]);
  assert.equal(template.split('\n').at(-1), '[/MAC_AGENT_READINESS_V1]');
  assert.doesNotMatch(template, /MAC_AGENT_HANDOFF_V1/);
  for (const forbidden of [
    'customer_name:', 'transaction_id:', 'transaction_date:', 'amount_krw:',
    'purpose:', 'phone:', 'item:',
  ]) assert.doesNotMatch(template, new RegExp(forbidden));

  const botUserId = 'U0BSAFTPTS9';
  const text = `\`\`\`text\n${template.replace(
    '{fresh-lowercase-uuid}',
    '9b617f7e-30c7-45e5-82d0-8a2a4799de31',
  )}\n\`\`\``;
  const decision = adaptSlackAppMention({
    route: {
      teamId: 'T03EB8LSB18',
      channelId: 'C0B7CLP4KDY',
      appId: 'A0LOCALCUA01',
      botUserId,
      allowedUserId: 'U03EB8L0QDR',
    },
    handoffSource: { userId: 'U0B66DNKXRU', botId: 'B0B68FQLVS6' },
    nowEpochSeconds: 1787796000,
    body: {
      type: 'event_callback',
      team_id: 'T03EB8LSB18',
      api_app_id: 'A0LOCALCUA01',
      event_id: 'Ev0HEYBILLYREADY2',
      event_time: 1787796000,
      event: {
        type: 'message',
        user: 'U0B66DNKXRU',
        bot_id: 'B0B68FQLVS6',
        subtype: 'bot_message',
        text,
        channel: 'C0B7CLP4KDY',
        ts: '1787796002.000001',
        thread_ts: '1787795900.000009',
      },
    },
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.kind, 'heybilly_readiness');
  assert.equal(decision.envelope.action, 'desktop_readiness');
});
