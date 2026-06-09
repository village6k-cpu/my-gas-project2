// 현실적인 시드 데이터 — 추후 Supabase 응답으로 교체. 형태는 동일(Trade[]).
import type { EquipmentItem, HandoverNote, Trade } from "../domain/types";
import { addDays } from "../domain/status";
import { CATALOG } from "../domain/catalog";

function at(date: string, hh: number, mm = 0): string {
  // 로컬(현지) 시각을 그대로 나타내는 ISO. timestamptz 왕복 시 +오프셋 밀림 방지.
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d, hh, mm, 0).toISOString();
}

let _eq = 0;
const sid = () => `S-${String(++_eq).padStart(4, "0")}`;
const CAT = new Map(CATALOG.map((c) => [c.name, c.category]));

function item(name: string, qty: number, opts: Partial<EquipmentItem> = {}): EquipmentItem {
  return { scheduleId: sid(), name, qty, category: CAT.get(name), checkoutState: "pending", returnState: "pending", ...opts };
}

export function buildSeed(today: string): { trades: Trade[]; notes: HandoverNote[] } {
  const yest = addDays(today, -1);

  const trades: Trade[] = [
    // ── 반출 (오늘 나감) ─────────────────────────────────────────
    {
      tradeId: "260608-001",
      customerName: "김도윤",
      customerPhone: "010-2841-5567",
      company: "스튜디오 노을",
      checkoutAt: at(today, 9, 30),
      returnAt: at(addDays(today, 2), 9, 0),
      contractStatus: "예약",
      setupDone: false,
      returnDone: false,
      paymentMethod: "계좌이체",
      depositStatus: "입금완료",
      proofType: "세금계산서",
      issueStatus: "발행대기",
      billingCompany: "노을미디어",
      amount: 286000,
      contractUrl: "https://example.com/c1",
      discountType: "개인사업자",
      equipments: [
        item("소니 A7S3 바디세트", 1, { isSetHeader: true, setName: "소니 A7S3 바디세트" }),
        item("소니 A7S3 바디", 1, { isComponent: true, setName: "소니 A7S3 바디세트" }),
        item("소니 NP-FZ100 배터리", 3, { isComponent: true, setName: "소니 A7S3 바디세트", emphasize: true }),
        item("CFexpress 160GB", 2, { isComponent: true, setName: "소니 A7S3 바디세트", emphasize: true }),
        item("소니 GM 24-70mm II", 1),
      ],
      photos: [],
      riskWarnings: [
        { id: "r1", phase: "checkout", equipmentName: "소니 GM 24-70mm II", riskLevel: "medium", customerMessage: "렌즈 후면 먼지 주의 — 반출 전 점검 안내", guidanceState: "발송권장" },
      ],
    },
    {
      tradeId: "260608-002",
      customerName: "이서연",
      customerPhone: "010-7720-1043",
      checkoutAt: at(today, 11, 0),
      returnAt: at(today, 22, 0),
      contractStatus: "예약",
      setupDone: false,
      returnDone: false,
      paymentMethod: "현장카드",
      depositStatus: "결제대기",
      paymentWarning: true,
      amount: 132000,
      contractUrl: null,
      contractRegenPending: true,
      equipments: [
        item("소니 FX3 바디세트", 1, { isSetHeader: true, setName: "소니 FX3 바디세트" }),
        item("소니 FX3 바디", 1, { isComponent: true, setName: "소니 FX3 바디세트" }),
        item("DJI RS3 Pro 짐벌", 1),
      ],
      photos: [],
      riskWarnings: [],
    },
    {
      // 반출 일부 진행: 가져감/제외/현장추가 + 부분수량 시연
      tradeId: "260608-003",
      customerName: "박준혁",
      customerPhone: "010-3398-8821",
      company: "프리랜서",
      checkoutAt: at(today, 14, 30),
      returnAt: at(addDays(today, 1), 14, 0),
      contractStatus: "예약",
      setupDone: false,
      returnDone: false,
      paymentMethod: "계좌이체",
      depositStatus: "입금완료",
      amount: 198000,
      contractUrl: "https://example.com/c3",
      noteCheckout: "",
      equipments: [
        item("소니 GM 70-200mm II", 1, { checkoutState: "taken" }),
        item("맨프로토 삼각대 055", 1, { checkoutState: "excluded", memoCheckout: "고객 본인 삼각대 지참" }),
        item("소니 NP-FZ100 배터리", 3, { emphasize: true, checkoutState: "taken", takenQty: 2 }),
        item("매직암 11인치", 1, { onsite: true, settlement: "무상", checkoutState: "taken" }),
      ],
      photos: [{ id: "p1", phase: "checkout", swatch: "#3b82f6", label: "반출 1" }],
      riskWarnings: [],
    },

    // ── 반납 (오늘 들어옴) ───────────────────────────────────────
    {
      tradeId: "260606-014",
      customerName: "최민지",
      customerPhone: "010-5512-9087",
      company: "감성필름",
      checkoutAt: at(addDays(today, -2), 10, 0),
      returnAt: at(today, 10, 0),
      contractStatus: "반출",
      setupDone: true,
      setupDoneAt: at(addDays(today, -2), 10, 5),
      returnDone: false,
      paymentMethod: "계좌이체",
      depositStatus: "입금완료",
      amount: 340000,
      contractUrl: "https://example.com/c14",
      equipments: [
        item("소니 FX6 바디세트", 1, { isSetHeader: true, setName: "소니 FX6 바디세트", checkoutState: "taken" }),
        item("소니 FX6 바디", 1, { isComponent: true, setName: "소니 FX6 바디세트", checkoutState: "taken" }),
        item("V마운트 배터리", 2, { isComponent: true, setName: "소니 FX6 바디세트", emphasize: true, checkoutState: "taken" }),
        item("탐론 28-75mm G2", 1, { checkoutState: "taken" }),
        item("SDI 연선 5m", 5, { checkoutState: "taken" }),
        item("SDI 연선 5m", 3, { onsite: true, settlement: "유상", checkoutState: "taken" }),
        item("중계선 20m", 5, { checkoutState: "taken" }),
        item("매직암 11인치", 3, { checkoutState: "taken" }),
        item("V마운트 배터리", 1, { onsite: true, settlement: "무상", checkoutState: "taken" }),
        item("소니 NP-FZ100 배터리", 6, { emphasize: true, checkoutState: "taken" }),
      ],
      returnCounts: {
        "SDI 연선 5m": { good: 7, damaged: 0, lost: 0 },
        "매직암 11인치": { good: 3, damaged: 0, lost: 0 },
      },
      photos: [{ id: "p3", phase: "checkout", swatch: "#3b82f6", label: "반출" }],
      riskWarnings: [
        { id: "r2", phase: "checkin", equipmentName: "소니 FX6 바디", riskLevel: "high", customerMessage: "센서 오염 빈발 기종 — 반납 시 센서 확인", guidanceState: "대상없음" },
      ],
    },
    {
      // 반납 파손 시연
      tradeId: "260605-009",
      customerName: "정해성",
      customerPhone: "010-9043-2256",
      checkoutAt: at(addDays(today, -3), 13, 0),
      returnAt: at(today, 13, 0),
      contractStatus: "반출",
      setupDone: true,
      returnDone: false,
      paymentMethod: "계좌이체",
      depositStatus: "입금완료",
      amount: 264000,
      contractUrl: "https://example.com/c9",
      equipments: [
        item("소니 GM 16-35mm II", 1, { checkoutState: "taken" }),
        item("소니 A7M4 바디", 1, { checkoutState: "taken" }),
      ],
      returnCounts: {
        "소니 A7M4 바디": { good: 1, damaged: 0, lost: 0 },
        "소니 GM 16-35mm II": { good: 0, damaged: 1, lost: 0, memo: "후드 깨짐 — 고객 확인, 수리비 청구 예정" },
      },
      photos: [
        { id: "p4", phase: "checkout", swatch: "#3b82f6", label: "반출" },
        { id: "p5", phase: "checkin", swatch: "#ef4444", label: "파손부" },
      ],
      riskWarnings: [],
    },

    // ── 확인필요: 미반납 경과 ────────────────────────────────────
    {
      tradeId: "260604-021",
      customerName: "한지우",
      customerPhone: "010-1184-7762",
      checkoutAt: at(addDays(today, -4), 9, 0),
      returnAt: at(yest, 18, 0),
      contractStatus: "반출",
      setupDone: true,
      returnDone: false,
      paymentMethod: "계좌이체",
      depositStatus: "입금완료",
      amount: 410000,
      contractUrl: "https://example.com/c21",
      equipments: [
        item("소니 A1 바디", 1, { checkoutState: "taken" }),
        item("소니 GM 50mm F1.2", 1, { checkoutState: "taken" }),
      ],
      photos: [],
      riskWarnings: [],
    },

    // ── 반출+반납 같은 날 (당일 대여) ────────────────────────────
    {
      tradeId: "260608-004",
      customerName: "오세훈",
      customerPhone: "010-6627-3390",
      company: "원데이웍스",
      checkoutAt: at(today, 8, 0),
      returnAt: at(today, 20, 0),
      contractStatus: "예약",
      setupDone: false,
      returnDone: false,
      paymentMethod: "계좌이체",
      depositStatus: "입금완료",
      amount: 99000,
      contractUrl: "https://example.com/c4",
      equipments: [
        item("DJI 마이크 2 세트", 1),
        item("아트리스트 LED P60c", 2),
      ],
      photos: [],
      riskWarnings: [],
    },
  ];

  const notes: HandoverNote[] = [
    { id: "n1", body: "FX6(260606-014) 반납 시 센서 클리닝 키트로 점검 — 오염 잦음" },
    { id: "n2", body: "한지우님(260604-021) 미반납 — 오전에 연락 한 번 더" },
    { id: "n3", body: "CFexpress 카드 재고 2장뿐. 반납 들어오면 바로 포맷" },
  ];

  return { trades, notes };
}
