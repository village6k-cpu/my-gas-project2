import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { adaptSlackAppMention } from '../tools/local-cua-clerk/gate3/slack-socket-connector.mjs';

const skillPath = new URL('../scripts/windows/hermes-profile-overlay/skills/productivity/village-operations/SKILL.md', import.meta.url);
const contractPath = new URL('../scripts/windows/hermes-profile-overlay/skills/productivity/village-operations/references/local-studio-mac-handoff.md', import.meta.url);

test('HeyBilly has one exact owner-authorized handoff contract for the local Studio Mac', async () => {
  const skill = await readFile(skillPath, 'utf8');
  const contract = await readFile(contractPath, 'utf8');
  assert.match(skill, /references\/local-studio-mac-handoff\.md/);
  assert.match(contract, /\[MAC_AGENT_HANDOFF_V1\]/);
  assert.match(contract, /task_type: hometax_cash_receipt_issue/);
  assert.match(contract, /authorization: owner_explicit/);
  assert.match(contract, /Slack\s+reply itself must be one fenced `text` block/);
  for (const key of [
    'handoff_id', 'customer_name', 'transaction_id', 'transaction_date',
    'amount_krw', 'purpose', 'phone', 'item',
  ]) assert.match(contract, new RegExp(`${key}:`));
  assert.match(`${skill}\n${contract}`, /이 로컬 스튜디오맥/);
  assert.doesNotMatch(`${skill}\n${contract}`, /MacBook|맥북/i);
});

test('the documented generic HeyBilly relay is plain text and accepted by the Studio Mac parser', async () => {
  const contract = await readFile(contractPath, 'utf8');
  const section = /## General Studio Mac handoff[\s\S]*?```text\n([\s\S]*?)\n```/u.exec(contract);
  assert.ok(section, 'generic Studio Mac handoff section must exist');

  const instruction = 'Supabase 대시보드를 열어 village-ai 프로젝트 상태를 확인하고 같은 스레드에 결과를 보고해.';
  const template = section[1].replace('{owner-approved-natural-language-instruction}', instruction);
  assert.deepEqual(template.split('\n'), [
    '<@U0BSAFTPTS9> 작업 요청',
    instruction,
  ]);
  assert.doesNotMatch(template, /```|MAC_AGENT_HANDOFF|hometax_cash_receipt_issue/u);

  const decision = adaptSlackAppMention({
    route: {
      teamId: 'T03EB8LSB18',
      channelId: 'C0B7CLP4KDY',
      appId: 'A0LOCALCUA01',
      botUserId: 'U0BSAFTPTS9',
      allowedUserId: 'U03EB8L0QDR',
    },
    handoffSource: { userId: 'U0B66DNKXRU', botId: 'B0B68FQLVS6' },
    nowEpochSeconds: 1787875200,
    body: {
      type: 'event_callback',
      team_id: 'T03EB8LSB18',
      api_app_id: 'A0LOCALCUA01',
      event_id: 'Ev0HEYBILLYGENERALDOC1',
      event_time: 1787875200,
      event: {
        type: 'message',
        user: 'U0B66DNKXRU',
        bot_id: 'B0B68FQLVS6',
        subtype: 'bot_message',
        text: template,
        channel: 'C0B7CLP4KDY',
        ts: '1787875202.000001',
        thread_ts: '1787875100.000009',
      },
    },
  });

  assert.equal(decision.accepted, true);
  assert.equal(decision.kind, 'heybilly_general');
  assert.equal(decision.task.action, 'general_local_cua');
  assert.equal(decision.task.authorization, 'owner_explicit');
  assert.equal(decision.task.instruction, instruction);
});

test('all documented route clauses preserve the trimmed owner task and stay relay-only on AX2', async () => {
  const contract = await readFile(contractPath, 'utf8');
  const examples = [...contract.matchAll(/^\| `([^`]+)` \| `([^`]+)` \|$/gmu)]
    .map(match => ({ ownerRequest: match[1], instruction: match[2] }));
  assert.deepEqual(examples, [
    {
      ownerRequest: 'Chrome에서 현재 탭 제목만 읽어. 맥에이전트로 해줘.',
      instruction: 'Chrome에서 현재 탭 제목만 읽어.',
    },
    {
      ownerRequest: '스튜디오맥에서 처리해: Supabase의 village-ai 프로젝트 상태만 확인해.',
      instruction: 'Supabase의 village-ai 프로젝트 상태만 확인해.',
    },
    {
      ownerRequest: 'CUA로 해줘. 현재 문서를 수정하지 말고 발급 여부만 확인해.',
      instruction: '현재 문서를 수정하지 말고 발급 여부만 확인해.',
    },
  ]);

  for (const [index, example] of examples.entries()) {
    const decision = adaptSlackAppMention({
      route: {
        teamId: 'T03EB8LSB18',
        channelId: 'C0B7CLP4KDY',
        appId: 'A0LOCALCUA01',
        botUserId: 'U0BSAFTPTS9',
        allowedUserId: 'U03EB8L0QDR',
      },
      handoffSource: { userId: 'U0B66DNKXRU', botId: 'B0B68FQLVS6' },
      nowEpochSeconds: 1787875300 + index,
      body: {
        type: 'event_callback',
        team_id: 'T03EB8LSB18',
        api_app_id: 'A0LOCALCUA01',
        event_id: `Ev0HEYBILLYGENERALDOC${index + 2}`,
        event_time: 1787875300 + index,
        event: {
          type: 'message',
          user: 'U0B66DNKXRU',
          bot_id: 'B0B68FQLVS6',
          subtype: 'bot_message',
          text: `<@U0BSAFTPTS9> 작업 요청\n${example.instruction}`,
          channel: 'C0B7CLP4KDY',
          ts: `178787530${index}.000001`,
          thread_ts: '1787875100.000009',
        },
      },
    });
    assert.equal(decision.accepted, true);
    assert.equal(decision.kind, 'heybilly_general');
    assert.equal(decision.task.instruction, example.instruction);
  }

  assert.match(contract, /AX2\/Hermes only[\s\S]*never runs Codex,[\s\S]*Chrome, or Computer Use/u);
  assert.match(contract, /specialized contracts take priority over this general\s+route/u);
});
