import { describeOwnerWorkType, isOwnerWorkType } from './work-taxonomy.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_STATES = new Set(['open', 'in_progress', 'snoozed']);
const TERMINAL_STATES = new Set(['resolved', 'dismissed']);
const PRIORITIES = new Set(['p0', 'urgent', 'normal', 'low']);
const SECTIONS = Object.freeze(['p0', 'overdue', 'urgent', 'carry_over', 'actionable']);
const SECTION_RANK = new Map(SECTIONS.map((section, index) => [section, index]));
const INCLUSION_REASONS = new Set([...SECTIONS, 'daily_reminder']);
const SELECTED_KEYS = Object.freeze([
  'id', 'version', 'title', 'summary', 'workType', 'recommendedAction', 'ownerId', 'roomKey', 'priority', 'dueAt',
  'firstOpenedAt', 'section', 'inclusionReason', 'ownerMentionRequired', 'dailyReminderDue'
]);
const MAX_INPUT_ITEMS = 500;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const MAX_SLACK_SECTION_TEXT = 3000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const P0_ACKNOWLEDGEMENT_TIMESTAMP = /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const REPORT_ITEM_KEYS = Object.freeze([
  'category', 'dueAt', 'firstOpenedAt', 'id', 'priority', 'recommendedAction', 'snoozedUntil',
  'state', 'summary', 'title', 'updatedAt', 'version', 'workType', 'workTypeLabel'
]);
const REPORT_CATEGORIES = Object.freeze([
  ['schedule', '예약·스케줄'],
  ['quote', '견적·가격'],
  ['settlement', '정산·서류'],
  ['customer', '고객 응대'],
  ['operations', '운영·예외']
]);

/**
 * @typedef {object} SelectedDigestItem
 * @property {string} id
 * @property {number} version
 * @property {string} title
 * @property {string} summary
 * @property {string} workType
 * @property {string} recommendedAction
 * @property {string|null} ownerId
 * @property {string} roomKey
 * @property {'p0'|'urgent'|'normal'|'low'} priority
 * @property {string|null} dueAt
 * @property {string} firstOpenedAt
 * @property {'p0'|'overdue'|'urgent'|'carry_over'|'actionable'} section
 * @property {'p0'|'overdue'|'urgent'|'carry_over'|'actionable'|'daily_reminder'} inclusionReason
 * @property {boolean} ownerMentionRequired
 * @property {boolean} dailyReminderDue
 */

/**
 * @typedef {object} DigestMessagePart
 * @property {'digest'|'daily_reminder'} kind
 * @property {number} partNumber
 * @property {number} partCount
 * @property {string[]} itemIds
 * @property {string} text
 * @property {object[]} blocks
 */

function invalidInput() {
  return new Error('invalid digest input');
}

function invalidConfig() {
  return new Error('invalid digest config');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return actual.length === allowed.length && actual.every((key, index) => key === allowed[index]);
}

function exactText(value, maxLength) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maxLength) {
    throw invalidInput();
  }
  return value;
}

function optionalText(value, maxLength) {
  if (value === null || value === undefined) return null;
  return exactText(value, maxLength);
}

function summaryText(value) {
  if (typeof value !== 'string' || value.length > 2000) throw invalidInput();
  return value;
}

function canonicalIso(value, { nullable = false, error = invalidInput } = {}) {
  if ((value === null || value === undefined) && nullable) return null;
  if (typeof value !== 'string' || !value || value.length > 40) throw error();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw error();
  return value;
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidInput();
  return value;
}

function nonnegativeCounter(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidInput();
  return value;
}

function validAcknowledgement(payload, nowMs) {
  if (!isRecord(payload)) return false;
  const value = payload.p0_acknowledged_at;
  if (typeof value !== 'string' || !P0_ACKNOWLEDGEMENT_TIMESTAMP.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime())
    && parsed.toISOString() === value
    && parsed.getTime() <= nowMs;
}

function selectedSection(row, nowMs) {
  if (row.priority === 'p0') return 'p0';
  if (nowMs - Date.parse(row.firstOpenedAt) >= DAY_MS) return 'overdue';
  if (row.priority === 'urgent') return 'urgent';
  if (row.consecutiveUnhandledDigests >= 2) return 'carry_over';
  return 'actionable';
}

function ownerActionMetadata(row) {
  if (!isRecord(row) || !isRecord(row.payload) || row.payload.requires_human_action !== true) return null;
  if (typeof row.work_type !== 'string' || !isOwnerWorkType(row.work_type)) return null;
  const recommended = row.payload.recommended_action;
  return {
    workType: row.work_type,
    recommendedAction: typeof recommended === 'string' && recommended.trim() === recommended && recommended.length > 0
      ? exactText(recommended, 1200)
      : exactText(row.title, 300)
  };
}

function validateActiveRow(row, nowMs) {
  if (!isRecord(row)) throw invalidInput();
  const state = row.state;
  if (!ACTIVE_STATES.has(state)) throw invalidInput();
  const id = exactText(row.id, 36).toLowerCase();
  if (!UUID.test(id)) throw invalidInput();
  const priority = exactText(row.priority, 20);
  if (!PRIORITIES.has(priority)) throw invalidInput();

  const normalized = {
    id,
    version: positiveVersion(row.version),
    title: exactText(row.title, 300),
    summary: summaryText(row.summary),
    ownerId: optionalText(row.owner_id, 200),
    roomKey: exactText(row.room_key, 500),
    priority,
    state,
    actionableAt: canonicalIso(row.actionable_at),
    dueAt: canonicalIso(row.due_at, { nullable: true }),
    snoozedUntil: canonicalIso(row.snoozed_until, { nullable: true }),
    firstOpenedAt: canonicalIso(row.first_opened_at),
    lastActivityAt: canonicalIso(row.last_activity_at),
    lastDigestAt: canonicalIso(row.last_digest_at, { nullable: true }),
    nextReminderAt: canonicalIso(row.next_reminder_at, { nullable: true }),
    digestInclusionCount: nonnegativeCounter(row.digest_inclusion_count),
    consecutiveUnhandledDigests: nonnegativeCounter(row.consecutive_unhandled_digests),
    p0Acknowledged: validAcknowledgement(row.payload, nowMs)
  };
  if (state === 'snoozed' && normalized.snoozedUntil === null) throw invalidInput();
  return normalized;
}

function compareIso(left, right) {
  return Date.parse(left) - Date.parse(right);
}

function compareSelected(left, right) {
  const sectionDifference = SECTION_RANK.get(left.section) - SECTION_RANK.get(right.section);
  if (sectionDifference) return sectionDifference;
  if (left.dueAt === null && right.dueAt !== null) return 1;
  if (left.dueAt !== null && right.dueAt === null) return -1;
  if (left.dueAt !== null && right.dueAt !== null) {
    const dueDifference = compareIso(left.dueAt, right.dueAt);
    if (dueDifference) return dueDifference;
  }
  const ageDifference = compareIso(left.firstOpenedAt, right.firstOpenedAt);
  if (ageDifference) return ageDifference;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

function validateSelectedEntry(entry) {
  if (!exactKeys(entry, SELECTED_KEYS)) throw invalidInput();
  const id = exactText(entry.id, 36).toLowerCase();
  if (!UUID.test(id)) throw invalidInput();
  const priority = exactText(entry.priority, 20);
  const workType = exactText(entry.workType, 100);
  const section = exactText(entry.section, 30);
  const inclusionReason = exactText(entry.inclusionReason, 30);
  if (!PRIORITIES.has(priority) || !isOwnerWorkType(workType)
    || !SECTION_RANK.has(section) || !INCLUSION_REASONS.has(inclusionReason)) {
    throw invalidInput();
  }
  if (typeof entry.ownerMentionRequired !== 'boolean' || typeof entry.dailyReminderDue !== 'boolean') {
    throw invalidInput();
  }
  const expectedReason = entry.dailyReminderDue ? 'daily_reminder' : section;
  if (inclusionReason !== expectedReason) throw invalidInput();
  return {
    id,
    version: positiveVersion(entry.version),
    title: exactText(entry.title, 300),
    summary: summaryText(entry.summary),
    workType,
    recommendedAction: exactText(entry.recommendedAction, 1200),
    ownerId: optionalText(entry.ownerId, 200),
    roomKey: exactText(entry.roomKey, 500),
    priority,
    dueAt: canonicalIso(entry.dueAt, { nullable: true }),
    firstOpenedAt: canonicalIso(entry.firstOpenedAt),
    section,
    inclusionReason,
    ownerMentionRequired: entry.ownerMentionRequired,
    dailyReminderDue: entry.dailyReminderDue
  };
}

function validateSelected(selected) {
  if (!Array.isArray(selected) || selected.length > MAX_INPUT_ITEMS) throw invalidInput();
  const seen = new Set();
  return selected.map((entry) => {
    const normalized = validateSelectedEntry(entry);
    if (seen.has(normalized.id)) throw invalidInput();
    seen.add(normalized.id);
    return normalized;
  });
}

/** @returns {SelectedDigestItem[]} */
export function selectDigestItems(items, now) {
  try {
    if (!Array.isArray(items) || items.length > MAX_INPUT_ITEMS) throw invalidInput();
    const selectedAt = canonicalIso(now);
    const nowMs = Date.parse(selectedAt);
    const seen = new Set();
    const selected = [];

    for (const row of items) {
      if (isRecord(row) && TERMINAL_STATES.has(row.state)) continue;
      const ownerAction = ownerActionMetadata(row);
      if (ownerAction === null) continue;
      const item = validateActiveRow(row, nowMs);
      if (seen.has(item.id)) throw invalidInput();
      seen.add(item.id);
      if (Date.parse(item.actionableAt) > nowMs) continue;
      if (item.state === 'snoozed' && Date.parse(item.snoozedUntil) > nowMs) continue;
      if (item.priority === 'p0' && !item.p0Acknowledged) continue;

      const section = selectedSection(item, nowMs);
      const ownerMentionRequired = item.consecutiveUnhandledDigests >= 2;
      const dailyReminderDue = item.nextReminderAt === null
        ? nowMs - Date.parse(item.firstOpenedAt) >= 3 * DAY_MS
        : Date.parse(item.nextReminderAt) <= nowMs;
      selected.push({
        id: item.id,
        version: item.version,
        title: item.title,
        summary: item.summary,
        workType: ownerAction.workType,
        recommendedAction: ownerAction.recommendedAction,
        ownerId: item.ownerId,
        roomKey: item.roomKey,
        priority: item.priority,
        dueAt: item.dueAt,
        firstOpenedAt: item.firstOpenedAt,
        section,
        inclusionReason: dailyReminderDue ? 'daily_reminder' : section,
        ownerMentionRequired,
        dailyReminderDue
      });
    }
    return selected.sort(compareSelected);
  } catch {
    throw invalidInput();
  }
}

/** @returns {Array<{id:string,version:number,inclusionReason:string,priority:string}>} */
export function buildDigestSnapshot(selected) {
  try {
    return validateSelected(selected).map((entry) => ({
      id: entry.id,
      version: entry.version,
      inclusionReason: entry.inclusionReason,
      priority: entry.priority
    }));
  } catch {
    throw invalidInput();
  }
}

function escapeSlackText(value, maxLength) {
  const source = [...String(value)];
  let result = '';
  for (let index = 0; index < source.length; index += 1) {
    const token = ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '*': '＊',
      '_': '＿',
      '~': '～',
      '`': '｀'
    })[source[index]] ?? source[index];
    const needsEllipsis = index < source.length - 1;
    if (result.length + token.length + (needsEllipsis ? 1 : 0) > maxLength) {
      return `${result}…`;
    }
    result += token;
  }
  return result;
}

function safeDashboardUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || value !== value.trim()) throw invalidConfig();
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidConfig();
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw invalidConfig();
  }
  return parsed.href;
}

function validateReportSummary(value) {
  if (!exactKeys(value, ['now', 'snoozed', 'completed', 'p0', 'byCategory'])
    || !exactKeys(value.byCategory, REPORT_CATEGORIES.map(([key]) => key))) throw invalidConfig();
  const counters = [value.now, value.snoozed, value.completed, value.p0, ...Object.values(value.byCategory)];
  if (counters.some((counter) => !Number.isSafeInteger(counter) || counter < 0)
    || value.p0 > value.now
    || Object.values(value.byCategory).reduce((sum, counter) => sum + counter, 0) !== value.now + value.snoozed) {
    throw invalidConfig();
  }
  return structuredClone(value);
}

function validateReportItem(entry) {
  if (!exactKeys(entry, REPORT_ITEM_KEYS)) throw invalidInput();
  const id = exactText(entry.id, 36).toLowerCase();
  const priority = exactText(entry.priority, 20);
  const definition = describeOwnerWorkType(entry.workType);
  if (!UUID.test(id) || !PRIORITIES.has(priority) || definition === null
    || definition.category !== entry.category || definition.typeLabel !== entry.workTypeLabel
    || !ACTIVE_STATES.has(entry.state)) throw invalidInput();
  return {
    id,
    version: positiveVersion(entry.version),
    category: definition.category,
    workType: definition.type,
    workTypeLabel: definition.typeLabel,
    priority,
    state: entry.state,
    title: exactText(entry.title, 300),
    summary: summaryText(entry.summary),
    recommendedAction: typeof entry.recommendedAction === 'string' && entry.recommendedAction.length === 0
      ? ''
      : exactText(entry.recommendedAction, 1200),
    dueAt: canonicalIso(entry.dueAt, { nullable: true }),
    snoozedUntil: canonicalIso(entry.snoozedUntil, { nullable: true }),
    firstOpenedAt: canonicalIso(entry.firstOpenedAt),
    updatedAt: canonicalIso(entry.updatedAt)
  };
}

function validateReportItems(items, expectedCount) {
  if (!Array.isArray(items) || items.length !== Math.min(expectedCount, 5)) throw invalidInput();
  const seen = new Set();
  return items.map((entry) => {
    const item = validateReportItem(entry);
    if (seen.has(item.id)) throw invalidInput();
    seen.add(item.id);
    return item;
  });
}

export function buildReportDigestSnapshot(highlights, now) {
  try {
    const timestamp = canonicalIso(now);
    if (!Array.isArray(highlights) || highlights.length > 5) throw invalidInput();
    const seen = new Set();
    return highlights.map((entry) => {
      const item = validateReportItem(entry);
      if (seen.has(item.id)) throw invalidInput();
      seen.add(item.id);
      const inclusionReason = item.priority === 'p0'
        ? 'p0'
        : Date.parse(timestamp) - Date.parse(item.firstOpenedAt) >= DAY_MS
          ? 'overdue'
          : item.priority === 'urgent' ? 'urgent' : 'actionable';
      return { id: item.id, version: item.version, inclusionReason, priority: item.priority };
    });
  } catch {
    throw invalidInput();
  }
}

function reportHighlightText(items) {
  const lines = items.map((item, index) => {
    const priority = item.priority === 'p0' ? '즉시 확인' : item.priority === 'urgent' ? '긴급' : item.workTypeLabel;
    const title = escapeSlackText(item.title, 180);
    const action = escapeSlackText(item.recommendedAction || item.summary || item.title, 240);
    return `${index + 1}. *[${priority}] ${title}*\n   → ${action}`;
  });
  const text = lines.join('\n');
  if (!text || text.length > MAX_SLACK_SECTION_TEXT) throw invalidInput();
  return text;
}

/**
 * @returns {{selectedCount:number,renderedCount:number,dailyReminderCount:number,
 * ordinaryParts:DigestMessagePart[],dailyReminderParts:DigestMessagePart[]}}
 */
export function buildDigestSlackMessage(highlights, config = {}) {
  let items;
  let summary;
  let dashboardUrl;
  try {
    canonicalIso(config.now, { error: invalidConfig });
    summary = validateReportSummary(config.summary);
    dashboardUrl = safeDashboardUrl(config.dashboardUrl);
    items = validateReportItems(highlights, summary.now);
  } catch (error) {
    if (error?.message === 'invalid digest input') throw invalidInput();
    throw invalidConfig();
  }
  if (summary.now === 0) {
    return {
      selectedCount: 0, renderedCount: 0, dailyReminderCount: 0,
      ordinaryParts: [], dailyReminderParts: []
    };
  }
  const categoryText = REPORT_CATEGORIES
    .map(([key, label]) => `${label} ${summary.byCategory[key]}`)
    .join(' · ');
  const totalsText = `*지금 할 일 ${summary.now}건* · 즉시 확인 ${summary.p0}건 · 미뤄둔 일 ${summary.snoozed}건\n업무별 전체: ${categoryText}`;
  const highlightText = reportHighlightText(items);
  const omitted = summary.now - items.length;
  const link = dashboardUrl.replaceAll('&', '&amp;').replaceAll('>', '%3E').replaceAll('|', '%7C');
  const contextText = `<${link}|헤이빌리 후속조치에서 처리> · ${omitted > 0 ? `나머지 ${omitted}건` : '모든 업무 표시'}`;
  const fallback = `오늘 처리할 일 요약 — 지금 ${summary.now}건, 즉시 확인 ${summary.p0}건, ${omitted > 0 ? `나머지 ${omitted}건` : '전체 표시'} · 헤이빌리 후속조치에서 처리`;
  const ordinaryParts = [{
    kind: 'ordinary',
    partNumber: 1,
    partCount: 1,
    itemIds: items.map(({ id }) => id),
    text: fallback,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '오늘 처리할 일 요약', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: totalsText } },
      { type: 'section', text: { type: 'mrkdwn', text: highlightText } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: contextText }] }
    ]
  }];
  return {
    selectedCount: summary.now,
    renderedCount: items.length,
    dailyReminderCount: 0,
    ordinaryParts,
    dailyReminderParts: []
  };
}

export function nextDigestScheduledAt(lastScheduledAt, intervalMinutes) {
  try {
    const boundary = canonicalIso(lastScheduledAt, { error: () => new Error('invalid digest schedule') });
    if (!Number.isSafeInteger(intervalMinutes)
      || intervalMinutes < 1
      || intervalMinutes > MAX_INTERVAL_MINUTES) {
      throw new Error('invalid digest schedule');
    }
    const next = new Date(Date.parse(boundary) + intervalMinutes * 60_000);
    if (Number.isNaN(next.getTime())) throw new Error('invalid digest schedule');
    return next.toISOString();
  } catch {
    throw new Error('invalid digest schedule');
  }
}
