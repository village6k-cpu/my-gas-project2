'use strict';

function extractVillageClockTokens(sourceText) {
  const source = String(sourceText ?? '').normalize('NFKC');
  const tokens = [];
  const pattern = /(오전|오후)?\s*(\d{1,2})(?::(\d{1,2})|\s*시(?!간)(?:\s*(\d{1,2})\s*분)?)/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const marker = match[1] || '';
    const sourceHour = Number(match[2]);
    const minute = Number(match[3] ?? match[4] ?? 0);
    if (!Number.isInteger(sourceHour) || !Number.isInteger(minute) || minute < 0 || minute > 59) continue;
    if (marker && (sourceHour < 1 || sourceHour > 12)) continue;
    if (!marker && (sourceHour < 0 || sourceHour > 24)) continue;
    if (sourceHour === 24 && minute !== 0) continue;

    let hour = sourceHour;
    if (marker === '오전') hour = sourceHour === 12 ? 0 : sourceHour;
    if (marker === '오후') hour = sourceHour === 12 ? 12 : sourceHour + 12;
    if (!marker && sourceHour === 24) hour = 0;
    tokens.push({
      raw: match[0].trim(),
      marker: marker || null,
      sourceHour,
      minute,
      normalized: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    });
  }
  return tokens;
}

function validateVillageRentalTimeSource({
  sourceText,
  pickupTime,
  returnTime,
  pairMode = 'exact'
} = {}) {
  const source = String(sourceText ?? '').trim();
  if (!source) {
    return { ok: false, errors: ['시간원문 is required and must preserve the exact pickup/return wording'] };
  }
  const allTokens = extractVillageClockTokens(source);
  if (allTokens.length < 2 || (pairMode === 'exact' && allTokens.length !== 2)) {
    return {
      ok: false,
      errors: [`시간원문 must contain exactly two rental clock values (found ${allTokens.length})`],
      tokens: allTokens
    };
  }
  const tokens = pairMode === 'last' ? allTokens.slice(-2) : allTokens;
  const actual = [String(pickupTime ?? '').trim(), String(returnTime ?? '').trim()];
  const labels = ['반출시간', '반납시간'];
  const errors = [];
  tokens.forEach((token, index) => {
    if (token.normalized !== actual[index]) {
      const literalRule = token.marker
        ? ''
        : ` (Village 24-hour rule: ${token.raw} means ${token.normalized})`;
      errors.push(
        `${labels[index]} conflicts with 시간원문 ${token.raw}: expected ${token.normalized}, got ${actual[index]}${literalRule}`
      );
    }
  });
  return { ok: errors.length === 0, errors, tokens };
}

module.exports = {
  extractVillageClockTokens,
  validateVillageRentalTimeSource
};
