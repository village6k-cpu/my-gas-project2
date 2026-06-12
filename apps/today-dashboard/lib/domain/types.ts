// 빌리지 오늘일정 대시보드 — 도메인 타입 (Postgres 스키마와 1:1 대응)
// 핵심: 품목별 "실제 반출/반납 상태"를 구조화. 자유 텍스트 특이사항을 대체.

export type ContractStatus = "예약" | "반출" | "반납완료" | "취소";
export type Phase = "checkout" | "checkin";
export type RiskLevel = "low" | "medium" | "high";

/** 반출 시 이 품목이 실제로 어떻게 됐나 */
export type CheckoutState = "pending" | "taken" | "excluded";
/** 반납 시 이 품목이 실제로 어떻게 들어왔나 */
export type ReturnState = "pending" | "returned" | "missing" | "damaged" | "lost";
export type Settlement = "미정" | "무상" | "유상";

/** 반납 합산 카운트 (품목 종류별) */
export interface ReturnCount {
  good: number;
  damaged: number;
  lost: number;
  memo?: string;
}

export interface EquipmentItem {
  scheduleId: string;
  name: string;
  qty: number;
  /** 실제 가져간 수량 (부분 픽업). 미지정이면 qty와 동일 */
  takenQty?: number;
  setName?: string | null;
  isSetHeader?: boolean;
  isComponent?: boolean;
  /** 메모리/배터리/카드 등 수량 주의 품목 강조 */
  emphasize?: boolean;
  /** 장비 카테고리 (시각 구분 + 재고연동) */
  category?: string;
  /** 카탈로그에 없어 자유입력된 품목 (재고 미연동) */
  offCatalog?: boolean;
  /** 현장에서 추가된 품목(라인/암/악세사리 등) */
  onsite?: boolean;
  settlement?: Settlement;
  /** 타임라인: 이 품목 시작/종료 날짜 오프셋(일). 이동=둘 다, 리사이즈=한쪽 */
  startShiftDays?: number;
  endShiftDays?: number;

  /** timeline 합성 ID(시트 행번호 기반) — 실제 스케줄ID와 다르므로 시트 write-back 금지 */
  synthetic?: boolean;

  checkoutState: CheckoutState;
  /** (레거시) 품목별 반납 상태. 반납은 returnCounts(종류별 합산) 사용 */
  returnState?: ReturnState;
  /** 이 품목에 한정된 메모 (반출/반납 분리) */
  memoCheckout?: string;
  memoCheckin?: string;
}

export interface PhotoMeta {
  id: string;
  phase: Phase | "other";
  swatch: string;
  label: string;
  memo?: string;
  url?: string;
  thumbnailUrl?: string;
  fileId?: string;
  sheetValue?: string;
  uploadedAt?: string;
  row?: number;
}

export interface RiskWarning {
  id: string;
  phase: Phase;
  equipmentName: string;
  riskLevel: RiskLevel;
  customerMessage: string;
  guidanceState: "발송권장" | "최근발송" | "대상없음" | "확인함";
  sensitive?: boolean;
}

export interface Trade {
  tradeId: string;
  customerName: string;
  customerPhone: string;
  company?: string;
  checkoutAt: string;
  returnAt: string;
  contractStatus: ContractStatus;
  discountType?: string;

  // 검수 (PG 마스터)
  setupDone: boolean;
  setupDoneAt?: string | null;
  returnDone: boolean;
  returnDoneAt?: string | null;

  // 결제/증빙 (M1 표시 전용)
  paymentMethod?: string;
  paymentWarning?: boolean;
  depositStatus?: string;
  proofType?: string;
  issueStatus?: string;
  issueNote?: string;
  billingCompany?: string;
  amount?: number;

  // 계약서
  contractUrl?: string | null;
  contractRegenPending?: boolean;
  estimateSent?: boolean;
  statementSent?: boolean;

  // 인계 메모 — 반출/반납 완전 분리 (자유 텍스트는 보조용)
  noteCheckout?: string;
  noteCheckin?: string;

  // 반납: 품목명별 합산 카운트 (종류별 개수 대조). key = 품목명
  returnCounts?: Record<string, ReturnCount>;

  equipments: EquipmentItem[];
  photos: PhotoMeta[];
  riskWarnings: RiskWarning[];
}

export interface HandoverNote {
  id: string;
  body: string;
}

export type TabKey = "checkout" | "checkin" | "all" | "attention";

export interface DashboardDay {
  date: string;
  trades: Trade[];
  notes: HandoverNote[];
}
