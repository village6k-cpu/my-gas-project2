/** Pure resolver. Caller MUST fetch the complete thread directly from Slack and
 * verify its workspace/channel. IDs here are trusted configuration, not agent input.
 * This is a fail-closed missing-price fill resolver, not a general language parser.
 */
export const resolveContextualPrice = input => resolveContextualCorrection(input, 'price');
export const resolveContextualCreate = input => resolveContextualCorrection(input, 'create');
function resolveContextualCorrection({messages, questionTs, answerTs, ownerId, botId, threadTs}, kind) {
  const reject = reason => { throw Error('needs_review: ' + reason); };
  const timestamp = value => typeof value === 'string' && /^\d{10}\.\d{6}$/.test(value);
  if (!ownerId || !botId || !Array.isArray(messages) || ![answerTs, threadTs].every(timestamp) || (questionTs != null && !timestamp(questionTs))) reject('invalid contextual source');
  if (new Set(messages.map(m => m.ts)).size !== messages.length) reject('duplicate source messages');
  if (questionTs == null) {
    // With no pointer, use only the immediate preceding thread message, never
    // guess which older question is still pending. Remaining checks verify it.
    const preceding = messages.filter(m => (m.thread_ts || m.ts) === threadTs && timestamp(m.ts) && Number(m.ts) < Number(answerTs)).sort((a,b) => Number(b.ts) - Number(a.ts));
    if (!preceding.length) reject('no preceding question');
    questionTs = preceding[0].ts;
  }
  const question = messages.find(m => m.ts === questionTs);
  const answer = messages.find(m => m.ts === answerTs);
  const inThread = m => m && (m.thread_ts || m.ts) === threadTs;
  if (!inThread(question) || !inThread(answer) || Number(questionTs) >= Number(answerTs)) reject('question and answer must share an ordered thread');
  if (question.bot_id !== botId || question.edited || (question.subtype && question.subtype !== 'bot_message')) reject('untrusted question');
  if (answer.user !== ownerId || answer.bot_id || answer.app_id || answer.subtype || answer.edited) reject('untrusted owner answer');
  for (const m of [question, answer]) {
    if (typeof m.text !== 'string' || m.text.length > (m === question && kind === 'create' ? 3000 : 300) || m.files?.length || m.attachments?.length) reject('complex source');
  }
  // Match the existing conversational question, not a user-facing command format.
  const match = question.text.trim().match(kind === 'create'
    ? /^(.+?) 세트마스터에 새 품목으로 등록하겠습니다\. 구성은 (.+?)입니다\. (?:신규 재고는 (.+?)입니다\. )?1개 (?:하루|1일) 기본\s*단가(?:는|를)? 얼마로 등록할까요\?$/u
    : /^(.+?)\s+1개\s+(?:하루|1일)\s+기본\s*단가(?:는|를)?\s+얼마로\s+등록할까요\?$/u);
  if (!match) reject('question does not establish one standing daily unit price');
  const target = match[1].trim();
  if (!target || (kind==='create'?/[\r\n,;"'“”‘’<>`?？]/u:/[\r\n,"'“”‘’<>`+\/&?？:：]/u).test(target) || /(?:이번|거래|고객|손님|할인|무료|취소|말고|아니|정정|그리고|\s및\s|와\s|과\s|하고\s|이랑\s|랑\s)/u.test(target)) reject('ambiguous target or transaction exception');
  let components, newEquipment;
  if (kind === 'create') {
    const nameKey = name => name.normalize('NFKC').toLowerCase().replace(/[^0-9a-z가-힣]/g,'');
    const validName = name => name && name.trim() === name && name.length <= 160 && !/[\r\n,"'“”‘’<>`;]/u.test(name) && !/^[=+@]/u.test(name);
    components = match[2].split(', ').map(text => {
      const c = text.match(/^(.+?) ([1-9]\d*)개$/u);
      if (!c || !validName(c[1]) || Number(c[2]) > 1000) reject('exact component and quantity required');
      return {name:c[1],qty:Number(c[2])};
    });
    if (components.length > 50 || new Set(components.map(c=>nameKey(c.name))).size !== components.length) reject('duplicate or excessive components');
    if (match[3]) {
      newEquipment = match[3].split('; ').map(text => {
        const e = text.match(/^(.+?)\(대분류 (.+?), 카테고리 (.+?), 총보유 (\d+)개, 정비중 (\d+)개\)$/u);
        if (!e || !e.slice(1,4).every(validName) || !components.some(c=>c.name===e[1])) reject('new inventory must identify a named component and classifications');
        const stockTotal=Number(e[4]),stockMaintenance=Number(e[5]);
        if (!Number.isSafeInteger(stockTotal) || stockTotal > 9999 || !Number.isSafeInteger(stockMaintenance) || stockMaintenance > stockTotal) reject('invalid inventory counts');
        return {name:e[1],major:e[2],category:e[3],stockTotal,stockMaintenance};
      });
      if (newEquipment.length > 50 || new Set(newEquipment.map(e=>nameKey(e.name))).size !== newEquipment.length) reject('duplicate new inventory');
    }
  } else if (/등록하겠습니다|구성은/u.test(target)) reject('new product requires the create tool');
  // Any intervening thread message may change which question the
  // short answer addresses. Never silently bind an old pointer across that turn.
  if (messages.some(m => inThread(m) && Number(m.ts) > Number(questionTs) && Number(m.ts) < Number(answerTs))) reject('intervening conversation changes question context');
  // A later owner message could cancel or revise even without explicit keywords.
  if (messages.some(m => inThread(m) && Number(m.ts) > Number(answerTs) && m.user === ownerId)) reject('later owner message may supersede answer');
  const amount = answer.text.trim().match(/^(\d+|[1-9]\d{0,2}(?:,\d{3})+)\s*원[.!]?$/u);
  if (!amount) reject('answer is not an unambiguous bare amount');
  const price = Number(amount[1].replaceAll(',', ''));
  if (!Number.isSafeInteger(price) || price < 0) reject('invalid price requires explicit review');
  return {kind, scope:'standing', target, price, unit:'KRW/day', ...(components?{components}:{}), ...(newEquipment?{newEquipment}:{}), questionTs, answerTs, threadTs};
}
