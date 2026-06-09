# 빌리지 '오늘일정' 대시보드 재구축 — 설계 스펙

- **작성일**: 2026-06-08
- **상태**: 초안 (사용자 검토 대기)
- **기준 문서**: [`docs/superpowers/2026-06-08-village-system-map.md`](../2026-06-08-village-system-map.md) (8-에이전트 시스템 종합 맵)
- **산출 근거**: 대시보드 프론트 계약(13섹션/26 회귀-금지 기능), 백엔드 계약(27함수/6 외부연동), 재구축 설계(Postgres 스키마·동기화 경계·모듈 아키텍처·API)

---

## 0. 배경 & 목표

빌리지(카메라/렌즈 렌탈샵)의 운영은 구글시트+GAS 위에 쌓여 있고, 핵심 웹앱('오늘일정', '빌리지스케줄')이 GAS 기반이라 **느리고 반응성이 나쁘다**. 근본 원인은 프론트가 아니라 백엔드 구조다: 시트를 DB로 쓰며 매 요청마다 풀스캔, GAS 콜드스타트·6분 한도, 전역 캐시 무효화 폭발, 변이마다 `innerHTML` 통짜 재렌더.

목표는 **진짜 서비스급 통합 앱**으로의 재구축이며, 그 첫 웨지로 **'오늘일정 대시보드'**를 모던 스택(Supabase+Vercel+Next.js)에서 다시 짓는다. 이미 자동화 레이어(카카오 코워크 봇·후속조치 대시보드)가 Supabase+Vercel+Hermes로 탈-GAS 중이므로 같은 방향으로 수렴한다.

**이 스펙의 산출물**: 단일 마일스톤(M1)으로 출시 가능한 '오늘일정 대시보드' 신규 앱의 아키텍처·데이터모델·동기화·모듈·API·인증·마이그레이션 설계.

---

## 1. 확정된 결정 (사용자 승인)

| # | 결정 | 값 |
|---|---|---|
| 1 | 재구축 전략 | **모던 스택 풀 재구축** — Supabase(Postgres) + Vercel + Next.js |
| 2 | 데이터 source of truth | **DB가 마스터, 시트는 읽기 미러** (전환기 일부 필드는 시트로 write-back) |
| 3 | 첫 웨지 | **오늘일정 대시보드** |
| 4 | 주 사용 환경 | **현장 모바일 위주** → PWA·오프라인·옵티미스틱 UI 최우선 |
| 5 | 첫 마일스톤 범위 | **읽기 + 경량 변이부터** (가용성 영향 큰 변이는 한동안 기존 dashboard.html 유지) |
| 6 | 인증/사용자 | **사장 + 직원 + 코워크 AI 봇** 각자 계정/토큰 (Supabase Auth + RLS 역할 + 봇 서비스 토큰) |

---

## 2. 범위 — 마일스톤 경계

### 핵심 통찰 (전체를 좌우)
가용성 엔진(sweep-line)이 **아직 시트의 `계약마스터.J(계약상태)`·`스케줄상세.J(상태)`를 읽는다**(가용성 계산에서 `취소`/`반납완료` 행 제외 — 코드 근거: checkAvailability.js:2430, 4762-4766, 7324, 7407, 8544). 따라서 대시보드 변이를 **두 종류로 가른다**:
- **(a) PG가 마스터, write-back 불필요**: 검수(반출완료)·품목체크·인수인계 메모·사진·반납상태 메모. (기존 `ScriptProperties` 임시 플래그를 **정식 DB 컬럼으로 승격**)
- **(b) 시트로 write-back 필요**: 계약상태(반납완료/취소)·스케줄 행(추가/수량/삭제)·결제/증빙(개고생2.0 회계).

### 마일스톤 1 (이번 스펙의 구현 대상)
읽기 전체 + 경량 변이 + **가용성-critical 쓰기 중 '반납완료' 하나만** 포함.

**포함**: 4탭(반출/반납/전체/확인필요)+배지, 날짜 내비, 글로벌 검색, 시간대 그룹/한국어 정렬, 인수인계 메모, 품목 체크, **반출완료/반납완료 토글**, 반납상태/특이사항 메모, 사진 업로드·갤러리, 리스크 경고 **표시**, 계약서 상태 **표시**(realtime), 옵티미스틱 UI + 오프라인 큐 + PWA + Realtime 부분패치, 시트↔PG 동기화 인프라(초기 마이그레이션 + 지속 동기화 + write-back 큐), 인증/RLS.

**제외(한동안 기존 dashboard.html 유지)**: 장비 추가/현장추가, 수량 수정, 삭제, 계약상태 변경/취소, 결제수단, 증빙/입금/발행상태, 발행처, 견적 발송, 팝빌 발행요청, 리스크 발송/이벤트 액션, AI 카톡 예약입력(별도 모듈).

> 전환기에는 신규 대시보드(일상 운영·검수·확인)와 기존 dashboard.html(중량 편집)이 **공존**한다. 시트 정합은 신규가 '반납완료'를 write-back하고, 나머지 중량 편집은 기존 경로가 시트에 직접 쓰며 그 변경분이 동기화로 PG에 흘러든다.

---

## 3. 아키텍처 — DB-마스터 대시보드 + 시트 동기화 브리지

```
                  ┌─────────────────────────────────────────────┐
   현장 모바일 ───▶│  Next.js PWA (Vercel)  · 옵티미스틱 · Realtime │
   사장/직원/봇     └───────────────┬─────────────────────────────┘
                                  │ 읽기(RPC) / 변이
                          ┌───────▼────────┐   realtime 부분패치
                          │  Supabase(PG)  │◀── (통짜 재렌더 폐기)
                          │  운영 진실원본  │
                          └──┬──────────┬──┘
              (a) PG-only    │          │  (b) 가용성/회계 영향
        검수·품목·메모·사진   │          │  → sheet_writeback_queue
                             │     ┌────▼──────────────────────┐
                             │     │ 기존 GAS 변이함수 재호출    │
                             │     │ (setDashboardReturnContract │
                             │     │  Status_ → 계약마스터 J 등) │
                             │     └────┬──────────────────────┘
                 시트→PG 동기화 ◀───────┴──── 레거시 시트 (가용성 엔진이 읽음)
              (onEdit webhook + 2~3분 폴링 안전망)
```

**원칙**: 신규 앱은 시트 셀을 **직접 쓰지 않는다**. write-back은 반드시 기존 GAS 변이 함수를 `action=` API로 재호출한다(LockService·계약서 재생성·스타일·캐시무효화가 묶여 있어 우회하면 정합이 깨짐).

---

## 4. 데이터 모델 (Postgres / Supabase)

```sql
-- ============================================================================
-- 빌리지 '오늘 일정' 대시보드 — 최소 정규화 Postgres 스키마 (Supabase)
-- 목적: 대시보드 1읽기 + 운영 변이를 서빙. 가용성 엔진은 아직 시트(GAS)에 있으므로
--       이 DB는 "운영 진실원본 + 시트 미러"이며, 일부 필드는 시트로 write-back 됨.
-- 컨벤션: 모든 테이블 RLS on, app schema, created_at/updated_at, soft-delete 없음(시트가 삭제 마스터인 영역 존재)
-- ============================================================================

create schema if not exists village;

-- ── 상태 ENUM (시트 한글 문자열 ↔ enum 매핑은 sync 레이어가 담당) ──────────────
create type village.contract_status as enum ('예약','반출','반납완료','취소');   -- 계약마스터 J열
create type village.schedule_status as enum ('대기','반출중','반납완료','취소');  -- 스케줄상세 J열
create type village.check_phase     as enum ('checkout','checkin');             -- 반출/반납
create type village.return_status   as enum ('정상','확인필요','파손','분실','미반납','반납완료'); -- 장비체크 반납상태
create type village.photo_phase     as enum ('checkout','checkin','other');
create type village.settlement_status as enum ('미정','무상','유상');           -- 현장추가 정산
create type village.sync_origin     as enum ('postgres','sheet');              -- 변이 출처(루프 방지)

-- ── 거래 (계약마스터의 대시보드 투영) ───────────────────────────────────────
-- trade_id 는 시트의 '거래ID'(YYMMDD-NNN)를 그대로 PK로 채택(채번은 레거시 GAS 소유).
create table village.trades (
  trade_id          text primary key,                       -- = 계약마스터 A
  customer_name     text not null,                           -- 계약마스터 B
  customer_phone    text,                                    -- 계약마스터 C
  company           text,                                    -- 계약마스터 D
  checkout_at       timestamptz,                             -- E~F 반출일시
  return_at         timestamptz,                             -- G~H 반납일시
  round_no          int,                                     -- I 회차
  contract_status   village.contract_status not null default '예약', -- J (write-back 대상)
  discount_type     text,                                    -- K 할인유형
  contract_note     text,                                    -- L 비고
  contract_url      text,                                    -- 개고생2.0 거래내역 C(계약서링크)
  contract_regen_pending boolean not null default false,     -- 재생성 큐 상태(PG 소유)
  -- 검수(반출/반납 완료) — 기존 ScriptProperties setupDone_/returnDone_ 를 정식 컬럼으로 승격
  setup_done        boolean not null default false,
  setup_done_at     timestamptz,
  return_done       boolean not null default false,
  return_done_at    timestamptz,
  -- 정산/증빙/결제 (개고생2.0 거래내역 G/J/K/L/M) — PG가 표시 마스터, 시트에도 미러 write-back
  payment_method    text,                                    -- J 결제수단
  billing_company   text,                                    -- G 발행처상호
  proof_type        text,                                    -- K 증빙유형
  issue_status      text,                                    -- L 발행상태
  deposit_status    text,                                    -- M 입금상태
  -- 동기화 메타
  sheet_row         int,                                     -- 계약마스터 행번호(write-back 가속용 힌트, 신뢰X)
  last_synced_at    timestamptz,
  sheet_revision    bigint not null default 0,               -- 시트→PG 반영 버전
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index trades_checkout_idx on village.trades (checkout_at);
create index trades_return_idx   on village.trades (return_at);
create index trades_status_idx   on village.trades (contract_status);
-- 대시보드 날짜뷰 핵심: 해당 날짜 반출 또는 반납. 표현식 인덱스로 날짜경계 스캔.
create index trades_checkout_date_idx on village.trades ((checkout_at::date));
create index trades_return_date_idx   on village.trades ((return_at::date));
-- 검색(이름/연락처/회사) — pg_trgm
create extension if not exists pg_trgm;
create index trades_name_trgm  on village.trades using gin (customer_name gin_trgm_ops);
create index trades_phone_trgm on village.trades using gin (customer_phone gin_trgm_ops);

-- ── 장비 마스터 (장비마스터의 대시보드 투영: 자동완성 + 표시명) ──────────────
create table village.equipment (
  equipment_id   text primary key,                           -- 장비마스터 B (CAM-001)
  category       text,                                       -- C
  name           text not null,                              -- D 장비명 (FK 키로 사용됨)
  total_qty      int,                                        -- E 총보유수량 (가용성 입력, 표시용 미러)
  photo_url      text,                                       -- M 장비사진
  sheet_revision bigint not null default 0,
  updated_at     timestamptz not null default now()
);
create unique index equipment_name_uidx on village.equipment (name);

-- ── 세트 마스터 (세트 구성 + 단가) — 대시보드 장비추가/표시용 ─────────────────
create table village.set_master (
  set_name       text not null,                              -- 세트마스터 A
  component_name text not null,                              -- B 구성장비명
  component_qty  int  not null default 1,                    -- C
  alt_equipment  text,                                       -- E 대체장비
  availability_check boolean not null default true,          -- F 가용체크(Y/N)
  unit_price     numeric(12,0),                              -- G 단가(전 시스템 단일 가격 소스)
  sheet_revision bigint not null default 0,
  primary key (set_name, component_name)
);

-- ── 스케줄(품목) 상세 (스케줄상세의 투영) ───────────────────────────────────
-- schedule_id 는 시트 '{거래ID}-NN' PK. 가용성 입력이라 INSERT/DELETE/qty 는 시트로 write-back.
create table village.schedule_items (
  schedule_id    text primary key,                           -- 스케줄상세 A
  trade_id       text not null references village.trades(trade_id) on delete cascade, -- B
  set_name       text,                                       -- C (세트명, 단품은 null)
  equipment_name text not null,                              -- D
  qty            int  not null default 1,                    -- E (write-back 대상)
  checkout_at    timestamptz,                                -- F~G
  return_at      timestamptz,                                -- H~I
  status         village.schedule_status not null default '대기', -- J (write-back 대상)
  unit_price     numeric(12,0),                              -- L
  reserver_name  text,                                       -- M (merge 키)
  -- 구조 메타(렌더 분기용, 시트엔 없음/파생)
  is_set_header  boolean not null default false,
  is_component   boolean not null default false,
  -- 품목 체크(반출/반납) — 기존 ScriptProperties itemCheck_<scheduleId>_<phase> 승격. PG 마스터.
  checked_checkout boolean not null default false,
  checked_checkin  boolean not null default false,
  -- 동기화 메타
  source         village.sync_origin not null default 'sheet',
  sheet_row      int,
  sheet_revision bigint not null default 0,
  pending        boolean not null default false,             -- 옵티미스틱 대기행
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create index sched_trade_idx  on village.schedule_items (trade_id);
create index sched_equip_idx  on village.schedule_items (equipment_name);
create index sched_status_idx on village.schedule_items (status);

-- ── 장비 점검 결과 (개고생2.0 장비체크 시트의 투영) — PG 마스터 + 미러 write-back ──
create table village.equipment_checks (
  trade_id      text primary key references village.trades(trade_id) on delete cascade,
  reserver_name text,                                        -- B 예약자명
  return_status village.return_status,                       -- 반납상태
  memo          text,                                        -- 특이사항 (<=500)
  updated_by    text,
  sheet_revision bigint not null default 0,
  updated_at    timestamptz not null default now()
);

-- ── 사진 (반출/반납/기타) — PG 마스터(메타), 바이너리는 Supabase Storage ─────────
-- 마이그레이션 후 신규는 Storage 업로드. 레거시는 Drive URL 미러.
create table village.trade_photos (
  id            uuid primary key default gen_random_uuid(),
  trade_id      text not null references village.trades(trade_id) on delete cascade,
  phase         village.photo_phase not null,
  storage_path  text,                                        -- Supabase Storage object (신규)
  drive_url     text,                                        -- 레거시 Drive 원본 URL
  thumbnail_url text,
  drive_file_id text,
  memo          text,
  uploaded_by   text,
  uploaded_at   timestamptz not null default now(),
  synced_to_sheet boolean not null default false             -- 반출반납 사진 시트 append 완료여부
);
create index photos_trade_phase_idx on village.trade_photos (trade_id, phase);

-- ── 현장추가 로그 (onsiteAddon) — PG 마스터(감사용), 시트엔 스케줄행으로만 반영 ──
create table village.onsite_addons (
  id            uuid primary key default gen_random_uuid(),
  trade_id      text not null references village.trades(trade_id) on delete cascade,
  entries       jsonb not null,                              -- [{name,qty}]
  settlement_status village.settlement_status not null default '미정',
  actor_name    text,
  created_at    timestamptz not null default now()
);

-- ── 인수인계 메모(포스트잇) — PG 마스터. 기존 ScriptProperties dashboardPostItNotes_v1 승격 ──
create table village.handover_notes (
  id         uuid primary key default gen_random_uuid(),
  position   int not null,                                   -- 0..7 (최대 8)
  body       text not null check (char_length(body) <= 180),
  updated_at timestamptz not null default now()
);

-- ── 장비 리스크 경고 (장비주의사항 평가 결과) — 외부 risk 백엔드가 진실원본, PG는 캐시 투영 ──
create table village.risk_warnings (
  id             uuid primary key default gen_random_uuid(),
  trade_id       text not null references village.trades(trade_id) on delete cascade,
  phase          village.check_phase not null,
  rule_id        text,
  rule_version   text,
  risk_level     text,
  equipment_name text,
  customer_message text,
  pickup_staff_text text,
  return_check_text text,
  sensitive      boolean default false,
  cooldown_days  int,
  guidance_state text,                                       -- 발송권장/최근발송/대상없음/...
  guidance_reason text,
  last_sent_at   timestamptz,
  evaluated_at   timestamptz not null default now()
);
create index risk_trade_idx on village.risk_warnings (trade_id, phase);

-- ── 외부행 변이 아웃박스 (PG→시트 write-back 큐) — 가용성/등록 정합성 보장의 핵심 ──
create table village.sheet_writeback_queue (
  id          bigint generated always as identity primary key,
  trade_id    text,
  target      text not null,        -- 'contract_status' | 'schedule_qty' | 'schedule_insert' | 'schedule_delete' | 'trade_extra' | 'equipment_check' | 'photo'
  payload     jsonb not null,
  status      text not null default 'pending',  -- pending|processing|done|failed
  attempts    int  not null default 0,
  last_error  text,
  created_at  timestamptz not null default now(),
  processed_at timestamptz
);
create index wbq_pending_idx on village.sheet_writeback_queue (status, created_at) where status in ('pending','failed');

-- ── 업데이트 타임스탬프 트리거 ─────────────────────────────────────────────
create or replace function village.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
create trigger trg_trades_touch  before update on village.trades         for each row execute function village.touch_updated_at();
create trigger trg_sched_touch   before update on village.schedule_items for each row execute function village.touch_updated_at();

-- ── RLS: 운영자/직원만(현재 역할 모델 없음 → 단일 'staff' 역할로 시작) ──────────
alter table village.trades            enable row level security;
alter table village.schedule_items    enable row level security;
alter table village.equipment_checks  enable row level security;
alter table village.trade_photos      enable row level security;
alter table village.handover_notes    enable row level security;
alter table village.onsite_addons     enable row level security;
alter table village.risk_warnings     enable row level security;
-- equipment / set_master 는 읽기전용 참조 → authenticated select 만 허용.
-- 예시 정책(authenticated = 로그인한 빌리지 직원). 변이는 RPC(security definer) 경유 권장.
create policy staff_read   on village.trades         for select to authenticated using (true);
create policy staff_write  on village.trades         for update to authenticated using (true) with check (true);
create policy staff_read_s on village.schedule_items for select to authenticated using (true);
create policy staff_notes  on village.handover_notes for all    to authenticated using (true) with check (true);
-- (나머지 테이블 동형. write 경로는 RPC에서 security definer로 RLS 우회 + 자체 검증)

-- ── Realtime: 대시보드가 구독할 테이블만 publication 등록 ──────────────────────
alter publication supabase_realtime add table
  village.trades, village.schedule_items, village.equipment_checks,
  village.trade_photos, village.handover_notes, village.risk_warnings;
-- writeback_queue / set_master / equipment 은 realtime 제외(노이즈).
```


---

## 5. 시트 ↔ Postgres 동기화·write-back 경계

## 시트 ↔ Postgres 동기화·write-back 경계

핵심 원칙: **가용성 엔진(sweep-line)이 읽는 시트 셀을 바꾸는 변이는 반드시 시트로 write-back**한다. 그 외 표시/검수성 변이는 Postgres가 마스터이고 시트는 회계(개고생2.0) 정합을 위해 best-effort 미러만 한다.

코드 근거(검증): 가용성 필터는 `계약마스터.J === '취소'` 행과 `스케줄상세.J(status) ∈ {반납완료, 취소}` 행을 동시사용 계산에서 **제외**한다(checkAvailability.js:2430, 4762-4766, 7324, 7407, 8544; `setDashboardReturnContractStatus_`:2706 가 J=반납완료를 직접 씀). 따라서 이 세 가지(계약상태=반납완료/취소, 스케줄행 존재·수량·상태)가 정확하지 않으면 레거시 GAS의 확인요청→등록 가용판정이 과대/과소 오판한다.

### (a) Postgres가 진실원본(write-back 불필요, 단 회계 미러는 선택)
- **검수 토글**: `trades.setup_done/return_done(+at)` — 기존 ScriptProperties `setupDone_`/`returnDone_` 를 정식 컬럼으로 승격. 단 `return_done=true`는 (b)의 계약상태 반납완료 write-back을 **수반**한다.
- **품목 체크**: `schedule_items.checked_checkout/checkin` — 기존 `itemCheck_` 프로퍼티. 가용성과 무관, 순수 UI 상태. write-back 없음.
- **인수인계 메모**: `handover_notes` — 기존 `dashboardPostItNotes_v1`. 시트 무관.
- **사진**: `trade_photos` + Supabase Storage — 신규 업로드는 PG/Storage가 마스터. 개고생2.0 '반출반납 사진' 시트로는 회계/레거시 조회 호환을 위해 **append 미러**(write-back 큐 target=`photo`)만.
- **장비 점검 결과(반납상태/메모)**: `equipment_checks` — PG 마스터. 가용성과 무관하나 개고생2.0 장비체크 시트가 회계/이력 참조처라 **미러 write-back**(target=`equipment_check`).
- **현장추가 로그/정산**: `onsite_addons` — PG 마스터(감사). 단 추가된 품목 자체는 스케줄행이므로 (b)로 write-back.
- **리스크 평가 캐시**: `risk_warnings` — 외부 risk 백엔드가 진실원본, PG는 투영 캐시. 시트 write-back 없음.

### (b) 반드시 시트로 write-back (가용성/등록 정합성 필수)
| PG 변이 | 시트 대상 | 이유 | 큐 target |
|---|---|---|---|
| `trades.contract_status = 반납완료` (반납검수 ON) | 계약마스터 **J열** + 직전상태 보존(`returnPrevContractStatus_`) | 반납완료여야 sweep-line이 해당 거래 점유를 해제 → 같은 장비 신규 예약 가용 | `contract_status` |
| `trades.contract_status = 취소` | 계약마스터 J=취소 + **스케줄상세 행 DELETE** + 개고생2.0 거래내역 행 DELETE (`cancelContract`) | 취소 행이 남으면 가용성에서 점유로 잡힘. 행 삭제까지 해야 정합 | `contract_status`(payload.cancel=true) |
| `trades.contract_status = 예약/반출` 복원(반납검수 OFF) | 계약마스터 J 복원 | 반출로 되돌리면 다시 점유로 잡혀야 함 | `contract_status` |
| `schedule_items` INSERT (장비추가/현장추가) | 스케줄상세 행 INSERT(A~M, 세트 구성품 전개, status 대기) + `scheduleContractRegen` | 새 점유는 시트에 있어야 가용성·계약서 반영 | `schedule_insert` |
| `schedule_items.qty` 수정 | 스케줄상세 **E열**(세트헤더면 구성품도) + regen | 수량이 곧 동시사용 qty | `schedule_qty` |
| `schedule_items` DELETE | 스케줄상세 행 DELETE + regen | 제거된 점유 해제 | `schedule_delete` |
| 결제/발행처/증빙/입금 (`payment_method,billing_company,proof_type,issue_status,deposit_status`) | 개고생2.0 거래내역 G/J/K/L/M | 가용성 무관이나 **개고생2.0(회계)가 마스터**라 반드시 미러 | `trade_extra` |

> write-back은 GAS의 기존 변이 함수(`setDashboardReturnContractStatus_`, `updateDashboardContractStatus`, `dashboardAddEquipments`, `dashboardUpdateEquipmentQty`, `dashboardRemoveEquipment`, `updateTradePaymentMethod` 등)를 **그대로 재사용**한다. 신규 앱은 시트 셀을 직접 쓰지 않고 이 함수들을 호출(LockService·계약서 재생성·스타일링·캐시 무효화가 묶여 있어 우회하면 정합 깨짐).

### (c) 동기화 메커니즘
**초기 마이그레이션 (1회)**: GAS 일괄 export 스크립트 → 계약마스터/스케줄상세/장비마스터/세트마스터/개고생2.0 거래내역·장비체크·사진을 batch read(풀스캔 1회) → Supabase service-role로 upsert. `setupDone_/returnDone_/itemCheck_/dashboardPostItNotes_v1` ScriptProperties도 함께 추출해 정식 컬럼/테이블로 적재. 한글 상태문자열 → enum 매핑 테이블 적용. 각 행 `sheet_revision=1`, `source='sheet'`.

**지속 동기화 — 시트 → Postgres (이벤트 우선 + 폴링 안전망)**:
- 1차: GAS `onEdit`(installable) 훅에서 변경된 시트/행 범위만 추려 Vercel webhook(`POST /api/sync/sheet-edit`, HMAC 서명)으로 push → service-role로 해당 거래만 upsert(부분 패치, 풀스캔 금지). 페이로드에 `sheet_revision++`.
- 2차 안전망: Supabase cron(또는 Vercel cron) 2~3분 주기로 `nocache=1 action=dashboard` 또는 전용 gviz 읽기로 최근 N일치 거래를 diff upsert. onEdit 누락/콜드스타트 대비.
- 마이그레이션 기간엔 레거시 등록(registerByReqID)이 새 거래/스케줄을 시트에 만드므로 시트→PG가 신규 거래의 1차 유입 경로. 이 흐름을 끊지 말 것.

**지속 동기화 — Postgres → 시트 (write-back, 큐 기반)**:
- 대시보드 변이는 PG에 즉시 커밋(옵티미스틱) + `sheet_writeback_queue`에 enqueue.
- 워커(Vercel cron 또는 Supabase Edge Function, 직렬)가 큐를 폴링 → 해당 GAS 변이 함수를 `action=` API로 호출 → 성공 시 `done`, 실패 시 `attempts++` 지수 백오프 재시도. 계약상태/스케줄 변이는 **순서 보존**(같은 trade_id 직렬) 필수.

### 충돌·정합성 처리
- **루프 방지**: write-back으로 GAS가 시트를 바꾸면 onEdit이 또 fire한다. 페이로드에 `source/origin` 표식 + `sheet_revision` 비교로, PG가 방금 보낸 변이로 인한 시트 echo는 무시(이미 PG가 더 최신).
- **충돌 정책(필드별 소유권으로 단순화)**: (b)-가용성 필드는 **PG가 권위**(대시보드가 운영 진실원본). 시트가 레거시 경로(확인요청 등록, markOverdueReturnContracts 배치)로 바꾼 값은 시트→PG로 들어오되, 진행 중인 PG 미반영 write-back이 있으면 큐 우선. 단순 last-writer 대신 `sheet_revision`(시트발) vs `updated_at`(PG발) 중 큐 pending 여부로 판정.
- **자동 반납완료 배치**(`markOverdueReturnContracts`)는 시트에서 J=반납완료를 직접 쓰므로, 이 경로는 시트→PG 동기화로 흡수(PG의 return_done도 갱신).
- **취소의 행삭제**는 비가역 → write-back 큐에서 `cancel`을 단일 트랜잭션으로 처리하고, PG도 동시에 contract_status=취소 + 관련 schedule_items soft-mark 후 다음 sync에서 정리.
- **계약서 재생성 비동기**: add/qty/remove write-back은 GAS가 디바운스 트리거로 계약서/계약마스터를 다시 쓴다. PG `contract_regen_pending`를 true로 세팅 후, 후속 시트→PG sync에서 `contract_url` 갱신되면 false로 클리어(기존 1s→7s 폴링을 realtime 구독으로 대체).


---

## 6. 모듈 아키텍처 (Next.js App Router · 모바일 우선)

## 모바일 우선 대시보드 모듈 분해 (Next.js App Router + Supabase + Vercel)

핵심 설계 결정: 깜빡임/스크롤점프(현 시스템 최대 페인)를 없애기 위해 **(1) silent-refresh 통짜 재렌더 → Supabase Realtime 부분 패치**, **(2) localStorage SWR → React Query 캐시 + IndexedDB persist**, **(3) ScriptProperties 상태 → 정식 DB 컬럼**으로 전환.

```
app/
  (dashboard)/
    layout.tsx                 # 헤더 앱스위처, 새로고침, 날짜뷰/검색뷰 공통 셸
    page.tsx                   # ?date= ?q= ?tid= 진입, RSC로 초기 데이터 prefetch(콜드스타트 해소)
    loading.tsx                # 스켈레톤(무한 스피너 제거)
    error.tsx                  # 로드실패 + 다시시도(docs판 견고화 표준)

components/
  header/AppSwitcher.tsx       # 오늘일정↔타임라인, AI예약입력 링크
  header/RefreshButton.tsx     # 강제 무효화(queryClient.invalidate + nocache)
  date-nav/DateNav.tsx         # ◀ ▶ date-input 오늘, URL 동기화
  search/GlobalSearch.tsx      # 입력+상태바
  search/SearchResults.tsx     # 날짜별 그룹 접기/펼침 lazy 상세
  notes/HandoverBoard.tsx      # 포스트잇(최대8), 글자크기 영속, 600ms 디바운스 저장
  tabs/TabBar.tsx              # 반출/반납/전체/확인필요 + 실시간 배지
  card/ScheduleCard.tsx        # 카드 셸(상세 open 상태는 URL/zustand로 보존 → 재렌더에도 유지)
  card/TaskToggles.tsx         # 반출완료/반납완료(낙관적 + 완료시각)
  card/EquipmentList.tsx       # 체크박스/세트구분/수량인라인/삭제
  card/EquipmentRow.tsx
  card/PaymentControls.tsx     # 결제/입금/증빙/발행/발행처
  card/ContractActions.tsx     # 계약서 열기/재생성상태(realtime), 견적, 취소, 계약상태
  card/ReturnInspection.tsx    # 반납상태 + 특이사항 메모(dirty 추적)
  card/RiskPanel.tsx           # 반출/반납 리스크 액션
  card/PhotoStrip.tsx          # 썸네일 + 갤러리 트리거
  modals/AddEquipModal.tsx     # 다중행 + 정산 + 가용확인
  modals/PhotoGalleryModal.tsx
  ui/Toast.tsx, ui/Sheet.tsx   # 모바일 바텀시트 기반 다이얼로그(confirm/alert 대체)

lib/
  supabase/client.ts           # 브라우저 client(anon, RLS)
  supabase/server.ts           # RSC/route용 server client
  data/dashboard.queries.ts    # useDashboardDay(date), useTradeSearch(q) — React Query 키 = ['day',date] 등
  data/realtime.ts             # village.trades/schedule_items/... 구독 → queryClient.setQueryData 부분 패치(통짜 재렌더 금지)
  data/mutations.ts            # 각 변이 useMutation + onMutate 낙관적 패치 + onError 롤백 + invalidate
  data/queryClient.ts          # IndexedDB persister(기존 localStorage SWR 대체, TTL/버전키 자동화)
  offline/queue.ts             # 오프라인 변이 큐(IndexedDB) — 온라인 복귀 시 순차 flush, 멱등키
  offline/sync.ts              # navigator.onLine + Background Sync 연동
  domain/status.ts             # enum/한글 매핑, timeSortKey 한국어 파싱, 확인필요 집계 규칙
  domain/availability-hint.ts  # 클라 사전 가용 힌트(서버 RPC 확정 전 UX용)
  image/compress.ts            # 1600px/JPEG0.82 압축(웹워커로 이동 → 다중 병렬 업로드)

app/api/                       # Vercel route handlers (아래 apiEndpoints 참조)
  dashboard/route.ts           # 읽기(또는 RPC로 대체 가능)
  mutations/[action]/route.ts  # write-back 필요 변이 게이트웨이(큐 enqueue + GAS 호출)

public/
  manifest.json, icons/        # PWA
app/sw.ts (next-pwa/serwist)   # 서비스워커: 앱셸 precache, 읽기 SWR, 변이 Background Sync 큐
```

### 데이터 레이어
- **읽기**: React Query. `useDashboardDay(date)`는 (1) RSC prefetch된 초기 데이터로 hydrate(콜드 화면 제거), (2) IndexedDB 캐시 즉시표시, (3) Supabase에서 fresh fetch. 검색 인덱스는 별도 키.
- **Realtime**: 날짜뷰가 보이는 동안 해당 날짜 거래의 `trades/schedule_items/equipment_checks/trade_photos/risk_warnings` 변경을 구독 → `queryClient.setQueryData`로 **해당 카드만 패치**. silent-refresh 전면 재조회 폐기 → 스크롤·포커스·열린 상세·썸네일 보존.
- **옵티미스틱 UI**: `onMutate`에서 캐시 직접 수정 + 스냅샷, 서버 확정/롤백. 멱등키(client mutation id)로 중복 방지. 토글류는 이미 깜빡임 없던 패턴을 전 변이로 일반화.
- **오프라인 큐**: 변이를 IndexedDB 큐에 적재(멱등키 포함). 온라인 시 순차 flush, 서버 응답으로 확정. 가용성 영향 변이(add/qty/remove)는 오프라인에서 "잠정"으로 표시하고 온라인 복귀 시 서버 가용확인 결과로 확정/경고.
- **PWA**: manifest + 서비스워커(serwist). 앱셸 precache, 읽기 stale-while-revalidate, 변이 Background Sync. 현장 모바일에서 설치형 체감.

### 재생성·폴링 제거
- 계약서 재생성 상태는 `trades.contract_regen_pending` + `contract_url`을 **realtime 구독**으로 받아 1s→7s 백오프 폴링 폐기.
- 사진은 batch 조회 대신 carded lazy + realtime insert 반영.


---

## 7. API / RPC 계약

## 신규 대시보드 API/RPC 계약

선택 근거: **읽기·가용성무관 표시변이는 Supabase 직접/RPC**(레이턴시↓, RLS, realtime 일관). **write-back이 필요한 변이는 Vercel route**(서버 시크릿으로 GAS 호출 + 아웃박스 큐 enqueue를 한 트랜잭션 경계에서 처리, GAS 키·시트 정합 로직을 클라에 노출 금지). 한글 상태→enum 매핑과 멱등키 검증은 항상 서버측.

### 읽기 (1개)
- **`rpc village.get_dashboard_day(p_date date)`** → `{ date, checkout[], checkin[], all[], attention[], counts, options }`
  Supabase RPC(security definer, read-only). 한 번에 카드+품목+점검+사진메타+리스크+발행/결제 옵션 조인. 클라는 이걸로 4탭 전부 구성. 검색은 별도 `rpc village.search_trades(p_q text, p_limit int)`(요약) + `rpc village.search_trade_group(p_q, p_group)`(상세 lazy). Vercel route 아님 — 순수 읽기라 RPC가 더 빠르고 realtime과 캐시키 일관.

### 변이 — Supabase 직접/RPC (가용성·시트 write-back 불필요)
| 동작 | 엔드포인트 | 비고 |
|---|---|---|
| 품목 체크 토글 | `rpc toggle_item_check(schedule_id, phase, done)` | PG-only |
| 인수인계 메모 저장 | `upsert village.handover_notes` (또는 `rpc save_handover_notes`) | PG-only, 600ms 디바운스 |
| 사진 메타 등록 | Storage 업로드 후 `insert village.trade_photos` | 바이너리는 Storage, 시트 미러는 (아래 큐) |
| 리스크 이벤트/발송 | `POST /api/risk/{send|event}` (Vercel) | 외부 risk 백엔드 호출 필요 → route |

### 변이 — Vercel route (시트 write-back 필요, 모두 멱등키 헤더 + 큐 enqueue)
모든 응답: `{ ok, trade, queued:boolean }`. route가 PG 커밋 + `sheet_writeback_queue` enqueue를 같이 수행, 워커가 GAS 변이함수 호출.
| 동작 | 엔드포인트 | GAS write-back |
|---|---|---|
| 반출완료 토글 | `POST /api/trades/:tid/setup-toggle` | (PG-only, 시트 무관) — 예외적으로 RPC 가능 |
| **반납완료 토글** | `POST /api/trades/:tid/return-toggle` | `setDashboardReturnContractStatus_` → 계약마스터 J |
| **계약상태 변경/취소** | `POST /api/trades/:tid/contract-status` | `updateDashboardContractStatus` (취소 시 행삭제) |
| **장비 추가/현장추가** | `POST /api/trades/:tid/equipment` | `dashboardAddEquipments`/`dashboardRecordOnsiteAddon` (가용확인 결과 반환) |
| **장비 수량 수정** | `PATCH /api/trades/:tid/equipment/:scheduleId` | `dashboardUpdateEquipmentQty` |
| **장비 삭제** | `DELETE /api/trades/:tid/equipment/:scheduleId` | `dashboardRemoveEquipment` |
| 결제수단 | `PATCH /api/trades/:tid/payment` | `updateTradePaymentMethod`(부수효과 K/L/M) |
| 증빙/입금/발행 | `PATCH /api/trades/:tid/proof` | `updateTradeProofField`(발행요청→ops/팝빌) |
| 발행처 | `PATCH /api/trades/:tid/billing-company` | `updateTradeBillingCompany` |
| 반납상태/메모 | `PATCH /api/trades/:tid/inspection` | `updateEquipmentCheck` → 장비체크 시트 |
| 견적 발송 | `POST /api/trades/:tid/estimate` | `requestTradeEstimate`(ops 웹앱) |
| 사진 업로드 시트 미러 | (큐 워커가 자동) `uploadDashboardPhoto` append | route 불필요, queue target=photo |
| 가용 사전확인(dryRun) | `POST /api/availability/check` | `dashboardAddEquipments(dryRun)` 프록시 |

규칙: 가용성에 영향 주는 add/qty/remove/contract-status는 **항상 Vercel route → GAS 동기 호출(또는 큐) + 가용 충돌/계약재생성 결과를 응답에 포함**. 그래야 옵티미스틱 반영 후 서버 확정/롤백이 정확. 표시성(payment/proof/billing/inspection/photo/note/item-check)은 PG 즉시 커밋 + 시트 미러는 비동기 큐로 best-effort.


> **M1 적용 범위**: 위 계약 중 읽기(RPC)·검색·품목체크·메모·사진·반출/반납 토글·반납상태 메모만 구현. 표(payment/proof/billing/장비 add·qty·remove/contract-status/estimate)는 M2+ (기존 dashboard.html이 담당). 단 라우트·큐 골격은 M1에서 함께 깔아 둔다.

---

## 8. 인증·권한 모델

- **사람(사장/직원)**: Supabase Auth(매직링크 또는 이메일). `app_metadata.role ∈ {owner, staff}`. RLS로 읽기/쓰기 게이트. 직원별 검수 기록(누가 반출/반납 완료했는지)을 `setup_done`/`return_done`/`equipment_checks.updated_by`에 보존(현재 실사 이메일 기록 관행 계승).
- **코워크 AI 봇(Hermes)**: 서버 측 **서비스 토큰**으로 Vercel API 경유. M1에서는 주로 **읽기**(현재도 gviz 읽기전용) + 향후 쓰기 API는 화이트리스트 액션만. 봇 토큰은 RLS를 우회하는 service-role을 직접 주지 않고 Vercel route가 검증·중계.
- **레거시 키 폐기 경로**: `key=village2026` 단일 평문키는 신규 경로에서 사용하지 않음. 단 write-back이 호출하는 기존 GAS `action` API는 전환기 동안 키 유지(별도 회전·IP/HMAC 보강은 M2 보안 항목).

---

## 9. 회귀 금지 기능 — 마일스톤별 분류

신규 대시보드는 아래 기능을 **하나도 잃지 않는다**. M1/M2 태그로 이번 범위를 구분.

- [**M1**] 4개 탭(반출/반납/전체/확인필요) + 각 탭 배지 실시간 카운트, 확인필요는 returnStatus 비정상 또는 미결제 자동 집계
- [**M1**] 날짜 내비게이션: ◀/▶ 1일 이동, date input 직접 선택, 오늘 버튼, URL ?date= 파라미터 진입
- [**M1**] 글로벌 전체검색: 로컬 압축 인덱스 즉시검색 + 서버 dashboardSearch 디바운스 폴백, 날짜별 그룹 접기/펼치기 lazy 상세로드, URL ?search/?q/?tid 자동 검색
- [**M1**] 인수인계 포스트잇 메모: 최대 8개, 추가/삭제/인라인편집, 600ms 디바운스 자동저장(saveDashboardNotes), 글자크기 A-/기본/A+(localStorage 영속), 서버실패 시 로컬폴백
- [**M1**] 시간대별 그룹핑 + 한국어 시간 파싱 정렬(timeSortKey: 오전/오후/시 처리)
- [**M1**] 반출완료/반납완료 토글 버튼(longpress 아님, 클릭): 낙관적 DOM 패치 + 완료시각 표시, 반납완료 시 contractStatus 자동 반납완료 전환 _(반납완료는 계약마스터 J write-back 포함 — M1 유일의 가용성-critical 쓰기)_
- [**M1**] 장비 체크리스트: 항목별 체크박스 토글(toggleItem, phase별), 세트/구성품/단품 구분 + SET 태그, 메모리/배터리 수량 색상강조
- [M2+] 장비 수량 인라인 수정(editEquipQty, prompt) + 낙관적 반영 + 계약서 재생성 큐
- [M2+] 장비 삭제(removeEquip): 세트 대표행 삭제 시 구성품 동반삭제 경고, 낙관적 제거 + 스냅샷 롤백
- [M2+] 장비추가 모달: 다중행 입력, 장비명 자동완성(datalist + 커스텀 드롭다운), 동일장비 수량 병합, '가용 확인 후 추가'(addEquips)
- [M2+] 현장추가 반출(addOnsiteAddon/onsiteAddon): 정산상태(미정/무상/유상) 선택 포함
- [**M1**] 사진 업로드: 반출/반납별, 클라이언트 압축(최대 1600px JPEG 0.82), 다중파일 순차업로드, 진행상태 표시, 배치 조회(dashboardPhotosBatch)
- [**M1**] 사진 갤러리 모달: 반출/반납/기타 섹션별 썸네일 + 원본 새창 열기
- [M2+] 결제수단 셀렉트(updatePayment) + 부수효과(증빙/입금상태 동기화) + 경고문 표시
- [M2+] 입금상태/증빙유형/발행상태 셀렉트(updateTradeProof): 세금계산서 발행 전 발행처 필수검증, 발행요청 시 확인 다이얼로그
- [M2+] 발행처 상호 입력(updateBillingCompany) + datalist 자동완성
- [M2+] 계약상태 셀렉트(updateContractStatus): 예약/반출/취소, 취소 시 스케줄·거래 제거 확인 + 재조회
- [**M1**] 반납상태 셀렉트 + 특이사항 메모(updateEquipmentCheck): 메모 dirty 추적 + 저장버튼 _(반납상태/메모는 PG 마스터 + 개고생2.0 장비체크 시트 best-effort 미러)_
- [M2+] 취소처리 버튼(반납카드, cancelDashboardTrade)
- [M2+] 계약서 열기/갱신중/확인중/없음 상태 버튼 + 자동 재생성(regenerateContractById) + 상태 폴링(dashboardContractExtras) _(M1: 계약서 열기/상태 **표시**(realtime); 재생성 트리거는 M2)_
- [M2+] 견적서 발송 버튼(sendEstimate via runTradeOpsAction)
- [**M1**] 장비 리스크 경고 패널: 반출(카톡 발송권장/확인함)·반납(이상없음/이상있음/확인못함) 액션, equipmentRiskSend/equipmentRiskEvent, 민감/쿨다운/대상유무 판정 _(M1은 리스크 경고 **표시**만; 발송/이벤트 액션은 외부 백엔드라 M2)_
- [**M1**] SWR 캐싱: 날짜별 대시보드 캐시, 장비명 캐시, 검색인덱스 캐시(localStorage TTL) _(localStorage SWR/ silent-refresh → React Query + Supabase Realtime 부분패치로 대체)_
- [**M1**] 낙관적 변이 + 스냅샷 롤백 + mutation-seq 기반 stale 응답 폐기
- [**M1**] 변이 후 silent refresh(최소 5초 디바운스, &nocache=1) _(localStorage SWR/ silent-refresh → React Query + Supabase Realtime 부분패치로 대체)_
- [**M1**] docs판: 견고한 fetch(타임아웃 25s + 재시도 2회 + HTTP/JSON 검증), 7초 지연 안내메시지, 로드실패 다시시도 버튼, 갱신실패 새로고침 강조

---

## 10. 재사용할 레거시 GAS 함수 (write-back, M1)

| 동작(M1) | 재사용 GAS 함수 | 시트 영향 | write-back 성격 |
|---|---|---|---|
| 반납완료 토글 | `setDashboardReturnContractStatus_` (checkAvailability.js:2684) | 계약마스터 **J열=반납완료** + 직전상태 보존 | **가용성-critical** (점유 해제) — 큐 직렬·순서보존 |
| 반납상태/특이사항 메모 | `updateEquipmentCheck` (checkAvailability.js:3218) | 개고생2.0 **장비체크** 시트(반납상태/특이사항) | best-effort 미러 (가용성 무관) |
| 사진 업로드 시트 미러 | `uploadDashboardPhoto` (checkAvailability.js:3926) | 개고생2.0 **반출반납 사진** append + Drive | best-effort 미러 (신규 바이너리는 Supabase Storage 마스터) |
| 반출완료 토글 | (PG-only, 시트 무관) | 없음 | write-back 불필요 |
| 품목 체크 / 인수인계 메모 | (PG-only) | 없음 | write-back 불필요 |

> M1의 시트→PG 유입(읽기)은 레거시 등록(`registerByReqID`)이 만든 거래/스케줄을 동기화로 가져온다. M1의 PG→시트(쓰기)는 위 3개뿐이며 그중 가용성-critical은 **반납완료 하나**다.


---

## 11. 마이그레이션 & 지속 동기화 계획

1. **초기 마이그레이션(1회)**: GAS 일괄 export → 계약마스터/스케줄상세/장비마스터/세트마스터/개고생2.0(거래내역·장비체크·사진) batch read(풀스캔 1회) → Supabase service-role upsert. `setupDone_/returnDone_/itemCheck_/dashboardPostItNotes_v1` ScriptProperties도 추출해 정식 컬럼/테이블로 적재. 한글 상태→enum 매핑. 각 행 `sheet_revision=1, source='sheet'`.
2. **지속: 시트→PG** — (1차) GAS `onEdit`(installable) 훅에서 변경 거래/행만 추려 Vercel webhook(`POST /api/sync/sheet-edit`, HMAC) → service-role 부분 upsert(풀스캔 금지). (2차 안전망) Vercel/Supabase cron 2~3분 주기 최근 N일 diff upsert(onEdit 누락·콜드스타트 대비).
3. **지속: PG→시트(write-back)** — 변이는 PG 즉시 커밋(옵티미스틱) + `sheet_writeback_queue` enqueue. 직렬 워커(Vercel cron / Supabase Edge Function)가 큐 폴링 → 해당 GAS 변이 함수 `action` 호출 → 성공 `done`/실패 지수 백오프. **같은 trade_id는 순서 보존**.
4. **루프 방지**: write-back으로 GAS가 시트를 바꾸면 onEdit이 재발화 → 페이로드 `source` 표식 + `sheet_revision` 비교로 echo 무시.

---

## 12. 비기능 요구사항

- **성능 목표(M1)**: 오늘 날짜 대시보드 첫 의미있는 표시 < 1s(IndexedDB 캐시 즉시 + RSC prefetch), fresh 데이터 < 1.5s(p75). 변이→화면 반영 < 100ms(옵티미스틱). 깜빡임·스크롤점프 **0**(realtime 부분패치).
- **오프라인/PWA**: 앱셸 precache, 읽기 SWR, 변이 IndexedDB 큐 + Background Sync(멱등키). 현장 모바일 설치형 체감. 가용성 영향 변이는 오프라인에서 '잠정' 표시 후 온라인 복귀 시 서버 확정/경고.
- **관측성**: write-back 큐 실패·재시도·지연 가시화(관리 화면 또는 Slack 경보). 현재 `catch{} Logger.log` 침묵을 구조화 로깅으로 대체.
- **보안**: 단일 평문키 폐기(신규 경로), RLS, 서버 시크릿(service-role/GAS키)은 클라 비노출. 계약서 공유권한 `ANYONE EDIT`→`VIEW`/만료링크(계약서 모듈은 M2지만 정책 명시).

---

## 13. 리스크 & 확정된 기본값 (open decisions 처리)

설계자가 제기한 미결 결정 중, 사용자 확인이 끝난 2건(마일스톤 범위·인증) 외에는 아래 **기본값으로 확정**해 진행한다. 이견 시 검토 단계에서 조정.

1. **write-back 실행 주체** → (확정) 기존 GAS 변이 함수 `action` API 재호출. GAS 콜드스타트로 인한 큐 지연 허용치: **반납완료 시트 반영까지 최대 ~10s**(현장 운영상 즉시성 낮음). 화면은 옵티미스틱이라 체감 지연 없음.
2. **시트→PG 유입** → (확정) onEdit webhook + 2~3분 폴링 **둘 다**. 등록 직후 신규 대시보드 노출 지연 < ~10s 목표.
3. **사진 저장소** → (확정) 신규 업로드는 **Supabase Storage**가 마스터, 개고생2.0 '반출반납 사진' 시트로는 best-effort append 미러. 레거시 Drive 사진은 URL 미러로 표시.
4. **확인필요 탭 집계** → (기본값) `반납상태 ∈ 비정상` 또는 미결제(`deposit_status` 미완) → RPC/뷰에서 정의. 추가 조건(미반납 경과·리스크 미확인)은 검토 시 확정.
5. **개고생2.0 미러 실패 정책** → (기본값) 표시성 변이(결제/증빙 — M2)는 PG값으로 진행 + 큐 실패 경보. 팝빌 발행요청(비가역)은 확인 다이얼로그 유지.
6. **realtime 구독 범위** → (기본값) 보고 있는 날짜 ±0(현재 날짜 카드)만 구독, 검색뷰는 폴백 폴링. 동시연결 한도 대비.

**주요 리스크**: (i) 시트↔PG 양방향 동기화의 정합/루프 — `source`+`sheet_revision`+필드 소유권으로 방어, 충돌 시 가용성 필드는 PG 권위. (ii) 전환기 두 대시보드 공존 혼선 — 역할 분담을 UI로 명시(신규=운영/검수, 기존=중량 편집). (iii) GAS write-back 지연/실패 — 큐 가시화·재시도·경보.

---

## 14. 성공 기준 (M1 수용 기준)

- [ ] 오늘일정 4탭·배지·날짜내비·검색·시간정렬이 기존과 동등(26 회귀-금지 중 M1 항목 전부 통과).
- [ ] 변이 시 깜빡임·스크롤점프·포커스유실 **없음**(realtime 부분패치 검증).
- [ ] 반출/반납 검수·품목체크·메모·사진이 PG 마스터로 동작, 반납완료가 계약마스터 J로 정확히 write-back되어 **가용성 엔진이 점유를 해제**함(레거시 가용확인으로 회귀 검증).
- [ ] 초기 마이그레이션 + 지속 동기화로 레거시 등록 건이 ~10s 내 신규 대시보드에 노출.
- [ ] 오프라인에서 경량 변이 후 온라인 복귀 시 큐 flush·정합 유지.
- [ ] 사장/직원/봇 인증·RLS 동작, 단일 평문키 신규 경로에서 미사용.
- [ ] p75 첫 표시 < 1s(캐시) / fresh < 1.5s.

---

## 15. 범위 외 / 이후 마일스톤 (참고)

전체 통합 앱의 9개 모듈 중 이번은 #7(통합 프론트의 대시보드 부분)의 첫 조각이다. 시스템 맵의 분해안 순서:
1 공유 스키마/타입 · 2 DB & 마이그레이션 · 3 가용성 엔진 · 4 예약 도메인 서비스 · 5 계약서 생성 · 6 API 게이트웨이 · **7 통합 프론트(← M1: 오늘일정 대시보드)** · 8 카카오 자동화 · 9 외부연동/알림.

**M2 후보**(대시보드 완전 이관): 장비 add/qty/remove, 계약상태/취소, 결제·증빙·발행처, 견적/발행, 리스크 액션 — 모두 write-back 큐 위에 얹는다. 이후 빌리지스케줄 타임라인, 확인요청 관리, 예약/가용성 엔진의 DB 이관으로 확장.
