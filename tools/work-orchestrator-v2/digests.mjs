import { encodeWorkActionValue } from './work-items.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLACK_USER_ID = /^[UW][A-Z0-9]{1,79}$/;
const ACTIVE_STATES = new Set(['open', 'in_progress', 'snoozed']);
const TERMINAL_STATES = new Set(['resolved', 'dismissed']);
const PRIORITIES = new Set(['p0', 'urgent', 'normal', 'low']);
const SECTIONS = Object.freeze(['p0', 'overdue', 'urgent', 'carry_over', 'actionable']);
const SECTION_RANK = new Map(SECTIONS.map((section, index) => [section, index]));
const INCLUSION_REASONS = new Set([...SECTIONS, 'daily_reminder']);
const SELECTED_KEYS = Object.freeze([
  'id', 'version', 'title', 'summary', 'ownerId', 'roomKey', 'priority', 'dueAt',
  'firstOpenedAt', 'section', 'inclusionReason', 'ownerMentionRequired', 'dailyReminderDue'
]);
const MAX_INPUT_ITEMS = 500;
const MAX_ROWS_PER_PART = 24;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const MAX_RENDERED_TITLE = 500;
const MAX_RENDERED_SUMMARY = 1500;
const MAX_RENDERED_ROOM = 500;
const MAX_SLACK_SECTION_TEXT = 3000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const KST_OFFSET_MS = 9 * HOUR_MS;

/**
 * @typedef {object} SelectedDigestItem
 * @property {string} id
 * @property {number} version
 * @property {string} title
 * @property {string} summary
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
  if (typeof value !== 'string' || !value || value.length > 40) return false;
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
  const section = exactText(entry.section, 30);
  const inclusionReason = exactText(entry.inclusionReason, 30);
  if (!PRIORITIES.has(priority) || !SECTION_RANK.has(section) || !INCLUSION_REASONS.has(inclusionReason)) {
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

function addMillisecondsIso(timestamp, milliseconds) {
  const result = new Date(Date.parse(timestamp) + milliseconds);
  if (Number.isNaN(result.getTime())) throw invalidConfig();
  return result.toISOString();
}

function kstPresetTimes(now) {
  const nowMs = Date.parse(now);
  const kst = new Date(nowMs + KST_OFFSET_MS);
  const year = kst.getUTCFullYear();
  const month = kst.getUTCMonth();
  const day = kst.getUTCDate();
  const eveningMs = Date.UTC(year, month, day, 18) - KST_OFFSET_MS;
  const tomorrowMorningMs = Date.UTC(year, month, day + 1, 9) - KST_OFFSET_MS;
  const presets = [
    {
      actionId: 'village_work_v2_snooze_3h',
      label: '3시간 미루기',
      snoozedUntil: addMillisecondsIso(now, 3 * HOUR_MS)
    }
  ];
  if (eveningMs > nowMs) {
    presets.push({
      actionId: 'village_work_v2_snooze_evening',
      label: '오늘 저녁',
      snoozedUntil: new Date(eveningMs).toISOString()
    });
  }
  presets.push(
    {
      actionId: 'village_work_v2_snooze_tomorrow',
      label: '내일 오전',
      snoozedUntil: new Date(tomorrowMorningMs).toISOString()
    }
  );
  return presets;
}

function button(item, actionId, label, action, style) {
  const result = {
    type: 'button',
    text: { type: 'plain_text', text: label.slice(0, 75), emoji: true },
    action_id: actionId,
    value: encodeWorkActionValue({ id: item.id, version: item.version, action })
  };
  if (style) result.style = style;
  return result;
}

function itemActions(item, presets) {
  const actions = [
    button(item, 'village_work_v2_progress', '진행 중', { type: 'progress' }, 'primary'),
    ...presets.map((preset) => button(item, preset.actionId, preset.label, {
      type: 'snooze', snoozedUntil: preset.snoozedUntil
    }))
  ];
  actions.push(
    button(item, 'village_work_v2_request_resolve', '해결 요청', { type: 'request_resolve' }),
    button(item, 'village_work_v2_dismiss', '닫기', { type: 'dismiss' }, 'danger')
  );
  return actions;
}

function configuredOwnerMention(item, config) {
  if (!item.ownerMentionRequired) return '';
  const configured = isRecord(config.ownerSlackIds) ? config.ownerSlackIds[item.ownerId] : null;
  const candidate = typeof configured === 'string' && SLACK_USER_ID.test(configured)
    ? configured
    : (typeof item.ownerId === 'string' && SLACK_USER_ID.test(item.ownerId) ? item.ownerId : null);
  return candidate ? `<@${candidate}>` : '_담당자 미지정_';
}

function workBlock(item, config, presets, reminder) {
  const owner = configuredOwnerMention(item, config);
  const due = item.dueAt ? ` · 기한 ${escapeSlackText(item.dueAt, 40)}` : '';
  const reminderLabel = reminder ? ' · 매일 알림' : '';
  const lines = [
    `${owner ? `${owner} ` : ''}*[${item.section}${reminderLabel}] ${escapeSlackText(item.title, MAX_RENDERED_TITLE)}*`,
    `${escapeSlackText(item.summary, MAX_RENDERED_SUMMARY)}\n방 ${escapeSlackText(item.roomKey, MAX_RENDERED_ROOM)}${due}`
  ];
  const text = lines.join('\n');
  if (text.length > MAX_SLACK_SECTION_TEXT) throw invalidInput();
  return [
    {
      type: 'section',
      text: { type: 'mrkdwn', text }
    },
    {
      type: 'actions',
      elements: itemActions(item, presets)
    }
  ];
}

function chunks(values, size) {
  const result = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function buildParts(items, config, presets, kind) {
  const groups = chunks(items, MAX_ROWS_PER_PART);
  return groups.map((group, index) => {
    const partNumber = index + 1;
    const partCount = groups.length;
    const reminder = kind === 'daily_reminder';
    const header = reminder ? '⏰ 매일 확인 알림' : '🎯 집중 작업 다이제스트';
    const suffix = partCount > 1 ? ` (${partNumber}/${partCount})` : '';
    return {
      kind,
      partNumber,
      partCount,
      itemIds: group.map(({ id }) => id),
      text: `${header}${suffix}: ${group.length}개 작업`,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: `${header}${suffix}`.slice(0, 150), emoji: true } },
        ...group.flatMap((item) => workBlock(item, config, presets, reminder))
      ]
    };
  });
}

/**
 * @returns {{selectedCount:number,renderedCount:number,dailyReminderCount:number,
 * ordinaryParts:DigestMessagePart[],dailyReminderParts:DigestMessagePart[]}}
 */
export function buildDigestSlackMessage(selected, config = {}) {
  let normalized;
  let now;
  try {
    normalized = validateSelected(selected);
    now = canonicalIso(config.now, { error: invalidConfig });
  } catch (error) {
    if (error?.message === 'invalid digest input') throw invalidInput();
    throw invalidConfig();
  }
  const presets = kstPresetTimes(now);
  const reminderItems = normalized.filter(({ dailyReminderDue }) => dailyReminderDue);
  const ordinaryParts = buildParts(normalized, config, presets, 'digest');
  const dailyReminderParts = buildParts(reminderItems, config, presets, 'daily_reminder');
  return {
    selectedCount: normalized.length,
    renderedCount: ordinaryParts.reduce((count, part) => count + part.itemIds.length, 0),
    dailyReminderCount: dailyReminderParts.reduce((count, part) => count + part.itemIds.length, 0),
    ordinaryParts,
    dailyReminderParts
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
