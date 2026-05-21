const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);

  assert.ok(
    html.includes("if (eq.isSet || (eq.isHeader && !eq.isComponent)) rowCls += ' is-set';"),
    `${file} must highlight component-less single item headers like parent equipment rows`
  );

  assert.ok(
    html.includes("if (eq.isSet) html += '<span class=\"equip-set-tag\">SET</span>';"),
    `${file} must keep the SET label limited to actual set headers`
  );

  assert.match(
    html,
    /removeEquip\([\s\S]*\+\s*\(eq\.isSet\s*\?\s*'true'\s*:\s*'false'\)/,
    `${file} must keep set-delete behavior tied to actual sets, not single item highlighting`
  );
});

console.log('dashboard-single-item-highlight.static.test.js passed');
