const ASSIGNMENT_KEYS = [
  'id', 'expectedVersion', 'caseKey', 'title', 'requestSummary',
  'problemSummary', 'nextActionSummary', 'taskKey'
];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNSAFE = /(01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4}|\brq(?:\b|[-/])|거래\s*id|confirmation_request|automation|worker|bridge|gateway|^네[.!]?$|timeout|exception|stack|payload|raw log)/i;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function text(value, maxLength) {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || value.length > maxLength || UNSAFE.test(value)) throw new Error('owner case reconciliation input invalid');
  return value;
}

export function normalizeOwnerCaseAssignments(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) {
    throw new Error('owner case reconciliation input invalid');
  }
  const ids = new Set();
  return value.map((assignment) => {
    if (!exactKeys(assignment, ASSIGNMENT_KEYS) || typeof assignment.id !== 'string'
      || !UUID.test(assignment.id) || ids.has(assignment.id)
      || !Number.isSafeInteger(assignment.expectedVersion) || assignment.expectedVersion < 1) {
      throw new Error('owner case reconciliation input invalid');
    }
    ids.add(assignment.id);
    return {
      id: assignment.id,
      expectedVersion: assignment.expectedVersion,
      caseKey: text(assignment.caseKey, 160),
      title: text(assignment.title, 120),
      requestSummary: text(assignment.requestSummary, 500),
      problemSummary: text(assignment.problemSummary, 500),
      nextActionSummary: text(assignment.nextActionSummary, 500),
      taskKey: text(assignment.taskKey, 160)
    };
  });
}

export async function runOwnerCaseReconciliation(input = {}) {
  if (!isRecord(input) || !isRecord(input.store) || typeof input.store.reconcileOwnerCases !== 'function') {
    throw new Error('owner case reconciliation input invalid');
  }
  const apply = input.apply === undefined ? false : input.apply;
  if (typeof apply !== 'boolean') throw new Error('owner case reconciliation input invalid');
  const assignments = normalizeOwnerCaseAssignments(input.assignments);
  return input.store.reconcileOwnerCases({ assignments, apply });
}
