"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase/client";
import { ViewHeader } from "@/components/ViewHeader";
import { Check, ChevronRight, History, Pencil, Refresh, Search } from "@/components/icons";
import { EquipmentBlackbox } from "@/components/EquipmentBlackbox";
import { InventoryAuditMvp } from "@/components/inventory-audit/InventoryAuditMvp";
import { normalizeStockName } from "@/lib/data/equipmentStock";
import nameLinkQueueJson from "@/lib/data/nameLinkQueue.json";

// 재고 — village.equipment_ledger(재고관리대장) 뷰 + 실물 확인(검증) 플로우.
// 275행 전체 1회 로드(페이지네이션 불필요) → 칩 필터/검색 + 옵티미스틱 업데이트 + equipment_events 이력.
// 원장 테이블이 아직 없으면(마이그레이션 전) 안내 문구만 — 크래시 금지.

type VerifyStatus = "unverified" | "verified" | "attention";

type OpenIssue = { label: string; tradeId?: string; at?: string };

type LedgerRow = {
  equipment_id: string;
  major: string | null;
  category: string | null;
  name: string;
  aliases: string[];
  stock_total: number | null;
  stock_maint: number;
  price: number | null;
  state: string;
  note: string | null;
  verify_status: VerifyStatus;
  last_verified_at: string | null;
  last_verified_by: string | null;
  last_activity_at: string | null;
  open_issues: OpenIssue[];
};

type FilterKey = "all" | "attention" | "unverified" | "verified";

type VerifyDraft = { count: string; issueOn: boolean; issueLabel: string };

// 장비명/수량/비고/문제 인라인 편집 초안 — 기존 항목의 tradeId/at 메타는 유지하고 label만 고침
// stockTotal 빈칸 = 미기록(null), stockMaint 빈칸 = 0
type IssueEditDraft = { name: string; note: string; issues: OpenIssue[]; stockTotal: string; stockMaint: string };

// 장비 추가 초안 — 대분류는 카테고리 선택 시 자동 추천(직접 고르면 그대로 유지)
type AddDraft = {
  name: string;
  category: string;
  majorSel: string; // 기존 대분류 값 또는 "__custom__"(직접 입력)
  majorCustom: string;
  majorTouched: boolean;
  count: string;
  price: string;
  note: string;
};

const EMPTY_ADD_DRAFT: AddDraft = { name: "", category: "", majorSel: "", majorCustom: "", majorTouched: false, count: "1", price: "", note: "" };

// 보관 처리(소프트 삭제) — 스키마 변경 없이 state 컬럼 재사용
const ARCHIVED_STATE = "보관종료";

// ── 이름 연결 큐 — 대여기록 장비명 ↔ 원장 장비명 불일치 해소 작업 목록 ──
// 해결 판정: (a) 정규화 이름이 활성 원장 이름/별칭과 일치, (b) SYS-000 name_link_decision 이벤트 존재
type QueueCandidate = { id: string; name: string };
type QueueLinkItem = { name: string; count: number; candidates: QueueCandidate[] };
type QueueAddItem = { name: string; count: number };

const NAME_LINK_QUEUE = nameLinkQueueJson as { generatedAt: string; link: QueueLinkItem[]; add: QueueAddItem[] };
const QUEUE_TOTAL = NAME_LINK_QUEUE.link.length + NAME_LINK_QUEUE.add.length;
const QUEUE_PAGE = 15;
// 이름연결 결정 기록용 센티널 행 — 원장 목록(보관됨 포함)에 절대 노출하지 않음
const SYS_EQUIPMENT_ID = "SYS-000";

const STATUS_LABEL: Record<VerifyStatus, string> = {
  attention: "주의",
  unverified: "미검증",
  verified: "확인됨",
};
const STATUS_CHIP: Record<VerifyStatus, string> = {
  attention: "bg-attention-bg text-attention-fg",
  unverified: "bg-line/40 text-ink-mute",
  verified: "bg-checkin-bg text-checkin-fg",
};

function asVerifyStatus(v: unknown): VerifyStatus {
  return v === "verified" || v === "attention" ? v : "unverified";
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x ?? "")).filter(Boolean) : [];
}
function asIssues(v: unknown): OpenIssue[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
    .map((x) => ({
      label: String(x.label ?? ""),
      tradeId: x.tradeId != null ? String(x.tradeId) : undefined,
      at: x.at != null ? String(x.at) : undefined,
    }))
    .filter((x) => x.label);
}
/* eslint-disable-next-line @typescript-eslint/no-explicit-any */
function rowFromDb(r: any): LedgerRow {
  return {
    equipment_id: String(r.equipment_id ?? ""),
    major: r.major ?? null,
    category: r.category ?? null,
    name: String(r.name ?? ""),
    aliases: asStringArray(r.aliases),
    stock_total: r.stock_total ?? null,
    stock_maint: Number(r.stock_maint) || 0,
    price: r.price ?? null,
    state: String(r.state ?? "정상"),
    note: r.note ?? null,
    verify_status: asVerifyStatus(r.verify_status),
    last_verified_at: r.last_verified_at ?? null,
    last_verified_by: r.last_verified_by ?? null,
    last_activity_at: r.last_activity_at ?? null,
    open_issues: asIssues(r.open_issues),
  };
}

function fmtMd(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

// 장비ID 자동 생성 — 접두어는 같은 카테고리에서 가장 흔한 것(없으면 ETC),
// 순번은 보관 포함 전체 행에서 해당 접두어 최대 숫자 + 1 (3자리 0패딩)
function idPrefixOf(equipmentId: string): string | null {
  const m = equipmentId.match(/^([A-Za-z]+)-/);
  return m ? m[1] : null;
}
function genEquipmentId(rows: LedgerRow[], category: string): string {
  const prefixCounts = new Map<string, number>();
  for (const r of rows) {
    if ((r.category ?? "") !== category) continue;
    const p = idPrefixOf(r.equipment_id);
    if (!p) continue;
    prefixCounts.set(p, (prefixCounts.get(p) ?? 0) + 1);
  }
  let prefix = "ETC";
  let best = 0;
  for (const [p, c] of prefixCounts) {
    if (c > best) {
      best = c;
      prefix = p;
    }
  }
  let maxSeq = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const r of rows) {
    const m = r.equipment_id.match(re);
    if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
  }
  return `${prefix}-${String(maxSeq + 1).padStart(3, "0")}`;
}
function bumpEquipmentId(id: string): string {
  const m = id.match(/^(.*)-(\d+)$/);
  if (!m) return `${id}-001`;
  return `${m[1]}-${String(Number(m[2]) + 1).padStart(Math.max(m[2].length, 3), "0")}`;
}

// 오늘 확인할 장비 우선순위: 주의(단가 높은 순) → 미검증(단가 높은 순) → 확인됨(확인이 오래된 순 = 롤링 재점검)
const byPriceDesc = (a: LedgerRow, b: LedgerRow) => (b.price ?? -1) - (a.price ?? -1);
const byOldestVerified = (a: LedgerRow, b: LedgerRow) => (a.last_verified_at ?? "").localeCompare(b.last_verified_at ?? "");
function todayPicks(rows: LedgerRow[], limit = 10): LedgerRow[] {
  const attention = rows.filter((r) => r.verify_status === "attention").sort(byPriceDesc);
  const unverified = rows.filter((r) => r.verify_status === "unverified").sort(byPriceDesc);
  const verified = rows.filter((r) => r.verify_status === "verified").sort(byOldestVerified);
  return [...attention, ...unverified, ...verified].slice(0, limit);
}

export function InventoryView() {
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "unavailable">("loading");
  const [auditLocked, setAuditLocked] = useState(true);
  const [filter, setFilter] = useState<FilterKey>("all");
  const [q, setQ] = useState("");
  const [userEmail, setUserEmail] = useState<string | null>(null);

  // 확인(검증) 인라인 스테퍼 — 한 번에 한 행만 펼침. 같은 장비가 두 섹션에 보여도 누른 쪽만 펼침("섹션:장비ID")
  // 비고/문제 편집 패널은 "edit:장비ID" — 같은 openKey를 쓰므로 스테퍼와 동시에 열리지 않음
  const [openKey, setOpenKey] = useState<string | null>(null);
  // 블랙박스(장비 이력) 시트 — 파손/분실 분쟁 때 최근 거래·사진 증거 타임라인
  const [blackbox, setBlackbox] = useState<LedgerRow | null>(null);
  const [draft, setDraft] = useState<VerifyDraft>({ count: "0", issueOn: false, issueLabel: "" });
  const [editDraft, setEditDraft] = useState<IssueEditDraft>({ name: "", note: "", issues: [], stockTotal: "", stockMaint: "0" });

  // 장비 추가 패널 + 보관 목록 토글
  const [addOpen, setAddOpen] = useState(false);
  const [addDraft, setAddDraft] = useState<AddDraft>(EMPTY_ADD_DRAFT);
  const [showArchived, setShowArchived] = useState(false);

  // 이름 연결 큐 — SYS-000 결정 이력(해당 없음/무시) + 카드 펼침/표시 개수
  const [linkDecisions, setLinkDecisions] = useState<Set<string>>(new Set());
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkShown, setLinkShown] = useState(QUEUE_PAGE);

  // 토스트 (뷰 로컬 — 스토어 저장 토스트와 동일 룩)
  const [toast, setToast] = useState<{ id: number; text: string; ok: boolean } | null>(null);
  const toastSeq = useRef(0);
  const showToast = useCallback((text: string, ok = true) => {
    const id = ++toastSeq.current;
    setToast({ id, text, ok });
    window.setTimeout(() => setToast((t) => (t?.id === id ? null : t)), 2000);
  }, []);

  const load = useCallback(async () => {
    if (!supabase) {
      setPhase("unavailable");
      return;
    }
    try {
      const [ledgerRes, decisionRes] = await Promise.all([
        supabase.from("equipment_ledger").select("*").order("equipment_id"),
        // 이름연결 결정 이력 (SYS-000) — 실패해도 큐만 미해결로 남을 뿐 화면은 정상
        supabase.from("equipment_events").select("payload").eq("equipment_id", SYS_EQUIPMENT_ID).eq("type", "name_link_decision"),
      ]);
      // 테이블 미생성(PGRST205/42P01) 포함 모든 에러 → 안내 문구로 강등 (크래시 금지)
      if (ledgerRes.error) throw ledgerRes.error;
      setRows((ledgerRes.data ?? []).map(rowFromDb));
      if (decisionRes.error) {
        console.error("[inventory] 이름연결 이력 로드 실패", decisionRes.error);
      } else {
        const decided = new Set<string>();
        for (const ev of decisionRes.data ?? []) {
          const n = (ev as { payload?: { name?: unknown } })?.payload?.name;
          if (typeof n === "string" && n) decided.add(n);
        }
        setLinkDecisions(decided);
      }
      setPhase("ready");
    } catch (e) {
      console.error("[inventory] 원장 로드 실패", e);
      setPhase("unavailable");
    }
  }, []);

  useEffect(() => {
    load();
    supabase?.auth.getSession().then(({ data }) => setUserEmail(data.session?.user?.email ?? null)).catch(() => {});
  }, [load]);

  // 보관종료 행은 모든 목록/칩/검증률/오늘 확인에서 제외 — 하단 "보관됨 보기"에서만 노출
  // SYS-000(이름연결 센티널)은 보관됨 목록에서도 숨김
  const activeRows = useMemo(() => rows.filter((r) => r.state !== ARCHIVED_STATE), [rows]);
  const archivedRows = useMemo(
    () => rows.filter((r) => r.state === ARCHIVED_STATE && r.equipment_id !== SYS_EQUIPMENT_ID),
    [rows],
  );

  // 이름 연결 큐 미해결 항목 — 원장 이름/별칭 매칭 또는 SYS-000 결정으로 해결됨 처리 (재접속·다기기 안전)
  const ledgerNameKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const r of activeRows) {
      keys.add(normalizeStockName(r.name));
      for (const a of r.aliases) keys.add(normalizeStockName(a));
    }
    keys.delete("");
    return keys;
  }, [activeRows]);
  const isQueueResolved = useCallback(
    (name: string) => ledgerNameKeys.has(normalizeStockName(name)) || linkDecisions.has(name),
    [ledgerNameKeys, linkDecisions],
  );
  const pendingLink = useMemo(() => NAME_LINK_QUEUE.link.filter((it) => !isQueueResolved(it.name)), [isQueueResolved]);
  const pendingAdd = useMemo(() => NAME_LINK_QUEUE.add.filter((it) => !isQueueResolved(it.name)), [isQueueResolved]);
  const queuePending = pendingLink.length + pendingAdd.length;

  const counts = useMemo(
    () => ({
      all: activeRows.length,
      attention: activeRows.filter((r) => r.verify_status === "attention").length,
      unverified: activeRows.filter((r) => r.verify_status === "unverified").length,
      verified: activeRows.filter((r) => r.verify_status === "verified").length,
    }),
    [activeRows],
  );
  const verifiedPct = counts.all ? Math.round((counts.verified / counts.all) * 100) : 0;

  const picks = useMemo(() => todayPicks(activeRows), [activeRows]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return activeRows.filter((r) => {
      if (filter !== "all" && r.verify_status !== filter) return false;
      if (!needle) return true;
      return (
        r.name.toLowerCase().includes(needle) ||
        r.equipment_id.toLowerCase().includes(needle) ||
        r.aliases.some((a) => a.toLowerCase().includes(needle))
      );
    });
  }, [activeRows, filter, q]);

  // 장비 추가 폼 보조 데이터 — 카테고리/대분류 후보 + 카테고리별 최다 대분류 추천
  const categories = useMemo(
    () => Array.from(new Set(activeRows.map((r) => (r.category ?? "").trim()).filter(Boolean))).sort(),
    [activeRows],
  );
  const majors = useMemo(
    () => Array.from(new Set(activeRows.map((r) => (r.major ?? "").trim()).filter(Boolean))).sort(),
    [activeRows],
  );
  const suggestMajor = useCallback(
    (category: string): string => {
      const tally = new Map<string, number>();
      for (const r of activeRows) {
        if ((r.category ?? "").trim() !== category.trim() || !r.major) continue;
        tally.set(r.major, (tally.get(r.major) ?? 0) + 1);
      }
      let major = "";
      let best = 0;
      for (const [m, c] of tally) {
        if (c > best) {
          best = c;
          major = m;
        }
      }
      return major;
    },
    [activeRows],
  );

  const openVerify = useCallback((section: string, r: LedgerRow) => {
    setOpenKey(`${section}:${r.equipment_id}`);
    setDraft({ count: String(r.stock_total ?? 0), issueOn: false, issueLabel: "" });
  }, []);

  const submitVerify = useCallback(
    async (row: LedgerRow) => {
      if (!supabase) return;
      const counted = Number(draft.count);
      if (!Number.isInteger(counted) || counted < 0) {
        showToast("수량을 숫자로 입력해주세요", false);
        return;
      }
      const nowIso = new Date().toISOString();
      const issueLabel = draft.issueOn ? draft.issueLabel.trim() || "문제 있음" : "";
      const nextStatus: VerifyStatus = draft.issueOn ? "attention" : "verified";
      const nextIssues = draft.issueOn ? [...row.open_issues, { label: issueLabel, at: nowIso }] : row.open_issues;
      const countChanged = row.stock_total !== counted;
      const before = { stock_total: row.stock_total, verify_status: row.verify_status };

      // 옵티미스틱 반영 + 스테퍼 닫기
      const prevRows = rows;
      setRows((prev) =>
        prev.map((r) =>
          r.equipment_id === row.equipment_id
            ? { ...r, stock_total: counted, verify_status: nextStatus, last_verified_at: nowIso, last_verified_by: userEmail, open_issues: nextIssues }
            : r,
        ),
      );
      setOpenKey(null);

      try {
        const { error } = await supabase
          .from("equipment_ledger")
          .update({
            stock_total: counted,
            verify_status: nextStatus,
            last_verified_at: nowIso,
            last_verified_by: userEmail,
            open_issues: nextIssues,
          })
          .eq("equipment_id", row.equipment_id);
        if (error) throw error;
        showToast(`확인 완료: ${row.name}`);
        // 이력은 부가 기록 — 실패해도 원장 반영은 유지 (콘솔에만 남김)
        const { error: evError } = await supabase.from("equipment_events").insert({
          equipment_id: row.equipment_id,
          type: countChanged ? "count_fixed" : "verified",
          payload: {
            before,
            after: { stock_total: counted, verify_status: nextStatus },
            ...(draft.issueOn ? { issue: issueLabel } : {}),
          },
          actor: userEmail,
        });
        if (evError) console.error("[inventory] 이벤트 기록 실패", evError);
      } catch (e) {
        console.error("[inventory] 확인 저장 실패", e);
        setRows(prevRows); // 롤백
        showToast("저장에 실패했어요 — 다시 시도해주세요", false);
      }
    },
    [draft, rows, userEmail, showToast],
  );

  // section: "edit"(전체 목록) | "editToday"(오늘 확인할 장비) — 같은 장비가 두 섹션에 보여도 누른 쪽만 펼침
  const openIssueEdit = useCallback((section: string, r: LedgerRow) => {
    setOpenKey(`${section}:${r.equipment_id}`);
    setEditDraft({
      name: r.name,
      note: r.note ?? "",
      issues: r.open_issues.map((i) => ({ ...i })),
      stockTotal: r.stock_total == null ? "" : String(r.stock_total),
      stockMaint: String(r.stock_maint),
    });
  }, []);

  const submitIssueEdit = useCallback(
    async (row: LedgerRow) => {
      if (!supabase) return;
      const name = editDraft.name.trim();
      if (!name) {
        showToast("장비명을 입력해주세요", false);
        return;
      }
      // 수량 파싱 — 보유수량 빈칸 = 미기록(null), 정비중수량 빈칸 = 0
      const totalStr = editDraft.stockTotal.trim();
      const newTotal = totalStr === "" ? null : Number(totalStr);
      if (newTotal != null && (!Number.isInteger(newTotal) || newTotal < 0)) {
        showToast("보유수량을 숫자로 입력해주세요", false);
        return;
      }
      const maintStr = editDraft.stockMaint.trim();
      const maintRaw = maintStr === "" ? 0 : Number(maintStr);
      if (!Number.isInteger(maintRaw) || maintRaw < 0) {
        showToast("정비중수량을 숫자로 입력해주세요", false);
        return;
      }
      // 정비중수량은 보유수량을 넘지 않게 소프트 클램프 (보유 미기록이면 그대로)
      const newMaint = newTotal == null ? maintRaw : Math.min(maintRaw, newTotal);
      const nowIso = new Date().toISOString();

      // 빈 항목 제거 + 같은 내용 중복 제거 (기존 항목의 tradeId/at은 유지, 새 항목은 지금 시각)
      const seen = new Set<string>();
      const cleaned: OpenIssue[] = [];
      for (const it of editDraft.issues) {
        const label = it.label.trim();
        if (!label || seen.has(label)) continue;
        seen.add(label);
        cleaned.push({ label, ...(it.tradeId ? { tradeId: it.tradeId } : {}), at: it.at ?? nowIso });
      }
      const note = editDraft.note.trim() || null;

      // 상태 재계산: 문제/정비(수정된 값 기준)/비정상 있으면 주의, 없으면 확인 이력 여부로 확인됨/미검증
      // 수량 수정은 기억에 의존한 장부 정정이므로 last_verified_at/by는 건드리지 않음 (실물 확인은 [확인] 플로우)
      const nextStatus: VerifyStatus =
        cleaned.length > 0 || newMaint > 0 || row.state !== "정상"
          ? "attention"
          : row.last_verified_at
            ? "verified"
            : "unverified";

      const nameChanged = name !== row.name;
      const totalChanged = newTotal !== row.stock_total;
      const maintChanged = newMaint !== row.stock_maint;
      const before = { name: row.name, note: row.note, open_issues: row.open_issues, stock_total: row.stock_total, stock_maint: row.stock_maint };

      // 옵티미스틱 반영 + 패널 닫기
      const prevRows = rows;
      setRows((prev) =>
        prev.map((r) =>
          r.equipment_id === row.equipment_id
            ? { ...r, name, note, open_issues: cleaned, verify_status: nextStatus, stock_total: newTotal, stock_maint: newMaint }
            : r,
        ),
      );
      setOpenKey(null);

      try {
        const { error } = await supabase
          .from("equipment_ledger")
          .update({
            note,
            open_issues: cleaned,
            verify_status: nextStatus,
            ...(nameChanged ? { name } : {}),
            ...(totalChanged ? { stock_total: newTotal } : {}),
            ...(maintChanged ? { stock_maint: newMaint } : {}),
          })
          .eq("equipment_id", row.equipment_id);
        if (error) throw error;
        showToast(`수정 완료: ${name}`);
        // 이력은 부가 기록 — 실패해도 원장 반영은 유지 (콘솔에만 남김)
        const { error: evError } = await supabase.from("equipment_events").insert({
          equipment_id: row.equipment_id,
          type: "issue_edited",
          payload: { before, after: { name, note, open_issues: cleaned, stock_total: newTotal, stock_maint: newMaint } },
          actor: userEmail,
        });
        if (evError) console.error("[inventory] 이벤트 기록 실패", evError);
      } catch (e) {
        console.error("[inventory] 비고/문제 저장 실패", e);
        setRows(prevRows); // 롤백
        showToast("저장에 실패했어요 — 다시 시도해주세요", false);
      }
    },
    [editDraft, rows, userEmail, showToast],
  );

  const submitAdd = useCallback(async () => {
    if (!supabase) return;
    const name = addDraft.name.trim();
    if (!name) {
      showToast("장비명을 입력해주세요", false);
      return;
    }
    const count = Number(addDraft.count);
    if (!Number.isInteger(count) || count < 0 || addDraft.count.trim() === "") {
      showToast("보유수량을 숫자로 입력해주세요", false);
      return;
    }
    const price = addDraft.price.trim() ? Number(addDraft.price) : null;
    if (price != null && (!Number.isInteger(price) || price < 0)) {
      showToast("단가를 숫자로 입력해주세요", false);
      return;
    }
    const category = addDraft.category.trim() || null;
    const major = (addDraft.majorSel === "__custom__" ? addDraft.majorCustom : addDraft.majorSel).trim() || null;
    const note = addDraft.note.trim() || null;
    const nowIso = new Date().toISOString();

    const firstId = genEquipmentId(rows, category ?? "");
    const newRow: LedgerRow = {
      equipment_id: firstId,
      major,
      category,
      name,
      aliases: [],
      stock_total: count,
      stock_maint: 0,
      price,
      state: "정상",
      note,
      verify_status: "verified", // 등록하는 사람이 실물을 보고 있음
      last_verified_at: nowIso,
      last_verified_by: userEmail,
      last_activity_at: null,
      open_issues: [],
    };

    // 옵티미스틱 추가 + 패널 닫기
    const prevRows = rows;
    setRows((prev) => [...prev, newRow].sort((a, b) => a.equipment_id.localeCompare(b.equipment_id)));
    setAddOpen(false);

    try {
      // ID 충돌(23505) 시 순번 올려 최대 3회 시도
      let equipmentId = firstId;
      let inserted = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        const { error } = await supabase.from("equipment_ledger").insert({
          equipment_id: equipmentId,
          major,
          category,
          name,
          aliases: [],
          stock_total: count,
          stock_maint: 0,
          price,
          state: "정상",
          note,
          verify_status: "verified",
          last_verified_at: nowIso,
          last_verified_by: userEmail,
          open_issues: [],
          source: "app",
        });
        if (!error) {
          inserted = true;
          break;
        }
        if ((error as { code?: string }).code === "23505") {
          equipmentId = bumpEquipmentId(equipmentId);
          continue;
        }
        throw error;
      }
      if (!inserted) throw new Error("장비ID 중복으로 등록하지 못했습니다");
      // 재시도로 ID가 바뀌었으면 화면에도 반영
      if (equipmentId !== firstId) {
        setRows((prev) =>
          prev
            .map((r) => (r === newRow || r.equipment_id === firstId ? { ...r, equipment_id: equipmentId } : r))
            .sort((a, b) => a.equipment_id.localeCompare(b.equipment_id)),
        );
      }
      showToast(`등록 완료: ${name} (${equipmentId})`);
      setAddDraft(EMPTY_ADD_DRAFT);
      // 이력은 부가 기록 — 실패해도 원장 반영은 유지 (콘솔에만 남김)
      const { error: evError } = await supabase.from("equipment_events").insert({
        equipment_id: equipmentId,
        type: "created",
        payload: { name, stock_total: count },
        actor: userEmail,
      });
      if (evError) console.error("[inventory] 이벤트 기록 실패", evError);
    } catch (e) {
      console.error("[inventory] 장비 등록 실패", e);
      setRows(prevRows); // 롤백
      setAddOpen(true); // 입력값 보존한 채 다시 열기
      showToast("등록에 실패했어요 — 다시 시도해주세요", false);
    }
  }, [addDraft, rows, userEmail, showToast]);

  const archiveRow = useCallback(
    async (row: LedgerRow) => {
      if (!supabase) return;
      const prevRows = rows;
      setRows((prev) => prev.map((r) => (r.equipment_id === row.equipment_id ? { ...r, state: ARCHIVED_STATE } : r)));
      setOpenKey(null);
      try {
        const { error } = await supabase.from("equipment_ledger").update({ state: ARCHIVED_STATE }).eq("equipment_id", row.equipment_id);
        if (error) throw error;
        showToast(`보관 처리 완료: ${row.name}`);
        const { error: evError } = await supabase.from("equipment_events").insert({
          equipment_id: row.equipment_id,
          type: "archived",
          payload: { name: row.name, before_state: row.state },
          actor: userEmail,
        });
        if (evError) console.error("[inventory] 이벤트 기록 실패", evError);
      } catch (e) {
        console.error("[inventory] 보관 처리 실패", e);
        setRows(prevRows); // 롤백
        showToast("보관 처리에 실패했어요 — 다시 시도해주세요", false);
      }
    },
    [rows, userEmail, showToast],
  );

  const restoreRow = useCallback(
    async (row: LedgerRow) => {
      if (!supabase) return;
      const prevRows = rows;
      setRows((prev) =>
        prev.map((r) => (r.equipment_id === row.equipment_id ? { ...r, state: "정상", verify_status: "unverified" } : r)),
      );
      try {
        const { error } = await supabase
          .from("equipment_ledger")
          .update({ state: "정상", verify_status: "unverified" })
          .eq("equipment_id", row.equipment_id);
        if (error) throw error;
        showToast(`복원 완료: ${row.name}`);
        const { error: evError } = await supabase.from("equipment_events").insert({
          equipment_id: row.equipment_id,
          type: "restored",
          payload: { name: row.name },
          actor: userEmail,
        });
        if (evError) console.error("[inventory] 이벤트 기록 실패", evError);
      } catch (e) {
        console.error("[inventory] 복원 실패", e);
        setRows(prevRows); // 롤백
        showToast("복원에 실패했어요 — 다시 시도해주세요", false);
      }
    },
    [rows, userEmail, showToast],
  );

  // ── 이름 연결 큐 액션 ─────────────────────────────────────────
  // 후보 연결: 선택한 원장 장비의 별칭에 기록 이름을 추가 → 이름 매칭 규칙으로 항목이 자동 해결됨
  const linkAlias = useCallback(
    async (queueName: string, cand: QueueCandidate) => {
      if (!supabase) return;
      const target = rows.find((r) => r.equipment_id === cand.id);
      if (!target) {
        showToast("대상 장비를 찾을 수 없어요 — 새로고침 후 다시 시도해주세요", false);
        return;
      }
      const key = normalizeStockName(queueName);
      const nextAliases = target.aliases.some((a) => normalizeStockName(a) === key)
        ? target.aliases
        : [...target.aliases, queueName];

      const prevRows = rows;
      setRows((prev) => prev.map((r) => (r.equipment_id === cand.id ? { ...r, aliases: nextAliases } : r)));
      try {
        const { error } = await supabase.from("equipment_ledger").update({ aliases: nextAliases }).eq("equipment_id", cand.id);
        if (error) throw error;
        showToast(`연결됨: ${queueName} → ${target.name}`);
        // 이력은 부가 기록 — 실패해도 별칭 반영은 유지 (콘솔에만 남김)
        const { error: evError } = await supabase.from("equipment_events").insert({
          equipment_id: cand.id,
          type: "alias_added",
          payload: { alias: queueName, source: "name-link-queue" },
          actor: userEmail,
        });
        if (evError) console.error("[inventory] 이벤트 기록 실패", evError);
      } catch (e) {
        console.error("[inventory] 별칭 연결 실패", e);
        setRows(prevRows); // 롤백
        showToast("연결에 실패했어요 — 다시 시도해주세요", false);
      }
    },
    [rows, userEmail, showToast],
  );

  // 해당 없음/무시 — SYS-000 이벤트가 곧 영속 기록이므로 INSERT 실패 시 되돌림
  const dismissQueueItem = useCallback(
    async (queueName: string, decision: "none" | "ignore") => {
      if (!supabase) return;
      const prevDecisions = linkDecisions;
      setLinkDecisions(new Set(prevDecisions).add(queueName));
      try {
        const { error } = await supabase.from("equipment_events").insert({
          equipment_id: SYS_EQUIPMENT_ID,
          type: "name_link_decision",
          payload: { name: queueName, decision },
          actor: userEmail,
        });
        if (error) throw error;
        showToast(decision === "none" ? `처리됨: ${queueName} (해당 없음)` : `무시됨: ${queueName}`);
      } catch (e) {
        console.error("[inventory] 이름연결 처리 실패", e);
        setLinkDecisions(prevDecisions); // 롤백
        showToast("처리에 실패했어요 — 다시 시도해주세요", false);
      }
    },
    [linkDecisions, userEmail, showToast],
  );

  // 장비로 추가 — 기존 추가 패널을 기록 이름으로 프리필해 열기. 등록되면 이름 매칭으로 자동 해결
  const openAddFromQueue = useCallback((queueName: string) => {
    setAddDraft({ ...EMPTY_ADD_DRAFT, name: queueName });
    setAddOpen(true);
    setOpenKey(null);
    window.setTimeout(() => document.getElementById("inv-add-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  }, []);

  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <header className="safe-top sticky top-0 z-40 bg-paper/90 backdrop-blur-md ring-1 ring-line/70">
        <ViewHeader title="재고">
          <span className="hidden text-[12px] text-ink-faint sm:inline">재고관리대장</span>
          <button
            onClick={load}
            className={`tap flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white ring-1 ring-line/60 text-ink-soft ${phase === "loading" ? "animate-spin" : ""}`}
            title="새로고침"
          >
            <Refresh className="h-4 w-4" />
          </button>
        </ViewHeader>

        {phase === "ready" && !auditLocked && (
          <div className="space-y-2 px-4 pb-2.5 pt-1">
            {/* 상태 칩 = 필터 */}
            <div className="flex flex-wrap items-center gap-1.5">
              <FilterChip label="전체" count={counts.all} active={filter === "all"} onClick={() => setFilter("all")} />
              <FilterChip label="주의" count={counts.attention} tone="attention" active={filter === "attention"} onClick={() => setFilter("attention")} />
              <FilterChip label="미검증" count={counts.unverified} tone="mute" active={filter === "unverified"} onClick={() => setFilter("unverified")} />
              <FilterChip label="확인됨" count={counts.verified} tone="ok" active={filter === "verified"} onClick={() => setFilter("verified")} />
              <button
                onClick={() => {
                  setAddOpen((v) => !v);
                  setOpenKey(null);
                  if (!addOpen) setAddDraft(EMPTY_ADD_DRAFT);
                }}
                className={`tap rounded-full px-2.5 py-1.5 text-[12px] font-bold ring-1 ${
                  addOpen ? "bg-brand-50 text-brand-700 ring-brand-200" : "bg-white text-brand-700 ring-line/60"
                }`}
              >
                ＋ 장비 추가
              </button>
            </div>

            {/* 검증률 진행바 */}
            <div>
              <div className="flex items-baseline justify-between text-[11.5px]">
                <span className="font-semibold text-ink-mute">대장 검증률</span>
                <span className="font-bold tabular-nums text-ink-soft">{verifiedPct}%</span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line/40">
                <div className="h-full rounded-full bg-checkin-fg" style={{ width: `${verifiedPct}%` }} />
              </div>
            </div>

            {/* 검색 */}
            <div className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 ring-1 ring-line/60">
              <Search className="h-4 w-4 text-ink-faint" />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="장비명·ID·별칭 검색"
                className="flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-faint"
              />
              {q && <button onClick={() => setQ("")} className="text-ink-faint">✕</button>}
            </div>
          </div>
        )}
      </header>

      <main className="flex-1 space-y-3.5 p-3 pb-24">
        <InventoryAuditMvp onLockChange={setAuditLocked} />

        {phase === "loading" && <div className="py-16 text-center text-[14px] text-ink-faint">불러오는 중…</div>}

        {phase === "unavailable" && (
          <div className="rounded-xl bg-warn-bg px-3.5 py-4 ring-1 ring-warn-ring">
            <div className="text-[13.5px] font-bold text-warn-fg">재고 원장이 아직 준비되지 않았어요. 관리자에게 문의해주세요.</div>
            <button onClick={load} className="tap mt-2.5 rounded-lg bg-white px-3 py-1.5 text-[12.5px] font-bold text-ink-soft ring-1 ring-line/70">
              다시 시도
            </button>
          </div>
        )}

        {phase === "ready" && auditLocked && (
          <div className="rounded-xl bg-warn-bg px-3.5 py-3 text-[12.5px] font-semibold text-warn-fg ring-1 ring-warn-ring">
            전체 실사 중에는 기존 재고 수량 수정 기능이 잠깁니다. 위 버튼으로 실사를 이어서 진행해 주세요.
          </div>
        )}

        {phase === "ready" && !auditLocked && (
          <>
            {/* 장비 추가 패널 */}
            {addOpen && (
              <div id="inv-add-panel">
                <AddPanel
                  draft={addDraft}
                  setDraft={setAddDraft}
                  categories={categories}
                  majors={majors}
                  suggestMajor={suggestMajor}
                  onCancel={() => setAddOpen(false)}
                  onSubmit={submitAdd}
                />
              </div>
            )}

            {/* 이름 연결 큐 — 대여기록 이름 ↔ 원장 이름 불일치 해소 (하루 15건씩) */}
            {filter === "all" && !q.trim() && queuePending > 0 && (
              <section className="overflow-hidden rounded-xl bg-white shadow-card ring-1 ring-line/70">
                <button onClick={() => setLinkOpen((v) => !v)} className="tap w-full px-3.5 py-3 text-left">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[14px] font-bold text-ink">이름 연결 — 남은 {queuePending}건</span>
                    <ChevronRight className={`h-4 w-4 shrink-0 text-ink-mute transition-transform ${linkOpen ? "rotate-90" : ""}`} />
                  </div>
                  <div className="mt-0.5 text-[11.5px] text-ink-mute">하루 15건이면 1주에 끝나요</div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-line/40">
                    <div
                      className="h-full rounded-full bg-checkin-fg"
                      style={{ width: `${QUEUE_TOTAL ? Math.round(((QUEUE_TOTAL - queuePending) / QUEUE_TOTAL) * 100) : 0}%` }}
                    />
                  </div>
                </button>
                {linkOpen && (
                  <div className="divide-y divide-line/60 border-t border-line/60">
                    {[
                      ...pendingLink.map((it) => ({ kind: "link" as const, link: it, add: null as QueueAddItem | null })),
                      ...pendingAdd.map((it) => ({ kind: "add" as const, link: null as QueueLinkItem | null, add: it })),
                    ]
                      .slice(0, linkShown)
                      .map((entry) => {
                        const name = entry.kind === "link" ? entry.link!.name : entry.add!.name;
                        const count = entry.kind === "link" ? entry.link!.count : entry.add!.count;
                        return (
                          <div key={`${entry.kind}:${name}`} className="px-3.5 py-2.5">
                            <div className="flex items-baseline gap-1.5">
                              <span className="min-w-0 truncate text-[13.5px] font-bold text-ink">“{name}”</span>
                              <span className="shrink-0 text-[11.5px] text-ink-mute">기록 {count}회</span>
                            </div>
                            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                              {entry.kind === "link" ? (
                                <>
                                  {entry.link!.candidates.map((c) => (
                                    <button
                                      key={c.id}
                                      onClick={() => linkAlias(name, c)}
                                      className="tap flex max-w-full items-center gap-1 rounded-lg bg-brand-50 px-2.5 py-1.5 text-[12px] font-bold text-brand-700 ring-1 ring-brand-200"
                                    >
                                      <span className="shrink-0 tabular-nums">{c.id}</span>
                                      <span className="truncate">{c.name}</span>
                                    </button>
                                  ))}
                                  <button
                                    onClick={() => dismissQueueItem(name, "none")}
                                    className="tap rounded-lg bg-white px-2.5 py-1.5 text-[12px] font-bold text-ink-faint ring-1 ring-line/60"
                                  >
                                    해당 없음
                                  </button>
                                </>
                              ) : (
                                <>
                                  <button
                                    onClick={() => openAddFromQueue(name)}
                                    className="tap rounded-lg bg-brand-600 px-2.5 py-1.5 text-[12px] font-bold text-white"
                                  >
                                    장비로 추가
                                  </button>
                                  <button
                                    onClick={() => dismissQueueItem(name, "ignore")}
                                    className="tap rounded-lg bg-white px-2.5 py-1.5 text-[12px] font-bold text-ink-faint ring-1 ring-line/60"
                                  >
                                    무시
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    {queuePending > linkShown && (
                      <button
                        onClick={() => setLinkShown((n) => n + QUEUE_PAGE)}
                        className="tap w-full px-3.5 py-2.5 text-center text-[12.5px] font-bold text-brand-700"
                      >
                        더 보기 {Math.min(QUEUE_PAGE, queuePending - linkShown)}건
                      </button>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* 오늘 확인할 장비 — 우선순위 10개 */}
            {filter === "all" && !q.trim() && picks.length > 0 && (
              <section>
                <div className="mb-2 flex items-baseline justify-between px-1">
                  <h2 className="text-[14px] font-bold text-ink-soft">오늘 확인할 장비</h2>
                  <span className="text-[12px] text-ink-mute">{picks.length}개</span>
                </div>
                <div className="overflow-hidden rounded-xl bg-white shadow-card ring-1 ring-line/70">
                  <div className="divide-y divide-line/60">
                    {picks.map((r) => (
                      <div key={r.equipment_id}>
                        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2.5">
                          <div className="min-w-0">
                            <div className="flex min-w-0 items-baseline gap-1.5">
                              <StatusChip status={r.verify_status} />
                              <span className="truncate text-[14px] font-bold text-ink">{r.name}</span>
                            </div>
                            <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px] text-ink-mute">
                              <span className="font-semibold text-ink-faint">{r.equipment_id}</span>
                              <span>{r.stock_total == null ? "보유 미기록" : `보유 ${r.stock_total}대`}</span>
                            </div>
                            {r.note && <div className="mt-0.5 truncate text-[11.5px] text-ink-mute">{r.note}</div>}
                          </div>
                          <div className="flex shrink-0 items-center gap-1.5">
                            <button
                              onClick={() => setBlackbox(r)}
                              className="tap flex h-[32px] w-[32px] items-center justify-center rounded-lg bg-white text-ink-soft ring-1 ring-line/70"
                              title="블랙박스 — 대여 이력·사진 증거"
                              aria-label="블랙박스 — 대여 이력·사진 증거"
                            >
                              <History className="h-3.5 w-3.5" />
                            </button>
                            {/* 항상 보이는 수정 진입점 (오늘 확인 섹션) */}
                            <button
                              onClick={() => (openKey === `editToday:${r.equipment_id}` ? setOpenKey(null) : openIssueEdit("editToday", r))}
                              className={`tap flex h-[32px] w-[32px] items-center justify-center rounded-lg ring-1 ${
                                openKey === `editToday:${r.equipment_id}` ? "bg-brand-50 text-brand-700 ring-brand-200" : "bg-white text-ink-soft ring-line/70"
                              }`}
                              title="장비 정보 수정"
                              aria-label="장비 정보 수정"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <VerifyButton onClick={() => openVerify("today", r)} />
                          </div>
                        </div>
                        {openKey === `today:${r.equipment_id}` && (
                          <VerifyPanel row={r} draft={draft} setDraft={setDraft} onCancel={() => setOpenKey(null)} onSubmit={() => submitVerify(r)} />
                        )}
                        {openKey === `editToday:${r.equipment_id}` && (
                          <IssueEditPanel
                            draft={editDraft}
                            setDraft={setEditDraft}
                            onCancel={() => setOpenKey(null)}
                            onSubmit={() => submitIssueEdit(r)}
                            onArchive={() => archiveRow(r)}
                          />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              </section>
            )}

            {/* 전체 목록 */}
            <section>
              <div className="mb-2 flex items-baseline justify-between px-1">
                <h2 className="text-[14px] font-bold text-ink-soft">전체 장비</h2>
                <span className="text-[12px] text-ink-mute">{filtered.length}개</span>
              </div>
              <div className="overflow-hidden rounded-xl bg-white shadow-card ring-1 ring-line/70">
                {filtered.length === 0 ? (
                  <div className="px-3 py-5 text-center text-[12.5px] font-semibold text-ink-faint">조건에 맞는 장비가 없어요</div>
                ) : (
                  <div className="divide-y divide-line/60">
                    {filtered.map((r) => {
                      const issues = r.open_issues.map((i) => i.label).join(" · ");
                      return (
                        <div key={r.equipment_id}>
                          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2.5">
                            <StatusChip status={r.verify_status} />
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-baseline gap-1.5">
                                <span className="truncate text-[14px] font-bold text-ink">{r.name}</span>
                                <span className="shrink-0 text-[11px] font-semibold text-ink-faint">{r.equipment_id}</span>
                              </div>
                              <div className="mt-0.5 flex flex-wrap gap-x-2 text-[11.5px] text-ink-mute">
                                <span>{r.stock_total == null ? "보유 미기록" : `보유 ${r.stock_total}대`}</span>
                                {r.stock_maint > 0 && <span className="font-semibold text-warn-fg">정비 {r.stock_maint}대</span>}
                                {r.last_verified_at && <span>{fmtMd(r.last_verified_at)} 확인</span>}
                              </div>
                              {(r.note || issues) && (
                                <button
                                  onClick={() => openIssueEdit("edit", r)}
                                  className="tap mt-0.5 flex w-full min-w-0 items-center gap-1 text-left"
                                  title="비고·문제 수정"
                                >
                                  <span className="min-w-0 truncate text-[11.5px]">
                                    {issues && <span className="font-semibold text-attention-fg">{issues}</span>}
                                    {issues && r.note && <span className="text-ink-faint"> · </span>}
                                    {r.note && <span className="text-ink-mute">{r.note}</span>}
                                  </span>
                                  <Pencil className="h-3 w-3 shrink-0 text-ink-faint" />
                                </button>
                              )}
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              <button
                                onClick={() => setBlackbox(r)}
                                className="tap flex h-[32px] w-[32px] items-center justify-center rounded-lg bg-white text-ink-soft ring-1 ring-line/70"
                                title="블랙박스 — 대여 이력·사진 증거"
                                aria-label="블랙박스 — 대여 이력·사진 증거"
                              >
                                <History className="h-3.5 w-3.5" />
                              </button>
                              {/* 항상 보이는 수정 진입점 — 비고/문제가 없는 행도 장비명 수정·보관 처리 가능 */}
                              <button
                                onClick={() => (openKey === `edit:${r.equipment_id}` ? setOpenKey(null) : openIssueEdit("edit", r))}
                                className={`tap flex h-[32px] w-[32px] items-center justify-center rounded-lg ring-1 ${
                                  openKey === `edit:${r.equipment_id}` ? "bg-brand-50 text-brand-700 ring-brand-200" : "bg-white text-ink-soft ring-line/70"
                                }`}
                                title="장비 정보 수정"
                                aria-label="장비 정보 수정"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <VerifyButton onClick={() => openVerify("list", r)} />
                            </div>
                          </div>
                          {openKey === `list:${r.equipment_id}` && (
                            <VerifyPanel row={r} draft={draft} setDraft={setDraft} onCancel={() => setOpenKey(null)} onSubmit={() => submitVerify(r)} />
                          )}
                          {openKey === `edit:${r.equipment_id}` && (
                            <IssueEditPanel
                              draft={editDraft}
                              setDraft={setEditDraft}
                              onCancel={() => setOpenKey(null)}
                              onSubmit={() => submitIssueEdit(r)}
                              onArchive={() => archiveRow(r)}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* 보관된 장비 — 목록/칩/검증률에서 제외, 여기서만 확인·복원 */}
              {archivedRows.length > 0 && (
                <div className="mt-2.5 px-1">
                  <button onClick={() => setShowArchived((v) => !v)} className="tap text-[12px] font-semibold text-ink-faint">
                    {showArchived ? "보관됨 숨기기" : `보관됨 ${archivedRows.length}개 보기`}
                  </button>
                  {showArchived && (
                    <div className="mt-2 overflow-hidden rounded-xl bg-white/70 ring-1 ring-line/60">
                      <div className="divide-y divide-line/50">
                        {archivedRows.map((r) => (
                          <div key={r.equipment_id} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 px-3 py-2.5">
                            <div className="min-w-0">
                              <div className="flex min-w-0 items-baseline gap-1.5">
                                <span className="truncate text-[13.5px] font-bold text-ink-mute">{r.name}</span>
                                <span className="shrink-0 text-[11px] font-semibold text-ink-faint">{r.equipment_id}</span>
                              </div>
                              <div className="mt-0.5 truncate text-[11.5px] text-ink-faint">
                                보관종료{r.note ? ` · ${r.note}` : ""}
                              </div>
                            </div>
                            <button
                              onClick={() => restoreRow(r)}
                              className="tap min-h-[32px] shrink-0 rounded-lg bg-white px-3 text-[12.5px] font-bold text-ink-soft ring-1 ring-line/70"
                            >
                              복원
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </section>
          </>
        )}
      </main>

      {toast && (
        <div
          key={toast.id}
          className={`animate-toast pointer-events-none fixed bottom-24 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-2 rounded-full px-4 py-2 text-[13px] font-semibold text-white shadow-pop ${toast.ok ? "bg-ink" : "bg-attention-fg"}`}
        >
          {toast.ok && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-checkin-fg">
              <Check className="h-3 w-3" />
            </span>
          )}
          {toast.text}
        </div>
      )}

      {blackbox && <EquipmentBlackbox name={blackbox.name} aliases={blackbox.aliases} onClose={() => setBlackbox(null)} />}
    </div>
  );
}

function StatusChip({ status }: { status: VerifyStatus }) {
  return <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-bold ${STATUS_CHIP[status]}`}>{STATUS_LABEL[status]}</span>;
}

function VerifyButton({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} className="tap min-h-[32px] shrink-0 rounded-lg bg-brand-600 px-3 text-[12.5px] font-bold text-white">
      확인
    </button>
  );
}

function FilterChip({
  label, count, tone, active, onClick,
}: {
  label: string; count: number; tone?: "attention" | "mute" | "ok"; active: boolean; onClick: () => void;
}) {
  const toneCls =
    tone === "attention" ? "text-attention-fg" : tone === "ok" ? "text-checkin-fg" : tone === "mute" ? "text-ink-mute" : "text-ink-soft";
  return (
    <button
      onClick={onClick}
      className={`tap rounded-full px-2.5 py-1.5 text-[12px] font-bold ring-1 ${
        active ? "bg-brand-50 text-brand-700 ring-brand-200" : `bg-white ring-line/60 ${toneCls}`
      }`}
    >
      {label} <span className="tabular-nums">{count}</span>
    </button>
  );
}

// 확인 스테퍼 — 인라인 펼침. 수량 확인(기본 = 현재 보유수량) + 문제 있음 토글 + 확인 완료.
function VerifyPanel({
  row, draft, setDraft, onCancel, onSubmit,
}: {
  row: LedgerRow;
  draft: VerifyDraft;
  setDraft: React.Dispatch<React.SetStateAction<VerifyDraft>>;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const counted = Number(draft.count);
  const valid = Number.isInteger(counted) && counted >= 0 && draft.count.trim() !== "";
  const changed = valid && counted !== (row.stock_total ?? null);
  const step = (delta: number) =>
    setDraft((d) => {
      const cur = Number(d.count);
      const base = Number.isInteger(cur) ? cur : row.stock_total ?? 0;
      return { ...d, count: String(Math.max(0, base + delta)) };
    });

  return (
    <div className="animate-pop border-t border-line/60 bg-paper/70 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="text-[12px] font-bold text-ink-mute">실물 수량</span>
        <div className="flex items-center gap-0.5 rounded-lg bg-white p-0.5 ring-1 ring-line/60">
          <button onClick={() => step(-1)} className="tap h-9 w-9 rounded-md text-[17px] font-black text-ink-soft" aria-label="수량 줄이기">−</button>
          <input
            inputMode="numeric"
            value={draft.count}
            onChange={(e) => setDraft((d) => ({ ...d, count: e.target.value.replace(/[^\d]/g, "") }))}
            className="w-12 bg-transparent text-center text-[16px] font-extrabold tabular-nums text-ink outline-none"
            aria-label="실물 수량"
          />
          <button onClick={() => step(1)} className="tap h-9 w-9 rounded-md text-[17px] font-black text-ink-soft" aria-label="수량 늘리기">＋</button>
        </div>
        <span className="text-[11.5px] text-ink-faint">
          {row.stock_total == null ? "장부 미기록" : `장부 ${row.stock_total}대`}
          {changed && <b className="ml-1 text-warn-fg">→ {counted}대로 수정</b>}
        </span>
        <button
          onClick={() => setDraft((d) => ({ ...d, issueOn: !d.issueOn }))}
          className={`tap min-h-[32px] rounded-lg px-2.5 text-[12px] font-bold ring-1 ${
            draft.issueOn ? "bg-attention-bg text-attention-fg ring-attention-ring" : "bg-white text-ink-mute ring-line/60"
          }`}
        >
          문제 있음
        </button>
      </div>

      {draft.issueOn && (
        <input
          value={draft.issueLabel}
          onChange={(e) => setDraft((d) => ({ ...d, issueLabel: e.target.value }))}
          placeholder="어떤 문제인가요? 예) 배터리 커버 파손"
          className="mt-2.5 w-full rounded-lg bg-white px-3 py-2.5 text-[13px] text-ink outline-none ring-1 ring-attention-ring placeholder:text-ink-faint"
          autoFocus
        />
      )}

      <div className="mt-2.5 flex gap-2">
        <button
          onClick={onSubmit}
          disabled={!valid}
          className="tap min-h-[38px] flex-1 rounded-lg bg-brand-600 px-3.5 text-[13.5px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          확인 완료
        </button>
        <button onClick={onCancel} className="tap min-h-[38px] rounded-lg px-3.5 text-[13.5px] font-bold text-ink-mute ring-1 ring-line/70">
          취소
        </button>
      </div>
    </div>
  );
}

// 비고/문제 편집 패널 — 인라인 펼침. 빈 항목·중복은 저장 시 자동 정리. 하단에 보관 처리(2단계 확인).
function IssueEditPanel({
  draft, setDraft, onCancel, onSubmit, onArchive,
}: {
  draft: IssueEditDraft;
  setDraft: React.Dispatch<React.SetStateAction<IssueEditDraft>>;
  onCancel: () => void;
  onSubmit: () => void;
  onArchive: () => void;
}) {
  const [confirmArchive, setConfirmArchive] = useState(false);
  const nameValid = draft.name.trim() !== "";
  // 보유수량: 빈칸 = 미기록. − 는 빈칸에서 동작 안 함, ＋ 는 0부터 시작
  const stepTotal = (delta: number) =>
    setDraft((d) => {
      if (d.stockTotal.trim() === "" && delta < 0) return d;
      const cur = Number(d.stockTotal);
      const base = d.stockTotal.trim() !== "" && Number.isInteger(cur) ? cur : 0;
      return { ...d, stockTotal: String(Math.max(0, base + delta)) };
    });
  // 정비중수량: 최소 0, 보유수량이 기록돼 있으면 그 이하로만
  const stepMaint = (delta: number) =>
    setDraft((d) => {
      const cur = Number(d.stockMaint);
      const base = d.stockMaint.trim() !== "" && Number.isInteger(cur) ? cur : 0;
      let next = Math.max(0, base + delta);
      const total = d.stockTotal.trim() === "" ? null : Number(d.stockTotal);
      if (total != null && Number.isInteger(total)) next = Math.min(next, total);
      return { ...d, stockMaint: String(next) };
    });
  return (
    <div className="animate-pop border-t border-line/60 bg-paper/70 px-3 py-3">
      <label className="block">
        <span className="mb-1 block text-[12px] font-bold text-ink-mute">장비명 <b className="text-attention-fg">*</b></span>
        <input
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          placeholder="장비명을 입력해주세요"
          className="w-full rounded-lg bg-white px-3 py-2.5 text-[13px] font-semibold text-ink outline-none ring-1 ring-line/60 placeholder:text-ink-faint"
        />
      </label>

      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-2">
        <div>
          <span className="mb-1 block text-[12px] font-bold text-ink-mute">보유수량</span>
          <div className="flex items-center gap-0.5 rounded-lg bg-white p-0.5 ring-1 ring-line/60">
            <button onClick={() => stepTotal(-1)} className="tap h-9 w-9 rounded-md text-[17px] font-black text-ink-soft" aria-label="보유수량 줄이기">−</button>
            <input
              inputMode="numeric"
              value={draft.stockTotal}
              onChange={(e) => setDraft((d) => ({ ...d, stockTotal: e.target.value.replace(/[^\d]/g, "") }))}
              placeholder="미기록"
              className="w-14 bg-transparent text-center text-[15px] font-extrabold tabular-nums text-ink outline-none placeholder:text-[11.5px] placeholder:font-semibold placeholder:text-ink-faint"
              aria-label="보유수량"
            />
            <button onClick={() => stepTotal(1)} className="tap h-9 w-9 rounded-md text-[17px] font-black text-ink-soft" aria-label="보유수량 늘리기">＋</button>
          </div>
        </div>
        <div>
          <span className="mb-1 block text-[12px] font-bold text-ink-mute">정비중수량</span>
          <div className="flex items-center gap-0.5 rounded-lg bg-white p-0.5 ring-1 ring-line/60">
            <button onClick={() => stepMaint(-1)} className="tap h-9 w-9 rounded-md text-[17px] font-black text-ink-soft" aria-label="정비중수량 줄이기">−</button>
            <input
              inputMode="numeric"
              value={draft.stockMaint}
              onChange={(e) => setDraft((d) => ({ ...d, stockMaint: e.target.value.replace(/[^\d]/g, "") }))}
              className="w-14 bg-transparent text-center text-[15px] font-extrabold tabular-nums text-ink outline-none"
              aria-label="정비중수량"
            />
            <button onClick={() => stepMaint(1)} className="tap h-9 w-9 rounded-md text-[17px] font-black text-ink-soft" aria-label="정비중수량 늘리기">＋</button>
          </div>
        </div>
      </div>

      <label className="mt-2.5 block">
        <span className="mb-1 block text-[12px] font-bold text-ink-mute">비고</span>
        <input
          value={draft.note}
          onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
          placeholder="비고 없음"
          className="w-full rounded-lg bg-white px-3 py-2.5 text-[13px] text-ink outline-none ring-1 ring-line/60 placeholder:text-ink-faint"
        />
      </label>

      <div className="mt-2.5">
        <span className="mb-1 block text-[12px] font-bold text-ink-mute">문제 목록</span>
        {draft.issues.length === 0 ? (
          <div className="rounded-lg bg-white/60 px-3 py-2 text-[11.5px] text-ink-faint ring-1 ring-line/40">등록된 문제가 없어요</div>
        ) : (
          <div className="space-y-1.5">
            {draft.issues.map((it, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <input
                  value={it.label}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, issues: d.issues.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) }))
                  }
                  placeholder="문제 내용"
                  className="min-w-0 flex-1 rounded-lg bg-white px-3 py-2.5 text-[13px] text-ink outline-none ring-1 ring-attention-ring placeholder:text-ink-faint"
                />
                <button
                  onClick={() => setDraft((d) => ({ ...d, issues: d.issues.filter((_, j) => j !== i) }))}
                  className="tap flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-[14px] font-bold text-ink-mute ring-1 ring-line/60"
                  aria-label="문제 삭제"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
        <button
          onClick={() => setDraft((d) => ({ ...d, issues: [...d.issues, { label: "" }] }))}
          className="tap mt-1.5 rounded-lg bg-white px-2.5 py-1.5 text-[12px] font-bold text-ink-soft ring-1 ring-line/70"
        >
          ＋ 문제 추가
        </button>
      </div>

      <div className="mt-2.5 flex gap-2">
        <button
          onClick={onSubmit}
          disabled={!nameValid}
          className="tap min-h-[38px] flex-1 rounded-lg bg-brand-600 px-3.5 text-[13.5px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          저장
        </button>
        <button onClick={onCancel} className="tap min-h-[38px] rounded-lg px-3.5 text-[13.5px] font-bold text-ink-mute ring-1 ring-line/70">
          취소
        </button>
      </div>

      {/* 보관 처리 — 소프트 삭제 (2단계 확인) */}
      <div className="mt-3 border-t border-line/50 pt-2.5">
        {!confirmArchive ? (
          <button onClick={() => setConfirmArchive(true)} className="tap text-[12px] font-bold text-attention-fg">
            이 장비 보관 처리
          </button>
        ) : (
          <div className="rounded-lg bg-attention-bg px-3 py-2.5 ring-1 ring-attention-ring">
            <div className="text-[12px] font-bold text-attention-fg">보관 처리하면 목록에서 숨겨져요. 기록은 남습니다.</div>
            <div className="mt-2 flex gap-2">
              <button onClick={onArchive} className="tap min-h-[32px] rounded-lg bg-attention-fg px-3 text-[12.5px] font-bold text-white">
                보관 처리
              </button>
              <button
                onClick={() => setConfirmArchive(false)}
                className="tap min-h-[32px] rounded-lg bg-white px-3 text-[12.5px] font-bold text-ink-mute ring-1 ring-line/60"
              >
                취소
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// 장비 추가 패널 — 카테고리는 기존 값 자동완성, 대분류는 카테고리 최다값 자동 추천(직접 입력 가능).
function AddPanel({
  draft, setDraft, categories, majors, suggestMajor, onCancel, onSubmit,
}: {
  draft: AddDraft;
  setDraft: React.Dispatch<React.SetStateAction<AddDraft>>;
  categories: string[];
  majors: string[];
  suggestMajor: (category: string) => string;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const count = Number(draft.count);
  const valid = draft.name.trim() !== "" && Number.isInteger(count) && count >= 0 && draft.count.trim() !== "";
  const step = (delta: number) =>
    setDraft((d) => {
      const cur = Number(d.count);
      const base = Number.isInteger(cur) ? cur : 1;
      return { ...d, count: String(Math.max(0, base + delta)) };
    });

  return (
    <section className="animate-pop rounded-xl bg-white p-3.5 shadow-card ring-1 ring-line/70">
      <h2 className="text-[14px] font-bold text-ink-soft">장비 추가</h2>

      <label className="mt-2.5 block">
        <span className="mb-1 block text-[12px] font-bold text-ink-mute">장비명 <b className="text-attention-fg">*</b></span>
        <input
          value={draft.name}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          placeholder="예) 소니 FX30 바디"
          className="w-full rounded-lg bg-white px-3 py-2.5 text-[13px] text-ink outline-none ring-1 ring-line/60 placeholder:text-ink-faint"
          autoFocus
        />
      </label>

      <div className="mt-2.5 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1 block text-[12px] font-bold text-ink-mute">카테고리</span>
          <input
            value={draft.category}
            onChange={(e) => {
              const v = e.target.value;
              setDraft((d) => (d.majorTouched ? { ...d, category: v } : { ...d, category: v, majorSel: suggestMajor(v) }));
            }}
            list="inventory-category-options"
            placeholder="예) 카메라"
            className="w-full rounded-lg bg-white px-3 py-2.5 text-[13px] text-ink outline-none ring-1 ring-line/60 placeholder:text-ink-faint"
          />
          <datalist id="inventory-category-options">
            {categories.map((c) => (
              <option key={c} value={c} />
            ))}
          </datalist>
        </label>

        <label className="block">
          <span className="mb-1 block text-[12px] font-bold text-ink-mute">대분류</span>
          <select
            value={draft.majorSel}
            onChange={(e) => setDraft((d) => ({ ...d, majorSel: e.target.value, majorTouched: true }))}
            className="w-full rounded-lg bg-white px-3 py-2.5 text-[13px] text-ink outline-none ring-1 ring-line/60"
          >
            <option value="">대분류 없음</option>
            {majors.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value="__custom__">직접 입력…</option>
          </select>
          {draft.majorSel === "__custom__" && (
            <input
              value={draft.majorCustom}
              onChange={(e) => setDraft((d) => ({ ...d, majorCustom: e.target.value }))}
              placeholder="새 대분류 입력"
              className="mt-1.5 w-full rounded-lg bg-white px-3 py-2.5 text-[13px] text-ink outline-none ring-1 ring-line/60 placeholder:text-ink-faint"
              autoFocus
            />
          )}
        </label>
      </div>

      <div className="mt-2.5 flex flex-wrap items-end gap-2.5">
        <div>
          <span className="mb-1 block text-[12px] font-bold text-ink-mute">보유수량</span>
          <div className="flex items-center gap-0.5 rounded-lg bg-white p-0.5 ring-1 ring-line/60">
            <button onClick={() => step(-1)} className="tap h-9 w-9 rounded-md text-[17px] font-black text-ink-soft" aria-label="수량 줄이기">−</button>
            <input
              inputMode="numeric"
              value={draft.count}
              onChange={(e) => setDraft((d) => ({ ...d, count: e.target.value.replace(/[^\d]/g, "") }))}
              className="w-12 bg-transparent text-center text-[16px] font-extrabold tabular-nums text-ink outline-none"
              aria-label="보유수량"
            />
            <button onClick={() => step(1)} className="tap h-9 w-9 rounded-md text-[17px] font-black text-ink-soft" aria-label="수량 늘리기">＋</button>
          </div>
        </div>
        <label className="min-w-[120px] flex-1">
          <span className="mb-1 block text-[12px] font-bold text-ink-mute">1일 단가 (선택)</span>
          <input
            inputMode="numeric"
            value={draft.price}
            onChange={(e) => setDraft((d) => ({ ...d, price: e.target.value.replace(/[^\d]/g, "") }))}
            placeholder="예) 30000"
            className="w-full rounded-lg bg-white px-3 py-2.5 text-[13px] tabular-nums text-ink outline-none ring-1 ring-line/60 placeholder:text-ink-faint"
          />
        </label>
      </div>

      <label className="mt-2.5 block">
        <span className="mb-1 block text-[12px] font-bold text-ink-mute">비고 (선택)</span>
        <input
          value={draft.note}
          onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
          placeholder="비고 없음"
          className="w-full rounded-lg bg-white px-3 py-2.5 text-[13px] text-ink outline-none ring-1 ring-line/60 placeholder:text-ink-faint"
        />
      </label>

      <div className="mt-3 flex gap-2">
        <button
          onClick={onSubmit}
          disabled={!valid}
          className="tap min-h-[38px] flex-1 rounded-lg bg-brand-600 px-3.5 text-[13.5px] font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"
        >
          등록
        </button>
        <button onClick={onCancel} className="tap min-h-[38px] rounded-lg px-3.5 text-[13.5px] font-bold text-ink-mute ring-1 ring-line/70">
          취소
        </button>
      </div>
    </section>
  );
}
