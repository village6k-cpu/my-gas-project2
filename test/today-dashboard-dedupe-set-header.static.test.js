const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const status = fs.readFileSync(path.join(root, 'apps/today-dashboard/lib/domain/status.ts'), 'utf8');
const catalog = fs.readFileSync(path.join(root, 'apps/today-dashboard/lib/domain/catalog.ts'), 'utf8');

assert(
  status.includes('function setKeyOf') &&
    /const setNameByKey = new Map<string, string>\(\)/.test(status) &&
    /items\.forEach\(\(e\) => \{[\s\S]*if \(e\.setName\) setNameByKey\.set\(setKeyOf\(e\.setName\), e\.setName\)/.test(status),
  'groupBySet must build a normalized set-name lookup before rendering groups'
);

assert(
  /const inferredSetName = e\.setName \?\? setNameByKey\.get\(setKeyOf\(e\.name\)\)/.test(status),
  'groupBySet must infer missing setName when a row name equals an existing set name'
);

assert(
  /const inferredSetHeader = !!e\.isSetHeader \|\| \(!e\.setName && sameSetKey\(e\.name, inferredSetName\)\)/.test(status),
  'a no-setName row whose name equals a known set name must be treated as the set header, not a loose item'
);

assert(
  /if \(inferredSetHeader\) \{[\s\S]{0,260}g\.headers\.push\(header\)/.test(status) &&
    /else g\.rows\.push\(e\)/.test(status),
  'inferred set headers must all be stored in group headers and excluded from component rows'
);

assert(
  catalog.includes('function catalogSetKeyOf') &&
    /const setNameByKey = new Map<string, string>\(\)/.test(catalog) &&
    /items\.forEach\(\(e\) => \{[\s\S]*if \(e\.setName\) setNameByKey\.set\(catalogSetKeyOf\(e\.setName\), e\.setName\)/.test(catalog),
  'normalizeItems must build a set-name lookup so stale no-setName duplicate set headers do not count in progress totals'
);

assert(
  /const inferredSetName = e\.setName \?\? setNameByKey\.get\(catalogSetKeyOf\(e\.name\)\)/.test(catalog) &&
    /const isSetHeader = !!inferredSetName && \(!!e\.isSetHeader \|\| \(!e\.setName && sameCatalogSetKey\(e\.name, inferredSetName\)\)\)/.test(catalog),
  'normalizeItems must infer stale duplicate set headers before handover summary/progress counts are calculated'
);

console.log('today-dashboard duplicate set header static checks passed');
