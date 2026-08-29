set lock_timeout = '5s';

create table public.message_notification_receipts (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  source_event_key text not null,
  source_message_id text,
  room_key text not null,
  received_at timestamptz not null,
  urgency text not null default 'normal' check (urgency in ('p0','urgent','normal','low')),
  notification_state text not null default 'pending'
    check (notification_state in ('pending','delivering','delivered','failed','cleanup_pending','deleted')),
  client_message_id uuid not null,
  slack_channel_id text,
  slack_message_ts text,
  delivered_at timestamptz,
  cleanup_after timestamptz,
  cleanup_state text not null default 'idle'
    check (cleanup_state in ('idle','pending','deleted','failed','blocked_p0')),
  cleanup_error text,
  delivery_attempts integer not null default 0 check (delivery_attempts >= 0),
  last_delivery_error text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_event_key)
);

create table public.work_items_v2 (
  id uuid primary key default gen_random_uuid(),
  work_key text not null,
  source_event_keys text[] not null default '{}',
  room_key text not null,
  title text not null,
  summary text not null default '',
  work_type text not null,
  priority text not null default 'normal' check (priority in ('p0','urgent','normal','low')),
  state text not null default 'open' check (state in ('open','in_progress','snoozed','resolved','dismissed')),
  owner_id text,
  actionable_at timestamptz not null default now(),
  due_at timestamptz,
  snoozed_until timestamptz,
  first_opened_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  digest_inclusion_count integer not null default 0 check (digest_inclusion_count >= 0),
  consecutive_unhandled_digests integer not null default 0 check (consecutive_unhandled_digests >= 0),
  last_digest_at timestamptz,
  next_reminder_at timestamptz,
  automation_state text not null default 'not_attempted'
    check (automation_state in ('not_attempted','running','succeeded','failed','needs_human')),
  resolution_kind text,
  resolution_evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(resolution_evidence) = 'object'),
  resolved_at timestamptz,
  resolved_by text,
  pending_action jsonb not null default '{}'::jsonb check (jsonb_typeof(pending_action) = 'object'),
  version integer not null default 1 check (version > 0),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index work_items_v2_active_key_unique
  on public.work_items_v2 (work_key)
  where state not in ('resolved','dismissed');

create table public.digest_runs (
  id uuid primary key default gen_random_uuid(),
  window_started_at timestamptz not null,
  window_ended_at timestamptz not null,
  scheduled_at timestamptz not null,
  state text not null default 'building'
    check (state in ('building','delivering','delivered','failed','replaced')),
  destination_key text not null,
  item_snapshot jsonb not null default '[]'::jsonb check (jsonb_typeof(item_snapshot) = 'array'),
  slack_channel_id text,
  slack_message_ts text,
  delivered_at timestamptz,
  previous_digest_id uuid references public.digest_runs(id) on delete set null,
  previous_deleted_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (destination_key, scheduled_at)
);

create index message_notification_receipts_state_age_idx
  on public.message_notification_receipts (notification_state, created_at);
create index work_items_v2_actionable_idx
  on public.work_items_v2 (state, actionable_at, priority, first_opened_at);
create index digest_runs_destination_state_idx
  on public.digest_runs (destination_key, state, scheduled_at desc);

create function public.touch_work_orchestrator_v2_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger touch_message_notification_receipts_updated_at
before update on public.message_notification_receipts
for each row execute function public.touch_work_orchestrator_v2_updated_at();
create trigger touch_work_items_v2_updated_at
before update on public.work_items_v2
for each row execute function public.touch_work_orchestrator_v2_updated_at();
create trigger touch_digest_runs_updated_at
before update on public.digest_runs
for each row execute function public.touch_work_orchestrator_v2_updated_at();

create function public.claim_message_notification_receipt(
  p_source text,
  p_source_event_key text,
  p_source_message_id text,
  p_room_key text,
  p_received_at timestamptz,
  p_client_message_id uuid,
  p_payload jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.message_notification_receipts%rowtype;
  v_created boolean := false;
begin
  insert into public.message_notification_receipts
    (source, source_event_key, source_message_id, room_key, received_at, client_message_id, payload)
  values
    (p_source, p_source_event_key, p_source_message_id, p_room_key, p_received_at, p_client_message_id, coalesce(p_payload, '{}'::jsonb))
  on conflict (source_event_key) do nothing
  returning * into v_row;
  if found then
    v_created := true;
  else
    select * into strict v_row
    from public.message_notification_receipts
    where source_event_key = p_source_event_key;
  end if;
  return jsonb_build_object('created', v_created, 'row', to_jsonb(v_row));
end;
$$;

alter table public.message_notification_receipts enable row level security;
alter table public.work_items_v2 enable row level security;
alter table public.digest_runs enable row level security;

revoke all on table public.message_notification_receipts from public, anon, authenticated;
revoke all on table public.work_items_v2 from public, anon, authenticated;
revoke all on table public.digest_runs from public, anon, authenticated;
grant select, insert, update, delete on table public.message_notification_receipts to service_role;
grant select, insert, update, delete on table public.work_items_v2 to service_role;
grant select, insert, update, delete on table public.digest_runs to service_role;

revoke execute on function public.touch_work_orchestrator_v2_updated_at() from public, anon, authenticated;
revoke execute on function public.claim_message_notification_receipt(text,text,text,text,timestamptz,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.touch_work_orchestrator_v2_updated_at() to service_role;
grant execute on function public.claim_message_notification_receipt(text,text,text,text,timestamptz,uuid,jsonb) to service_role;
