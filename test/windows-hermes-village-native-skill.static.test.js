const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const overlayRoot = path.join(root, 'scripts', 'windows', 'hermes-profile-overlay', 'skills');
const operationsRoot = path.join(overlayRoot, 'productivity', 'village-operations');
const brainRoot = path.join(overlayRoot, 'village', 'village-brain-first');
const syncScript = fs.readFileSync(
  path.join(root, 'scripts', 'windows', 'sync-hermes-profile-overlay.ps1'),
  'utf8'
);

function loadSkill(skillRoot) {
  const skillPath = path.join(skillRoot, 'SKILL.md');
  assert.ok(fs.existsSync(skillPath), `missing candidate skill: ${skillPath}`);
  const source = fs.readFileSync(skillPath, 'utf8');
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(frontmatter, `${skillPath} must have YAML frontmatter`);
  const descriptionMatch = frontmatter[1].match(/^description:\s*(.+)$/m);
  assert.ok(descriptionMatch, `${skillPath} must declare a description`);
  const description = descriptionMatch[1].trim().replace(/^(['"])([\s\S]*)\1$/, '$2');
  const body = source.slice(frontmatter[0].length);
  return { skillPath, skillRoot, source, body, description };
}

function assertNativeEnvelope(skill) {
  assert.ok(
    [...skill.description].length <= 60,
    `${skill.skillPath} description exceeds Hermes' 60-character catalog limit`
  );
  assert.equal(
    skill.description.split(/[.!?]/).filter((part) => part.trim()).length,
    1,
    `${skill.skillPath} description must be one sentence`
  );
  assert.ok(
    skill.body.split(/\r?\n/).length <= 200,
    `${skill.skillPath} exceeds the native complex-skill envelope`
  );

  for (const match of skill.body.matchAll(/\((references\/[^)#\s]+)(?:#[^)]+)?\)/g)) {
    const target = path.resolve(skill.skillRoot, match[1].replaceAll('/', path.sep));
    assert.ok(fs.existsSync(target), `missing referenced support file: ${match[1]}`);
  }
}

test('Village operations is a compact substantive Hermes umbrella', () => {
  const skill = loadSkill(operationsRoot);
  assertNativeEnvelope(skill);
  assert.equal(skill.description, 'Use when staff requests Village operational work.');
  for (const required of [
    /authority/i,
    /source of truth/i,
    /interpret/i,
    /readback/i,
    /ambigu/i,
    /learn/i,
    /confirmation|reservation/i,
    /schedule/i,
    /quote|document/i,
    /payment|tax/i,
    /return|equipment/i,
    /messag/i
  ]) {
    assert.match(skill.body, required);
  }
  assert.doesNotMatch(skill.source, /\bvillage_operation\b/i);
  assert.doesNotMatch(skill.source, /\b(?:broker|semantic router|universal executor)\b/i);
  assert.doesNotMatch(skill.source, /must (?:always )?(?:load|query|retrieve).*Village Brain/i);
  assert.match(
    skill.body,
    /registered quote\/schedule item correction[\s\S]{0,120}references\/registered-quote-schedule-item-correction\.md/i
  );
  assert.match(
    skill.body,
    /village-registered-trade-correction\.js/,
    'the compact skill must expose the bounded registered-trade correction runner directly'
  );
  assert.match(
    skill.body,
    /explicit JSON[\s\S]{0,180}AI|AI[\s\S]{0,180}explicit JSON/i,
    'the runner pointer must preserve AI judgment and describe only an execution boundary'
  );
  assert.match(skill.body, /only when[\s\S]{0,120}direct reference/i);
  assert.ok(
    fs.existsSync(path.join(operationsRoot, 'references', 'legacy-village-operations-2026-08-15.md')),
    'the lossless legacy entrypoint archive must remain recoverable outside the auto-loaded root'
  );
});

test('Village Brain is narrow and never impersonates Gary Tan G-Brain', () => {
  const skill = loadSkill(brainRoot);
  assertNativeEnvelope(skill);
  assert.match(skill.source, /^name:\s*village-history-evidence$/m);
  assert.doesNotMatch(skill.source, /^name:\s*village-brain-first$/m);
  assert.equal(skill.description, 'Only for explicit Village history; never current operations.');
  assert.match(skill.body, /history|historical/i);
  assert.match(skill.body, /policy/i);
  assert.match(skill.body, /evidence/i);
  assert.match(skill.body, /strategy/i);
  assert.match(skill.body, /live (?:system|source|API)|current facts/i);
  assert.doesNotMatch(skill.source, /every (?:Village )?business question/i);
  assert.doesNotMatch(skill.source, /(?:GBrain|G-Brain) (?:retrieval|RAG|query)/i);
  assert.doesNotMatch(
    skill.source,
    /(?:quote|confirmation|schedule|live-state)[\s\S]{0,120}(?:must|always)[\s\S]{0,80}(?:load|query|retrieve).*Village Brain/i
  );
  assert.ok(
    fs.existsSync(path.join(brainRoot, 'references', 'legacy-village-brain-first-2026-08-15.md')),
    'the lossless legacy Brain entrypoint archive must remain recoverable outside the auto-loaded root'
  );
});

test('explicit recovery imports compact overlays without reinstalling the retired router', () => {
  assert.match(syncScript, /overlaySkillsRoot/);
  assert.match(syncScript, /village-operations/);
  assert.match(syncScript, /village-brain-first/);
  assert.match(syncScript, /village-history-evidence/);
  assert.doesNotMatch(
    syncScript,
    /Copy-SkillPackage\s+-Source\s+\$routerSource/i,
    'the retired Village router must not be installed by an explicit recovery import'
  );
});
