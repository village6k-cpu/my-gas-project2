alter table village.schedule_items
  add column if not exists removed_at timestamptz;

create index if not exists sched_active_trade_idx
  on village.schedule_items (trade_id, sort, schedule_id)
  where removed_at is null;
