const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('additive audit migration admits reservation registration without weakening immutability', () => {
  const migrations = fs.readdirSync('supabase/migrations')
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => fs.readFileSync(path.join('supabase/migrations', name), 'utf8'))
    .join('\n');

  assert.match(migrations, /reservation_registration/);
  assert.match(migrations, /add constraint[\s\S]*not valid/i);
  assert.match(migrations, /validate constraint[\s\S]*begin;[\s\S]*drop constraint[\s\S]*rename constraint/i);
  assert.match(migrations, /reject_kakao_automation_audit_event_mutation/);
});
