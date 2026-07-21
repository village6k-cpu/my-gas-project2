-- 빌리지 오늘일정/스케줄 — Supabase 스키마 (village 스키마)
-- Supabase SQL Editor에 붙여넣고 실행하세요. 기존 자동화 테이블(public)과 분리됩니다.
-- 프로토타입: anon 키로 읽기/쓰기 허용(권장 운영에선 인증·역할로 제한).

create schema if not exists village;

-- ── 거래(예약) ─────────────────────────────────────────────────
create table if not exists village.trades (
  trade_id            text primary key,
  customer_name       text not null,
  customer_phone      text,
  company             text,
  checkout_at         timestamptz not null,
  return_at           timestamptz not null,
  contract_status     text not null default '예약',   -- 예약/반출/반납완료/취소
  discount_type       text,
  setup_done          boolean not null default false,
  setup_done_at       timestamptz,
  return_done         boolean not null default false,
  return_done_at      timestamptz,
  payment_method      text,
  payment_warning     boolean not null default false,
  deposit_status      text,
  proof_type          text,
  issue_status        text,
  billing_company     text,
  amount              numeric(12,0),
  contract_url        text,
  contract_regen_pending boolean not null default false,
  estimate_sent       boolean not null default false,
  note_checkout       text,
  note_checkin        text,
  photos              jsonb not null default '[]'::jsonb,   -- [{id,phase,swatch,label,memo}]
  risk_warnings       jsonb not null default '[]'::jsonb,   -- [{id,phase,equipmentName,...}]
  return_counts       jsonb not null default '{}'::jsonb,   -- { 품목명: {good,damaged,lost,memo} }
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index if not exists trades_checkout_idx on village.trades (checkout_at);
create index if not exists trades_return_idx   on village.trades (return_at);
create index if not exists trades_status_idx   on village.trades (contract_status);

-- ── 스케줄 품목(예약 구성 장비) ────────────────────────────────
create table if not exists village.schedule_items (
  schedule_id      text primary key,
  trade_id         text not null references village.trades(trade_id) on delete cascade,
  sort             int not null default 0,
  name             text not null,
  qty              int not null default 1,
  taken_qty        int,
  actual_name      text,
  actual_taken_qty int check (actual_taken_qty is null or actual_taken_qty >= 0),
  actual_source    jsonb,
  set_name         text,
  is_set_header    boolean not null default false,
  is_component     boolean not null default false,
  emphasize        boolean not null default false,
  category         text,
  off_catalog      boolean not null default false,
  onsite           boolean not null default false,
  settlement       text,
  checkout_state   text not null default 'pending',   -- pending/taken/excluded
  start_shift_days int not null default 0,
  end_shift_days   int not null default 0,
  memo_checkout    text,
  memo_checkin     text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists sched_trade_idx on village.schedule_items (trade_id);

-- ── 인수인계 메모(전역 포스트잇) ───────────────────────────────
create table if not exists village.handover_notes (
  id         text primary key,
  position   int not null default 0,
  body       text not null default '',
  updated_at timestamptz not null default now()
);

-- ── updated_at 자동 갱신 ───────────────────────────────────────
create or replace function village.touch_updated_at() returns trigger
language plpgsql as $$ begin new.updated_at = now(); return new; end $$;
drop trigger if exists trg_trades_touch on village.trades;
create trigger trg_trades_touch before update on village.trades for each row execute function village.touch_updated_at();
drop trigger if exists trg_sched_touch on village.schedule_items;
create trigger trg_sched_touch before update on village.schedule_items for each row execute function village.touch_updated_at();

-- ── 반출 기준선 불변성 ─────────────────────────────────────────
-- taken_qty가 한번 기록되면 그 수량과 장비 정체성/반출 포함 여부는 일반 sync가 바꿀 수 없다.
create table if not exists village.checkout_baseline_audit (
  id             bigint generated always as identity primary key,
  schedule_id    text not null,
  trade_id       text not null,
  attempted_at   timestamptz not null default now(),
  actor          uuid default auth.uid(),
  attempted      jsonb not null,
  preserved      jsonb not null
);
create or replace function village.protect_checkout_baseline() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if coalesce(old.taken_qty, 0) > 0 and (
    new.schedule_id is distinct from old.schedule_id or
    new.trade_id is distinct from old.trade_id or
    new.taken_qty is distinct from old.taken_qty or
    new.name is distinct from old.name or
    new.set_name is distinct from old.set_name or
    new.is_set_header is distinct from old.is_set_header or
    new.is_component is distinct from old.is_component or
    new.onsite is distinct from old.onsite or
    new.checkout_state is distinct from old.checkout_state
  ) then
    insert into village.checkout_baseline_audit(schedule_id, trade_id, actor, attempted, preserved)
    values (
      old.schedule_id,
      old.trade_id,
      auth.uid(),
      jsonb_build_object(
        'schedule_id', new.schedule_id, 'trade_id', new.trade_id, 'taken_qty', new.taken_qty,
        'name', new.name, 'set_name', new.set_name, 'is_set_header', new.is_set_header,
        'is_component', new.is_component, 'onsite', new.onsite, 'checkout_state', new.checkout_state
      ),
      jsonb_build_object(
        'schedule_id', old.schedule_id, 'trade_id', old.trade_id, 'taken_qty', old.taken_qty,
        'name', old.name, 'set_name', old.set_name, 'is_set_header', old.is_set_header,
        'is_component', old.is_component, 'onsite', old.onsite, 'checkout_state', old.checkout_state
      )
    );
    -- 예외로 벌크 sync 전체를 중독시키지 않고 보호 필드만 OLD로 되돌린다.
    new.schedule_id := old.schedule_id;
    new.trade_id := old.trade_id;
    new.taken_qty := old.taken_qty;
    new.name := old.name;
    new.set_name := old.set_name;
    new.is_set_header := old.is_set_header;
    new.is_component := old.is_component;
    new.onsite := old.onsite;
    new.checkout_state := old.checkout_state;
  end if;
  return new;
end $$;
drop trigger if exists trg_sched_checkout_baseline_guard on village.schedule_items;
create trigger trg_sched_checkout_baseline_guard
before update on village.schedule_items
for each row execute function village.protect_checkout_baseline();
alter table village.checkout_baseline_audit enable row level security;
revoke all on village.checkout_baseline_audit from anon, authenticated;
grant select on village.checkout_baseline_audit to service_role;

-- ── Slack 단톡방 → 기존 거래 카드 동기화 내부 원장 ─────────────
-- 직원이 보는 별도 보드가 아니다. 같은 메시지의 중복 적용과 스레드 정정 이력을 막기 위한 서버 전용 로그다.
create table if not exists village.slack_ops_events (
  channel_id        text not null,
  message_ts        text not null,
  thread_ts         text not null,
  source_hash       text not null,
  phase_hint        text,
  customer_hint     text,
  trade_id_hint     text,
  permalink         text,
  raw_context       jsonb not null default '{}'::jsonb,
  status            text not null default 'pending'
                    check (status in ('pending','applying','applied','needs_context','ignored','error')),
  matched_trade_id  text references village.trades(trade_id) on delete set null,
  applied_plan      jsonb,
  applied_at        timestamptz,
  last_error        text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (channel_id, message_ts)
);
create index if not exists slack_ops_status_idx on village.slack_ops_events (status, updated_at);
drop trigger if exists trg_slack_ops_touch on village.slack_ops_events;
create trigger trg_slack_ops_touch before update on village.slack_ops_events
for each row execute function village.touch_updated_at();
alter table village.slack_ops_events enable row level security;
revoke all on village.slack_ops_events from anon, authenticated;
grant select, insert, update on village.slack_ops_events to service_role;

-- ── RLS (프로토타입: anon 전체 허용) ───────────────────────────
alter table village.trades         enable row level security;
alter table village.schedule_items enable row level security;
alter table village.handover_notes enable row level security;
do $$ begin
  drop policy if exists proto_all on village.trades;
  drop policy if exists proto_all on village.schedule_items;
  drop policy if exists proto_all on village.handover_notes;
  create policy proto_all on village.trades         for all to anon, authenticated using (true) with check (true);
  create policy proto_all on village.schedule_items for all to anon, authenticated using (true) with check (true);
  create policy proto_all on village.handover_notes for all to anon, authenticated using (true) with check (true);
end $$;

-- ── Realtime 구독 등록 ─────────────────────────────────────────
do $$ begin
  alter publication supabase_realtime add table village.trades;
  alter publication supabase_realtime add table village.schedule_items;
  alter publication supabase_realtime add table village.handover_notes;
exception when others then null; end $$;

-- ── PostgREST가 village 스키마를 노출하도록 (Settings > API > Exposed schemas 에 'village' 추가 필요) ──
-- 또는 아래로 권한 부여:
grant usage on schema village to anon, authenticated;
grant all on all tables in schema village to anon, authenticated;
alter default privileges in schema village grant all on tables to anon, authenticated;
-- slack_ops_events는 직원 UI용 보드가 아니라 서버 내부 중복방지 로그다.
revoke all on village.slack_ops_events from anon, authenticated;
grant select, insert, update on village.slack_ops_events to service_role;
