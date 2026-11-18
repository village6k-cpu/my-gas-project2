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
const audit = records.map(([, id, quotedName, numericPrice]) => {
  const name = JSON.parse(quotedName);
  const price = Number(numericPrice);
  const mapping = keys.get(Number(id));
  const product = { id: Number(id), name, price };
  if (!mapping || mapping[1] !== name) return { ...product, status: 'review_identity' };
  const [, , canonical, reason] = mapping;
  if (!canonical) return { ...product, status: 'separate_options_or_service', reason };
  const rows = rowsByName.get(canonical);
  if (!rows) return { ...product, canonical, status: 'missing' };
  const prices = rows.filter(row => String(row.value ?? '').trim() !== '');
  if (prices.length !== 1 || !/^\d+$/.test(String(prices[0].value).replace(/,/g, '')))
    return { ...product, canonical, status: 'review_sheet_price' };
  const sheetPrice = Number(String(prices[0].value).replace(/,/g, ''));
  return { ...product, canonical, sheetPrice, sheetRow: prices[0].sheetRow, status: sheetPrice === price ? 'matched' : 'price_difference' };
});
console.log(JSON.stringify(audit, null, 2));
