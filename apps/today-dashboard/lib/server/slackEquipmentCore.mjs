const compact = value => String(value ?? '').replace(/[^a-zA-Z0-9가-힣]/g, '').toLowerCase();
const text = value => String(value ?? '').replace(/\u0000/g, '').trim();
function contains(haystack, needle) {
  const raw = String(haystack ?? '').toLowerCase(), positions = [];
  let h = '';
  for (let i=0;i<raw.length;i++) if (/[a-z0-9가-힣]/.test(raw[i])) { h += raw[i]; positions.push(i); }
  const n = compact(needle);
  if (n.length < 2) return false;
  let start = h.indexOf(n);
  while (start >= 0) {
    const before = raw[positions[start] - 1] || '', after = raw[positions[start + n.length - 1] + 1] || '';
    if (!(/[a-z0-9]/.test(n[0]) && /[a-z0-9]/.test(before)) &&
        !(/[a-z0-9]/.test(n.at(-1)) && /[a-z0-9]/.test(after))) return true;
    start = h.indexOf(n, start + 1);
  }
  return false;
}

export function lookupEquipment(source, query, catalog) {
  query = text(query);
  if (!query || query.length > 120 || !contains(source, query)) throw new Error('장비 조회 단서가 직원 원문에 없습니다');
  const candidates = catalog.filter(row => row.state !== '보관종료' &&
    [row.equipment_id, row.name, ...(Array.isArray(row.aliases) ? row.aliases : [])].some(name => contains(name, query)))
    .map(row => ({equipmentId: row.equipment_id, name: row.name, aliases: row.aliases || []}));
  return {query, selectedEquipmentId: candidates.length === 1 ? candidates[0].equipmentId : null, candidates};
}

export function validateEquipmentReports(source, event, reports, catalog) {
  if (!Array.isArray(reports) || reports.length > 12) throw new Error('장비 보고는 최대 12개입니다');
  const seen = new Set();
  return reports.map(report => {
    const equipmentId = text(report?.equipmentId), quote = text(report?.quote), kind = text(report?.kind);
    if (seen.has(equipmentId)) throw new Error('한 사건의 장비 보고가 중복되었습니다');
    seen.add(equipmentId);
    const lines = value => text(value).split('\n').map(line=>line.trim().replace(/[\t ]+/g,' ')).join('\n');
    const messages = event.sourceMessages || [source];
    const wholeMessages = messages.some((_,start)=>messages.some((__,end)=>end>=start && lines(messages.slice(start,end+1).join('\n'))===lines(quote)));
    if (!quote || quote.length > 700 || !wholeMessages) throw new Error('보고 인용문은 직원 원문 메시지를 자르지 않고 그대로 포함해야 합니다');
    const resolved = lookupEquipment(source, report?.query, catalog);
    if (resolved.selectedEquipmentId !== equipmentId || !contains(quote, resolved.query)) throw new Error('보고 대상 장비를 원문과 장비마스터에서 하나로 확인하지 못했습니다');
    const kinds = {inventory:'재고 관련 공유', loss:'분실 관련 공유', damage:'파손·고장 관련 공유'};
    if (!Object.hasOwn(kinds, kind)) throw new Error('지원하지 않는 장비 보고 종류');
    if (kind === 'loss' && !/분실/.test(quote)) throw new Error('분실은 원문에 명시되어야 합니다');
    const day = new Date(Number(event.messageTs) * 1000 + 9 * 3600000).toISOString().slice(0,10);
    return {equipmentId, query:resolved.query, kind, quote, label:`[${day} ${kinds[kind]}] ${quote.replace(/\s+/g,' ')}`};
  });
}

/** Preserve sheet-only handwriting before making the ledger authoritative. */
export function mergeEquipmentSheetNote(sheetNote, row, historicalLabels = []) {
  const delimiter = ' · ';
  let remaining = text(sheetNote);
  const known = [...new Set([row.note, ...(row.open_issues || []).map(i=>i.label), ...historicalLabels].filter(Boolean))].sort((a,b)=>b.length-a.length);
  for (const part of known) {
    // Match complete mirror segments; never remove a coincidental substring.
    let wrapped = `${delimiter}${remaining}${delimiter}`;
    const needle = `${delimiter}${part}${delimiter}`;
    while (wrapped.includes(needle)) wrapped = wrapped.replace(needle,delimiter);
    remaining = wrapped.slice(delimiter.length,-delimiter.length).trim();
  }
  return remaining ? [...new Set([row.note,remaining].filter(Boolean))].join(delimiter) : (row.note || '');
}
