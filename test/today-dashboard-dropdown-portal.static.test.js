const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const checklist = fs.readFileSync(path.join(root, 'apps/today-dashboard/components/HandoverChecklist.tsx'), 'utf8');

assert(
  checklist.includes('createPortal') &&
    checklist.includes('function FloatingCatalogMenu') &&
    checklist.includes('document.body'),
  'equipment dropdown menu must render in a body portal so parent overflow-hidden containers cannot clip it'
);

assert(
  /function EquipmentNameCombobox[\s\S]*const inputRef = useRef<HTMLInputElement \| null>\(null\)[\s\S]*<FloatingCatalogMenu[\s\S]*anchorRef=\{inputRef\}/.test(checklist),
  'equipment name editor must use the floating portal menu anchored to its input'
);

assert(
  /style=\{\{[\s\S]*position:\s*"fixed"[\s\S]*maxHeight: rect\.maxHeight[\s\S]*zIndex:\s*9999/.test(checklist),
  'floating catalog menu must use fixed positioning with a high z-index and bounded max height'
);

assert(
  !/function EquipmentNameCombobox[\s\S]*absolute left-0 right-0 z-20[\s\S]*<\/div>\s*\)\}/.test(checklist),
  'equipment name editor must not keep the old inline absolute dropdown that gets clipped by set/card containers'
);

console.log('today-dashboard dropdown portal static checks passed');
