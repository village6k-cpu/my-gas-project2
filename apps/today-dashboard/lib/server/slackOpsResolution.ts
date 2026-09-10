// The model chooses useful clues; this module checks them against employee text
// and current cards. Lookup results never grant authority without a fresh check.
export type SlackResolutionQuery = {
  customer?: string; equipment?: string[]; tradeId?: string;
  phase?: 'checkout' | 'checkin'; time?: string; dayOffset?: -1 | 0 | 1;
};
type Event = { messageTs: string; phaseHint?: string; root: {text: string}; replies?: Array<{text: string}> };
type Card = {tradeId: string; customerName: string; company?: string | null; checkoutAt: string; returnAt: string; items: Array<{name: string; actualName?: string | null}>};
const DAY = 86_400_000;
const compact = (s: unknown) => String(s ?? '').replace(/[^a-zA-Z0-9가-힣]/g, '').toLowerCase();
const local = (ms: number) => new Date(ms + 9 * 3_600_000).toISOString();
function typedText(text: string): string {
  return String(text || '').split('[Hermes 이미지 분석')[0].replace(/\[첨부:[^\]]*\]/g, '');
}
function explicitSubject(text: string): string {
  const named = text.match(/(?:^|\n)\s*([가-힣]{1}\s+[가-힣]{2}|[가-힣]{2,5}?)\s*(?:감독|대표|실장|팀장)?님(?:\s|$)/u)?.[1];
  const tagged = text.match(/(?:^|\n)\s*\[\s*(?:반출|반납)\s*\]\s*([가-힣]{1}\s+[가-힣]{2}|[가-힣]{2,5}?)(?=\s*(?:(?:감독|대표|실장|팀장)?님)|\s|$)/u)?.[1];
  return compact(named || tagged);
}
function messagePhase(text: string): string {
  const checkout = /반출|출고/.test(text), checkin = /반납|회수|미반납/.test(text);
  return checkout === checkin ? 'unknown' : checkout ? 'checkout' : 'checkin';
}
export function employeeMessages(event: Event): string[] {
  const root = typedText(event.root.text), subject = explicitSubject(root);
  return [root, ...(event.replies || []).map(m => typedText(m.text)).filter(text => {
    const replySubject = explicitSubject(text), phase = messagePhase(text);
    if (subject && replySubject && subject !== replySubject) return false;
    return !['checkout','checkin'].includes(event.phaseHint || '') || phase === 'unknown' || phase === event.phaseHint;
  })];
}
function identityMessages(event: Event): string[] {
  const messages = employeeMessages(event);
  return messages.filter((text, index) => index === 0 || /^\s*(?:(?:고객명|대여자명|예약자명|거래ID)\s*[:：]\s*)?(?:[가-힣]{1}\s+[가-힣]{2}|[가-힣]{2,5}|\d{6}-\d{3})(?:\s*(?:감독)?님)?(?:입니다|이에요|이요)?[.!~]?\s*$/u.test(text));
}
export function employeeSource(event: Event): string { return employeeMessages(event).join('\n'); }
function completeNameInSource(event: Event, name: string): boolean {
  const pattern = compact(name).split('').join('\\s*');
  const subject = explicitSubject(typedText(event.root.text));
  if (subject && subject !== compact(name)) return false;
  return identityMessages(event).some(text => {
    // A space between surname and given name is not an identity boundary.
    const spaced = text.match(/^\s*(?:\[\s*(?:반출|반납)\s*\]\s*)?([가-힣]\s+[가-힣]{2})(?=\s|$)/u)?.[1];
    if (spaced && compact(spaced) !== compact(name) && compact(spaced).endsWith(compact(name))) return false;
    return new RegExp(`(?:^|[^a-zA-Z0-9가-힣])${pattern}(?=$|[^a-zA-Z0-9가-힣]|(?:감독|대표|실장|팀장)?님(?:$|[^가-힣]))`, 'iu').test(text);
  });
}
export function validateSlackResolutionQuery(event: Event, raw: unknown): SlackResolutionQuery {
  const q = (raw && typeof raw === 'object' ? raw : {}) as SlackResolutionQuery;
  const text = employeeSource(event), sources = employeeMessages(event).map(compact);
  const grounded = (value: unknown, min = 2) => {
    const s = String(value || '').trim();
    if (s.length > 100 || compact(s).length < min || !sources.some(source => source.includes(compact(s)))) throw new Error('조회 단서가 직원 Slack 원문에 없습니다');
    return s;
  };
  const result: SlackResolutionQuery = {};
  if (q.customer) {
    result.customer = grounded(q.customer);
    if (!identityMessages(event).some(text => compact(text).includes(compact(q.customer)))) throw new Error('고객 단서가 원래 사건 또는 명시적인 확인 답변 원문에 없습니다');
  }
  if (q.tradeId) {
    if (!/^\d{6}-\d{3}$/.test(q.tradeId) || !identityMessages(event).some(text => text.includes(q.tradeId!))) throw new Error('거래ID가 직원 Slack 원문에 없습니다');
    result.tradeId = q.tradeId;
  }
  if (q.equipment) {
    if (!Array.isArray(q.equipment) || q.equipment.length > 4) throw new Error('장비 단서는 최대 4개입니다');
    result.equipment = [...new Set(q.equipment.map(value => grounded(value)))];
  }
  if (q.phase) {
    if (!['checkout','checkin'].includes(q.phase)) throw new Error('지원하지 않는 단계');
    if (['checkout','checkin'].includes(event.phaseHint || '') && event.phaseHint !== q.phase) throw new Error('원래 사건 단계를 바꿀 수 없습니다');
    result.phase = q.phase;
  } else if (event.phaseHint === 'checkout' || event.phaseHint === 'checkin') result.phase = event.phaseHint;
  const offset = q.dayOffset ?? 0;
  if (![-1,0,1].includes(offset) || (offset === -1 && !/어제/.test(text)) || (offset === 1 && !/내일/.test(text))) throw new Error('날짜 단서가 직원 Slack 원문에 없습니다');
  result.dayOffset = offset;
  if (q.time) {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(q.time)) throw new Error('시간 단서가 직원 Slack 원문에 없습니다');
    const [h,m] = q.time.split(':');
    if (!new RegExp(`(?:^|[^0-9])0?${Number(h)}:${m}(?![0-9])`).test(text)) throw new Error('시간 단서가 직원 Slack 원문에 없습니다');
    result.time = `${h.padStart(2,'0')}:${m}`;
  }
  return result;
}
export function resolveSlackEvidence<T extends Card>(event: Event, raw: unknown, cards: T[]) {
  const query = validateSlackResolutionQuery(event, raw);
  const epoch = Number(event.messageTs) * 1_000;
  if (!Number.isFinite(epoch) || epoch <= 0) throw new Error('잘못된 Slack 사건 시각');
  const date = local(epoch + (query.dayOffset || 0) * DAY).slice(0,10);
  const rootSubject = explicitSubject(typedText(event.root.text));
  const name = compact(query.customer), equipment = (query.equipment || []).map(compact);
  const hasClue = Boolean(query.tradeId || name || equipment.length);
  const candidates = (hasClue ? cards : []).flatMap(card => {
    const customer = compact(card.customerName), company = compact(card.company);
    const exactCustomer = Boolean(name) && name === customer && completeNameInSource(event, query.customer || "");
    if (rootSubject && !customer.includes(rootSubject)) return [];
    const customerMatch = !name || customer.includes(name) || (company && company.includes(name));
    const equipmentMatch = equipment.every(term => card.items.some(item => compact(item.actualName || item.name).includes(term)));
    if ((query.tradeId && query.tradeId !== card.tradeId) || !customerMatch || !equipmentMatch) return [];
    const at = Date.parse(query.phase === 'checkout' ? card.checkoutAt : card.returnAt);
    const sameDay = Number.isFinite(at) && local(at).slice(0,10) === date;
    const timeMatch = !query.time || (sameDay && local(at).slice(11,16) === query.time);
    if (!timeMatch) return [];
    const dateMatches = !query.dayOffset || sameDay;
    const days = Math.abs(epoch - at) / DAY;
    const explicitPhase = event.phaseHint === query.phase && Boolean(query.phase);
    const explicitId = query.tradeId === card.tradeId;
    // Keep count/state writes tied to a known phase. Reports after a checkout,
    // or a model-inferred phase, can update notes only when independently linked.
    const direct = explicitPhase && (explicitId || (exactCustomer && days <= 1));
    const notes = Boolean(query.phase) && (explicitId
      || (equipment.length > 0 && Boolean(query.time) && sameDay)
      || (exactCustomer && equipment.length > 0 && epoch >= Date.parse(card.checkoutAt) - DAY && epoch <= Date.parse(card.returnAt) + 3 * DAY));
    return [{...card, matchEvidence: {
      exactCustomer, customerMatch: Boolean(name), equipment: query.equipment || [], sameDay,
      timeMatch: Boolean(query.time) && timeMatch, explicitTradeId: explicitId,
      phaseConfirmed: explicitPhase, daysFromPhase: Math.round(days * 100) / 100,
    }, eligible: dateMatches && Boolean(query.phase) && (direct || notes), notesOnly: !direct}];
  }).sort((a,b) => Number(b.eligible)-Number(a.eligible) || a.matchEvidence.daysFromPhase-b.matchEvidence.daysFromPhase || a.tradeId.localeCompare(b.tradeId));
  // Never choose the top score when two cards satisfy the evidence equally.
  const eligible = candidates.filter(c => c.eligible);
  const selected = eligible.length === 1 ? eligible[0] : null;
  return {query, selectedTradeId: selected?.tradeId || null, notesOnly: selected?.notesOnly ?? true,
    reason: selected ? 'resolved' : eligible.length > 1 ? 'ambiguous' : !hasClue ? 'missing_identity' : candidates.length ? 'insufficient_evidence' : 'no_matching_card',
    candidateCount: candidates.length, candidates: candidates.slice(0,8)};
}
