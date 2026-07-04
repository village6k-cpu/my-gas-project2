const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const sync = read('apps/today-dashboard/lib/data/sync.ts');
const panel = read('apps/today-dashboard/components/RiskPanel.tsx');
const card = read('apps/today-dashboard/components/ScheduleCard.tsx');
const types = read('apps/today-dashboard/lib/domain/types.ts');
const status = read('apps/today-dashboard/lib/domain/status.ts');
const cautions = read('apps/today-dashboard/lib/domain/cautions.ts');
const cautionRoute = read('apps/today-dashboard/app/api/cautions/route.ts');

[
  'source?: "cardCaution" | "riskWarning"',
  'severity?: 1 | 2 | 3',
  'cautionId?: string',
  'hiddenCount?: number',
  'totalMatched?: number',
].forEach((contract) => {
  assert.ok(types.includes(contract), `RiskWarning type must support card caution field: ${contract}`);
});

[
  'function mapDashboardCardCautions(it: any): RiskWarning[]',
  'Array.isArray(it?.cardCautions) ? it.cardCautions : []',
  'sanitizeCautionDisplayText(c?.text)',
  '.slice(0, 5)',
  'cardCautionsHiddenCount',
  'source: "cardCaution"',
  'cautionId: String(c?.id || "").trim() || undefined',
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
  'useState<Set<string>>(new Set())',
  'w.cautionId && !hiddenCautionIds.has(w.cautionId)',
  'handleDismissCaution(w.cautionId)',
  'authFetch(`/api/cautions?id=${encodeURIComponent(cautionId)}`',
  'method: "DELETE"',
  'sanitizeCautionDisplayText(w.cautionId ? (editedTexts[w.cautionId] ?? w.customerMessage) : w.customerMessage)',
  '.slice(0, 5)',
  'const hiddenCount = Math.max(0, ...list.map((w) => Number(w.hiddenCount || 0) || 0))',
  '외 {hiddenCount}건 ▸',
  'w.severity === 3 ? "font-extrabold text-attention-fg" : "font-normal text-ink-mute"',
  'setEditing({ id: w.cautionId!, text: editedTexts[w.cautionId!] ?? w.customerMessage })',
  'method: "PATCH"',
  'body: JSON.stringify({ text })',
  'authFetch("/api/cautions",',
  'method: "PUT"',
  'body: JSON.stringify({ equipment, phase: phaseLabel(phase), text, severity: addSeverity })',
  'useState<SeverityText>("중요")',
  '<option value="공통">공통</option>',
].forEach((contract) => {
  assert.ok(panel.includes(contract), `RiskPanel must render only capped card cautions: ${contract}`);
});

assert.ok(
  card.includes('<RiskPanel warnings={trade.riskWarnings} phase={phase} equipments={trade.equipments} />'),
  'ScheduleCard must pass card equipment names into the caution add form',
);

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

[
  'export function sanitizeCautionDisplayText(value: unknown): string',
  'NotebookLM',
  'kakao[-_\\s]?\\d{4}',
  'corrections?\\.md',
].forEach((contract) => {
  assert.ok(cautions.includes(contract), `caution sanitizer must strip internal evidence labels: ${contract}`);
});

[
  'export async function DELETE(req: NextRequest)',
  'export async function PUT(req: NextRequest)',
  'export async function PATCH(req: NextRequest)',
  'https://village-ai-six.vercel.app/api/cautions',
  'url.searchParams.set("id", id)',
  'method: "DELETE"',
  'return proxyJsonMutation(req, "PUT")',
  'return proxyJsonMutation(req, "PATCH")',
].forEach((contract) => {
  assert.ok(cautionRoute.includes(contract), `caution route must proxy mined caution mutations: ${contract}`);
});

console.log('today-dashboard card caution static checks passed');
