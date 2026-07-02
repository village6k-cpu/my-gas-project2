-- 빌리지 재고관리대장 (equipment_ledger) — village 스키마
-- 장비마스터(통합재고관리v2)를 시드로 하는 장비 단위 원장 + 확인/문제 이벤트 로그.
-- Supabase Dashboard > SQL Editor 에 붙여넣고 Run 하세요.
-- 실행 후 시드는 스크립트(seed-equipment-ledger.mjs)가 REST로 넣습니다.

-- ── 원장: 품목당 1행 ───────────────────────────────────────────
create table if not exists village.equipment_ledger (
  equipment_id     text primary key,          -- 장비마스터 ID (CAM-001)
  major            text,                      -- 대분류
  category         text,                      -- 카테고리
  name             text not null,             -- 장비명
  aliases          jsonb not null default '[]'::jsonb,  -- 대여기록 이름 별칭
  stock_total      int,                       -- 총보유수량 (null = 미기록)
  stock_maint      int not null default 0,    -- 정비중수량
  price            int,                       -- 1일 대여단가
  state            text not null default '정상',
  note             text,                      -- 마스터 비고
  verify_status    text not null default 'unverified', -- unverified/verified/attention
  last_verified_at timestamptz,               -- 마지막 실물 확인
  last_verified_by text,
  last_activity_at timestamptz,               -- 마지막 반출입 활동 (참고용)
  open_issues      jsonb not null default '[]'::jsonb, -- [{label, tradeId?, at?}]
  source           text not null default 'master-20260702',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index if not exists eq_ledger_status_idx on village.equipment_ledger (verify_status);

-- ── 이벤트: 확인/개수수정/문제 이력 (원장은 항상 재구성 가능) ───
create table if not exists village.equipment_events (
  id           bigint generated always as identity primary key,
  equipment_id text not null references village.equipment_ledger(equipment_id) on delete cascade,
  type         text not null,                 -- verified/count_fixed/issue_resolved/note/seed
  payload      jsonb not null default '{}'::jsonb,
  actor        text,
  created_at   timestamptz not null default now()
);
create index if not exists eq_events_eq_idx on village.equipment_events (equipment_id, created_at desc);

-- ── updated_at 자동 갱신 (기존 village.touch_updated_at 재사용) ──
drop trigger if exists trg_eq_ledger_touch on village.equipment_ledger;
create trigger trg_eq_ledger_touch before update on village.equipment_ledger
  for each row execute function village.touch_updated_at();

-- ── RLS: lockdown.sql과 동일 정책 (anon 차단, 로그인 직원만) ────
alter table village.equipment_ledger enable row level security;
alter table village.equipment_events enable row level security;
do $$ begin
  drop policy if exists auth_rw on village.equipment_ledger;
  drop policy if exists auth_rw on village.equipment_events;
  create policy auth_rw on village.equipment_ledger for all to authenticated using (true) with check (true);
  create policy auth_rw on village.equipment_events for all to authenticated using (true) with check (true);
end $$;
revoke all on village.equipment_ledger from anon;
revoke all on village.equipment_events from anon;
grant all on village.equipment_ledger to authenticated, service_role;
grant all on village.equipment_events to authenticated, service_role;
grant usage, select on all sequences in schema village to authenticated, service_role;

-- ── Realtime ───────────────────────────────────────────────────
do $$ begin
  alter publication supabase_realtime add table village.equipment_ledger;
exception when others then null; end $$;
