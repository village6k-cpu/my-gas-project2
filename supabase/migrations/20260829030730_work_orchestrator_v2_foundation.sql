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
  updated_at timestamptz not null default now(),
  check (state <> 'snoozed' or snoozed_until is not null)
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
  manifest_prepared_at timestamptz,
  slack_channel_id text,
  slack_message_ts text,
  delivered_at timestamptz,
  previous_digest_id uuid references public.digest_runs(id) on delete set null,
  previous_deleted_at timestamptz,
  previous_cleanup_state text not null default 'idle'
    check (previous_cleanup_state in ('idle','deleting','failed','deleted','already_absent')),
  previous_cleanup_error text,
  lease_owner text,
  lease_token uuid,
  lease_expires_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (destination_key, scheduled_at),
  check (
    state not in ('building','delivering','failed')
    or (lease_owner is not null and lease_token is not null and lease_expires_at is not null)
  ),
  check (
    state not in ('delivered','replaced')
    or (
      lease_owner is null and lease_token is null and lease_expires_at is null
      and delivered_at is not null and isfinite(delivered_at)
      and (
        (jsonb_array_length(item_snapshot) = 0 and slack_channel_id is null and slack_message_ts is null)
        or (
          jsonb_array_length(item_snapshot) > 0
          and slack_channel_id is not null
          and slack_message_ts ~ '^[0-9]{1,20}\.[0-9]{1,20}$'
        )
      )
    )
  ),
  check (state not in ('building','delivering','failed') or delivered_at is null)
);

create table public.digest_message_parts (
  id uuid primary key default gen_random_uuid(),
  digest_run_id uuid not null references public.digest_runs(id) on delete cascade,
  part_kind text not null check (part_kind in ('ordinary','daily_reminder')),
  part_number integer not null check (part_number between 1 and 50),
  part_count integer not null check (part_count between 1 and 50 and part_number <= part_count),
  item_ids uuid[] not null check (
    cardinality(item_ids) between 1 and 24 and array_position(item_ids, null) is null
  ),
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  client_message_id uuid not null default gen_random_uuid(),
  delivery_state text not null default 'planned'
    check (delivery_state in ('planned','delivering','delivered','failed')),
  delivery_attempts integer not null default 0 check (delivery_attempts between 0 and 3),
  delivery_claimed_at timestamptz,
  slack_channel_id text,
  slack_message_ts text,
  delivered_at timestamptz,
  delivery_error text check (
    delivery_error is null
    or delivery_error in ('post_rejected','rate_limited','delivery_unconfirmed','slack_api_error')
  ),
  delivery_retry_at timestamptz,
  cleanup_state text not null default 'idle'
    check (cleanup_state in ('idle','deleting','deleted','already_absent','failed')),
  cleanup_attempts integer not null default 0 check (cleanup_attempts >= 0),
  cleanup_owner text,
  cleanup_token uuid,
  cleanup_expires_at timestamptz,
  cleanup_attempted_at timestamptz,
  cleaned_at timestamptz,
  cleanup_error text check (
    cleanup_error is null
    or cleanup_error in ('cant_delete_message','rate_limited','cleanup_unconfirmed','slack_api_error')
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (digest_run_id, part_kind, part_number),
  unique (digest_run_id, client_message_id),
  check (delivery_claimed_at is null or isfinite(delivery_claimed_at)),
  check (delivered_at is null or isfinite(delivered_at)),
  check (delivery_retry_at is null or isfinite(delivery_retry_at)),
  check (cleanup_expires_at is null or isfinite(cleanup_expires_at)),
  check (cleanup_attempted_at is null or isfinite(cleanup_attempted_at)),
  check (cleaned_at is null or isfinite(cleaned_at)),
  check (
    (delivery_state = 'planned' and delivery_attempts = 0 and delivery_claimed_at is null
      and slack_channel_id is null and slack_message_ts is null and delivered_at is null
      and delivery_error is null and delivery_retry_at is null)
    or (delivery_state = 'delivering' and delivery_attempts between 1 and 3 and delivery_claimed_at is not null
      and slack_channel_id is null and slack_message_ts is null and delivered_at is null
      and delivery_error is null and delivery_retry_at is null)
    or (delivery_state = 'failed' and delivery_attempts between 1 and 3 and delivery_claimed_at is not null
      and slack_channel_id is null and slack_message_ts is null and delivered_at is null and delivery_error is not null
      and (
        (delivery_error = 'rate_limited' and delivery_retry_at is not null and isfinite(delivery_retry_at))
        or (delivery_error <> 'rate_limited' and delivery_retry_at is null)
      ))
    or (delivery_state = 'delivered' and delivery_attempts between 1 and 3 and delivery_claimed_at is not null
      and slack_channel_id is not null and length(slack_channel_id) between 1 and 500
      and slack_channel_id = btrim(slack_channel_id)
      and slack_message_ts ~ '^[0-9]{1,20}\.[0-9]{1,20}$'
      and delivered_at is not null and delivery_error is null and delivery_retry_at is null)
  ),
  check (
    (cleanup_state = 'idle' and cleanup_attempts = 0 and cleanup_owner is null and cleanup_token is null
      and cleanup_expires_at is null and cleanup_attempted_at is null and cleaned_at is null and cleanup_error is null)
    or (cleanup_state = 'deleting' and cleanup_attempts > 0 and cleanup_owner is not null
      and length(cleanup_owner) between 1 and 200 and cleanup_owner = btrim(cleanup_owner)
      and cleanup_token is not null and cleanup_expires_at is not null
      and cleanup_attempted_at is not null and cleaned_at is null and cleanup_error is null)
    or (cleanup_state = 'failed' and cleanup_attempts > 0 and cleanup_owner is null and cleanup_token is null
      and cleanup_expires_at is null and cleanup_attempted_at is not null and cleaned_at is null and cleanup_error is not null)
    or (cleanup_state in ('deleted','already_absent') and cleanup_attempts > 0
      and cleanup_owner is null and cleanup_token is null and cleanup_expires_at is null
      and cleanup_attempted_at is not null and cleaned_at is not null and cleanup_error is null)
  )
);

create index message_notification_receipts_state_age_idx
  on public.message_notification_receipts (notification_state, created_at);
create index work_items_v2_actionable_idx
  on public.work_items_v2 (state, actionable_at, priority, first_opened_at);
create index digest_runs_destination_state_idx
  on public.digest_runs (destination_key, state, scheduled_at desc);
create index digest_runs_cleanup_backlog_idx
  on public.digest_runs (destination_key, scheduled_at, id)
  where state in ('delivered','replaced')
    and previous_digest_id is not null;
create index digest_message_parts_run_delivery_idx
  on public.digest_message_parts (digest_run_id, delivery_state, part_kind, part_number);
create index digest_message_parts_cleanup_idx
  on public.digest_message_parts (digest_run_id, cleanup_state, cleanup_expires_at);

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
create trigger touch_digest_message_parts_updated_at
before update on public.digest_message_parts
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

create function public.is_effective_p0_ack_v2(
  p_payload jsonb,
  p_cutoff timestamptz
) returns boolean language plpgsql stable security invoker set search_path = '' as $$
declare
  v_acknowledged_at timestamptz;
begin
  if p_cutoff is null
    or not isfinite(p_cutoff)
    or p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or left(p_payload->>'p0_acknowledged_at', 4) = '0000'
    or not (
      p_payload @? '$.p0_acknowledged_at ? (
        @.type() == "string"
        && @ like_regex "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$"
        && @.datetime("YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"") != null
      )'
    ) then
    return false;
  end if;
  begin
    v_acknowledged_at := (p_payload->>'p0_acknowledged_at')::timestamptz;
  exception when others then
    return false;
  end;
  return isfinite(v_acknowledged_at) and v_acknowledged_at <= p_cutoff;
end;
$$;

create function public.upsert_work_item_v2(
  p_candidate jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.work_items_v2%rowtype;
  v_source_event_keys text[];
  v_attempt integer;
  v_priority text;
  v_actionable_at timestamptz;
  v_due_at timestamptz;
  v_snoozed_until timestamptz;
  v_first_opened_at timestamptz;
  v_last_activity_at timestamptz;
  v_wake_snooze boolean;
  v_incoming_is_fresh boolean;
begin
  if p_candidate is null
    or jsonb_typeof(p_candidate) <> 'object'
    or not (p_candidate ?& array[
      'work_key','source_event_keys','room_key','title','summary','work_type','priority','state',
      'owner_id','actionable_at','due_at','snoozed_until','first_opened_at','last_activity_at',
      'automation_state','payload'
    ])
    or (p_candidate - array[
      'work_key','source_event_keys','room_key','title','summary','work_type','priority','state',
      'owner_id','actionable_at','due_at','snoozed_until','first_opened_at','last_activity_at',
      'automation_state','payload'
    ]::text[]) <> '{}'::jsonb then
    raise exception 'invalid work candidate' using errcode = '22023';
  end if;
  if jsonb_typeof(p_candidate->'work_key') <> 'string'
    or length(p_candidate->>'work_key') not between 1 and 500
    or p_candidate->>'work_key' <> btrim(p_candidate->>'work_key')
    or jsonb_typeof(p_candidate->'room_key') <> 'string'
    or length(p_candidate->>'room_key') not between 1 and 500
    or p_candidate->>'room_key' <> btrim(p_candidate->>'room_key')
    or jsonb_typeof(p_candidate->'title') <> 'string'
    or length(p_candidate->>'title') not between 1 and 300
    or p_candidate->>'title' <> btrim(p_candidate->>'title')
    or jsonb_typeof(p_candidate->'summary') <> 'string'
    or length(p_candidate->>'summary') > 2000
    or jsonb_typeof(p_candidate->'work_type') <> 'string'
    or (p_candidate->>'work_type') not in (
      'human_review','reply_needed','quote_send','tax_invoice','schedule_check',
      'reservation_review','price_review','payment_check','contract_document',
      'return_extension','damage_repair','sheet_duplicate_check',
      'reservation_review_timeout','automation_error_review'
    )
    or jsonb_typeof(p_candidate->'priority') <> 'string'
    or (p_candidate->>'priority') not in ('p0','urgent','normal','low')
    or jsonb_typeof(p_candidate->'state') <> 'string'
    or p_candidate->>'state' <> 'open'
    or jsonb_typeof(p_candidate->'automation_state') <> 'string'
    or (p_candidate->>'automation_state') not in ('not_attempted','running','succeeded','failed','needs_human')
    or (jsonb_typeof(p_candidate->'owner_id') not in ('string','null'))
    or (jsonb_typeof(p_candidate->'owner_id') = 'string' and (
      length(p_candidate->>'owner_id') not between 1 and 200
      or p_candidate->>'owner_id' <> btrim(p_candidate->>'owner_id')
    )) then
    raise exception 'invalid work candidate' using errcode = '22023';
  end if;
  if jsonb_typeof(p_candidate->'actionable_at') <> 'string'
    or jsonb_typeof(p_candidate->'first_opened_at') <> 'string'
    or jsonb_typeof(p_candidate->'last_activity_at') <> 'string'
    or jsonb_typeof(p_candidate->'due_at') not in ('string','null')
    or jsonb_typeof(p_candidate->'snoozed_until') not in ('string','null') then
    raise exception 'invalid work candidate' using errcode = '22023';
  end if;
  if jsonb_typeof(p_candidate->'source_event_keys') <> 'array'
    or jsonb_array_length(p_candidate->'source_event_keys') > 100
    or exists (
      select 1 from jsonb_array_elements(p_candidate->'source_event_keys') as source_key(value)
      where jsonb_typeof(source_key.value) <> 'string'
        or length(source_key.value #>> '{}') not between 1 and 500
        or source_key.value #>> '{}' <> btrim(source_key.value #>> '{}')
    )
    or (
      select count(*) from jsonb_array_elements_text(p_candidate->'source_event_keys')
    ) <> (
      select count(distinct value) from jsonb_array_elements_text(p_candidate->'source_event_keys') as source_key(value)
    ) then
    raise exception 'invalid work candidate' using errcode = '22023';
  end if;
  if jsonb_typeof(p_candidate->'payload') <> 'object'
    or (p_candidate->'payload')->'requires_human_action' is distinct from 'true'::jsonb
    or ((p_candidate->'payload') - array[
      'requires_human_action','action_family','business_key','business_object_key','follow_up_route',
      'follow_up_task_key','alert_level','alert_reason','blocking_reason','due_hint','recommended_action'
    ]::text[]) <> '{}'::jsonb
    or length((p_candidate->'payload')::text) > 5000
    or exists (
      select 1 from jsonb_each(p_candidate->'payload') as payload_entry(key, value)
      where payload_entry.key <> 'requires_human_action'
        and (
          jsonb_typeof(payload_entry.value) <> 'string'
          or length(payload_entry.value #>> '{}') < 1
        )
    ) then
    raise exception 'invalid work candidate' using errcode = '22023';
  end if;
  if length(coalesce((p_candidate->'payload')->>'action_family','')) > 100
    or length(coalesce((p_candidate->'payload')->>'business_key','')) > 500
    or length(coalesce((p_candidate->'payload')->>'business_object_key','')) > 500
    or length(coalesce((p_candidate->'payload')->>'follow_up_route','')) > 100
    or length(coalesce((p_candidate->'payload')->>'follow_up_task_key','')) > 500
    or length(coalesce((p_candidate->'payload')->>'alert_level','')) > 20
    or length(coalesce((p_candidate->'payload')->>'alert_reason','')) > 1000
    or length(coalesce((p_candidate->'payload')->>'blocking_reason','')) > 1000
    or length(coalesce((p_candidate->'payload')->>'due_hint','')) > 100
    or length(coalesce((p_candidate->'payload')->>'recommended_action','')) > 1200 then
    raise exception 'invalid work candidate' using errcode = '22023';
  end if;

  begin
    v_actionable_at := (p_candidate->>'actionable_at')::timestamptz;
    v_first_opened_at := (p_candidate->>'first_opened_at')::timestamptz;
    v_last_activity_at := (p_candidate->>'last_activity_at')::timestamptz;
    if jsonb_typeof(p_candidate->'due_at') <> 'null' then
      v_due_at := (p_candidate->>'due_at')::timestamptz;
    end if;
    if jsonb_typeof(p_candidate->'snoozed_until') <> 'null' then
      v_snoozed_until := (p_candidate->>'snoozed_until')::timestamptz;
    end if;
    if not isfinite(v_actionable_at)
      or not isfinite(v_first_opened_at)
      or not isfinite(v_last_activity_at)
      or (v_due_at is not null and not isfinite(v_due_at))
      or (v_snoozed_until is not null and not isfinite(v_snoozed_until)) then
      raise exception 'non-finite timestamp';
    end if;
  exception when others then
    raise exception 'invalid work candidate' using errcode = '22023';
  end;
  select coalesce(array_agg(source_key order by source_key), '{}'::text[])
  into v_source_event_keys
  from jsonb_array_elements_text(p_candidate->'source_event_keys') as source_key;
  v_priority := p_candidate->>'priority';
  perform pg_advisory_xact_lock(hashtextextended(p_candidate->>'work_key', 91420260829));

  for v_attempt in 1..3 loop
    select * into v_row
    from public.work_items_v2
    where work_key = p_candidate->>'work_key'
      and state in ('open','in_progress','snoozed')
    for update;

    if found then
      v_incoming_is_fresh := v_last_activity_at >= v_row.last_activity_at;
      v_wake_snooze := v_row.state = 'snoozed' and (
        v_row.snoozed_until <= now()
        or (v_incoming_is_fresh and v_priority = 'p0' and v_row.priority <> 'p0')
        or (
          v_row.priority = 'p0'
          and not public.is_effective_p0_ack_v2(v_row.payload, now())
        )
      );
      update public.work_items_v2
      set source_event_keys = (
            select coalesce(array_agg(key order by key), '{}'::text[])
            from (
              select distinct key
              from unnest(v_row.source_event_keys || v_source_event_keys) as source_keys(key)
              order by key
              limit 100
            ) as bounded_keys
          ),
          title = case when v_last_activity_at >= v_row.last_activity_at then p_candidate->>'title' else v_row.title end,
          summary = case when v_last_activity_at >= v_row.last_activity_at then p_candidate->>'summary' else v_row.summary end,
          priority = case
            when not v_incoming_is_fresh then v_row.priority
            when v_row.priority = 'p0' or v_priority = 'p0' then 'p0'
            when v_row.priority = 'urgent' or v_priority = 'urgent' then 'urgent'
            when v_row.priority = 'normal' or v_priority = 'normal' then 'normal'
            else 'low'
          end,
          state = case when v_wake_snooze then 'open' else v_row.state end,
          owner_id = coalesce(v_row.owner_id, nullif(p_candidate->>'owner_id','')),
          actionable_at = case when v_wake_snooze then now() else v_row.actionable_at end,
          due_at = case
            when v_row.due_at is null then v_due_at
            when v_due_at is null then v_row.due_at
            else least(v_row.due_at, v_due_at)
          end,
          snoozed_until = case when v_wake_snooze then null else v_row.snoozed_until end,
          last_activity_at = greatest(v_row.last_activity_at, v_last_activity_at),
          automation_state = case
            when v_last_activity_at >= v_row.last_activity_at then p_candidate->>'automation_state'
            else v_row.automation_state
          end,
          payload = case
            when v_last_activity_at >= v_row.last_activity_at
              and (case v_priority when 'p0' then 3 when 'urgent' then 2 when 'normal' then 1 else 0 end)
                >= (case v_row.priority when 'p0' then 3 when 'urgent' then 2 when 'normal' then 1 else 0 end)
              then v_row.payload || (p_candidate->'payload')
            else v_row.payload
          end,
          version = v_row.version + 1
      where id = v_row.id
        and version = v_row.version
        and state in ('open','in_progress','snoozed')
      returning * into v_row;
      return jsonb_build_object('applied', true, 'created', false, 'row', to_jsonb(v_row));
    end if;

    select * into v_row
    from public.work_items_v2
    where work_key = p_candidate->>'work_key'
      and state in ('resolved','dismissed')
    order by updated_at desc, id desc
    limit 1
    for update;
    if found then
      return jsonb_build_object('applied', false, 'created', false, 'row', to_jsonb(v_row));
    end if;

    insert into public.work_items_v2 (
      work_key, source_event_keys, room_key, title, summary, work_type, priority, state,
      owner_id, actionable_at, due_at, snoozed_until, first_opened_at, last_activity_at,
      automation_state, payload
    ) values (
      p_candidate->>'work_key', v_source_event_keys, p_candidate->>'room_key',
      p_candidate->>'title', p_candidate->>'summary', p_candidate->>'work_type', v_priority, 'open',
      nullif(p_candidate->>'owner_id',''), v_actionable_at,
      v_due_at, v_snoozed_until, v_first_opened_at, v_last_activity_at,
      p_candidate->>'automation_state', p_candidate->'payload'
    )
    on conflict do nothing
    returning * into v_row;
    if found then
      return jsonb_build_object('applied', true, 'created', true, 'row', to_jsonb(v_row));
    end if;
  end loop;
  raise exception 'work item concurrency retry exhausted' using errcode = '40001';
end;
$$;

create function public.request_work_item_action_v2(
  p_id uuid,
  p_expected_version integer,
  p_action jsonb,
  p_requested_by text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.work_items_v2%rowtype;
  v_action_type text;
  v_snoozed_until timestamptz;
begin
  if p_id is null or p_expected_version is null or p_expected_version < 1
    or p_requested_by is null or p_requested_by !~ '^[UW][A-Z0-9]{2,79}$'
    or p_action is null or jsonb_typeof(p_action) <> 'object'
    or not (p_action ? 'type')
    or jsonb_typeof(p_action->'type') <> 'string' then
    raise exception 'invalid work action request' using errcode = '22023';
  end if;
  v_action_type := p_action->>'type';
  if v_action_type not in ('progress','snooze','ack_p0','request_resolve','dismiss')
    or (v_action_type = 'snooze' and (
      not (p_action ?& array['type','snoozedUntil'])
      or (p_action - array['type','snoozedUntil']::text[]) <> '{}'::jsonb
      or jsonb_typeof(p_action->'snoozedUntil') <> 'string'
      or length(p_action->>'snoozedUntil') > 40
    ))
    or (v_action_type <> 'snooze' and (p_action - 'type') <> '{}'::jsonb) then
    raise exception 'invalid work action request' using errcode = '22023';
  end if;
  if v_action_type = 'snooze' then
    begin
      v_snoozed_until := (p_action->>'snoozedUntil')::timestamptz;
      if not isfinite(v_snoozed_until) or v_snoozed_until <= now() then
        raise exception 'non-future snooze';
      end if;
    exception when others then
      raise exception 'invalid work action request' using errcode = '22023';
    end;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    'work-action:' || p_id::text || ':' || p_expected_version::text,
    91420260830
  ));
  update public.work_items_v2
  set pending_action = jsonb_build_object(
        'type', v_action_type,
        'action', p_action,
        'status', 'pending',
        'requested_at', now(),
        'requested_by', p_requested_by,
        'expected_version', p_expected_version
      ),
      version = version + 1
  where id = p_id
    and version = p_expected_version
    and state in ('open','in_progress','snoozed')
    and not exists (
      select 1
      from public.digest_runs as unfinished
      where unfinished.state in ('building','delivering','failed')
        and unfinished.manifest_prepared_at is not null
        and jsonb_array_length(unfinished.item_snapshot) > 0
        and exists (
          select 1 from public.digest_message_parts as stored_part
          where stored_part.digest_run_id = unfinished.id
        )
        and exists (
          select 1
          from jsonb_array_elements(unfinished.item_snapshot) as snapshot(entry)
          where snapshot.entry->>'id' = p_id::text
            and (snapshot.entry->>'version')::integer = p_expected_version
        )
    )
  returning * into v_row;
  return jsonb_build_object('applied', found, 'row', case when found then to_jsonb(v_row) else null end);
end;
$$;

create function public.is_processable_pending_work_action_v2(
  p_pending jsonb,
  p_current_version integer
) returns boolean language plpgsql stable security invoker set search_path = '' as $$
declare
  v_type text;
  v_action jsonb;
  v_expected_version integer;
  v_requested_at timestamptz;
  v_snoozed_until timestamptz;
begin
  if p_pending is null or jsonb_typeof(p_pending) <> 'object'
    or not (p_pending ?& array['type','action','status','requested_at','requested_by','expected_version'])
    or (p_pending - array['type','action','status','requested_at','requested_by','expected_version']::text[]) <> '{}'::jsonb
    or jsonb_typeof(p_pending->'type') <> 'string'
    or jsonb_typeof(p_pending->'action') <> 'object'
    or jsonb_typeof(p_pending->'status') <> 'string' or p_pending->>'status' <> 'pending'
    or jsonb_typeof(p_pending->'requested_at') <> 'string' or length(p_pending->>'requested_at') > 40
    or (p_pending->>'requested_at') !~ '^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    or jsonb_typeof(p_pending->'requested_by') <> 'string'
    or (p_pending->>'requested_by') !~ '^[UW][A-Z0-9]{2,79}$'
    or jsonb_typeof(p_pending->'expected_version') <> 'number'
    or (p_pending->>'expected_version') !~ '^[1-9][0-9]*$' then
    return false;
  end if;
  begin
    v_expected_version := (p_pending->>'expected_version')::integer;
    v_requested_at := (p_pending->>'requested_at')::timestamptz;
  exception when others then
    return false;
  end;
  if p_current_version is null or p_current_version <= 1 or v_expected_version <> p_current_version - 1
    or not isfinite(v_requested_at) or v_requested_at > now() then
    return false;
  end if;
  v_type := p_pending->>'type';
  v_action := p_pending->'action';
  if v_type not in ('progress','snooze','ack_p0','dismiss')
    or v_action->>'type' is distinct from v_type
    or (v_type <> 'snooze' and (v_action - 'type') <> '{}'::jsonb)
    or (v_type = 'snooze' and (
      not (v_action ?& array['type','snoozedUntil'])
      or (v_action - array['type','snoozedUntil']::text[]) <> '{}'::jsonb
      or jsonb_typeof(v_action->'snoozedUntil') <> 'string'
      or length(v_action->>'snoozedUntil') > 40
      or (v_action->>'snoozedUntil') !~ '^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    )) then
    return false;
  end if;
  if v_type = 'snooze' then
    begin
      v_snoozed_until := (v_action->>'snoozedUntil')::timestamptz;
    exception when others then
      return false;
    end;
    if not isfinite(v_snoozed_until) or v_snoozed_until <= now() then return false; end if;
  end if;
  return true;
end;
$$;

create function public.list_pending_work_actions_v2(
  p_limit integer
) returns table (
  id uuid,
  state text,
  priority text,
  actionable_at timestamptz,
  snoozed_until timestamptz,
  resolution_kind text,
  resolution_evidence jsonb,
  resolved_at timestamptz,
  resolved_by text,
  pending_action jsonb,
  version integer,
  payload jsonb,
  updated_at timestamptz
) language plpgsql stable security invoker set search_path = '' as $$
begin
  if p_limit is null or p_limit not between 1 and 50 then
    raise exception 'invalid pending work action query' using errcode = '22023';
  end if;
  return query
  select w.id, w.state, w.priority, w.actionable_at, w.snoozed_until,
    w.resolution_kind, w.resolution_evidence, w.resolved_at, w.resolved_by,
    w.pending_action, w.version, w.payload, w.updated_at
  from public.work_items_v2 as w
  where w.state in ('open','in_progress','snoozed')
    and public.is_processable_pending_work_action_v2(w.pending_action, w.version)
  order by w.updated_at, w.id
  limit p_limit;
end;
$$;

create function public.list_actionable_work_v2(
  p_now timestamptz,
  p_limit integer
) returns table (
  id uuid,
  work_key text,
  room_key text,
  title text,
  summary text,
  work_type text,
  priority text,
  state text,
  owner_id text,
  actionable_at timestamptz,
  due_at timestamptz,
  snoozed_until timestamptz,
  first_opened_at timestamptz,
  last_activity_at timestamptz,
  digest_inclusion_count integer,
  consecutive_unhandled_digests integer,
  last_digest_at timestamptz,
  next_reminder_at timestamptz,
  version integer,
  payload jsonb
) language plpgsql stable security invoker set search_path = '' as $$
begin
  if p_now is null or not isfinite(p_now) or p_limit is null or p_limit not between 1 and 500 then
    raise exception 'invalid actionable work query' using errcode = '22023';
  end if;
  return query
  select
    w.id, w.work_key, w.room_key, w.title, w.summary, w.work_type, w.priority, w.state,
    w.owner_id, w.actionable_at, w.due_at, w.snoozed_until, w.first_opened_at,
    w.last_activity_at, w.digest_inclusion_count, w.consecutive_unhandled_digests,
    w.last_digest_at, w.next_reminder_at, w.version, w.payload
  from public.work_items_v2 as w
  where w.state in ('open','in_progress','snoozed')
    and (
      w.actionable_at <= p_now
      or (
        w.priority = 'p0'
        and not public.is_effective_p0_ack_v2(w.payload, p_now)
      )
    )
  order by w.actionable_at, w.first_opened_at, w.id
  limit p_limit;
end;
$$;

create function public.claim_digest_run_v2(
  p_destination_key text,
  p_scheduled_at timestamptz,
  p_window_started_at timestamptz,
  p_window_ended_at timestamptz,
  p_lease_owner text,
  p_lease_seconds integer
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.digest_runs%rowtype;
  v_previous public.digest_runs%rowtype;
  v_previous_json jsonb;
begin
  if p_destination_key is null or length(p_destination_key) not between 1 and 500
    or p_destination_key <> btrim(p_destination_key)
    or p_lease_owner is null or length(p_lease_owner) not between 1 and 200
    or p_lease_owner <> btrim(p_lease_owner)
    or p_lease_seconds is null or p_lease_seconds not between 1 and 900
    or p_scheduled_at is null or p_window_started_at is null or p_window_ended_at is null
    or not isfinite(p_scheduled_at) or not isfinite(p_window_started_at) or not isfinite(p_window_ended_at)
    or p_window_started_at > p_window_ended_at then
    raise exception 'invalid digest claim' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('digest:' || p_destination_key, 91420260829));
  select * into v_previous
  from public.digest_runs
  where destination_key = p_destination_key
    and scheduled_at < p_scheduled_at
    and state = 'delivered'
    and exists (
      select 1 from public.digest_message_parts as delivered_part
      where delivered_part.digest_run_id = public.digest_runs.id
        and delivered_part.delivery_state = 'delivered'
    )
  order by delivered_at desc, scheduled_at desc, id desc
  limit 1
  for share;
  if found then
    select jsonb_build_object(
      'id', v_previous.id,
      'parts', coalesce(jsonb_agg(jsonb_build_object(
        'id', part.id,
        'part_kind', part.part_kind,
        'part_number', part.part_number,
        'part_count', part.part_count,
        'slack_channel_id', part.slack_channel_id,
        'slack_message_ts', part.slack_message_ts
      ) order by case part.part_kind when 'ordinary' then 0 else 1 end, part.part_number), '[]'::jsonb)
    ) into v_previous_json
    from public.digest_message_parts as part
    where part.digest_run_id = v_previous.id and part.delivery_state = 'delivered';
  end if;

  insert into public.digest_runs (
    window_started_at, window_ended_at, scheduled_at, state, destination_key,
    previous_digest_id, lease_owner, lease_token, lease_expires_at
  ) values (
    p_window_started_at, p_window_ended_at, p_scheduled_at, 'building', p_destination_key,
    v_previous.id, p_lease_owner, gen_random_uuid(), now() + make_interval(secs => p_lease_seconds)
  )
  on conflict (destination_key, scheduled_at) do nothing
  returning * into v_row;
  if found then
    return jsonb_build_object(
      'claimed', true, 'created', true, 'row', to_jsonb(v_row), 'previous_digest', v_previous_json
    );
  end if;

  select * into strict v_row
  from public.digest_runs
  where destination_key = p_destination_key and scheduled_at = p_scheduled_at
  for update;
  if v_row.previous_digest_id is not null then
    select jsonb_build_object(
      'id', prior.id,
      'parts', coalesce(jsonb_agg(jsonb_build_object(
        'id', part.id,
        'part_kind', part.part_kind,
        'part_number', part.part_number,
        'part_count', part.part_count,
        'slack_channel_id', part.slack_channel_id,
        'slack_message_ts', part.slack_message_ts
      ) order by case part.part_kind when 'ordinary' then 0 else 1 end, part.part_number), '[]'::jsonb)
    ) into v_previous_json
    from public.digest_runs as prior
    join public.digest_message_parts as part on part.digest_run_id = prior.id
      and part.delivery_state = 'delivered'
    where prior.id = v_row.previous_digest_id
    group by prior.id;
  end if;
  if v_row.state in ('building','delivering','failed')
    and v_row.lease_expires_at is not null
    and v_row.lease_expires_at <= now() then
    update public.digest_runs
    set state = case when manifest_prepared_at is null then 'building' else 'delivering' end,
        lease_owner = p_lease_owner,
        lease_token = gen_random_uuid(),
        lease_expires_at = now() + make_interval(secs => p_lease_seconds), error = null
    where id = v_row.id
      and state in ('building','delivering','failed')
      and lease_expires_at <= now()
    returning * into v_row;
    if found then
      return jsonb_build_object(
        'claimed', true, 'created', false, 'row', to_jsonb(v_row), 'previous_digest', v_previous_json
      );
    end if;
  end if;
  return jsonb_build_object(
    'claimed', false, 'created', false, 'row', to_jsonb(v_row), 'previous_digest', v_previous_json
  );
end;
$$;

create function public.prepare_digest_parts_v2(
  p_id uuid,
  p_lease_owner text,
  p_lease_token uuid,
  p_item_snapshot jsonb,
  p_parts jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_run public.digest_runs%rowtype;
  v_entry jsonb;
  v_part jsonb;
  v_item jsonb;
  v_kind text;
  v_kind_count integer;
  v_snapshot_ids jsonb;
  v_reminder_ids jsonb;
  v_part_ids jsonb;
  v_existing_intent jsonb;
  v_parts_json jsonb;
begin
  if p_id is null or p_lease_owner is null or length(p_lease_owner) not between 1 and 200
    or p_lease_owner <> btrim(p_lease_owner) or p_lease_token is null
    or p_item_snapshot is null or jsonb_typeof(p_item_snapshot) <> 'array'
    or jsonb_array_length(p_item_snapshot) > 500
    or p_parts is null or jsonb_typeof(p_parts) <> 'array'
    or jsonb_array_length(p_parts) > 50 then
    raise exception 'invalid digest manifest' using errcode = '22023';
  end if;

  for v_entry in select value from jsonb_array_elements(p_item_snapshot) loop
    if jsonb_typeof(v_entry) <> 'object'
      or not (v_entry ?& array['id','version','inclusionReason','priority'])
      or (v_entry - array['id','version','inclusionReason','priority']::text[]) <> '{}'::jsonb
      or jsonb_typeof(v_entry->'id') <> 'string'
      or (v_entry->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or jsonb_typeof(v_entry->'version') <> 'number'
      or (v_entry->>'version') !~ '^[1-9][0-9]*$'
      or jsonb_typeof(v_entry->'inclusionReason') <> 'string'
      or (v_entry->>'inclusionReason') not in ('p0','overdue','urgent','carry_over','actionable','daily_reminder')
      or jsonb_typeof(v_entry->'priority') <> 'string'
      or (v_entry->>'priority') not in ('p0','urgent','normal','low') then
      raise exception 'invalid digest manifest' using errcode = '22023';
    end if;
    begin
      perform (v_entry->>'id')::uuid;
      perform (v_entry->>'version')::integer;
    exception when others then
      raise exception 'invalid digest manifest' using errcode = '22023';
    end;
  end loop;
  if (select count(*) from jsonb_array_elements(p_item_snapshot)) <>
     (select count(distinct (entry->>'id')::uuid) from jsonb_array_elements(p_item_snapshot) as snapshot(entry)) then
    raise exception 'invalid digest manifest' using errcode = '22023';
  end if;

  for v_entry in
    select snapshot.entry
    from jsonb_array_elements(p_item_snapshot) as snapshot(entry)
    order by snapshot.entry->>'id', (snapshot.entry->>'version')::integer
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'work-action:' || (v_entry->>'id') || ':' || (v_entry->>'version'),
      91420260830
    ));
  end loop;

  for v_part in select value from jsonb_array_elements(p_parts) loop
    if jsonb_typeof(v_part) <> 'object'
      or not (v_part ?& array['kind','partNumber','partCount','itemIds','payloadHash'])
      or (v_part - array['kind','partNumber','partCount','itemIds','payloadHash']::text[]) <> '{}'::jsonb
      or jsonb_typeof(v_part->'kind') <> 'string'
      or (v_part->>'kind') not in ('ordinary','daily_reminder')
      or jsonb_typeof(v_part->'partNumber') <> 'number'
      or (v_part->>'partNumber') !~ '^[1-9][0-9]*$'
      or (v_part->>'partNumber')::integer not between 1 and 50
      or jsonb_typeof(v_part->'partCount') <> 'number'
      or (v_part->>'partCount') !~ '^[1-9][0-9]*$'
      or (v_part->>'partCount')::integer not between 1 and 50
      or (v_part->>'partNumber')::integer > (v_part->>'partCount')::integer
      or jsonb_typeof(v_part->'itemIds') <> 'array'
      or jsonb_array_length(v_part->'itemIds') not between 1 and 24
      or jsonb_typeof(v_part->'payloadHash') <> 'string'
      or (v_part->>'payloadHash') !~ '^[0-9a-f]{64}$' then
      raise exception 'invalid digest manifest' using errcode = '22023';
    end if;
    for v_item in select value from jsonb_array_elements(v_part->'itemIds') loop
      if jsonb_typeof(v_item) <> 'string'
        or (v_item #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
        raise exception 'invalid digest manifest' using errcode = '22023';
      end if;
    end loop;
  end loop;

  if (jsonb_array_length(p_item_snapshot) = 0 and jsonb_array_length(p_parts) <> 0)
    or (jsonb_array_length(p_item_snapshot) > 0 and not exists (
      select 1 from jsonb_array_elements(p_parts) as candidate(part)
      where candidate.part->>'kind' = 'ordinary'
    )) then
    raise exception 'invalid digest manifest' using errcode = '22023';
  end if;
  foreach v_kind in array array['ordinary','daily_reminder'] loop
    select count(*)::integer into v_kind_count
    from jsonb_array_elements(p_parts) as candidate(part)
    where candidate.part->>'kind' = v_kind;
    if v_kind_count > 0 and exists (
      select 1 from jsonb_array_elements(p_parts) as candidate(part)
      where candidate.part->>'kind' = v_kind
        and (candidate.part->>'partCount')::integer <> v_kind_count
    ) then
      raise exception 'invalid digest manifest' using errcode = '22023';
    end if;
    if v_kind_count > 0 and (
      select count(distinct (candidate.part->>'partNumber')::integer) <> v_kind_count
        or min((candidate.part->>'partNumber')::integer) <> 1
        or max((candidate.part->>'partNumber')::integer) <> v_kind_count
      from jsonb_array_elements(p_parts) as candidate(part)
      where candidate.part->>'kind' = v_kind
    ) then
      raise exception 'invalid digest manifest' using errcode = '22023';
    end if;
  end loop;
  if exists (
    select 1
    from (
      select candidate.ordinality,
        row_number() over (
          order by case candidate.part->>'kind' when 'ordinary' then 0 else 1 end,
            (candidate.part->>'partNumber')::integer
        ) as expected_ordinality
      from jsonb_array_elements(p_parts) with ordinality as candidate(part, ordinality)
    ) as ordered_parts
    where ordered_parts.ordinality <> ordered_parts.expected_ordinality
  ) then
    raise exception 'invalid digest manifest' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(snapshot.entry->'id' order by snapshot.ordinality), '[]'::jsonb)
  into v_snapshot_ids
  from jsonb_array_elements(p_item_snapshot) with ordinality as snapshot(entry, ordinality);
  select coalesce(jsonb_agg(snapshot.entry->'id' order by snapshot.ordinality), '[]'::jsonb)
  into v_reminder_ids
  from jsonb_array_elements(p_item_snapshot) with ordinality as snapshot(entry, ordinality)
  where snapshot.entry->>'inclusionReason' = 'daily_reminder';
  select coalesce(jsonb_agg(item.value order by (candidate.part->>'partNumber')::integer, item.ordinality), '[]'::jsonb)
  into v_part_ids
  from jsonb_array_elements(p_parts) as candidate(part)
  cross join lateral jsonb_array_elements(candidate.part->'itemIds') with ordinality as item(value, ordinality)
  where candidate.part->>'kind' = 'ordinary';
  if v_part_ids <> v_snapshot_ids then
    raise exception 'invalid digest manifest' using errcode = '22023';
  end if;
  select coalesce(jsonb_agg(item.value order by (candidate.part->>'partNumber')::integer, item.ordinality), '[]'::jsonb)
  into v_part_ids
  from jsonb_array_elements(p_parts) as candidate(part)
  cross join lateral jsonb_array_elements(candidate.part->'itemIds') with ordinality as item(value, ordinality)
  where candidate.part->>'kind' = 'daily_reminder';
  if v_part_ids <> v_reminder_ids then
    raise exception 'invalid digest manifest' using errcode = '22023';
  end if;

  select * into v_run from public.digest_runs where id = p_id for update;
  if not found or v_run.state not in ('building','delivering')
    or v_run.lease_owner is distinct from p_lease_owner
    or v_run.lease_token is distinct from p_lease_token
    or v_run.lease_expires_at is null or v_run.lease_expires_at <= now() then
    return jsonb_build_object('applied', false, 'created', false, 'row', null, 'parts', '[]'::jsonb);
  end if;

  if v_run.manifest_prepared_at is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
      'kind', part.part_kind,
      'partNumber', part.part_number,
      'partCount', part.part_count,
      'itemIds', to_jsonb(part.item_ids),
      'payloadHash', part.payload_hash
    ) order by case part.part_kind when 'ordinary' then 0 else 1 end, part.part_number), '[]'::jsonb)
    into v_existing_intent
    from public.digest_message_parts as part
    where part.digest_run_id = v_run.id;
    if v_run.item_snapshot <> p_item_snapshot or v_existing_intent <> p_parts then
      raise exception 'digest manifest mismatch' using errcode = '22023';
    end if;
    select coalesce(jsonb_agg(to_jsonb(part) order by case part.part_kind when 'ordinary' then 0 else 1 end, part.part_number), '[]'::jsonb)
    into v_parts_json from public.digest_message_parts as part where part.digest_run_id = v_run.id;
    return jsonb_build_object('applied', true, 'created', false, 'row', to_jsonb(v_run), 'parts', v_parts_json);
  end if;

  update public.digest_runs
  set state = 'delivering', item_snapshot = p_item_snapshot, manifest_prepared_at = now(), error = null
  where id = v_run.id and state = 'building' and lease_owner = p_lease_owner and lease_token = p_lease_token
  returning * into v_run;
  if not found then
    return jsonb_build_object('applied', false, 'created', false, 'row', null, 'parts', '[]'::jsonb);
  end if;
  insert into public.digest_message_parts (
    digest_run_id, part_kind, part_number, part_count, item_ids, payload_hash
  )
  select v_run.id, candidate.part->>'kind', (candidate.part->>'partNumber')::integer,
    (candidate.part->>'partCount')::integer,
    array(select (item.value #>> '{}')::uuid
      from jsonb_array_elements(candidate.part->'itemIds') with ordinality as item(value, ordinality)
      order by item.ordinality),
    candidate.part->>'payloadHash'
  from jsonb_array_elements(p_parts) as candidate(part);
  select coalesce(jsonb_agg(to_jsonb(part) order by case part.part_kind when 'ordinary' then 0 else 1 end, part.part_number), '[]'::jsonb)
  into v_parts_json from public.digest_message_parts as part where part.digest_run_id = v_run.id;
  return jsonb_build_object('applied', true, 'created', true, 'row', to_jsonb(v_run), 'parts', v_parts_json);
end;
$$;

create function public.claim_digest_part_delivery_v2(
  p_id uuid,
  p_part_id uuid,
  p_lease_owner text,
  p_lease_token uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_run public.digest_runs%rowtype;
  v_part public.digest_message_parts%rowtype;
begin
  if p_id is null or p_part_id is null or p_lease_owner is null
    or length(p_lease_owner) not between 1 and 200 or p_lease_owner <> btrim(p_lease_owner)
    or p_lease_token is null then
    raise exception 'invalid digest part delivery claim' using errcode = '22023';
  end if;
  select * into v_run from public.digest_runs where id = p_id for update;
  if not found or v_run.state <> 'delivering' or v_run.lease_owner is distinct from p_lease_owner
    or v_run.lease_token is distinct from p_lease_token
    or v_run.lease_expires_at is null or v_run.lease_expires_at <= now() then
    return jsonb_build_object('claimed', false, 'row', null);
  end if;
  select * into v_part from public.digest_message_parts
  where id = p_part_id and digest_run_id = p_id for update;
  if not found then return jsonb_build_object('claimed', false, 'row', null); end if;
  if v_part.delivery_state in ('delivering','delivered') or v_part.delivery_attempts >= 3 then
    return jsonb_build_object('claimed', false, 'row', to_jsonb(v_part));
  end if;
  if v_part.delivery_state = 'failed' and v_part.delivery_error = 'rate_limited'
    and v_part.delivery_retry_at > now() then
    return jsonb_build_object('claimed', false, 'row', to_jsonb(v_part));
  end if;
  update public.digest_message_parts
  set delivery_state = 'delivering', delivery_attempts = delivery_attempts + 1,
      delivery_claimed_at = now(), delivery_error = null, delivery_retry_at = null
  where id = v_part.id and delivery_state in ('planned','failed') and delivery_attempts < 3
  returning * into v_part;
  return jsonb_build_object('claimed', found, 'row', case when found then to_jsonb(v_part) else null end);
end;
$$;

create function public.mark_digest_part_delivered_v2(
  p_id uuid,
  p_part_id uuid,
  p_lease_owner text,
  p_lease_token uuid,
  p_expected_delivery_attempts integer,
  p_slack_channel_id text,
  p_slack_message_ts text,
  p_delivered_at timestamptz
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_run public.digest_runs%rowtype;
  v_part public.digest_message_parts%rowtype;
begin
  if p_id is null or p_part_id is null or p_lease_owner is null
    or length(p_lease_owner) not between 1 and 200 or p_lease_owner <> btrim(p_lease_owner)
    or p_lease_token is null or p_expected_delivery_attempts not between 1 and 3
    or p_slack_channel_id is null or length(p_slack_channel_id) not between 1 and 500
    or p_slack_channel_id <> btrim(p_slack_channel_id)
    or p_slack_message_ts is null or p_slack_message_ts !~ '^[0-9]{1,20}\.[0-9]{1,20}$'
    or p_delivered_at is null or not isfinite(p_delivered_at) then
    raise exception 'invalid digest part delivery' using errcode = '22023';
  end if;
  select * into v_run from public.digest_runs where id = p_id for update;
  if not found or v_run.state <> 'delivering' or v_run.lease_owner is distinct from p_lease_owner
    or v_run.lease_token is distinct from p_lease_token
    or v_run.lease_expires_at is null or v_run.lease_expires_at <= now() then
    return jsonb_build_object('applied', false, 'row', null);
  end if;
  update public.digest_message_parts
  set delivery_state = 'delivered', slack_channel_id = p_slack_channel_id,
      slack_message_ts = p_slack_message_ts, delivered_at = p_delivered_at,
      delivery_error = null, delivery_retry_at = null
  where id = p_part_id and digest_run_id = p_id and delivery_state = 'delivering'
    and delivery_attempts = p_expected_delivery_attempts
  returning * into v_part;
  return jsonb_build_object('applied', found, 'row', case when found then to_jsonb(v_part) else null end);
end;
$$;

create function public.mark_digest_part_failed_v2(
  p_id uuid,
  p_part_id uuid,
  p_lease_owner text,
  p_lease_token uuid,
  p_expected_delivery_attempts integer,
  p_error text,
  p_failed_at timestamptz,
  p_retry_at timestamptz
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_run public.digest_runs%rowtype;
  v_part public.digest_message_parts%rowtype;
begin
  if p_id is null or p_part_id is null or p_lease_owner is null
    or length(p_lease_owner) not between 1 and 200 or p_lease_owner <> btrim(p_lease_owner)
    or p_lease_token is null or p_expected_delivery_attempts not between 1 and 3
    or p_error is null
    or p_error not in ('post_rejected','rate_limited','delivery_unconfirmed','slack_api_error')
    or p_failed_at is null or not isfinite(p_failed_at)
    or (p_error = 'rate_limited' and (
      p_retry_at is null or not isfinite(p_retry_at)
      or p_retry_at < p_failed_at or p_retry_at > p_failed_at + interval '1 day'
    ))
    or (p_error <> 'rate_limited' and p_retry_at is not null) then
    raise exception 'invalid digest part failure' using errcode = '22023';
  end if;
  select * into v_run from public.digest_runs where id = p_id for update;
  if not found or v_run.state <> 'delivering' or v_run.lease_owner is distinct from p_lease_owner
    or v_run.lease_token is distinct from p_lease_token
    or v_run.lease_expires_at is null or v_run.lease_expires_at <= now() then
    return jsonb_build_object('applied', false, 'row', null);
  end if;
  update public.digest_message_parts
  set delivery_state = 'failed', delivery_error = p_error, delivery_retry_at = p_retry_at
  where id = p_part_id and digest_run_id = p_id and delivery_state = 'delivering'
    and delivery_attempts = p_expected_delivery_attempts
  returning * into v_part;
  return jsonb_build_object('applied', found, 'row', case when found then to_jsonb(v_part) else null end);
end;
$$;

create function public.finalize_digest_run_v2(
  p_id uuid,
  p_lease_owner text,
  p_lease_token uuid,
  p_delivered_at timestamptz
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_run public.digest_runs%rowtype;
  v_updated_count integer := 0;
  v_slack_channel_id text;
  v_slack_message_ts text;
begin
  if p_id is null or p_lease_owner is null or length(p_lease_owner) not between 1 and 200
    or p_lease_owner <> btrim(p_lease_owner) or p_lease_token is null
    or p_delivered_at is null or not isfinite(p_delivered_at) then
    raise exception 'invalid digest finalization' using errcode = '22023';
  end if;
  select * into v_run from public.digest_runs where id = p_id for update;
  if not found or v_run.state <> 'delivering' or v_run.manifest_prepared_at is null
    or v_run.lease_owner is distinct from p_lease_owner
    or v_run.lease_token is distinct from p_lease_token
    or v_run.lease_expires_at is null or v_run.lease_expires_at <= now() then
    return jsonb_build_object('applied', false, 'row', null, 'updated_count', 0);
  end if;
  if jsonb_array_length(v_run.item_snapshot) = 0 then
    if exists (select 1 from public.digest_message_parts where digest_run_id = v_run.id) then
      return jsonb_build_object('applied', false, 'row', null, 'updated_count', 0);
    end if;
  else
    if not exists (select 1 from public.digest_message_parts where digest_run_id = v_run.id)
      or exists (
        select 1 from public.digest_message_parts
        where digest_run_id = v_run.id and delivery_state <> 'delivered'
      ) then
      return jsonb_build_object('applied', false, 'row', null, 'updated_count', 0);
    end if;
    select slack_channel_id, slack_message_ts into v_slack_channel_id, v_slack_message_ts
    from public.digest_message_parts
    where digest_run_id = v_run.id and part_kind = 'ordinary' and part_number = 1
      and delivery_state = 'delivered';
    if not found then
      return jsonb_build_object('applied', false, 'row', null, 'updated_count', 0);
    end if;
  end if;

  perform 1 from public.work_items_v2 as w
  join jsonb_array_elements(v_run.item_snapshot) as s(entry) on w.id = (s.entry->>'id')::uuid
  order by w.id for update of w;
  if exists (
    select 1 from public.work_items_v2 as w
    join jsonb_array_elements(v_run.item_snapshot) as s(entry) on w.id = (s.entry->>'id')::uuid
    where w.version = (s.entry->>'version')::integer
      and w.state in ('open','in_progress','snoozed')
      and (
        s.entry->>'priority' <> w.priority
        or not (w.actionable_at <= p_delivered_at or (
          w.priority = 'p0' and not public.is_effective_p0_ack_v2(w.payload, p_delivered_at)
        ))
        or (s.entry->>'inclusionReason' = 'p0' and w.priority <> 'p0')
        or (s.entry->>'inclusionReason' = 'urgent' and w.priority <> 'urgent')
        or (s.entry->>'inclusionReason' = 'overdue' and p_delivered_at < w.first_opened_at + interval '24 hours')
        or (s.entry->>'inclusionReason' = 'carry_over' and w.consecutive_unhandled_digests < 2)
        or (s.entry->>'inclusionReason' = 'daily_reminder'
          and coalesce(w.next_reminder_at, w.first_opened_at + interval '72 hours') > p_delivered_at)
      )
  ) then
    raise exception 'invalid digest snapshot semantics' using errcode = '22023';
  end if;

  update public.work_items_v2 as w
  set digest_inclusion_count = w.digest_inclusion_count + 1,
      consecutive_unhandled_digests = w.consecutive_unhandled_digests + 1,
      last_digest_at = p_delivered_at,
      next_reminder_at = case when s.entry->>'inclusionReason' = 'daily_reminder'
        then p_delivered_at + interval '24 hours'
        else coalesce(w.next_reminder_at, w.first_opened_at + interval '72 hours') end
  from jsonb_array_elements(v_run.item_snapshot) as s(entry)
  where w.id = (s.entry->>'id')::uuid and w.version = (s.entry->>'version')::integer
    and w.state in ('open','in_progress','snoozed');
  get diagnostics v_updated_count = row_count;

  update public.digest_runs
  set state = 'delivered', slack_channel_id = v_slack_channel_id,
      slack_message_ts = v_slack_message_ts, delivered_at = p_delivered_at,
      lease_owner = null, lease_token = null, lease_expires_at = null, error = null
  where id = v_run.id and state = 'delivering' and lease_owner = p_lease_owner and lease_token = p_lease_token
  returning * into v_run;
  if not found then raise exception 'digest lease changed while locked' using errcode = '40001'; end if;
  return jsonb_build_object('applied', true, 'row', to_jsonb(v_run), 'updated_count', v_updated_count);
end;
$$;

create function public.fail_digest_run_v2(
  p_id uuid,
  p_lease_owner text,
  p_lease_token uuid,
  p_error text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.digest_runs%rowtype;
begin
  if p_id is null
    or p_lease_owner is null or length(p_lease_owner) not between 1 and 200
    or p_lease_owner <> btrim(p_lease_owner)
    or p_lease_token is null
    or p_error is null
    or p_error not in ('digest_build_failed','digest_delivery_failed','delivery_unconfirmed') then
    raise exception 'invalid digest failure' using errcode = '22023';
  end if;
  select * into v_row from public.digest_runs where id = p_id for update;
  if not found
    or v_row.state not in ('building','delivering')
    or v_row.lease_owner is distinct from p_lease_owner
    or v_row.lease_token is distinct from p_lease_token
    or v_row.lease_expires_at is null
    or v_row.lease_expires_at <= now() then
    return jsonb_build_object('applied', false, 'row', null);
  end if;
  update public.digest_runs
  set state = 'failed', error = p_error
  where id = v_row.id and state in ('building','delivering') and lease_owner = p_lease_owner
    and lease_token = p_lease_token
  returning * into v_row;
  return jsonb_build_object('applied', found, 'row', case when found then to_jsonb(v_row) else null end);
end;
$$;

create function public.list_digest_cleanup_backlog_v2(
  p_destination_key text,
  p_limit integer
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_result jsonb;
begin
  if p_destination_key is null
    or length(p_destination_key) not between 1 and 500
    or p_destination_key <> btrim(p_destination_key)
    or p_limit is null or p_limit not between 1 and 10 then
    raise exception 'invalid digest cleanup backlog' using errcode = '22023';
  end if;

  with eligible_successors as (
    select successor.id as successor_digest_id,
      successor.previous_digest_id,
      successor.previous_cleanup_state,
      successor.scheduled_at
    from public.digest_runs successor
    join public.digest_runs previous on previous.id = successor.previous_digest_id
    where successor.destination_key = p_destination_key
      and successor.state in ('delivered','replaced')
      and successor.delivered_at is not null
      and successor.manifest_prepared_at is not null
      and successor.id <> successor.previous_digest_id
      and (
        successor.previous_cleanup_state in ('idle','deleting','failed')
        or exists (
          select 1 from public.digest_message_parts pending_part
          where pending_part.digest_run_id = previous.id
            and pending_part.delivery_state = 'delivered'
            and pending_part.slack_channel_id is not null
            and pending_part.slack_message_ts is not null
            and pending_part.cleanup_state in ('idle','deleting','failed')
        )
      )
      and previous.destination_key = successor.destination_key
      and previous.state in ('delivered','replaced')
      and previous.delivered_at is not null
      and previous.manifest_prepared_at is not null
      and previous.scheduled_at < successor.scheduled_at
      and exists (
        select 1 from public.digest_message_parts pending_part
        where pending_part.digest_run_id = previous.id
          and pending_part.delivery_state = 'delivered'
          and pending_part.slack_channel_id is not null
          and pending_part.slack_message_ts is not null
      )
    order by successor.scheduled_at, successor.id
    limit p_limit
  ), backlog_entries as (
    select eligible.*,
      parts.payload as parts
    from eligible_successors eligible
    cross join lateral (
      select jsonb_agg(bounded_part.payload order by bounded_part.kind_order,
        bounded_part.part_number, bounded_part.previous_part_id) as payload
      from (
        select case when part.part_kind = 'ordinary' then 0 else 1 end as kind_order,
          part.part_number,
          part.id as previous_part_id,
          jsonb_build_object(
            'previous_part_id', part.id,
            'part_kind', part.part_kind,
            'part_number', part.part_number,
            'part_count', part.part_count,
            'slack_channel_id', part.slack_channel_id,
            'slack_message_ts', part.slack_message_ts,
            'cleanup_state', part.cleanup_state
          ) as payload
        from public.digest_message_parts part
        where part.digest_run_id = eligible.previous_digest_id
          and part.delivery_state = 'delivered'
          and part.slack_channel_id is not null
          and part.slack_message_ts is not null
        order by case when part.cleanup_state in ('idle','deleting','failed') then 0 else 1 end,
          case when part.part_kind = 'ordinary' then 0 else 1 end,
          part.part_number, part.id
        limit 50
      ) bounded_part
    ) parts
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'successor_digest_id', entry.successor_digest_id,
    'previous_digest_id', entry.previous_digest_id,
    'previous_cleanup_state', entry.previous_cleanup_state,
    'parts', entry.parts
  ) order by entry.scheduled_at, entry.successor_digest_id), '[]'::jsonb)
  into v_result
  from backlog_entries entry;
  return v_result;
end;
$$;

create function public.claim_digest_part_cleanup_v2(
  p_id uuid,
  p_previous_digest_id uuid,
  p_previous_part_id uuid,
  p_cleanup_owner text,
  p_lease_seconds integer
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.digest_runs%rowtype;
  v_previous_row public.digest_runs%rowtype;
  v_part public.digest_message_parts%rowtype;
  v_claimed boolean := false;
  v_aggregate_state text;
  v_aggregate_error text;
begin
  if p_id is null or p_previous_digest_id is null or p_previous_part_id is null
    or p_id = p_previous_digest_id or p_cleanup_owner is null
    or length(p_cleanup_owner) not between 1 and 200 or p_cleanup_owner <> btrim(p_cleanup_owner)
    or p_lease_seconds is null or p_lease_seconds not between 1 and 900 then
    raise exception 'invalid digest part cleanup claim' using errcode = '22023';
  end if;
  select * into v_row from public.digest_runs where id = p_id for update;
  if not found or v_row.state not in ('delivered','replaced')
    or v_row.delivered_at is null or v_row.manifest_prepared_at is null
    or v_row.previous_digest_id is distinct from p_previous_digest_id then
    return jsonb_build_object('claimed', false, 'row', null, 'part', null);
  end if;
  select * into v_previous_row from public.digest_runs
  where id = p_previous_digest_id and state in ('delivered','replaced') for update;
  if not found
    or v_previous_row.delivered_at is null or v_previous_row.manifest_prepared_at is null
    or v_previous_row.destination_key is distinct from v_row.destination_key
    or v_previous_row.scheduled_at >= v_row.scheduled_at then
    return jsonb_build_object('claimed', false, 'row', null, 'part', null);
  end if;
  select * into v_part from public.digest_message_parts
  where id = p_previous_part_id and digest_run_id = p_previous_digest_id
    and delivery_state = 'delivered' and slack_channel_id is not null and slack_message_ts is not null
  for update;
  if not found then return jsonb_build_object('claimed', false, 'row', null, 'part', null); end if;
  if v_part.cleanup_state in ('idle','failed')
    or (v_part.cleanup_state = 'deleting' and v_part.cleanup_expires_at <= now()) then
    update public.digest_message_parts
    set cleanup_state = 'deleting', cleanup_attempts = cleanup_attempts + 1,
        cleanup_owner = p_cleanup_owner, cleanup_token = gen_random_uuid(),
        cleanup_expires_at = now() + make_interval(secs => p_lease_seconds),
        cleanup_attempted_at = now(), cleaned_at = null, cleanup_error = null
    where id = v_part.id and (
      cleanup_state in ('idle','failed')
      or (cleanup_state = 'deleting' and cleanup_expires_at <= now())
    ) returning * into v_part;
    v_claimed := found;
  end if;

  if not exists (
    select 1 from public.digest_message_parts
    where digest_run_id = p_previous_digest_id and delivery_state = 'delivered'
      and cleanup_state not in ('deleted','already_absent')
  ) then
    update public.digest_runs set state = 'replaced'
    where id = p_previous_digest_id and state = 'delivered';
    select case when exists (
      select 1 from public.digest_message_parts
      where digest_run_id = p_previous_digest_id and delivery_state = 'delivered' and cleanup_state = 'deleted'
    ) then 'deleted' else 'already_absent' end into v_aggregate_state;
    update public.digest_runs
    set previous_cleanup_state = v_aggregate_state, previous_cleanup_error = null,
        previous_deleted_at = coalesce(previous_deleted_at, now())
    where id = v_row.id and state in ('delivered','replaced') and previous_digest_id = p_previous_digest_id
    returning * into v_row;
  else
    if exists (
      select 1 from public.digest_message_parts
      where digest_run_id = p_previous_digest_id and delivery_state = 'delivered' and cleanup_state = 'deleting'
    ) then
      v_aggregate_state := 'deleting';
      v_aggregate_error := null;
    elsif exists (
      select 1 from public.digest_message_parts
      where digest_run_id = p_previous_digest_id and delivery_state = 'delivered' and cleanup_state = 'failed'
    ) then
      v_aggregate_state := 'failed';
      select cleanup_error into v_aggregate_error from public.digest_message_parts
      where digest_run_id = p_previous_digest_id and delivery_state = 'delivered' and cleanup_state = 'failed'
      order by updated_at desc, id limit 1;
    else
      v_aggregate_state := 'idle';
      v_aggregate_error := null;
    end if;
    update public.digest_runs
    set previous_cleanup_state = v_aggregate_state, previous_cleanup_error = v_aggregate_error,
        previous_deleted_at = null
    where id = v_row.id and state in ('delivered','replaced') and previous_digest_id = p_previous_digest_id
    returning * into v_row;
  end if;
  return jsonb_build_object('claimed', v_claimed, 'row', to_jsonb(v_row), 'part', to_jsonb(v_part));
end;
$$;

create function public.record_digest_part_cleanup_v2(
  p_id uuid,
  p_previous_digest_id uuid,
  p_previous_part_id uuid,
  p_cleanup_owner text,
  p_cleanup_token uuid,
  p_expected_cleanup_attempts integer,
  p_outcome text,
  p_error text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.digest_runs%rowtype;
  v_previous_row public.digest_runs%rowtype;
  v_part public.digest_message_parts%rowtype;
  v_applied boolean := false;
  v_aggregate_state text;
  v_aggregate_error text;
begin
  if p_id is null or p_previous_digest_id is null or p_previous_part_id is null
    or p_id = p_previous_digest_id or p_cleanup_owner is null
    or length(p_cleanup_owner) not between 1 and 200 or p_cleanup_owner <> btrim(p_cleanup_owner)
    or p_cleanup_token is null or p_expected_cleanup_attempts is null or p_expected_cleanup_attempts < 1
    or p_outcome is null or p_outcome not in ('deleted','already_absent','failed')
    or (p_outcome in ('deleted','already_absent') and p_error is not null)
    or (p_outcome = 'failed' and (
      p_error is null or p_error not in ('cant_delete_message','rate_limited','cleanup_unconfirmed','slack_api_error')
    )) then
    raise exception 'invalid digest part cleanup' using errcode = '22023';
  end if;
  select * into v_row from public.digest_runs where id = p_id for update;
  if not found or v_row.state not in ('delivered','replaced')
    or v_row.delivered_at is null or v_row.manifest_prepared_at is null
    or v_row.previous_digest_id is distinct from p_previous_digest_id then
    return jsonb_build_object('applied', false, 'row', null, 'part', null);
  end if;
  select * into v_previous_row from public.digest_runs
  where id = p_previous_digest_id and state in ('delivered','replaced') for update;
  if not found
    or v_previous_row.delivered_at is null or v_previous_row.manifest_prepared_at is null
    or v_previous_row.destination_key is distinct from v_row.destination_key
    or v_previous_row.scheduled_at >= v_row.scheduled_at then
    return jsonb_build_object('applied', false, 'row', null, 'part', null);
  end if;
  select * into v_part from public.digest_message_parts
  where id = p_previous_part_id and digest_run_id = p_previous_digest_id for update;
  if not found or v_part.delivery_state <> 'delivered' then
    return jsonb_build_object('applied', false, 'row', null, 'part', null);
  end if;
  if v_part.cleanup_state = 'deleting'
    and v_part.cleanup_owner is not distinct from p_cleanup_owner
    and v_part.cleanup_token is not distinct from p_cleanup_token
    and v_part.cleanup_attempts = p_expected_cleanup_attempts
    and v_part.cleanup_expires_at is not null and v_part.cleanup_expires_at > now() then
    update public.digest_message_parts
    set cleanup_state = p_outcome, cleanup_owner = null, cleanup_token = null,
        cleanup_expires_at = null,
        cleaned_at = case when p_outcome in ('deleted','already_absent') then now() else null end,
        cleanup_error = case when p_outcome = 'failed' then p_error else null end
    where id = v_part.id and cleanup_state = 'deleting'
      and cleanup_owner = p_cleanup_owner and cleanup_token = p_cleanup_token
      and cleanup_attempts = p_expected_cleanup_attempts
    returning * into v_part;
    if not found then return jsonb_build_object('applied', false, 'row', null, 'part', null); end if;
    v_applied := true;
  elsif v_part.cleanup_attempts <> p_expected_cleanup_attempts
    or v_part.cleanup_state <> p_outcome
    or (p_outcome = 'failed' and v_part.cleanup_error is distinct from p_error)
    or (p_outcome in ('deleted','already_absent') and v_part.cleanup_error is not null) then
    return jsonb_build_object('applied', false, 'row', null, 'part', null);
  end if;

  if not exists (
    select 1 from public.digest_message_parts
    where digest_run_id = p_previous_digest_id and delivery_state = 'delivered'
      and cleanup_state not in ('deleted','already_absent')
  ) then
    update public.digest_runs set state = 'replaced'
    where id = p_previous_digest_id and state = 'delivered';
    select case when exists (
      select 1 from public.digest_message_parts
      where digest_run_id = p_previous_digest_id and delivery_state = 'delivered' and cleanup_state = 'deleted'
    ) then 'deleted' else 'already_absent' end into v_aggregate_state;
    update public.digest_runs
    set previous_cleanup_state = v_aggregate_state, previous_cleanup_error = null,
        previous_deleted_at = coalesce(previous_deleted_at, now())
    where id = v_row.id and state in ('delivered','replaced') and previous_digest_id = p_previous_digest_id
    returning * into v_row;
  else
    if exists (
      select 1 from public.digest_message_parts
      where digest_run_id = p_previous_digest_id and delivery_state = 'delivered' and cleanup_state = 'deleting'
    ) then
      v_aggregate_state := 'deleting';
      v_aggregate_error := null;
    elsif exists (
      select 1 from public.digest_message_parts
      where digest_run_id = p_previous_digest_id and delivery_state = 'delivered' and cleanup_state = 'failed'
    ) then
      v_aggregate_state := 'failed';
      select cleanup_error into v_aggregate_error from public.digest_message_parts
      where digest_run_id = p_previous_digest_id and delivery_state = 'delivered' and cleanup_state = 'failed'
      order by updated_at desc, id limit 1;
    else
      v_aggregate_state := 'idle';
      v_aggregate_error := null;
    end if;
    update public.digest_runs
    set previous_cleanup_state = v_aggregate_state, previous_cleanup_error = v_aggregate_error,
        previous_deleted_at = null
    where id = v_row.id and state in ('delivered','replaced') and previous_digest_id = p_previous_digest_id
    returning * into v_row;
  end if;
  return jsonb_build_object('applied', v_applied, 'row', to_jsonb(v_row), 'part', to_jsonb(v_part));
end;
$$;

alter table public.message_notification_receipts enable row level security;
alter table public.work_items_v2 enable row level security;
alter table public.digest_runs enable row level security;
alter table public.digest_message_parts enable row level security;

revoke all on table public.message_notification_receipts from public, anon, authenticated;
revoke all on table public.work_items_v2 from public, anon, authenticated;
revoke all on table public.digest_runs from public, anon, authenticated;
revoke all on table public.digest_message_parts from public, anon, authenticated;
grant select, insert, update, delete on table public.message_notification_receipts to service_role;
grant select, insert, update, delete on table public.work_items_v2 to service_role;
grant select, insert, update, delete on table public.digest_runs to service_role;
grant select, insert, update, delete on table public.digest_message_parts to service_role;

revoke execute on function public.touch_work_orchestrator_v2_updated_at() from public, anon, authenticated;
revoke execute on function public.claim_message_notification_receipt(text,text,text,text,timestamptz,uuid,jsonb) from public, anon, authenticated;
revoke execute on function public.is_effective_p0_ack_v2(jsonb,timestamptz) from public, anon, authenticated;
revoke execute on function public.upsert_work_item_v2(jsonb) from public, anon, authenticated;
revoke execute on function public.request_work_item_action_v2(uuid,integer,jsonb,text) from public, anon, authenticated;
revoke execute on function public.is_processable_pending_work_action_v2(jsonb,integer) from public, anon, authenticated;
revoke execute on function public.list_pending_work_actions_v2(integer) from public, anon, authenticated;
revoke execute on function public.list_actionable_work_v2(timestamptz,integer) from public, anon, authenticated;
revoke execute on function public.claim_digest_run_v2(text,timestamptz,timestamptz,timestamptz,text,integer) from public, anon, authenticated;
revoke execute on function public.prepare_digest_parts_v2(uuid,text,uuid,jsonb,jsonb) from public, anon, authenticated;
revoke execute on function public.claim_digest_part_delivery_v2(uuid,uuid,text,uuid) from public, anon, authenticated;
revoke execute on function public.mark_digest_part_delivered_v2(uuid,uuid,text,uuid,integer,text,text,timestamptz) from public, anon, authenticated;
revoke execute on function public.mark_digest_part_failed_v2(uuid,uuid,text,uuid,integer,text,timestamptz,timestamptz) from public, anon, authenticated;
revoke execute on function public.finalize_digest_run_v2(uuid,text,uuid,timestamptz) from public, anon, authenticated;
revoke execute on function public.fail_digest_run_v2(uuid,text,uuid,text) from public, anon, authenticated;
revoke execute on function public.list_digest_cleanup_backlog_v2(text,integer) from public, anon, authenticated;
revoke execute on function public.claim_digest_part_cleanup_v2(uuid,uuid,uuid,text,integer) from public, anon, authenticated;
revoke execute on function public.record_digest_part_cleanup_v2(uuid,uuid,uuid,text,uuid,integer,text,text) from public, anon, authenticated;
grant execute on function public.touch_work_orchestrator_v2_updated_at() to service_role;
grant execute on function public.claim_message_notification_receipt(text,text,text,text,timestamptz,uuid,jsonb) to service_role;
grant execute on function public.is_effective_p0_ack_v2(jsonb,timestamptz) to service_role;
grant execute on function public.upsert_work_item_v2(jsonb) to service_role;
grant execute on function public.request_work_item_action_v2(uuid,integer,jsonb,text) to service_role;
grant execute on function public.is_processable_pending_work_action_v2(jsonb,integer) to service_role;
grant execute on function public.list_pending_work_actions_v2(integer) to service_role;
grant execute on function public.list_actionable_work_v2(timestamptz,integer) to service_role;
grant execute on function public.claim_digest_run_v2(text,timestamptz,timestamptz,timestamptz,text,integer) to service_role;
grant execute on function public.prepare_digest_parts_v2(uuid,text,uuid,jsonb,jsonb) to service_role;
grant execute on function public.claim_digest_part_delivery_v2(uuid,uuid,text,uuid) to service_role;
grant execute on function public.mark_digest_part_delivered_v2(uuid,uuid,text,uuid,integer,text,text,timestamptz) to service_role;
grant execute on function public.mark_digest_part_failed_v2(uuid,uuid,text,uuid,integer,text,timestamptz,timestamptz) to service_role;
grant execute on function public.finalize_digest_run_v2(uuid,text,uuid,timestamptz) to service_role;
grant execute on function public.fail_digest_run_v2(uuid,text,uuid,text) to service_role;
grant execute on function public.list_digest_cleanup_backlog_v2(text,integer) to service_role;
grant execute on function public.claim_digest_part_cleanup_v2(uuid,uuid,uuid,text,integer) to service_role;
grant execute on function public.record_digest_part_cleanup_v2(uuid,uuid,uuid,text,uuid,integer,text,text) to service_role;
