/** Pure resolver. Caller MUST fetch the complete thread directly from Slack and
 * verify its workspace/channel. IDs here are trusted configuration, not agent input.
 * This is a fail-closed missing-price fill resolver, not a general language parser.
 */
export function resolveContextualPrice({messages, questionTs, answerTs, ownerId, botId, threadTs}) {
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
    if (typeof m.text !== 'string' || m.text.length > 300 || m.files?.length || m.attachments?.length) reject('complex source');
  }
  // Match the existing conversational question, not a user-facing command format.
  const match = question.text.trim().match(/^(.+?)\s+1개\s+(?:하루|1일)\s+기본\s*단가(?:는|를)?\s+얼마로\s+등록할까요\?$/u);
  if (!match) reject('question does not establish one standing daily unit price');
  const target = match[1].trim();
  if (!target || /[\r\n,"'“”‘’<>`+\/&?？:：]/u.test(target) || /(?:이번|거래|고객|손님|할인|무료|취소|말고|아니|정정|그리고|\s및\s|와\s|과\s|하고\s|이랑\s|랑\s)/u.test(target)) reject('ambiguous target or transaction exception');
  // Any intervening thread message may change which question the
  // short answer addresses. Never silently bind an old pointer across that turn.
  if (messages.some(m => inThread(m) && Number(m.ts) > Number(questionTs) && Number(m.ts) < Number(answerTs))) reject('intervening conversation changes question context');
  // A later owner message could cancel or revise even without explicit keywords.
  if (messages.some(m => inThread(m) && Number(m.ts) > Number(answerTs) && m.user === ownerId)) reject('later owner message may supersede answer');
  const amount = answer.text.trim().match(/^(\d+|[1-9]\d{0,2}(?:,\d{3})+)\s*원[.!]?$/u);
  if (!amount) reject('answer is not an unambiguous bare amount');
  const price = Number(amount[1].replaceAll(',', ''));
  if (!Number.isSafeInteger(price) || price < 0) reject('invalid price requires explicit review');
  return {kind:'price', scope:'standing', target, price, unit:'KRW/day', questionTs, answerTs, threadTs};
}
