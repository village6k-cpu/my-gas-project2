const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  normalizeCorrectionInput
} = require('../scripts/windows/village-registered-trade-correction.js');

const root = path.resolve(__dirname, '..');
const overlayRoot = path.join(root, 'scripts', 'windows', 'hermes-profile-overlay', 'skills');
const operationsRoot = path.join(overlayRoot, 'productivity', 'village-operations');
const confirmRequestRoot = path.join(overlayRoot, 'productivity', 'village-confirm-request');
const capabilityRoot = path.join(overlayRoot, 'productivity', 'village-capability-development');
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
    skill.body.split(/\r?\n/).length <= 220,
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
  assert.match(skill.body, /owner-managed[\s\S]{0,160}(?:root|contract)/i);
  assert.match(skill.body, /focused[\s\S]{0,180}agent-managed[\s\S]{0,160}(?:skill|learning)/i);
  assert.match(skill.body, /only when[\s\S]{0,120}direct reference/i);
  assert.ok(
    fs.existsSync(path.join(operationsRoot, 'references', 'legacy-village-operations-2026-08-15.md')),
    'the lossless legacy entrypoint archive must remain recoverable outside the auto-loaded root'
  );
});

test('owner-managed Village operations learning stays outside the pinned package', () => {
  const skill = loadSkill(operationsRoot);
  const learning = skill.body.match(/## Learn as you work[\s\S]*$/i)?.[0] || '';

  assert.match(
    learning,
    /do not autonomously patch[\s\S]{0,180}owner-managed package[\s\S]{0,180}(?:root|reference)/i,
    'Hermes must not autonomously patch either the root or references of the owner-managed package'
  );
  assert.match(
    learning,
    /focused agent-managed skill[\s\S]{0,220}owner-reviewed promotion/i,
    'new evidence must remain in a focused agent-managed skill until an owner-reviewed promotion'
  );
  assert.doesNotMatch(
    learning,
    /patch the narrowest relevant reference/i,
    'the owner-managed package must not retain an autonomous reference-patching instruction'
  );
});

test('Village capability gaps use native Hermes learning without a business-operation broker', () => {
  const skill = loadSkill(capabilityRoot);
  assertNativeEnvelope(skill);
  assert.equal(skill.description, 'Use when a Village operation lacks a safe executable path.');
  for (const executableResource of ['scripts', 'references', 'assets']) {
    assert.equal(
      fs.existsSync(path.join(capabilityRoot, executableResource)),
      false,
      `the lifecycle skill must not add a ${executableResource} execution layer`
    );
  }

  const phases = [
    'CAPABILITY_GAP',
    'discover',
    'validate_candidate',
    'promote',
    'confirm_registration',
    'record_learning',
    'resume'
  ];
  let previous = -1;
  for (const phase of phases) {
    const current = skill.body.indexOf(phase);
    assert.ok(current > previous, `${phase} must appear in lifecycle order`);
    previous = current;
  }

  assert.match(skill.body, /native[\s\S]{0,160}skill_manage/i);
  assert.match(skill.body, /focused[\s\S]{0,180}agent-managed skill/i);
  assert.match(skill.body, /original request[\s\S]{0,180}(?:resume|complete)/i);
  assert.match(skill.body, /discover[\s\S]{0,260}(?:no live|must not)[\s\S]{0,180}(?:write|send|deploy)/i);
  assert.match(skill.body, /owner[\s-]*reviewed[\s\S]{0,180}promot/i);
  assert.match(skill.body, /confirm_registration[\s\S]{0,260}(?:live|runtime)[\s\S]{0,120}readback/i);
  assert.doesNotMatch(skill.source, /\bvillage_operation\b/i);
  assert.doesNotMatch(skill.source, /\b(?:broker|semantic router|universal executor)\b/i);
});

test('legacy archive preserves obsolete +6 evidence but makes current +3 unmistakable', () => {
  const archive = fs.readFileSync(
    path.join(
      operationsRoot,
      'references',
      'legacy-village-operations-2026-08-15.md'
    ),
    'utf8'
  );
  const top = archive.split(/\r?\n/).slice(0, 40).join('\n');
  const obsoleteFormula = 'ceil((hours - 6) / 24)';
  const obsoleteOffset = archive.indexOf(obsoleteFormula);

  assert.match(top, /historical archive[\s\S]{0,260}(?:do not use|do not execute)/i);
  assert.match(top, /current[\s\S]{0,160}(?:\+3|hours\s*-\s*3)/i);
  assert.notEqual(obsoleteOffset, -1, 'the original +6 formula must remain as historical evidence');
  assert.match(
    archive.slice(Math.max(0, obsoleteOffset - 320), obsoleteOffset + 420),
    /obsolete[\s\S]{0,260}ceil\(\(hours\s*-\s*6\)\s*\/\s*24\)[\s\S]{0,260}(?:\+3|hours\s*-\s*3)/i,
    'the preserved +6 formula must carry an inline obsolete warning and the current +3 rule'
  );
});

test('confirmation-request skill preserves AI judgment while enforcing the owner time and merge boundaries', () => {
  const skill = loadSkill(operationsRoot);
  assert.match(
    skill.body,
    /pickup|반출[\s\S]{0,160}(?:floor|내림)[\s\S]{0,220}(?:return|반납)[\s\S]{0,160}(?:ceil|올림)/i
  );
  assert.match(skill.body, /24:00[\s\S]{0,180}(?:next day|다음 날)[\s\S]{0,120}00:00/i);
  assert.match(
    skill.body,
    /existing partial request|기존 미등록[\s\S]{0,260}(?:authoritative|권위)[\s\S]{0,260}(?:merge|병합)/i
  );
  assert.match(skill.body, /read back|readback|읽어[\s\S]{0,160}(?:complete|전체)[\s\S]{0,160}(?:list|목록)/i);

  const archive = fs.readFileSync(
    path.join(operationsRoot, 'references', 'legacy-village-operations-2026-08-15.md'),
    'utf8'
  );
  const top = archive.split(/\r?\n/).slice(0, 45).join('\n');
  const obsolete24Offset = archive.indexOf('keeps the written date and becomes `27일 00:00`');
  assert.match(top, /current[\s\S]{0,300}24:00[\s\S]{0,180}(?:next day|다음 날)[\s\S]{0,120}00:00/i);
  assert.notEqual(obsolete24Offset, -1, 'the incorrect written-date rule must remain as marked historical evidence');
  assert.match(
    archive.slice(Math.max(0, obsolete24Offset - 200), obsolete24Offset + 420),
    /obsolete[\s\S]{0,220}24:00[\s\S]{0,260}(?:written date|적힌 날짜)[\s\S]{0,180}(?:next day|다음 날)/i
  );
});

test('confirmation-request execution skill pins bare Korean hours to Village literal 24-hour time', () => {
  const skill = loadSkill(confirmRequestRoot);
  assertNativeEnvelope(skill);
  assert.match(skill.body, /5시[\s\S]{0,80}05:00/i);
  assert.match(skill.body, /오후\s*5시[\s\S]{0,80}17:00/i);
  assert.match(skill.body, /17시[\s\S]{0,80}17:00/i);
  assert.match(skill.body, /시간원문[\s\S]{0,220}(?:required|필수)[\s\S]{0,220}(?:strip|제거)/i);
  assert.match(skill.body, /24시|24:00/i);
  assert.match(skill.body, /must never override[\s\S]{0,160}plausible overnight default/i);
  assert.match(skill.body, /Never add 12 hours[\s\S]{0,180}guessed time[\s\S]{0,120}owner/i);
});

test('registered-trade command resolves one centrally documented active runtime root', () => {
  const skill = loadSkill(operationsRoot);
  const taskReference = fs.readFileSync(
    path.join(
      operationsRoot,
      'references',
      'registered-trade-date-change-remove-item.md'
    ),
    'utf8'
  );
  const runtimeReference = fs.readFileSync(
    path.join(operationsRoot, 'references', 'windows-runtime-and-sources.md'),
    'utf8'
  );

  for (const [label, source] of [
    ['skill', skill.body],
    ['task reference', taskReference]
  ]) {
    assert.doesNotMatch(source, /ax2-hermes-final/i, `${label} must not pin one worktree`);
    assert.match(source, /active runtime root/i, `${label} must name the active runtime root`);
    assert.match(
      source,
      /windows-runtime-and-sources\.md/i,
      `${label} must resolve the root through the central runtime reference`
    );
    assert.match(
      source,
      /<active-runtime-root>\/scripts\/windows\/village-registered-trade-correction\.js/i,
      `${label} must invoke the bounded runner directly under the resolved root`
    );
  }

  assert.match(runtimeReference, /Active Kakao\/Windows source:/i);
});

test('runtime source map keeps Gary Tan GBrain physically separate from Village Brain', () => {
  const runtimeReference = fs.readFileSync(
    path.join(operationsRoot, 'references', 'windows-runtime-and-sources.md'),
    'utf8'
  );
  assert.match(runtimeReference, /Gary Tan GBrain home:\s*`%USERPROFILE%\/\.gbrain`/i);
  assert.match(runtimeReference, /never\s+(?:imports?|copies?|replaces?)[\s\S]{0,100}Village Brain/i);
});

test('registered-trade references expose only the atomic correction boundary', () => {
  const dateReference = fs.readFileSync(
    path.join(
      operationsRoot,
      'references',
      'registered-trade-date-change-remove-item.md'
    ),
    'utf8'
  );
  const quoteReference = fs.readFileSync(
    path.join(
      operationsRoot,
      'references',
      'registered-quote-schedule-item-correction.md'
    ),
    'utf8'
  );
  const combined = `${dateReference}\n${quoteReference}`;

  assert.match(
    dateReference,
    /village-registered-trade-correction\.js" execute --input-file/,
    'the reference must give Hermes the exact one-call runtime boundary'
  );
  assert.match(dateReference, /additions before removals/i);
  assert.match(dateReference, /Never blindly retry/i);
  assert.match(
    dateReference,
    /set representative[\s\S]{0,180}all[\s\S]{0,120}components[\s\S]{0,220}component row[\s\S]{0,160}only that row/i,
    'Hermes must know whether an exact scheduleId removes a whole set or one component'
  );
  assert.match(quoteReference, /sendEstimate:false/);
  assert.match(quoteReference, /same one-call registered-trade/i);

  for (const retiredRoute of [
    /\bremoveEquip\b/,
    /\baddEquips\b/,
    /scheduleRemoveEquip&/,
    /village-trade-date-change\.js/,
    /action=search/
  ]) {
    assert.doesNotMatch(
      combined,
      retiredRoute,
      `registered-trade references must not retain retired multi-call route ${retiredRoute}`
    );
  }
});

test('registered-trade reference JSON uses the runner date field contract', () => {
  const source = fs.readFileSync(
    path.join(
      operationsRoot,
      'references',
      'registered-trade-date-change-remove-item.md'
    ),
    'utf8'
  );
  const jsonBlock = source.match(/```json\s*([\s\S]*?)```/i);
  assert.ok(jsonBlock, 'registered-trade reference must include a JSON example');
  const sample = JSON.parse(jsonBlock[1]);

  sample.tradeId = '260818-001';
  sample.operationId = '8f6c77d1-8828-4a85-bf74-13815d96bf51';
  sample.dateChange.newStartDate = '2026-08-18';
  sample.dateChange.newEndDate = '2026-08-21';
  sample.remove = [{
    scheduleId: '260818-001-1',
    expectedName: 'exact current item name'
  }];

  assert.doesNotThrow(() => normalizeCorrectionInput(sample));
});

test('registered-trade reference operationId is accepted by the runner', () => {
  const source = fs.readFileSync(
    path.join(
      operationsRoot,
      'references',
      'registered-trade-date-change-remove-item.md'
    ),
    'utf8'
  );
  const jsonBlock = source.match(/```json\s*([\s\S]*?)```/i);
  assert.ok(jsonBlock, 'registered-trade reference must include a JSON example');
  const sample = JSON.parse(jsonBlock[1]);

  assert.doesNotThrow(() => normalizeCorrectionInput({
    tradeId: '260818-001',
    operationId: sample.operationId,
    add: [{ name: 'TEST EXACT', qty: 1 }]
  }));
});

test('registered completion Alimtalk is the narrow owner-confirmed send exception', () => {
  const skill = loadSkill(operationsRoot);
  assert.match(
    skill.body,
    /final registration[\s\S]{0,220}(?:one|once)[\s\S]{0,120}(?:Alimtalk|알림톡)/i
  );
  assert.match(
    skill.body,
    /(?:correction|preview|sendEstimate)[\s\S]{0,180}(?:does not|never)[\s\S]{0,120}(?:authorize|inherit|apply)/i
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
