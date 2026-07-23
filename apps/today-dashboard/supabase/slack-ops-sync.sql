-- Slack #단톡방의 반출/반납 특이사항을 "새 업무함"이 아니라 기존 헤이빌리 거래에 반영한다.
-- 원래 반출 기준선(taken_qty/name)은 감사 증거로 불변 유지하고, 확인된 실제값만 overlay로 저장한다.

alter table village.schedule_items
  add column if not exists actual_name text,
  add column if not exists actual_taken_qty int,
  add column if not exists actual_source jsonb;

alter table village.schedule_items
  drop constraint if exists schedule_items_actual_taken_qty_check;
alter table village.schedule_items
  add constraint schedule_items_actual_taken_qty_check
  check (actual_taken_qty is null or actual_taken_qty >= 0);

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

create index if not exists slack_ops_status_idx
  on village.slack_ops_events (status, updated_at);

drop trigger if exists trg_slack_ops_touch on village.slack_ops_events;
create trigger trg_slack_ops_touch
before update on village.slack_ops_events
for each row execute function village.touch_updated_at();

alter table village.slack_ops_events enable row level security;
revoke all on village.slack_ops_events from anon, authenticated;
grant select, insert, update on village.slack_ops_events to service_role;

comment on table village.slack_ops_events is
  '서버 전용 Slack 운영 동기화/중복방지 로그. 사용자 후속조치 보드가 아님.';
comment on column village.schedule_items.actual_taken_qty is
  'taken_qty 원본을 보존하면서 사후 증거로 확인된 실제 반출 수량을 적용하는 overlay';
