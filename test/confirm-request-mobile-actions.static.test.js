const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const view = fs.readFileSync(path.join(root, 'apps/today-dashboard/components/ConfirmView.tsx'), 'utf8');
const route = fs.readFileSync(path.join(root, 'apps/today-dashboard/app/api/confirm/route.ts'), 'utf8');

assert(
  /const ACTIONS = new Set\(\[[\s\S]*"registerAsync"/.test(route),
  'confirm route must expose registerAsync so the mobile 전체 등록 button uses the GAS queue'
);

assert(
  view.includes('body: JSON.stringify({ action: "registerAsync", reqID: req.reqID })') &&
    !view.includes('body: JSON.stringify({ action: "등록", reqID: req.reqID })'),
  'ConfirmView selected/전체 등록 must enqueue registerAsync, not call long-running synchronous 등록'
);

assert(
  /const registerQueueRef = useRef<Promise<void>>/.test(view) &&
    /queuedRegisterSetRef/.test(view) &&
    /registerQueueRef\.current = registerQueueRef\.current[\s\S]*registerSelectedNow\(req, excludedItems\)/.test(view),
  'ConfirmView must serialize repeated registration taps into an app-side queue'
);

assert(
  /function canEditConfirmRequest\(status\?: string\)/.test(view) &&
    /if \(!s \|\| s === "대기" \|\| s === "AI_REVIEW" \|\| s === "등록대기"\) return true;/.test(view) &&
    /return true;/.test(view),
  'blocking states such as 모델 미선택/등록 불가 must stay editable instead of hiding 수정 controls'
);

assert(
  /const needsModelChoice = \/모델\|미등록\|❓\//.test(view) &&
    /aria-label="모델 선택"/.test(view) &&
    /aria-label=\{needsModelChoice \? "모델 선택\/품목 수정" : "품목 수정"\}/.test(view),
  'model-selection warning rows must expose a direct model/item edit affordance'
);

assert(
  /const \[editingRowKey, setEditingRowKey\] = useState<string \| null>\(null\)/.test(view) &&
    /const openInlineItemEdit = \(row: ConfirmEquipmentRow\) => setEditingRowKey\(row\.rowKey\)/.test(view) &&
    /const rowOpensInlineEdit = canOpenRow && !isEditingRow/.test(view) &&
    /onClick=\{rowOpensInlineEdit \? \(\) => openInlineItemEdit\(row\) : undefined\}/.test(view) &&
    /aria-label=\{rowOpensInlineEdit \? `\$\{row\.장비명\} 행에서 바로 수정` : undefined\}/.test(view),
  'desktop operators must edit equipment directly inside the clicked row, not through a modal or tiny pencil hunt'
);

assert(
  !/onClick=\{canOpenRow \? editItem : undefined\}/.test(view),
  'equipment row click must not open ItemEditSheet, because the sheet-style workflow needs inline row editing'
);

assert(
  /const isEditingRow = editingRowKey === row\.rowKey/.test(view) &&
    /<InlineItemEditor/.test(view) &&
    /onCancel=\{\(\) => setEditingRowKey\(null\)\}/.test(view),
  'an active equipment row must render an inline editor with a local cancel path'
);

assert(
  /function InlineItemEditor/.test(view) &&
    /runFunc\("updateRequestItem"/.test(view) &&
    /저장 \+ 이 품목만 재확인/.test(view) &&
    /제외 해제 \(다시 등록 대상에 포함\)/.test(view),
  'inline equipment editing must preserve the same single-row update and exclude controls as the old item sheet'
);

assert(
  /onClick=\{\(e\) => e\.stopPropagation\(\)\}/.test(view) &&
    /onChange=\{\(\) => toggle\(row\.rowKey\)\}/.test(view),
  'row checkbox clicks must not also open the item edit sheet'
);

assert(
  /map\(\(row\) => row\.rowKey\)/.test(view) &&
    /filter\(\(row\) => !checked\.has\(row\.rowKey\)\)/.test(view) &&
    /runFunc\("updateRequestItem"[\s\S]*제외: true/.test(view),
  'selection/exclusion must be row-specific and use updateRequestItem so duplicate equipment names do not get edited together'
);

console.log('confirm-request-mobile-actions.static.test.js OK');
