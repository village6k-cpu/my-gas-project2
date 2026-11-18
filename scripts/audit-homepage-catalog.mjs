// Read-only comparison of the published product catalog with the live 세트마스터.
import { readFile } from 'node:fs/promises';
import catalog from '../homepageSetMasterCatalog.js';

const homepage = new URL('https://village6k.co.kr');
const sheets = new URL(process.env.GAS_API_URL ||
  'https://script.google.com/macros/s/AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT/exec');
async function fetchText(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw Error('Catalog read returned HTTP ' + response.status);
  return response.text();
}

async function deployedBundle() {
  const html = await fetchText(homepage);
  const asset = html.match(/<script\b[^>]*src="(\/assets\/index-[\w-]+\.js)"/)?.[1];
  if (!asset) throw Error('Could not identify the published catalog bundle');
  return fetchText(new URL(asset, homepage));
}

const [bundleFile, sheetFile] = process.argv.slice(2);
sheets.search = new URLSearchParams({ action: 'read', sheet: '세트마스터', key: 'village2026' });
const [bundle, sheet] = await Promise.all([
  bundleFile ? readFile(bundleFile, 'utf8') : deployedBundle(),
  sheetFile ? readFile(sheetFile, 'utf8') : fetchText(sheets)
]);
const records = [...bundle.matchAll(/\{id:(\d+),name:("(?:[^"\\]|\\.)*"),priceDay:(\d+(?:e\d+)?),/g)];
// Publishing a different bundle format must surface an error instead of an empty or partial audit.
if (!records.length || records.length !== [...bundle.matchAll(/\bpriceDay:/g)].length ||
    new Set(records.map(match => match[1])).size !== records.length) throw Error('Incomplete homepage catalog extraction');

const data = JSON.parse(sheet);
if (data.headers?.[0] !== '세트명' || data.headers?.[6] !== '단가' || !Array.isArray(data.data))
  throw Error('Unexpected 세트마스터 schema');
const keys = new Map(catalog.homepageSetMasterProducts_().map(row => [row[0], row]));
const rowsByName = new Map();
for (const [index, row] of data.data.entries()) {
  const rows = rowsByName.get(row[0]) || [];
  rows.push({ sheetRow: index + 2, value: row[6] });
  rowsByName.set(row[0], rows);
}
// Each listed SKU has the same advertised base rate, including legacy spellings.
const variants = new Map([
  [17, ['캐논 R6 Mark 2 + EF 100-400mm II (EF-EOS R 어댑터 포함)']],
  [42, ['TVLogic F-7HS']],
  [62, ['탑 클램프 M11-095', '탑 클램프 MB-55']],
  [130, ['테라덱 볼트 500 LT (1:1)']],
  [132, ['포트키 BM5', '5인치 모니터 BM5', 'VFM-055A', '티비로직 VFM-055A']],
  [148, ['석자 플로피', '넉자 플로피']],
  [156, ['틸타 MB-T15(미니)', '스몰리그 매트박스 미니', '미니 매트박스']],
  [158, ['사각', '원형'].flatMap(shape => ['1/2', '1/4', '1/8'].map(density => 'Black Pro-Mist ' + density + ' ' + shape))],
  [159, ['1/2 사각', '1/4 사각', '1/8 사각', '1/4 원형', '1/8 원형'].map(size => 'Hollywood Blackmagic ' + size)],
  [171, ['석자 그리드', '넉자 그리드']],
  [173, [
    ...['0.3', '0.6', '0.9'].map(density => 'NiSi IR ND 사각(' + density + ')'),
    ...['0.3', '0.6', '0.9', '1.2'].map(density => 'VAXIS IRND 원형(' + density + ')')
  ]]
]);

function comparePrice(canonical, price) {
  const rows = rowsByName.get(canonical);
  if (!rows) return { canonical, status: 'missing' };
  const prices = rows.filter(row => String(row.value ?? '').trim() !== '');
  if (prices.length !== 1 || !/^\d+$/.test(String(prices[0].value).replace(/,/g, '')))
    return { canonical, status: 'review_sheet_price' };
  const sheetPrice = Number(String(prices[0].value).replace(/,/g, ''));
  return { canonical, sheetPrice, sheetRow: prices[0].sheetRow, status: sheetPrice === price ? 'matched' : 'price_difference' };
}

const audit = records.map(([, id, quotedName, numericPrice]) => {
  const name = JSON.parse(quotedName);
  const price = Number(numericPrice);
  const mapping = keys.get(Number(id));
  const product = { id: Number(id), name, price };
  if (!mapping || mapping[1] !== name) return { ...product, status: 'review_identity' };
  const [, , mappedName, reason] = mapping;
  // The four-radio product is sold as two existing two-radio inventory kits.
  const canonical = Number(id) === 89 ? name : mappedName;
  const options = (variants.get(Number(id)) || []).map(item => comparePrice(item, price));
  if (!options.length) return canonical
    ? { ...product, ...comparePrice(canonical, price) }
    : { ...product, status: 'separate_options_or_service', reason };
  const primary = canonical ? comparePrice(canonical, price) : null;
  const issues = [primary, ...options].filter(Boolean).filter(row => row.status !== 'matched');
  return {
    ...product, ...primary, options,
    status: issues.length ? 'review_options' : (primary ? 'matched' : 'matched_options')
  };
});
console.log(JSON.stringify(audit, null, 2));
