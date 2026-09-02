import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
