-- 2026-07-14: 반출 순간 기준선(taken_qty + 장비 정체성)을 write-once로 만든다.
-- 안전한 배포 순서: 이 트리거 설치 -> 앱/GAS 배포 -> 검증된 거래만 taken_qty 백필.

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
