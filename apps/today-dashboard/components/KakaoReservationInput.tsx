"use client";

import { useMemo, useState, type ClipboardEvent, type DragEvent, type ReactNode } from "react";
import { authFetch } from "@/lib/data/authFetch";
import { searchEquipmentCatalog, useEquipmentCatalog } from "@/lib/data/equipmentCatalog";
import { Camera, Check, Plus, Send } from "@/components/icons";

type EquipmentDraft = {
  name: string;
  qty: number;
  raw?: string;
  warn?: boolean;
};

type ParsedPayload = {
  예약자명?: string;
  연락처?: string;
  반출일?: string;
  반출시간?: string;
  반납일?: string;
  반납시간?: string;
  할인유형?: string;
  비고?: string;
  장비?: { 이름?: string; 수량?: number | string }[];
};

type CheckResultRow = {
  장비명?: string;
  수량?: string | number;
  결과?: string;
  상세?: string;
  name?: string;
  detail?: string;
  status?: string;
};

type CheckResult = {
  success?: boolean;
  status?: string;
  reqID?: string;
  reqId?: string;
  requestId?: string;
  duplicate?: boolean;
  message?: string;
  error?: string;
  results?: CheckResultRow[];
  details?: CheckResultRow[];
  executionTime?: string;
};

type AttachedImage = {
  dataUrl: string;
  base64: string;
  mediaType: string;
};

const DISCOUNTS = ["일반", "학생", "개인사업자/프리랜서"] as const;
const CATALOG_SOURCE_LABEL = "dashboardEquipmentCatalog";

function todayValue() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function normalizeQty(value: unknown) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1;
}

function requestIdOf(result: CheckResult | null) {
  if (!result) return "";
  return result.reqID || result.reqId || result.requestId || "";
}

function resultRowsOf(result: CheckResult | null) {
  return result?.results || result?.details || [];
}

function resultTone(row: CheckResultRow) {
  const combined = `${row.결과 || ""} ${row.상세 || ""} ${row.detail || ""} ${row.status || ""}`;
  if (/가용0|불가|❌/.test(combined)) return "fail";
  if (/겹침|부족|⚠|미등록|선택|모델/.test(combined)) return "warn";
  if (/가용|✅/.test(combined)) return "ok";
  return "neutral";
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("이미지를 읽지 못했습니다."));
    reader.readAsDataURL(file);
  });
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("이미지를 불러오지 못했습니다."));
    img.src = dataUrl;
  });
}

async function prepareImage(file: File): Promise<AttachedImage> {
  const original = await readFileAsDataUrl(file);
  const originalBase64 = original.split(",")[1] || "";
  const originalImage = { dataUrl: original, base64: originalBase64, mediaType: file.type || "image/png" };
  try {
    const img = await loadImage(original);
    const maxSide = Math.max(img.naturalWidth, img.naturalHeight);
    if (!maxSide || (maxSide <= 1400 && originalBase64.length < 900_000)) return originalImage;
    const scale = Math.min(1, 1400 / maxSide);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return originalImage;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.78);
    return { dataUrl, base64: dataUrl.split(",")[1] || "", mediaType: "image/jpeg" };
  } catch {
    return originalImage;
  }
}

export function KakaoReservationInput({ onRequestCreated }: { onRequestCreated: () => void | Promise<void> }) {
  const catalog = useEquipmentCatalog();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [image, setImage] = useState<AttachedImage | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [parseBusy, setParseBusy] = useState(false);
  const [submitBusy, setSubmitBusy] = useState(false);
  const [registerBusy, setRegisterBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CheckResult | null>(null);

  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [discount, setDiscount] = useState<(typeof DISCOUNTS)[number]>("일반");
  const [outDate, setOutDate] = useState(todayValue());
  const [outTime, setOutTime] = useState("10:00");
  const [returnDate, setReturnDate] = useState(todayValue());
  const [returnTime, setReturnTime] = useState("18:00");
  const [note, setNote] = useState("");
  const [equipment, setEquipment] = useState<EquipmentDraft[]>([]);
  const [addName, setAddName] = useState("");

  const addSuggestions = useMemo(
    () => searchEquipmentCatalog(catalog.items, addName, 10),
    [catalog.items, addName],
  );

  const appendLog = (message: string) => setLog((prev) => [...prev, message]);

  const bestCatalogName = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return { name: "", warn: true };
    const exact = catalog.items.find((item) => item.name === trimmed);
    if (exact) return { name: exact.name, warn: false };
    const found = searchEquipmentCatalog(catalog.items, trimmed, 1)[0];
    if (found) return { name: found.name, warn: false };
    return { name: trimmed, warn: true };
  };

  const handleImageFile = (file: File) => {
    if (!file.type.startsWith("image/")) return;
    prepareImage(file)
      .then((prepared) => {
        if (prepared.base64) setImage(prepared);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  function handlePasteImage(event: ClipboardEvent<HTMLTextAreaElement>) {
    const items = Array.from(event.clipboardData.items || []);
    const imageItem = items.find((item) => item.type.startsWith("image/"));
    const file = imageItem?.getAsFile();
    if (!file) return;
    event.preventDefault();
    handleImageFile(file);
  }

  function handleDropImage(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const file = Array.from(event.dataTransfer.files || []).find((candidate) => candidate.type.startsWith("image/"));
    if (file) handleImageFile(file);
  }

  const applyParsedPayload = (payload: ParsedPayload) => {
    setCustomerName(payload.예약자명 || "");
    setPhone(payload.연락처 || "");
    setDiscount(DISCOUNTS.includes(payload.할인유형 as (typeof DISCOUNTS)[number]) ? (payload.할인유형 as (typeof DISCOUNTS)[number]) : "일반");
    setOutDate(payload.반출일 || "");
    setOutTime(payload.반출시간 || "10:00");
    setReturnDate(payload.반납일 || payload.반출일 || "");
    setReturnTime(payload.반납시간 || "18:00");
    setNote(payload.비고 || "");

    const rows = Array.isArray(payload.장비) ? payload.장비 : [];
    const next = rows
      .map((row): EquipmentDraft | null => {
        const raw = String(row.이름 || "").trim();
        if (!raw) return null;
        const match = bestCatalogName(raw);
        return {
          raw,
          name: match.name,
          qty: normalizeQty(row.수량),
          warn: match.warn,
        };
      })
      .filter((row): row is EquipmentDraft => !!row);
    setEquipment(next);
  };

  const parse = async () => {
    if (!text.trim() && !image) {
      setError("카톡 텍스트를 붙여넣거나 캡처 이미지를 첨부해주세요.");
      return;
    }
    if (image && image.base64.length > 3_500_000) {
      setError("이미지가 너무 큽니다. 캡처를 줄이거나 텍스트를 함께 붙여넣어 주세요.");
      return;
    }

    setParseBusy(true);
    setError("");
    setResult(null);
    setLog([]);
    try {
      const res = await authFetch("/api/gas?action=aiParse", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "aiParse",
          text,
          image: image?.base64 || "",
          imageType: image?.mediaType || "image/png",
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error || !json.success || !json.parsed) {
        throw new Error(json.error || "AI 파싱 실패");
      }
      applyParsedPayload(json.parsed as ParsedPayload);
      appendLog("AI 파싱 성공");
      const parsedEquipment = Array.isArray((json.parsed as ParsedPayload).장비) ? (json.parsed as ParsedPayload).장비?.length || 0 : 0;
      appendLog(`장비 ${parsedEquipment}건 감지`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      appendLog("AI 파싱 실패. 아래 항목을 직접 입력해서 가용 체크할 수 있습니다.");
    } finally {
      setParseBusy(false);
    }
  };

  const setEquipmentName = (index: number, value: string) => {
    setEquipment((prev) => prev.map((item, i) => (i === index ? { ...item, name: value, warn: !catalog.names.includes(value) } : item)));
  };

  const setEquipmentQty = (index: number, value: string) => {
    setEquipment((prev) => prev.map((item, i) => (i === index ? { ...item, qty: normalizeQty(value) } : item)));
  };

  const removeEquipment = (index: number) => setEquipment((prev) => prev.filter((_, i) => i !== index));

  const addEquipment = (name?: string) => {
    const raw = (name || addName).trim();
    if (!raw) return;
    const match = bestCatalogName(raw);
    setEquipment((prev) => [...prev, { raw, name: match.name, qty: 1, warn: match.warn }]);
    setAddName("");
  };

  const payload = () => ({
    반출일: outDate,
    반출시간: outTime || "10:00",
    반납일: returnDate,
    반납시간: returnTime || "18:00",
    예약자명: customerName.trim(),
    연락처: phone.trim(),
    할인유형: discount,
    비고: note.trim(),
    장비: equipment
      .filter((item) => item.name.trim())
      .map((item) => ({ 이름: item.name.trim(), 수량: item.qty || 1 })),
  });

  const validate = () => {
    const missing: string[] = [];
    if (!customerName.trim()) missing.push("예약자명");
    if (!phone.trim()) missing.push("연락처");
    if (!outDate) missing.push("반출일");
    if (!returnDate) missing.push("반납일");
    if (!equipment.some((item) => item.name.trim())) missing.push("장비");
    if (missing.length) return `필수 항목을 입력해주세요: ${missing.join(", ")}`;
    if (outDate > returnDate) return "반납일이 반출일보다 이전입니다.";
    return "";
  };

  const submit = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await authFetch("/api/confirm", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "run",
          func: "insertAndCheckRequest",
          args: payload(),
        }),
      });
      const json = await res.json().catch(() => ({}));
      const ok = res.ok && !json.error && (json.success || json.status === "OK" || json.reqID || json.duplicate);
      if (!ok) throw new Error(json.error || json.message || "확인요청 입력 실패");
      setResult(json as CheckResult);
      appendLog(json.duplicate ? "기존 확인요청 중복을 찾았습니다." : "확인요청 입력 및 가용 체크 완료");
      await onRequestCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitBusy(false);
    }
  };

  const registerNow = async () => {
    const reqID = requestIdOf(result);
    if (!reqID) return;
    if (!confirm(`${reqID}를 계약마스터 + 스케줄상세에 바로 등록할까요?`)) return;
    setRegisterBusy(true);
    setError("");
    try {
      const res = await authFetch("/api/gas?action=registerAsync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "registerAsync", reqID }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.error || json.success === false) throw new Error(json.error || json.message || "등록 실패");
      setResult((prev) => ({ ...(prev || {}), message: json.message || "등록 요청 완료" }));
      appendLog("바로 등록 요청 완료");
      await onRequestCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegisterBusy(false);
    }
  };

  const reqID = requestIdOf(result);
  const rows = resultRowsOf(result);

  return (
    <section className="rounded-xl2 bg-white shadow-card ring-1 ring-black/5">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="tap flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left"
      >
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-700">
            <Send className="h-4.5 w-4.5" />
          </span>
          <span className="min-w-0">
            <span className="block text-[15px] font-extrabold text-ink">카톡 예약입력</span>
            <span className="block truncate text-[12px] font-medium text-ink-faint">카톡 내용이나 캡처에서 확인요청을 만듭니다</span>
          </span>
        </span>
        <span className="rounded-full bg-black/[0.04] px-2.5 py-1 text-[12px] font-bold text-ink-soft">{open ? "닫기" : "열기"}</span>
      </button>

      {open && (
        <div className="border-t border-black/5 px-3.5 py-3">
          {error && <div className="mb-3 rounded-xl bg-attention-bg px-3 py-2 text-[12.5px] font-bold text-attention-fg ring-1 ring-attention-ring">{error}</div>}

          <div className="grid gap-3 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
            <div className="space-y-3">
              <div
                className="rounded-xl border border-dashed border-black/12 bg-paper p-3"
                onDragOver={(event) => event.preventDefault()}
                onDrop={handleDropImage}
              >
                <label className="mb-1.5 block text-[12px] font-extrabold text-ink-mute">카톡 문의 붙여넣기</label>
                <textarea
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  onPaste={handlePasteImage}
                  rows={7}
                  className="min-h-[132px] w-full resize-y rounded-xl border border-black/10 bg-white px-3 py-2.5 text-[13.5px] leading-6 text-ink outline-none focus:border-brand-500"
                  placeholder="카톡 대화 텍스트를 붙여넣거나 캡처 이미지를 붙여넣기/드래그하세요."
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={parse}
                    disabled={parseBusy}
                    className="tap inline-flex min-h-[38px] items-center gap-1.5 rounded-xl bg-brand-600 px-3.5 text-[13px] font-extrabold text-white disabled:opacity-50"
                  >
                    <Check className="h-4 w-4" />
                    {parseBusy ? "AI 파싱 중…" : "AI 파싱"}
                  </button>
                  <label className="tap inline-flex min-h-[38px] cursor-pointer items-center gap-1.5 rounded-xl bg-white px-3 text-[13px] font-bold text-ink-soft ring-1 ring-black/10">
                    <Camera className="h-4 w-4" />
                    이미지 선택
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) handleImageFile(file);
                        event.currentTarget.value = "";
                      }}
                    />
                  </label>
                  {catalog.loading && <span className="text-[12px] font-semibold text-ink-faint">장비목록 불러오는 중</span>}
                  {catalog.error && <span className="text-[12px] font-semibold text-warn-fg">장비목록 오류: {catalog.error}</span>}
                </div>
                {image && (
                  <div className="mt-2 flex items-center gap-2 rounded-xl bg-white p-2 ring-1 ring-black/8">
                    <img src={image.dataUrl} alt="첨부 이미지" className="h-16 w-16 rounded-lg object-cover" />
                    <div className="min-w-0 flex-1 text-[12px] font-semibold text-ink-soft">{image.mediaType} 캡처 첨부됨</div>
                    <button type="button" onClick={() => setImage(null)} className="tap rounded-lg px-2 py-1 text-[12px] font-bold text-ink-faint">제거</button>
                  </div>
                )}
              </div>

              {log.length > 0 && (
                <div className="rounded-xl bg-black/[0.025] px-3 py-2 text-[12px] leading-5 text-ink-soft">
                  {log.map((line, index) => <div key={`${line}-${index}`}>{line}</div>)}
                </div>
              )}
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <EntryField label="예약자명"><input value={customerName} onChange={(event) => setCustomerName(event.target.value)} className="entry-input" /></EntryField>
                <EntryField label="연락처"><input value={phone} onChange={(event) => setPhone(event.target.value)} className="entry-input" placeholder="010-0000-0000" /></EntryField>
                <EntryField label="할인유형">
                  <select value={discount} onChange={(event) => setDiscount(event.target.value as (typeof DISCOUNTS)[number])} className="entry-input">
                    {DISCOUNTS.map((item) => <option key={item} value={item}>{item}</option>)}
                  </select>
                </EntryField>
                <div aria-hidden />
                <EntryField label="반출일"><input type="date" value={outDate} onChange={(event) => setOutDate(event.target.value)} className="entry-input" /></EntryField>
                <EntryField label="반출시간"><input type="time" value={outTime} onChange={(event) => setOutTime(event.target.value)} className="entry-input" /></EntryField>
                <EntryField label="반납일"><input type="date" value={returnDate} onChange={(event) => setReturnDate(event.target.value)} className="entry-input" /></EntryField>
                <EntryField label="반납시간"><input type="time" value={returnTime} onChange={(event) => setReturnTime(event.target.value)} className="entry-input" /></EntryField>
              </div>

              <EntryField label="비고">
                <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} className="entry-input resize-y" placeholder="무료 제공 품목, 특이사항 등" />
              </EntryField>

              <div>
                <div className="mb-1.5 flex items-center justify-between">
                  <span className="text-[12px] font-extrabold text-ink-mute">장비 목록</span>
                  <span className="text-[11px] font-semibold text-ink-faint" title={CATALOG_SOURCE_LABEL}>세트마스터 기준</span>
                </div>
                <div className="space-y-1.5">
                  {equipment.length === 0 && <div className="rounded-xl bg-black/[0.025] px-3 py-4 text-center text-[13px] font-semibold text-ink-faint">장비를 추가해주세요.</div>}
                  {equipment.map((item, index) => (
                    <EquipmentRow
                      key={`${item.raw || item.name}-${index}`}
                      item={item}
                      index={index}
                      names={catalog.names}
                      onName={setEquipmentName}
                      onQty={setEquipmentQty}
                      onRemove={removeEquipment}
                    />
                  ))}
                </div>

                <div className="relative mt-2 flex gap-1.5">
                  <input
                    value={addName}
                    onChange={(event) => setAddName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        addEquipment(addSuggestions[0]?.name);
                      }
                    }}
                    className="entry-input flex-1"
                    placeholder="장비명 검색"
                  />
                  <button type="button" onClick={() => addEquipment(addSuggestions[0]?.name)} className="tap inline-flex w-12 items-center justify-center rounded-xl bg-white text-ink-soft ring-1 ring-black/10">
                    <Plus className="h-4.5 w-4.5" />
                  </button>
                  {addName.trim() && addSuggestions.length > 0 && (
                    <div className="absolute left-0 right-14 top-[calc(100%+4px)] z-30 max-h-56 overflow-y-auto rounded-xl bg-white py-1 shadow-card ring-1 ring-black/10">
                      {addSuggestions.map((item) => (
                        <button
                          key={item.name}
                          type="button"
                          onMouseDown={(event) => {
                            event.preventDefault();
                            addEquipment(item.name);
                          }}
                          className="block w-full px-3 py-2 text-left text-[13px] font-semibold text-ink hover:bg-brand-50"
                        >
                          {item.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <button
                type="button"
                onClick={submit}
                disabled={submitBusy}
                className="tap min-h-[44px] w-full rounded-xl bg-brand-600 text-[14px] font-extrabold text-white disabled:opacity-50"
              >
                {submitBusy ? "가용 체크 중…" : "가용 체크"}
              </button>
            </div>
          </div>

          {result && (
            <div className="mt-3 rounded-xl border border-black/8 bg-paper p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-[12px] font-bold text-ink-faint">가용 체크 결과</div>
                  <div className="text-[15px] font-extrabold text-ink">{reqID || "요청ID 확인 중"}</div>
                </div>
                {result.duplicate && <span className="rounded-full bg-warn-bg px-2.5 py-1 text-[12px] font-extrabold text-warn-fg">중복 요청</span>}
              </div>
              {result.message && <div className="mt-2 rounded-lg bg-white px-3 py-2 text-[12.5px] font-semibold text-ink-soft ring-1 ring-black/5">{result.message}</div>}
              {rows.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  {rows.map((row, index) => {
                    const tone = resultTone(row);
                    const name = row.장비명 || row.name || "장비명 없음";
                    const detail = row.상세 || row.detail || row.status || row.결과 || "";
                    return (
                      <div key={`${name}-${index}`} className="flex items-center gap-2 rounded-lg bg-white px-2.5 py-2 ring-1 ring-black/5">
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-bold text-ink">{name}</div>
                          {detail && <div className="truncate text-[11.5px] font-semibold text-ink-faint">{detail}</div>}
                        </div>
                        <span className={`rounded-full px-2 py-0.5 text-[11px] font-extrabold ${tone === "ok" ? "bg-checkin-bg text-checkin-fg" : tone === "fail" ? "bg-attention-bg text-attention-fg" : tone === "warn" ? "bg-warn-bg text-warn-fg" : "bg-black/[0.04] text-ink-faint"}`}>
                          {row.결과 || "확인"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              {reqID && (
                <button
                  type="button"
                  onClick={registerNow}
                  disabled={registerBusy}
                  className="tap mt-3 min-h-[42px] w-full rounded-xl bg-checkin-fg text-[14px] font-extrabold text-white disabled:opacity-50"
                >
                  {registerBusy ? "등록 요청 중…" : "바로 등록 (계약+스케줄)"}
                </button>
              )}
            </div>
          )}
        </div>
      )}

      <style jsx>{`
        .entry-input {
          width: 100%;
          min-height: 38px;
          border-radius: 0.75rem;
          border: 1px solid rgba(0, 0, 0, 0.1);
          background: #fff;
          padding: 0.5rem 0.65rem;
          font-size: 13.5px;
          font-weight: 600;
          color: #1a1a1a;
          outline: none;
        }
        .entry-input:focus {
          border-color: #e8593c;
          box-shadow: 0 0 0 2px rgba(232, 89, 60, 0.12);
        }
      `}</style>
    </section>
  );
}

function EntryField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[12px] font-extrabold text-ink-mute">{label}</span>
      {children}
    </label>
  );
}

function EquipmentRow({
  item,
  index,
  names,
  onName,
  onQty,
  onRemove,
}: {
  item: EquipmentDraft;
  index: number;
  names: string[];
  onName: (index: number, value: string) => void;
  onQty: (index: number, value: string) => void;
  onRemove: (index: number) => void;
}) {
  const [focused, setFocused] = useState(false);
  const q = item.name.trim().toLowerCase();
  const suggestions = useMemo(
    () => names.filter((name) => name.toLowerCase().includes(q)).slice(0, 8),
    [names, q],
  );

  return (
    <div className="relative flex items-center gap-1.5 rounded-xl bg-white px-2 py-1.5 ring-1 ring-black/8">
      <div className="min-w-0 flex-1">
        <input
          value={item.name}
          onChange={(event) => onName(index, event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          className="w-full rounded-lg border-0 bg-transparent px-1 py-1 text-[13.5px] font-bold text-ink outline-none"
        />
        {item.warn && <div className="px-1 text-[10.5px] font-bold text-warn-fg">세트마스터 미확인</div>}
      </div>
      <input
        value={item.qty}
        onChange={(event) => onQty(index, event.target.value)}
        className="h-9 w-14 rounded-lg border border-black/10 text-center text-[13px] font-extrabold text-ink outline-none"
        inputMode="numeric"
      />
      <button type="button" onClick={() => onRemove(index)} className="tap h-9 w-8 rounded-lg text-[18px] font-bold text-ink-faint">×</button>
      {focused && q && suggestions.length > 0 && (
        <div className="absolute left-2 right-16 top-[calc(100%+4px)] z-40 max-h-52 overflow-y-auto rounded-xl bg-white py-1 shadow-card ring-1 ring-black/10">
          {suggestions.map((name) => (
            <button
              key={name}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault();
                onName(index, name);
                setFocused(false);
              }}
              className="block w-full px-3 py-2 text-left text-[13px] font-semibold text-ink hover:bg-brand-50"
            >
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
