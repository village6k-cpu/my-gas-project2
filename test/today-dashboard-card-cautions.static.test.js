const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const sync = read('apps/today-dashboard/lib/data/sync.ts');
const panel = read('apps/today-dashboard/components/RiskPanel.tsx');
const types = read('apps/today-dashboard/lib/domain/types.ts');
const status = read('apps/today-dashboard/lib/domain/status.ts');

[
  'source?: "cardCaution" | "riskWarning"',
  'severity?: 1 | 2 | 3',
  'hiddenCount?: number',
  'totalMatched?: number',
].forEach((contract) => {
  assert.ok(types.includes(contract), `RiskWarning type must support card caution field: ${contract}`);
});

[
  'function mapDashboardCardCautions(it: any): RiskWarning[]',
  'Array.isArray(it?.cardCautions) ? it.cardCautions : []',
  '.slice(0, 5)',
  'cardCautionsHiddenCount',
  'source: "cardCaution"',
  'function mergeDashboardCardCautions(base: Trade, it: any): RiskWarning[]',
  'w.source === "cardCaution" && w.phase !== phase',
  'riskWarnings: mergeDashboardCardCautions(base, it)',
  'const pending = new Map<string, Trade>()',
  'pending.set(tid, mergeDashboard(base, it))',
  'for (const t of pending.values()) await persistTrade(t)',
  'const cautionsChanged = hasDashboardCardCautionChange(base, it)',
].forEach((contract) => {
  assert.ok(sync.includes(contract), `sync must route dashboard card cautions through the cache: ${contract}`);
});

[
  'w.source === "cardCaution" && w.phase === phase',
  '.slice(0, 5)',
  'const hiddenCount = Math.max(0, ...list.map((w) => Number(w.hiddenCount || 0) || 0))',
  '외 {hiddenCount}건 ▸',
  'w.severity === 3 ? "font-extrabold text-attention-fg" : "font-normal text-ink-mute"',
].forEach((contract) => {
  assert.ok(panel.includes(contract), `RiskPanel must render only capped card cautions: ${contract}`);
});

[
  '카톡 안내 발송',
  'w.guidanceState === "발송권장"',
  'const LEVEL: Record<string, string>',
].forEach((removed) => {
  assert.ok(!panel.includes(removed), `RiskPanel must not render old risk-warning UI: ${removed}`);
});

assert.ok(
  status.includes('r.source === "cardCaution" ? r.severity === 3 : r.guidanceState === "발송권장"'),
  'attention filter must treat required card cautions as attention without reviving old list rendering',
);

console.log('today-dashboard card caution static checks passed');
