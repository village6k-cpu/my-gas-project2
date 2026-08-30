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
  slack_channel_id text,
  slack_message_ts text,
  delivered_at timestamptz,
  previous_digest_id uuid references public.digest_runs(id) on delete set null,
  previous_deleted_at timestamptz,
  previous_cleanup_state text not null default 'idle'
    check (previous_cleanup_state in ('idle','failed','deleted','already_absent')),
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
    or p_requested_by is null or length(p_requested_by) not between 1 and 200
    or p_requested_by <> btrim(p_requested_by)
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
  returning * into v_row;
  return jsonb_build_object('applied', found, 'row', case when found then to_jsonb(v_row) else null end);
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
    and slack_channel_id is not null
    and slack_message_ts is not null
  order by delivered_at desc, scheduled_at desc, id desc
  limit 1
  for share;
  if found then
    v_previous_json := jsonb_build_object(
      'id', v_previous.id,
      'slack_channel_id', v_previous.slack_channel_id,
      'slack_message_ts', v_previous.slack_message_ts
    );
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
  select jsonb_build_object(
    'id', prior.id,
    'slack_channel_id', prior.slack_channel_id,
    'slack_message_ts', prior.slack_message_ts
  ) into v_previous_json
  from public.digest_runs as prior
  where prior.id = v_row.previous_digest_id;
  if v_row.state in ('building','failed')
    and v_row.lease_expires_at is not null
    and v_row.lease_expires_at <= now() then
    update public.digest_runs
    set state = 'building', lease_owner = p_lease_owner,
        lease_token = gen_random_uuid(),
        lease_expires_at = now() + make_interval(secs => p_lease_seconds), error = null
    where id = v_row.id
      and state in ('building','failed')
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

create function public.finalize_digest_run_v2(
  p_id uuid,
  p_lease_owner text,
  p_lease_token uuid,
  p_item_snapshot jsonb,
  p_slack_channel_id text,
  p_slack_message_ts text,
  p_delivered_at timestamptz
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_run public.digest_runs%rowtype;
  v_entry jsonb;
  v_updated_count integer := 0;
  v_snapshot_count integer;
begin
  if p_id is null
    or p_lease_owner is null or length(p_lease_owner) not between 1 and 200
    or p_lease_owner <> btrim(p_lease_owner)
    or p_lease_token is null
    or p_delivered_at is null or not isfinite(p_delivered_at)
    or p_item_snapshot is null or jsonb_typeof(p_item_snapshot) <> 'array'
    or jsonb_array_length(p_item_snapshot) > 1000 then
    raise exception 'invalid digest finalization' using errcode = '22023';
  end if;
  v_snapshot_count := jsonb_array_length(p_item_snapshot);
  if (v_snapshot_count = 0 and (p_slack_channel_id is not null or p_slack_message_ts is not null))
    or (v_snapshot_count > 0 and (
      p_slack_channel_id is null
      or length(p_slack_channel_id) not between 1 and 500
      or p_slack_channel_id <> btrim(p_slack_channel_id)
      or p_slack_message_ts is null
      or p_slack_message_ts !~ '^[0-9]{1,20}\.[0-9]{1,20}$'
    )) then
    raise exception 'invalid digest finalization' using errcode = '22023';
  end if;
  for v_entry in select value from jsonb_array_elements(p_item_snapshot) loop
    if jsonb_typeof(v_entry) <> 'object'
      or not (v_entry ?& array['id','version','inclusionReason','priority'])
      or (v_entry - array['id','version','inclusionReason','priority']::text[]) <> '{}'::jsonb
      or jsonb_typeof(v_entry->'id') <> 'string'
      or (v_entry->>'id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or jsonb_typeof(v_entry->'version') <> 'number'
      or (v_entry->>'version') !~ '^[1-9][0-9]*$'
      or jsonb_typeof(v_entry->'inclusionReason') <> 'string'
      or (v_entry->>'inclusionReason') not in ('p0','overdue','urgent','carry_over','actionable','daily_reminder')
      or jsonb_typeof(v_entry->'priority') <> 'string'
      or (v_entry->>'priority') not in ('p0','urgent','normal','low') then
      raise exception 'invalid digest finalization' using errcode = '22023';
    end if;
    begin
      perform (v_entry->>'id')::uuid;
      perform (v_entry->>'version')::integer;
    exception when others then
      raise exception 'invalid digest finalization' using errcode = '22023';
    end;
  end loop;
  if (
    select count(*) from jsonb_array_elements(p_item_snapshot)
  ) <> (
    select count(distinct (entry->>'id')::uuid)
    from jsonb_array_elements(p_item_snapshot) as snapshot(entry)
  ) then
    raise exception 'invalid digest finalization' using errcode = '22023';
  end if;

  select * into v_run
  from public.digest_runs
  where id = p_id
  for update;
  if not found
    or v_run.state <> 'building'
    or v_run.lease_owner is distinct from p_lease_owner
    or v_run.lease_token is distinct from p_lease_token
    or v_run.lease_expires_at is null
    or v_run.lease_expires_at <= now() then
    return jsonb_build_object('applied', false, 'row', null, 'updated_count', 0);
  end if;

  perform 1
  from public.work_items_v2 as w
  join jsonb_array_elements(p_item_snapshot) as s(entry)
    on w.id = (s.entry->>'id')::uuid
  order by w.id
  for update of w;

  if exists (
    select 1
    from public.work_items_v2 as w
    join jsonb_array_elements(p_item_snapshot) as s(entry)
      on w.id = (s.entry->>'id')::uuid
    where w.version = (s.entry->>'version')::integer
      and w.state in ('open','in_progress','snoozed')
      and (
        s.entry->>'priority' <> w.priority
        or not (
          w.actionable_at <= p_delivered_at
          or (
            w.priority = 'p0'
            and not public.is_effective_p0_ack_v2(w.payload, p_delivered_at)
          )
        )
        or (s.entry->>'inclusionReason' = 'p0' and w.priority <> 'p0')
        or (s.entry->>'inclusionReason' = 'urgent' and w.priority <> 'urgent')
        or (s.entry->>'inclusionReason' = 'overdue'
          and p_delivered_at < w.first_opened_at + interval '24 hours')
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
      next_reminder_at = case
        when s.entry->>'inclusionReason' = 'daily_reminder'
          then p_delivered_at + interval '24 hours'
        else coalesce(w.next_reminder_at, w.first_opened_at + interval '72 hours')
      end
  from jsonb_array_elements(p_item_snapshot) as s(entry)
  where w.id = (s.entry->>'id')::uuid
    and w.version = (s.entry->>'version')::integer
    and w.state in ('open','in_progress','snoozed');
  get diagnostics v_updated_count = row_count;

  update public.digest_runs
  set state = 'delivered', item_snapshot = p_item_snapshot,
      slack_channel_id = p_slack_channel_id, slack_message_ts = p_slack_message_ts,
      delivered_at = p_delivered_at, lease_owner = null, lease_token = null,
      lease_expires_at = null, error = null
  where id = v_run.id
    and state = 'building'
    and lease_owner = p_lease_owner
    and lease_token = p_lease_token
  returning * into v_run;
  if not found then
    raise exception 'digest lease changed while locked' using errcode = '40001';
  end if;
  return jsonb_build_object(
    'applied', true, 'row', to_jsonb(v_run), 'updated_count', v_updated_count
  );
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
    or v_row.state <> 'building'
    or v_row.lease_owner is distinct from p_lease_owner
    or v_row.lease_token is distinct from p_lease_token
    or v_row.lease_expires_at is null
    or v_row.lease_expires_at <= now() then
    return jsonb_build_object('applied', false, 'row', null);
  end if;
  update public.digest_runs
  set state = 'failed', error = p_error
  where id = v_row.id and state = 'building' and lease_owner = p_lease_owner
    and lease_token = p_lease_token
  returning * into v_row;
  return jsonb_build_object('applied', found, 'row', case when found then to_jsonb(v_row) else null end);
end;
$$;

create function public.record_digest_cleanup_v2(
  p_id uuid,
  p_previous_digest_id uuid,
  p_outcome text,
  p_error text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.digest_runs%rowtype;
  v_previous public.digest_runs%rowtype;
begin
  if p_id is null or p_previous_digest_id is null or p_id = p_previous_digest_id
    or p_outcome is null or p_outcome not in ('deleted','already_absent','failed')
    or (p_outcome in ('deleted','already_absent') and p_error is not null)
    or (p_outcome = 'failed' and (
      p_error is null
      or p_error not in ('cant_delete_message','rate_limited','cleanup_unconfirmed','slack_api_error')
    )) then
    raise exception 'invalid digest cleanup' using errcode = '22023';
  end if;

  select * into v_row
  from public.digest_runs
  where id = p_id
  for update;
  if not found
    or v_row.state <> 'delivered'
    or v_row.previous_digest_id is distinct from p_previous_digest_id then
    return jsonb_build_object('applied', false, 'row', null);
  end if;
  if v_row.previous_cleanup_state in ('deleted','already_absent') then
    return jsonb_build_object('applied', false, 'row', to_jsonb(v_row));
  end if;

  select * into v_previous
  from public.digest_runs
  where id = p_previous_digest_id
  for update;
  if not found then
    return jsonb_build_object('applied', false, 'row', null);
  end if;

  if p_outcome = 'failed' then
    update public.digest_runs
    set previous_cleanup_state = 'failed', previous_cleanup_error = p_error
    where id = v_row.id and state = 'delivered'
      and previous_digest_id = p_previous_digest_id
    returning * into v_row;
    return jsonb_build_object('applied', found, 'row', case when found then to_jsonb(v_row) else null end);
  end if;

  update public.digest_runs
  set state = 'replaced'
  where id = v_previous.id and state = 'delivered';
  update public.digest_runs
  set previous_cleanup_state = p_outcome, previous_cleanup_error = null,
      previous_deleted_at = now()
  where id = v_row.id and state = 'delivered'
    and previous_digest_id = p_previous_digest_id
  returning * into v_row;
  return jsonb_build_object('applied', found, 'row', case when found then to_jsonb(v_row) else null end);
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
revoke execute on function public.is_effective_p0_ack_v2(jsonb,timestamptz) from public, anon, authenticated;
revoke execute on function public.upsert_work_item_v2(jsonb) from public, anon, authenticated;
revoke execute on function public.request_work_item_action_v2(uuid,integer,jsonb,text) from public, anon, authenticated;
revoke execute on function public.list_actionable_work_v2(timestamptz,integer) from public, anon, authenticated;
revoke execute on function public.claim_digest_run_v2(text,timestamptz,timestamptz,timestamptz,text,integer) from public, anon, authenticated;
revoke execute on function public.finalize_digest_run_v2(uuid,text,uuid,jsonb,text,text,timestamptz) from public, anon, authenticated;
revoke execute on function public.fail_digest_run_v2(uuid,text,uuid,text) from public, anon, authenticated;
revoke execute on function public.record_digest_cleanup_v2(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function public.touch_work_orchestrator_v2_updated_at() to service_role;
grant execute on function public.claim_message_notification_receipt(text,text,text,text,timestamptz,uuid,jsonb) to service_role;
grant execute on function public.is_effective_p0_ack_v2(jsonb,timestamptz) to service_role;
grant execute on function public.upsert_work_item_v2(jsonb) to service_role;
grant execute on function public.request_work_item_action_v2(uuid,integer,jsonb,text) to service_role;
grant execute on function public.list_actionable_work_v2(timestamptz,integer) to service_role;
grant execute on function public.claim_digest_run_v2(text,timestamptz,timestamptz,timestamptz,text,integer) to service_role;
grant execute on function public.finalize_digest_run_v2(uuid,text,uuid,jsonb,text,text,timestamptz) to service_role;
grant execute on function public.fail_digest_run_v2(uuid,text,uuid,text) to service_role;
grant execute on function public.record_digest_cleanup_v2(uuid,uuid,text,text) to service_role;
