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
  /map\(\(row\) => row\.rowKey\)/.test(view) &&
    /filter\(\(row\) => !checked\.has\(row\.rowKey\)\)/.test(view) &&
    /runFunc\("updateRequestItem"[\s\S]*제외: true/.test(view),
  'selection/exclusion must be row-specific and use updateRequestItem so duplicate equipment names do not get edited together'
);

console.log('confirm-request-mobile-actions.static.test.js OK');
