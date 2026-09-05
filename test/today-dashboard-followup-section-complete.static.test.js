const assert = require('node:assert/strict');
const fs = require('node:fs');

const view = fs.readFileSync('apps/today-dashboard/components/FollowUpView.tsx', 'utf8');

assert(
  /import \{ Refresh \} from "@\/components\/icons";/.test(view),
  'FollowUpView must keep the compact refresh control without a selection icon'
);

for (const retired of [
  'type="checkbox"',
  'toggleSectionSelect',
  'BulkBtn',
  '개 선택',
  '선택 해제',
]) {
  assert(
    !view.includes(retired),
    `FollowUpView must not restore retired section or bulk selection UI: ${retired}`
  );
}

assert(
  /<WorkDetail item=\{selected\}/.test(view),
  'the selected work item must open the owner action detail'
);

assert(
  /onAction=\{submitAction\}/.test(view),
  'owner actions must remain wired through the versioned detail action boundary'
);

console.log('today-dashboard follow-up master-detail action checks passed');
