const assert = require('node:assert/strict');
const fs = require('node:fs');

const view = fs.readFileSync('apps/today-dashboard/components/FollowUpView.tsx', 'utf8');

assert(
  /import \{ Check,\s*Refresh \} from "@\/components\/icons";/.test(view),
  'FollowUpView must import the existing Check icon for section-level completion'
);

assert(
  /aria-label=\{`\$\{label\} 섹션 완료`\}/.test(view),
  'each follow-up section header must expose a check button labelled as section completion'
);

assert(
  /onClick=\{\(\) => onPatch\(items\.map\(\(it\) => it\.id\), "done"\)\}/.test(view),
  'section completion must mark every item in that section done in one PATCH call'
);

assert(
  /disabled=\{items\.length === 0\}/.test(view),
  'section completion must be disabled when a section has no items'
);

assert(
  /<Check className="h-3\.5 w-3\.5" \/>/.test(view),
  'section completion control must render as a compact check icon'
);

console.log('today-dashboard follow-up section complete static checks passed');
