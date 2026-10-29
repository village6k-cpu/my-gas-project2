const OWNER_CASE_LIMITS = Object.freeze({
  caseKey: 160, title: 120, requestSummary: 500, problemSummary: 500, nextActionSummary: 500
});
// Match the existing SQL owner-language policy. Keep the stronger existing
// client privacy and concrete-business-fact guards as well.
const UNSAFE_TEXT = /timeout|error|exception|automation|worker|payload|stack|trace|internal|bridge|gateway|confirmation_request|\bRQ\b|RQ[-/]|거래\s*ID|^네[.!]?$|(?:\+?82[- ]?)?0\d{1,2}[- ]?\d{3,4}[- ]?\d{4}|raw log/i;
const UNSAFE_TITLE = /오류|실패|충돌/;
const GENERIC_TEXT = /^(?:\S+\s+)?(?:p0\s+)?(?:문의|예약 확인|스케줄 확인|일정 확인|확인 필요|처리 필요|확인하세요)[.!]?$/i;
const OWNER_PAYLOAD_FIELDS = Object.freeze({
  owner_case_key: [160, 'key'],
  owner_case_title: [120, 'title'],
  owner_request_summary: [500, 'body'],
  owner_problem_summary: [500, 'body'],
  owner_next_action_summary: [500, 'body'],
  owner_task_key: [160, 'key'],
  owner_case_context_status: [20, 'key']
});

export class OwnerPresentationValidationError extends Error {
  constructor(field, requirement) {
    super(`owner presentation invalid: ${field} ${requirement}`);
    this.name = 'OwnerPresentationValidationError';
    this.code = 'owner_presentation_invalid';
    this.field = field;
  }
}

function fieldError(value, field, maxLength, kind) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maxLength) {
    return new OwnerPresentationValidationError(field,
      `must be a non-empty trimmed string up to ${maxLength} characters`);
  }
  if (kind === 'key') return null;
  if (UNSAFE_TEXT.test(value) || kind === 'title' && UNSAFE_TITLE.test(value)) {
    return new OwnerPresentationValidationError(field, 'must contain only owner-facing business facts');
  }
  if (GENERIC_TEXT.test(value)) {
    return new OwnerPresentationValidationError(field,
      'must contain concrete owner-facing request, problem, or action facts');
  }
  return null;
}

function ownerCaseErrors(value, prefix) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [new OwnerPresentationValidationError(prefix, 'must be an object')];
  }
  const expected = Object.keys(OWNER_CASE_LIMITS).sort();
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    return [new OwnerPresentationValidationError(prefix,
      `must contain exactly ${Object.keys(OWNER_CASE_LIMITS).join(', ')}`)];
  }
  return Object.entries(OWNER_CASE_LIMITS).map(([key, limit]) =>
    fieldError(value[key], `${prefix}.${key}`, limit,
      key === 'caseKey' ? 'key' : key === 'title' ? 'title' : 'body')).filter(Boolean);
}

export function ownerCaseContractErrors(value, prefix = 'owner_case') {
  return ownerCaseErrors(value, prefix).map(error => error.message);
}

export function assertOwnerCasePresentation(value, prefix = 'owner_case') {
  const [error] = ownerCaseErrors(value, prefix);
  if (error) throw error;
  return value;
}

export function assertOwnerPayloadPresentation(payload) {
  // Legacy work without semantic owner metadata retains its existing contract.
  if (!Object.keys(OWNER_PAYLOAD_FIELDS).some(key => Object.hasOwn(payload, key))) return;
  for (const [key, [limit, kind]] of Object.entries(OWNER_PAYLOAD_FIELDS)) {
    const error = fieldError(payload[key], `payload.${key}`, limit, kind);
    if (error) throw error;
  }
  if (!['available', 'unavailable'].includes(payload.owner_case_context_status)) {
    throw new OwnerPresentationValidationError('payload.owner_case_context_status',
      'must be available or unavailable');
  }
}
