import "server-only";

import { gasGet, gasPost } from "./gasPublic";
import { getInventoryAuditServiceClient } from "./inventoryAuditDb";

export const SLACK_OPS_CHANNEL_ID = process.env.SLACK_OPS_CHANNEL_ID?.trim() || "C0B6ZJZ2XU3";

type Phase = "checkout" | "checkin" | "unknown";
type SlackReply = { ts: string; userId?: string; userName?: string; text: string };

export type SlackOpsIncomingEvent = {
  channelId: string;
  messageTs: string;
  threadTs: string;
  sourceHash: string;
  phaseHint?: Phase;
  customerHint?: string;
  tradeIdHint?: string;
  permalink?: string;
  root: SlackReply;
  replies?: SlackReply[];
};

type ItemCorrectionAction = {
  type: "item_correction";
  scheduleId: string;
  actualName?: string;
  actualTakenQty?: number;
  memo?: string;
};

type ItemMemoAction = {
  type: "item_memo";
  scheduleId: string;
  memo: string;
};

type ReturnCountAction = {
  type: "return_count";
  scheduleId: string;
  good: number;
  damaged: number;
  lost: number;
  reportedMissing?: number;
  memo?: string;
};

type OnsiteAddAction = {
  type: "onsite_add";
  items: Array<{ name: string; qty: number }>;
  settlement: "미정" | "무상" | "유상";
};

export type SlackOpsApplyPlan = {
  channelId: string;
  messageTs: string;
  sourceHash: string;
  tradeId: string;
  phase: "checkout" | "checkin";
  summary: string;
  actions?: Array<ItemCorrectionAction | ItemMemoAction | ReturnCountAction | OnsiteAddAction>;
};

type StoredEvent = {
  channel_id: string;
  message_ts: string;
  thread_ts: string;
  source_hash: string;
  phase_hint: string | null;
  customer_hint: string | null;
  trade_id_hint: string | null;
  permalink: string | null;
  raw_context: { root?: SlackReply; replies?: SlackReply[] };
  status: string;
  matched_trade_id: string | null;
  applied_plan: unknown;
};

type TradeRow = {
  trade_id: string;
  customer_name: string;
  customer_phone: string | null;
  company: string | null;
  checkout_at: string;
  return_at: string;
  contract_status: string;
  setup_done: boolean;
  return_done: boolean;
  note_checkout: string | null;
  note_checkin: string | null;
  return_counts: Record<string, { good?: number; damaged?: number; lost?: number; reportedMissing?: number; memo?: string }> | null;
};

type ItemRow = {
  schedule_id: string;
  trade_id: string;
  name: string;
  qty: number;
  taken_qty: number | null;
  actual_name: string | null;
  actual_taken_qty: number | null;
  actual_source: Record<string, unknown> | null;
  set_name: string | null;
  is_set_header: boolean;
  is_component: boolean;
  onsite: boolean;
  settlement: string | null;
  checkout_state: string;
  memo_checkout: string | null;
  memo_checkin: string | null;
};

type Candidate = {
  source: "heybilli" | "gas";
  score: number;
  tradeId: string;
  customerName: string;
  checkoutAt: string;
  returnAt: string;
  contractStatus: string;
  setupDone: boolean;
  returnDone: boolean;
  noteCheckout?: string | null;
  noteCheckin?: string | null;
  returnCounts?: TradeRow["return_counts"];
  items: Array<{
    scheduleId: string;
    name: string;
    qty: number;
    takenQty?: number | null;
    actualName?: string | null;
    actualTakenQty?: number | null;
    onsite?: boolean;
    settlement?: string | null;
    memoCheckout?: string | null;
    memoCheckin?: string | null;
  }>;
};

const MAX_EVENTS = 80;
const MAX_CONTEXT_CHARS = 12_000;
const TRADE_ID_RE = /^\d{6}-\d{3}$/;

function cleanText(value: unknown, max = 2_000): string {
  return String(value ?? "").replace(/\u0000/g, "").trim().slice(0, max);
}

function normalizeName(value: unknown): string {
  return cleanText(value, 120)
    .replace(/(?:감독|대표|실장|작가|팀장)?님$/u, "")
    .replace(/[^0-9a-zA-Z가-힣]/g, "")
    .toLowerCase();
}

function eventEpochMs(ts: string): number {
  const seconds = Number.parseFloat(ts);
  return Number.isFinite(seconds) ? seconds * 1_000 : 0;
}

function relevantTradeMs(trade: Pick<TradeRow, "checkout_at" | "return_at">, phase: Phase): number {
  const raw = phase === "checkout" ? trade.checkout_at : phase === "checkin" ? trade.return_at : trade.return_at;
  const value = new Date(raw).getTime();
  return Number.isFinite(value) ? value : 0;
}

function candidateScore(
  event: Pick<SlackOpsIncomingEvent, "customerHint" | "tradeIdHint" | "phaseHint" | "messageTs">,
  trade: Pick<TradeRow, "trade_id" | "customer_name" | "checkout_at" | "return_at" | "contract_status">,
): number {
  if (event.tradeIdHint && event.tradeIdHint === trade.trade_id) return 1_000;
  const hint = normalizeName(event.customerHint);
  const customer = normalizeName(trade.customer_name);
  if (!hint || !customer) return 0;

  let score = 0;
  if (hint === customer) score += 100;
  else if (hint.includes(customer) || customer.includes(hint)) score += 70;
  else return 0;

  const eventMs = eventEpochMs(event.messageTs);
  const tradeMs = relevantTradeMs(trade, event.phaseHint || "unknown");
  const days = eventMs && tradeMs ? Math.abs(eventMs - tradeMs) / 86_400_000 : 99;
  if (days <= 1) score += 35;
  else if (days <= 3) score += 25;
  else if (days <= 10) score += 10;
  else score -= Math.min(40, Math.floor(days));

  if (event.phaseHint === "checkin" && trade.contract_status === "반납완료") score += 5;
  if (event.phaseHint === "checkout" && (trade.contract_status === "반출" || trade.contract_status === "예약")) score += 5;
  return score;
}

function sanitizeReply(value: unknown): SlackReply {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    ts: cleanText(raw.ts, 32),
    userId: cleanText(raw.userId, 80) || undefined,
    userName: cleanText(raw.userName, 120) || undefined,
    text: cleanText(raw.text, MAX_CONTEXT_CHARS),
  };
}

function sanitizeIncomingEvent(value: unknown): SlackOpsIncomingEvent {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const channelId = cleanText(raw.channelId, 80);
  const messageTs = cleanText(raw.messageTs, 32);
  const sourceHash = cleanText(raw.sourceHash, 128);
  const phaseRaw = cleanText(raw.phaseHint, 20);
  const phaseHint: Phase = phaseRaw === "checkout" || phaseRaw === "checkin" ? phaseRaw : "unknown";
  const root = sanitizeReply(raw.root);
  const replies = Array.isArray(raw.replies) ? raw.replies.slice(0, 100).map(sanitizeReply) : [];

  if (channelId !== SLACK_OPS_CHANNEL_ID) throw new Error(`허용되지 않은 Slack 채널: ${channelId || "없음"}`);
  if (!/^\d{9,12}\.\d{4,8}$/.test(messageTs)) throw new Error("잘못된 Slack message_ts");
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error("잘못된 source_hash");
  if (!root.text) throw new Error("Slack 원문이 비어 있습니다");

  const tradeIdHint = cleanText(raw.tradeIdHint, 20);
  return {
    channelId,
    messageTs,
    threadTs: cleanText(raw.threadTs, 32) || messageTs,
    sourceHash,
    phaseHint,
    customerHint: cleanText(raw.customerHint, 120) || undefined,
    tradeIdHint: TRADE_ID_RE.test(tradeIdHint) ? tradeIdHint : undefined,
    permalink: cleanText(raw.permalink, 1_000) || undefined,
    root,
    replies,
  };
}

async function upsertScannedEvents(events: SlackOpsIncomingEvent[]): Promise<StoredEvent[]> {
  const db = getInventoryAuditServiceClient();
  const ids = events.map((event) => event.messageTs);
  const { data: oldRows, error: oldError } = await db
    .from("slack_ops_events")
    .select("*")
    .eq("channel_id", SLACK_OPS_CHANNEL_ID)
    .in("message_ts", ids);
  if (oldError) throw oldError;
  const oldByTs = new Map<string, StoredEvent>((oldRows ?? []).map((row: StoredEvent) => [row.message_ts, row]));

  const writes = events.map((event) => {
    const previous = oldByTs.get(event.messageTs);
    const rawContext = { root: event.root, replies: event.replies ?? [] };
    const changed = !previous || previous.source_hash !== event.sourceHash;
    return {
      channel_id: event.channelId,
      message_ts: event.messageTs,
      thread_ts: event.threadTs,
      source_hash: event.sourceHash,
      phase_hint: event.phaseHint,
      customer_hint: event.customerHint ?? null,
      trade_id_hint: event.tradeIdHint ?? null,
      permalink: event.permalink ?? null,
      raw_context: rawContext,
      status: changed ? "pending" : previous?.status ?? "pending",
      matched_trade_id: changed ? null : previous?.matched_trade_id ?? null,
      applied_plan: changed ? null : previous?.applied_plan ?? null,
      applied_at: changed ? null : undefined,
      last_error: changed ? null : undefined,
    };
  });

  const { error: writeError } = await db.from("slack_ops_events").upsert(writes, { onConflict: "channel_id,message_ts" });
  if (writeError) throw writeError;
  const { data, error } = await db
    .from("slack_ops_events")
    .select("*")
    .eq("channel_id", SLACK_OPS_CHANNEL_ID)
    .in("message_ts", ids);
  if (error) throw error;
  return (data ?? []) as StoredEvent[];
}

async function loadCandidateRows(events: SlackOpsIncomingEvent[]): Promise<{ trades: TradeRow[]; items: ItemRow[] }> {
  const db = getInventoryAuditServiceClient();
  const times = events.map((event) => eventEpochMs(event.messageTs)).filter(Boolean);
  const min = Math.min(...times, Date.now()) - 45 * 86_400_000;
  const max = Math.max(...times, Date.now()) + 14 * 86_400_000;
  const { data: trades, error: tradeError } = await db
    .from("trades")
    .select("trade_id,customer_name,customer_phone,company,checkout_at,return_at,contract_status,setup_done,return_done,note_checkout,note_checkin,return_counts")
    .gte("return_at", new Date(min).toISOString())
    .lte("checkout_at", new Date(max).toISOString())
    .limit(1_000);
  if (tradeError) throw tradeError;
  const tradeRows = (trades ?? []) as TradeRow[];
  const ids = Array.from(new Set(events.flatMap((event) => tradeRows
    .map((trade) => ({ id: trade.trade_id, score: candidateScore(event, trade) }))
    .filter((candidate) => candidate.score >= 40)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((candidate) => candidate.id))));
  if (!ids.length) return { trades: [], items: [] };
  const items: ItemRow[] = [];
  for (let offset = 0; offset < ids.length; offset += 50) {
    const chunk = ids.slice(offset, offset + 50);
    for (let from = 0; ; from += 1_000) {
      const { data: page, error: itemError } = await db
        .from("schedule_items")
        .select("schedule_id,trade_id,name,qty,taken_qty,actual_name,actual_taken_qty,actual_source,set_name,is_set_header,is_component,onsite,settlement,checkout_state,memo_checkout,memo_checkin")
        .in("trade_id", chunk)
        .order("sort", { ascending: true })
        .range(from, from + 999);
      if (itemError) throw itemError;
      items.push(...((page ?? []) as ItemRow[]));
      if ((page ?? []).length < 1_000) break;
    }
  }
  return { trades: tradeRows, items };
}

function candidateFromTrade(trade: TradeRow, items: ItemRow[], score: number): Candidate {
  return {
    source: "heybilli",
    score,
    tradeId: trade.trade_id,
    customerName: trade.customer_name,
    checkoutAt: trade.checkout_at,
    returnAt: trade.return_at,
    contractStatus: trade.contract_status,
    setupDone: trade.setup_done,
    returnDone: trade.return_done,
    noteCheckout: trade.note_checkout,
    noteCheckin: trade.note_checkin,
    returnCounts: trade.return_counts ?? {},
    items: items.filter((item) => item.trade_id === trade.trade_id).map((item) => ({
      scheduleId: item.schedule_id,
      name: item.name,
      qty: item.qty,
      takenQty: item.taken_qty,
      actualName: item.actual_name,
      actualTakenQty: item.actual_taken_qty,
      onsite: item.onsite,
      settlement: item.settlement,
      memoCheckout: item.memo_checkout,
      memoCheckin: item.memo_checkin,
    })),
  };
}

function kstDateTimeToIso(dateValue: unknown, timeValue: unknown): string {
  const date = cleanText(dateValue, 20);
  const time = cleanText(timeValue, 20) || "00:00";
  const parsed = new Date(`${date}T${/^\d{1,2}:\d{2}$/.test(time) ? time.padStart(5, "0") : "00:00"}:00+09:00`);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : "";
}

function gasCandidateRows(payload: unknown): Array<Record<string, unknown>> {
  const data = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  return [...(Array.isArray(data.checkout) ? data.checkout : []), ...(Array.isArray(data.checkin) ? data.checkin : [])]
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
}

async function findGasCandidates(event: SlackOpsIncomingEvent): Promise<Candidate[]> {
  const query = event.tradeIdHint || event.customerHint;
  if (!query || cleanText(query).length < 2) return [];
  const payload = await gasGet({ action: "dashboardSearch", q: cleanText(query, 120), limit: "20" });
  const rows = gasCandidateRows(payload);
  const byTrade = new Map<string, Record<string, unknown>[] >();
  for (const row of rows) {
    const id = cleanText(row.tradeId, 20);
    if (!TRADE_ID_RE.test(id)) continue;
    (byTrade.get(id) ?? byTrade.set(id, []).get(id)!).push(row);
  }

  const out: Candidate[] = [];
  for (const [tradeId, grouped] of byTrade) {
    const checkout = grouped.find((row) => row._type === "checkout") ?? grouped[0];
    const checkin = grouped.find((row) => row._type === "checkin") ?? grouped[grouped.length - 1];
    const tradeLike: TradeRow = {
      trade_id: tradeId,
      customer_name: cleanText(checkout.name || checkin.name, 120),
      customer_phone: null,
      company: null,
      checkout_at: kstDateTimeToIso(checkout.searchDate || checkout.sortDate, checkout.time || checkout.sortTime),
      return_at: kstDateTimeToIso(checkin.searchDate || checkin.sortDate || checkout.returnDate, checkin.time || checkin.sortTime),
      contract_status: cleanText(checkout.contractStatus || checkin.contractStatus, 30) || "예약",
      setup_done: checkout.setupDone === true,
      return_done: checkin.returnDone === true,
      note_checkout: null,
      note_checkin: cleanText(checkin.returnMemo, 2_000) || null,
      return_counts: {},
    };
    if (!tradeLike.checkout_at || !tradeLike.return_at) continue;
    const score = candidateScore(event, tradeLike);
    if (score < 40) continue;
    const rawItems = Array.isArray(checkout.equipments) ? checkout.equipments : Array.isArray(checkin.equipments) ? checkin.equipments : [];
    out.push({
      source: "gas",
      score,
      tradeId,
      customerName: tradeLike.customer_name,
      checkoutAt: tradeLike.checkout_at,
      returnAt: tradeLike.return_at,
      contractStatus: tradeLike.contract_status,
      setupDone: tradeLike.setup_done,
      returnDone: tradeLike.return_done,
      noteCheckin: tradeLike.note_checkin,
      items: rawItems.filter((item): item is Record<string, unknown> => !!item && typeof item === "object").map((item) => ({
        scheduleId: cleanText(item.scheduleId, 80),
        name: cleanText(item.name, 300),
        qty: Math.max(1, Number.parseInt(cleanText(item.qty, 20), 10) || 1),
      })),
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

export async function scanSlackOpsEvents(values: unknown[]): Promise<{ pending: Array<{ event: StoredEvent; candidates: Candidate[] }> }> {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_EVENTS) {
    throw new Error(`events는 1~${MAX_EVENTS}건이어야 합니다`);
  }
  const events = values.map(sanitizeIncomingEvent);
  const stored = await upsertScannedEvents(events);
  const storedByTs = new Map(stored.map((row) => [row.message_ts, row]));
  const pendingEvents = events.filter((event) => {
    const row = storedByTs.get(event.messageTs);
    return row?.status === "pending" || row?.status === "error";
  });
  if (!pendingEvents.length) return { pending: [] };

  const { trades, items } = await loadCandidateRows(pendingEvents);
  const pending = await Promise.all(pendingEvents.map(async (event) => {
    const direct = trades
      .map((trade) => ({ trade, score: candidateScore(event, trade) }))
      .filter(({ score }) => score >= 40)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ trade, score }) => candidateFromTrade(trade, items, score));
    const gas = direct.length ? [] : await findGasCandidates(event).catch(() => []);
    return { event: storedByTs.get(event.messageTs)!, candidates: direct.length ? direct : gas };
  }));
  return { pending };
}

function incomingFromStored(event: StoredEvent): SlackOpsIncomingEvent {
  return {
    channelId: event.channel_id,
    messageTs: event.message_ts,
    threadTs: event.thread_ts,
    sourceHash: event.source_hash,
    phaseHint: event.phase_hint === "checkout" || event.phase_hint === "checkin" ? event.phase_hint : "unknown",
    customerHint: event.customer_hint || undefined,
    tradeIdHint: event.trade_id_hint || undefined,
    permalink: event.permalink || undefined,
    root: event.raw_context?.root || { ts: event.message_ts, text: "Slack 원문" },
    replies: event.raw_context?.replies || [],
  };
}

async function assertUniqueTopCandidate(event: StoredEvent, tradeId: string): Promise<void> {
  const incoming = incomingFromStored(event);
  const { trades, items } = await loadCandidateRows([incoming]);
  let candidates = trades
    .map((trade) => ({ trade, score: candidateScore(incoming, trade) }))
    .filter(({ score }) => score >= 40)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map(({ trade, score }) => candidateFromTrade(trade, items, score));
  if (!candidates.length) candidates = await findGasCandidates(incoming).catch(() => []);

  const selected = candidates.find((candidate) => candidate.tradeId === tradeId);
  const topScore = candidates[0]?.score ?? 0;
  const topCount = candidates.filter((candidate) => candidate.score === topScore).length;
  if (!selected || selected.score < 100 || selected.score !== topScore || topCount !== 1) {
    throw new Error("거래가 이 Slack 사건의 유일한 최상위 후보가 아닙니다. 거래ID/대여자 확인이 필요합니다");
  }
}

function sanitizePlan(value: unknown): SlackOpsApplyPlan {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const phase = cleanText(raw.phase, 20);
  const tradeId = cleanText(raw.tradeId, 20);
  const sourceHash = cleanText(raw.sourceHash, 128);
  const summary = cleanText(raw.summary, 2_000);
  if (cleanText(raw.channelId, 80) !== SLACK_OPS_CHANNEL_ID) throw new Error("허용되지 않은 Slack 채널");
  if (!/^\d{9,12}\.\d{4,8}$/.test(cleanText(raw.messageTs, 32))) throw new Error("잘못된 messageTs");
  if (!/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error("잘못된 sourceHash");
  if (!TRADE_ID_RE.test(tradeId)) throw new Error("잘못된 거래ID");
  if (phase !== "checkout" && phase !== "checkin") throw new Error("phase는 checkout/checkin이어야 합니다");
  if (!summary) throw new Error("summary가 비어 있습니다");
  const actions = Array.isArray(raw.actions) ? raw.actions.slice(0, 30) : [];
  return {
    channelId: SLACK_OPS_CHANNEL_ID,
    messageTs: cleanText(raw.messageTs, 32),
    sourceHash,
    tradeId,
    phase,
    summary,
    actions: actions.map((action) => sanitizeAction(action)),
  };
}

function nonnegativeInt(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 10_000) throw new Error(`${field}는 0 이상의 정수여야 합니다`);
  return number;
}

function sanitizeAction(value: unknown): ItemCorrectionAction | ItemMemoAction | ReturnCountAction | OnsiteAddAction {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const type = cleanText(raw.type, 40);
  if (type === "item_correction") {
    const actualName = cleanText(raw.actualName, 300) || undefined;
    const actualTakenQty = raw.actualTakenQty == null ? undefined : nonnegativeInt(raw.actualTakenQty, "actualTakenQty");
    if (actualName == null && actualTakenQty == null && !cleanText(raw.memo, 1_000)) throw new Error("item_correction 변경값이 없습니다");
    return { type, scheduleId: cleanText(raw.scheduleId, 100), actualName, actualTakenQty, memo: cleanText(raw.memo, 1_000) || undefined };
  }
  if (type === "item_memo") {
    const memo = cleanText(raw.memo, 1_000);
    if (!memo) throw new Error("item_memo가 비어 있습니다");
    return { type, scheduleId: cleanText(raw.scheduleId, 100), memo };
  }
  if (type === "return_count") {
    return {
      type,
      scheduleId: cleanText(raw.scheduleId, 100),
      good: nonnegativeInt(raw.good, "good"),
      damaged: nonnegativeInt(raw.damaged, "damaged"),
      lost: nonnegativeInt(raw.lost, "lost"),
      reportedMissing: raw.reportedMissing == null ? undefined : nonnegativeInt(raw.reportedMissing, "reportedMissing"),
      memo: cleanText(raw.memo, 1_000) || undefined,
    };
  }
  if (type === "onsite_add") {
    const settlementRaw = cleanText(raw.settlement, 20);
    const settlement: OnsiteAddAction["settlement"] = settlementRaw === "무상" || settlementRaw === "유상" ? settlementRaw : "미정";
    const items = (Array.isArray(raw.items) ? raw.items : []).slice(0, 20).map((entry) => {
      const item = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
      return { name: cleanText(item.name, 300), qty: Math.max(1, nonnegativeInt(item.qty, "onsite qty")) };
    }).filter((item) => item.name);
    if (!items.length) throw new Error("onsite_add 품목이 비어 있습니다");
    return { type, settlement, items };
  }
  throw new Error(`허용되지 않은 action: ${type || "없음"}`);
}

function actualQty(item: ItemRow): number {
  return item.actual_taken_qty ?? item.taken_qty ?? item.qty;
}

function noteBlock(event: StoredEvent, text: string): string {
  const date = new Date(eventEpochMs(event.message_ts));
  const label = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
  const link = event.permalink ? `\n원문: ${event.permalink}` : "";
  return `[Slack #단톡방 · ${label} · ${event.message_ts}]\n${cleanText(text, 2_000)}${link}`;
}

function upsertNoteBlock(existing: unknown, event: StoredEvent, text: string): string {
  const current = cleanText(existing, 20_000);
  const block = noteBlock(event, text);
  const marker = `[Slack #단톡방 ·`;
  const tsMarker = `· ${event.message_ts}]`;
  const chunks = current ? current.split(/\n{2,}/) : [];
  const kept = chunks.filter((chunk) => !(chunk.startsWith(marker) && chunk.includes(tsMarker)));
  return [...kept, block].filter(Boolean).join("\n\n").slice(-20_000);
}

async function gasTradeSnapshot(tradeId: string): Promise<{ trade: TradeRow; items: ItemRow[]; persistRows: { trade: Record<string, unknown>; items: Array<Record<string, unknown>> } }> {
  const payload = await gasGet({ action: "dashboardSearch", q: tradeId, limit: "20" });
  const grouped = gasCandidateRows(payload).filter((row) => cleanText(row.tradeId, 20) === tradeId);
  if (!grouped.length) throw new Error(`GAS 원장에서도 거래를 찾지 못했습니다: ${tradeId}`);
  const checkout = grouped.find((row) => row._type === "checkout") ?? grouped[0];
  const checkin = grouped.find((row) => row._type === "checkin") ?? grouped[grouped.length - 1];
  const checkoutAt = kstDateTimeToIso(checkout.searchDate || checkout.sortDate, checkout.time || checkout.sortTime);
  const returnAt = kstDateTimeToIso(checkin.searchDate || checkin.sortDate || checkout.returnDate, checkin.time || checkin.sortTime);
  if (!checkoutAt || !returnAt) throw new Error(`GAS 거래 날짜를 읽지 못했습니다: ${tradeId}`);
  const status = cleanText(checkout.contractStatus || checkin.contractStatus, 30) || "예약";
  const started = checkout.setupDone === true || checkin.returnDone === true || status === "반출" || status === "반납완료";
  const row: Record<string, unknown> = {
    trade_id: tradeId,
    customer_name: cleanText(checkout.name || checkin.name, 120) || "이름 미확인",
    customer_phone: cleanText(checkout.tel || checkin.tel, 80) || null,
    company: cleanText(checkout.company || checkin.company, 200) || null,
    checkout_at: checkoutAt,
    return_at: returnAt,
    contract_status: status,
    setup_done: checkout.setupDone === true || status === "반출" || status === "반납완료",
    setup_done_at: checkout.setupDoneAt || null,
    return_done: checkin.returnDone === true || status === "반납완료",
    return_done_at: checkin.returnDoneAt || null,
    payment_method: checkout.paymentMethod || null,
    deposit_status: checkout.depositStatus || null,
    proof_type: checkout.proofType || null,
    issue_status: checkout.issueStatus || null,
    billing_company: checkout.billingCompany || null,
    amount: typeof checkout.actualAmount === "number" ? checkout.actualAmount : null,
    contract_url: checkout.contractUrl || null,
    contract_regen_pending: checkout.contractRegenPending === true,
    note_checkin: cleanText(checkin.returnMemo, 2_000) || null,
    photos: [],
    risk_warnings: [],
    return_counts: {},
  };
  const rawItems = Array.isArray(checkout.equipments) ? checkout.equipments : Array.isArray(checkin.equipments) ? checkin.equipments : [];
  const itemRows = rawItems.filter((item): item is Record<string, unknown> => !!item && typeof item === "object").map((item, index) => {
    const qty = Math.max(1, Number.parseInt(cleanText(item.qty, 20), 10) || 1);
    return {
      schedule_id: cleanText(item.scheduleId, 100), trade_id: tradeId, sort: index,
      name: cleanText(item.name, 300) || "장비", qty,
      taken_qty: started ? qty : null,
      set_name: cleanText(item.setName, 300) || null,
      is_set_header: item.isHeader === true,
      is_component: item.isComponent === true,
      onsite: false,
      checkout_state: started ? "taken" : "pending",
    };
  }).filter((item) => item.schedule_id);
  const trade: TradeRow = {
    trade_id: tradeId,
    customer_name: String(row.customer_name),
    customer_phone: row.customer_phone as string | null,
    company: row.company as string | null,
    checkout_at: checkoutAt,
    return_at: returnAt,
    contract_status: status,
    setup_done: row.setup_done === true,
    return_done: row.return_done === true,
    note_checkout: null,
    note_checkin: row.note_checkin as string | null,
    return_counts: {},
  };
  const items: ItemRow[] = itemRows.map((item) => ({
    schedule_id: String(item.schedule_id), trade_id: tradeId, name: String(item.name), qty: Number(item.qty),
    taken_qty: item.taken_qty as number | null, actual_name: null, actual_taken_qty: null, actual_source: null,
    set_name: item.set_name as string | null, is_set_header: item.is_set_header === true,
    is_component: item.is_component === true, onsite: false, settlement: null,
    checkout_state: String(item.checkout_state), memo_checkout: null, memo_checkin: null,
  }));
  return { trade, items, persistRows: { trade: row, items: itemRows } };
}

async function importGasTrade(tradeId: string): Promise<{ trade: TradeRow; items: ItemRow[] }> {
  const snapshot = await gasTradeSnapshot(tradeId);
  const db = getInventoryAuditServiceClient();
  const { error: tradeError } = await db.from("trades").upsert(snapshot.persistRows.trade, { onConflict: "trade_id" });
  if (tradeError) throw tradeError;
  if (snapshot.persistRows.items.length) {
    const { error: itemError } = await db.from("schedule_items").upsert(snapshot.persistRows.items, { onConflict: "schedule_id" });
    if (itemError) throw itemError;
  }
  const { data, error } = await db.from("trades")
    .select("trade_id,customer_name,customer_phone,company,checkout_at,return_at,contract_status,setup_done,return_done,note_checkout,note_checkin,return_counts")
    .eq("trade_id", tradeId).single();
  if (error) throw error;
  return { trade: data as TradeRow, items: snapshot.items };
}

async function loadTradeAndItems(tradeId: string, execute: boolean): Promise<{ trade: TradeRow; items: ItemRow[]; imported: boolean }> {
  const db = getInventoryAuditServiceClient();
  let { data: trade, error } = await db.from("trades")
    .select("trade_id,customer_name,customer_phone,company,checkout_at,return_at,contract_status,setup_done,return_done,note_checkout,note_checkin,return_counts")
    .eq("trade_id", tradeId).maybeSingle();
  if (error) throw error;
  let imported = false;
  if (!trade) {
    if (!execute) {
      const snapshot = await gasTradeSnapshot(tradeId);
      return { trade: snapshot.trade, items: snapshot.items, imported: true };
    }
    const importedTrade = await importGasTrade(tradeId);
    trade = importedTrade.trade;
    imported = true;
  }
  const { data: items, error: itemError } = await db.from("schedule_items")
    .select("schedule_id,trade_id,name,qty,taken_qty,actual_name,actual_taken_qty,actual_source,set_name,is_set_header,is_component,onsite,settlement,checkout_state,memo_checkout,memo_checkin")
    .eq("trade_id", tradeId).order("sort", { ascending: true });
  if (itemError) throw itemError;
  return { trade: trade as TradeRow, items: (items ?? []) as ItemRow[], imported };
}

function validateActions(plan: SlackOpsApplyPlan, items: ItemRow[]) {
  const byId = new Map(items.map((item) => [item.schedule_id, item]));
  const plannedTakenQty = new Map<string, number>();
  for (const action of plan.actions ?? []) {
    if (action.type === "item_correction" && action.actualTakenQty != null) plannedTakenQty.set(action.scheduleId, action.actualTakenQty);
  }
  for (const action of plan.actions ?? []) {
    if (action.type === "onsite_add") continue;
    const item = byId.get(action.scheduleId);
    if (!item) throw new Error(`거래에 없는 scheduleId: ${action.scheduleId}`);
    if (action.type === "item_correction" && action.actualTakenQty != null && action.actualTakenQty > item.qty) {
      throw new Error(`실반출 수량이 예약 수량보다 큽니다. 추가분은 onsite_add로 기록하세요: ${action.scheduleId}`);
    }
    if (action.type === "return_count") {
      const expected = plannedTakenQty.get(action.scheduleId) ?? actualQty(item);
      const accounted = action.good + action.damaged + action.lost;
      if (accounted > expected) throw new Error(`반납 합계가 실반출 수량을 초과합니다: ${action.scheduleId}`);
      if (action.reportedMissing != null && accounted + action.reportedMissing !== expected) {
        throw new Error(`정상/파손/분실/미반납 합계가 실반출 수량과 다릅니다: ${action.scheduleId}`);
      }
    }
  }
}

async function previewOnsiteActions(plan: SlackOpsApplyPlan) {
  const previews = [];
  let onsiteIndex = 0;
  for (const action of plan.actions ?? []) {
    if (action.type !== "onsite_add") continue;
    const idempotencyKey = `${plan.channelId}:${plan.messageTs}:${plan.sourceHash}:onsite:${onsiteIndex++}`;
    const result = await gasPost({
      action: "onsiteAddon",
      tid: plan.tradeId,
      entries: JSON.stringify(action.items),
      rawNames: true,
      settlement_status: action.settlement,
      actorName: "Hermes Slack 동기화",
      directRegenerate: false,
      dryRun: true,
      idempotencyKey,
    }) as Record<string, unknown>;
    if (result?.error) throw new Error(cleanText(result.error, 1_000));
    previews.push(result);
  }
  return previews;
}

async function executeOnsiteActions(plan: SlackOpsApplyPlan) {
  const results = [];
  let onsiteIndex = 0;
  for (const action of plan.actions ?? []) {
    if (action.type !== "onsite_add") continue;
    const idempotencyKey = `${plan.channelId}:${plan.messageTs}:${plan.sourceHash}:onsite:${onsiteIndex++}`;
    const result = await gasPost({
      action: "onsiteAddon",
      tid: plan.tradeId,
      entries: JSON.stringify(action.items),
      rawNames: true,
      settlement_status: action.settlement,
      actorName: "Hermes Slack 동기화",
      directRegenerate: false,
      dryRun: false,
      idempotencyKey,
    }) as Record<string, unknown>;
    if (result?.error) throw new Error(cleanText(result.error, 1_000));
    results.push(result);
  }
  return results;
}

export async function applySlackOpsPlan(value: unknown, execute: boolean) {
  const plan = sanitizePlan(value);
  const db = getInventoryAuditServiceClient();
  const { data, error } = await db.from("slack_ops_events").select("*")
    .eq("channel_id", plan.channelId).eq("message_ts", plan.messageTs).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("먼저 scan을 실행해야 합니다");
  const event = data as StoredEvent;
  if (event.source_hash !== plan.sourceHash) throw new Error("Slack 스레드가 바뀌었습니다. 다시 scan해 주세요");
  if (event.status === "applied" && JSON.stringify(event.applied_plan) === JSON.stringify(plan)) {
    return { ok: true, duplicate: true, execute, tradeId: plan.tradeId };
  }

  await assertUniqueTopCandidate(event, plan.tradeId);

  const { trade, items, imported } = await loadTradeAndItems(plan.tradeId, execute);
  validateActions(plan, items);
  const onsitePreview = await previewOnsiteActions(plan);
  const preview = {
    tradeId: plan.tradeId,
    customerName: trade.customer_name,
    phase: plan.phase,
    summary: plan.summary,
    actions: plan.actions ?? [],
    onsitePreview,
    importedFromGas: imported,
  };
  if (!execute) return { ok: true, dryRun: true, preview };

  const applying = await db.from("slack_ops_events").update({ status: "applying", last_error: null })
    .eq("channel_id", plan.channelId).eq("message_ts", plan.messageTs).eq("source_hash", plan.sourceHash)
    .select("message_ts").maybeSingle();
  if (applying.error) throw applying.error;
  if (!applying.data) throw new Error("적용 직전에 Slack 원문이 변경되었습니다");

  try {
    const onsiteResults = await executeOnsiteActions(plan);
    const correctionSource = {
      kind: "slack", channelId: event.channel_id, messageTs: event.message_ts,
      permalink: event.permalink || undefined, correctedAt: new Date().toISOString(),
    };
    const returnCounts = { ...(trade.return_counts ?? {}) };
    for (const action of plan.actions ?? []) {
      if (action.type === "onsite_add") continue;
      const item = items.find((candidate) => candidate.schedule_id === action.scheduleId)!;
      if (action.type === "item_correction") {
        const patch: Record<string, unknown> = { actual_source: correctionSource };
        if (action.actualName != null) patch.actual_name = action.actualName;
        if (action.actualTakenQty != null) patch.actual_taken_qty = action.actualTakenQty;
        if (action.memo) {
          patch[plan.phase === "checkout" ? "memo_checkout" : "memo_checkin"] = upsertNoteBlock(
            plan.phase === "checkout" ? item.memo_checkout : item.memo_checkin, event, action.memo,
          );
        }
        const result = await db.from("schedule_items").update(patch).eq("schedule_id", action.scheduleId).eq("trade_id", plan.tradeId);
        if (result.error) throw result.error;
      } else if (action.type === "item_memo") {
        const field = plan.phase === "checkout" ? "memo_checkout" : "memo_checkin";
        const result = await db.from("schedule_items").update({
          [field]: upsertNoteBlock(field === "memo_checkout" ? item.memo_checkout : item.memo_checkin, event, action.memo),
        }).eq("schedule_id", action.scheduleId).eq("trade_id", plan.tradeId);
        if (result.error) throw result.error;
      } else if (action.type === "return_count") {
        returnCounts[action.scheduleId] = {
          good: action.good, damaged: action.damaged, lost: action.lost,
          reportedMissing: action.reportedMissing,
          memo: action.memo ? upsertNoteBlock(returnCounts[action.scheduleId]?.memo, event, action.memo) : returnCounts[action.scheduleId]?.memo,
        };
      }
    }

    const noteField = plan.phase === "checkout" ? "note_checkout" : "note_checkin";
    const noteValue = upsertNoteBlock(noteField === "note_checkout" ? trade.note_checkout : trade.note_checkin, event, plan.summary);
    const tradePatch: Record<string, unknown> = { [noteField]: noteValue };
    if ((plan.actions ?? []).some((action) => action.type === "return_count")) tradePatch.return_counts = returnCounts;
    const tradeUpdate = await db.from("trades").update(tradePatch).eq("trade_id", plan.tradeId).select("trade_id").maybeSingle();
    if (tradeUpdate.error) throw tradeUpdate.error;
    if (!tradeUpdate.data) throw new Error(`거래 업데이트 실패: ${plan.tradeId}`);

    const completed = await db.from("slack_ops_events").update({
      status: "applied", matched_trade_id: plan.tradeId, applied_plan: plan,
      applied_at: new Date().toISOString(), last_error: null,
    }).eq("channel_id", plan.channelId).eq("message_ts", plan.messageTs).eq("source_hash", plan.sourceHash);
    if (completed.error) throw completed.error;
    return { ok: true, dryRun: false, preview, onsiteResults };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.from("slack_ops_events").update({ status: "error", last_error: message.slice(0, 2_000) })
      .eq("channel_id", plan.channelId).eq("message_ts", plan.messageTs);
    throw error;
  }
}

export async function markSlackOpsEvent(value: unknown, status: "needs_context" | "ignored", reason: string) {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const messageTs = cleanText(raw.messageTs, 32);
  const sourceHash = cleanText(raw.sourceHash, 128);
  if (!/^\d{9,12}\.\d{4,8}$/.test(messageTs) || !/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error("잘못된 이벤트 식별자");
  const db = getInventoryAuditServiceClient();
  const result = await db.from("slack_ops_events").update({ status, last_error: cleanText(reason, 2_000) || null })
    .eq("channel_id", SLACK_OPS_CHANNEL_ID).eq("message_ts", messageTs).eq("source_hash", sourceHash)
    .select("message_ts").maybeSingle();
  if (result.error) throw result.error;
  if (!result.data) throw new Error("Slack 스레드가 바뀌었거나 이벤트가 없습니다");
  return { ok: true, status, messageTs };
}
