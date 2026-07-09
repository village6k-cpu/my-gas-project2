const assert = require('node:assert/strict');
const fs = require('node:fs');

const view = fs.readFileSync('apps/today-dashboard/components/FollowUpView.tsx', 'utf8');

assert(
  /import \{ Check,\s*Refresh \} from "@\/components\/icons";/.test(view),
  'FollowUpView must import the existing Check icon for section-level selection'
);

assert(
  /const toggleSectionSelect = useCallback/.test(view),
  'FollowUpView must have a section-level selection toggle'
);

assert(
  /const allSelected = sectionIds\.length > 0 && sectionIds\.every\(\(id\) => selected\.has\(id\)\)/.test(view),
  'section checkbox must know whether every card in the section is already selected'
);

assert(
  /if \(allSelected\) sectionIds\.forEach\(\(id\) => next\.delete\(id\)\);[\s\S]*else sectionIds\.forEach\(\(id\) => next\.add\(id\)\);/.test(view),
  'section checkbox must toggle visible card checkboxes on and off'
);

assert(
  /onToggleSection=\{toggleSectionSelect\}/.test(view) &&
    /onClick=\{\(\) => onToggleSection\(sectionIds\)\}/.test(view),
  'section checkbox must change selection state instead of completing cards immediately'
);

assert(
  !/onClick=\{\(\) => onPatch\(items\.map\(\(it\) => it\.id\), "done"\)\}/.test(view),
  'section checkbox must not immediately PATCH the section to done'
);

assert(
  /aria-pressed=\{allSelected\}/.test(view),
  'section checkbox must expose its filled/selected state'
);

assert(
  /aria-label=\{allSelected \? `\$\{label\} 섹션 선택 해제` : `\$\{label\} 섹션 선택`\}/.test(view),
  'section checkbox must be labelled as selection, not immediate completion'
);

assert(
  /disabled=\{items\.length === 0\}/.test(view),
  'section checkbox must be disabled when a section has no items'
);

assert(
  /<Check className="h-3\.5 w-3\.5" \/>/.test(view),
  'section selection control must render as a compact check icon'
);

console.log('today-dashboard follow-up section complete static checks passed');
