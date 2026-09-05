set lock_timeout = '5s';

create function public.owner_work_taxonomy_v2(
  p_work_type text
) returns jsonb language sql immutable security invoker set search_path = '' as $$
  select case p_work_type
    when 'reservation_review' then jsonb_build_object('category','schedule','categoryLabel','예약·스케줄','workTypeLabel','예약 확인')
    when 'schedule_check' then jsonb_build_object('category','schedule','categoryLabel','예약·스케줄','workTypeLabel','스케줄 확인')
    when 'schedule_register' then jsonb_build_object('category','schedule','categoryLabel','예약·스케줄','workTypeLabel','스케줄 등록')
    when 'schedule_change' then jsonb_build_object('category','schedule','categoryLabel','예약·스케줄','workTypeLabel','스케줄 변경')
    when 'return_extension' then jsonb_build_object('category','schedule','categoryLabel','예약·스케줄','workTypeLabel','반납·연장')
    when 'quote_send' then jsonb_build_object('category','quote','categoryLabel','견적·가격','workTypeLabel','견적서 발송')
    when 'price_review' then jsonb_build_object('category','quote','categoryLabel','견적·가격','workTypeLabel','가격·할인 확인')
    when 'payment_check' then jsonb_build_object('category','settlement','categoryLabel','정산·서류','workTypeLabel','입금·결제 확인')
    when 'tax_invoice' then jsonb_build_object('category','settlement','categoryLabel','정산·서류','workTypeLabel','세금계산서 발행')
    when 'contract_document' then jsonb_build_object('category','settlement','categoryLabel','정산·서류','workTypeLabel','계약·서류 처리')
    when 'reply_needed' then jsonb_build_object('category','customer','categoryLabel','고객 응대','workTypeLabel','고객 답변 필요')
    when 'human_review' then jsonb_build_object('category','operations','categoryLabel','운영·예외','workTypeLabel','기타 사람 확인')
    when 'damage_repair' then jsonb_build_object('category','operations','categoryLabel','운영·예외','workTypeLabel','파손·수리')
    when 'sheet_duplicate_check' then jsonb_build_object('category','operations','categoryLabel','운영·예외','workTypeLabel','중복 확인')
    else null
  end;
$$;

create function public.is_valid_work_actor_v2(
  p_actor text
) returns boolean language sql immutable security invoker set search_path = '' as $$
  select p_actor is not null and (
    p_actor ~ '^[UW][A-Z0-9]{2,79}$'
    or p_actor ~ '^heybilli:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  );
$$;

create function public.list_heybilli_owner_work_v2(
  p_now timestamptz,
  p_view text,
  p_category text,
  p_limit integer,
  p_after jsonb default null
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_after_p0_rank integer;
  v_after_overdue_rank integer;
  v_after_priority_rank integer;
  v_after_opened_at timestamptz;
  v_after_id uuid;
  v_result jsonb;
begin
  if p_now is null or not isfinite(p_now)
    or p_view is null or p_view not in ('now','snoozed','completed')
    or (p_category is not null and p_category not in ('schedule','quote','settlement','customer','operations'))
    or p_limit is null or p_limit not between 1 and 200 then
    raise exception 'invalid Heybilli owner inbox query' using errcode = '22023';
  end if;

  if p_after is not null then
    if jsonb_typeof(p_after) <> 'object'
      or not (p_after ?& array['p0Rank','overdueRank','priorityRank','openedAt','id'])
      or (p_after - array['p0Rank','overdueRank','priorityRank','openedAt','id']::text[]) <> '{}'::jsonb
      or jsonb_typeof(p_after->'p0Rank') <> 'number'
      or jsonb_typeof(p_after->'overdueRank') <> 'number'
      or jsonb_typeof(p_after->'priorityRank') <> 'number'
      or (p_after->>'p0Rank') !~ '^[01]$'
      or (p_after->>'overdueRank') !~ '^[01]$'
      or (p_after->>'priorityRank') !~ '^[0-3]$'
      or jsonb_typeof(p_after->'openedAt') <> 'string'
      or (p_after->>'openedAt') !~ '^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
      or jsonb_typeof(p_after->'id') <> 'string'
      or (p_after->>'id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'invalid Heybilli owner inbox query' using errcode = '22023';
    end if;
    begin
      v_after_p0_rank := (p_after->>'p0Rank')::integer;
      v_after_overdue_rank := (p_after->>'overdueRank')::integer;
      v_after_priority_rank := (p_after->>'priorityRank')::integer;
      v_after_opened_at := (p_after->>'openedAt')::timestamptz;
      v_after_id := (p_after->>'id')::uuid;
    exception when others then
      raise exception 'invalid Heybilli owner inbox query' using errcode = '22023';
    end;
    if not isfinite(v_after_opened_at)
      or to_char(v_after_opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> p_after->>'openedAt'
      or v_after_id::text <> p_after->>'id' then
      raise exception 'invalid Heybilli owner inbox query' using errcode = '22023';
    end if;
  end if;

  if exists (
    select 1
    from public.work_items_v2 as w
    where jsonb_typeof(w.payload->'requires_human_action') = 'boolean'
      and (w.payload->>'requires_human_action')::boolean is true
      and public.owner_work_taxonomy_v2(w.work_type) is not null
      and (
        length(w.title) not between 1 and 300 or length(w.summary) > 2000
        or length(coalesce(w.payload->>'recommended_action','')) > 1200
        or not isfinite(w.actionable_at) or not isfinite(w.first_opened_at)
        or not isfinite(w.last_activity_at) or not isfinite(w.created_at) or not isfinite(w.updated_at)
        or (w.due_at is not null and not isfinite(w.due_at))
        or (w.snoozed_until is not null and not isfinite(w.snoozed_until))
        or (w.payload ? 'recommended_action' and jsonb_typeof(w.payload->'recommended_action') <> 'string')
      )
  ) then
    raise exception 'invalid Heybilli owner inbox evidence' using errcode = '22023';
  end if;

  with classified as materialized (
    select
      w.id, w.title, w.summary, w.work_type, w.priority, w.state,
      w.due_at, w.snoozed_until, w.first_opened_at, w.updated_at, w.version, w.payload,
      public.owner_work_taxonomy_v2(w.work_type) as taxonomy,
      case when w.priority = 'p0' and not public.is_effective_p0_ack_v2(w.payload, p_now) then 0 else 1 end as p0_rank,
      case when w.due_at is not null and w.due_at < p_now then 0 else 1 end as overdue_rank,
      case w.priority when 'urgent' then 0 when 'p0' then 1 when 'normal' then 2 else 3 end as priority_rank
    from public.work_items_v2 as w
    where jsonb_typeof(w.payload->'requires_human_action') = 'boolean'
      and (w.payload->>'requires_human_action')::boolean is true
      and public.owner_work_taxonomy_v2(w.work_type) is not null
  ), summary_values as (
    select
      count(*) filter (where state in ('open','in_progress') or (state = 'snoozed' and snoozed_until <= p_now)) as now_count,
      count(*) filter (where state = 'snoozed' and snoozed_until > p_now) as snoozed_count,
      count(*) filter (where state in ('resolved','dismissed')) as completed_count,
      count(*) filter (where p0_rank = 0 and (state in ('open','in_progress') or (state = 'snoozed' and snoozed_until <= p_now))) as p0_count,
      count(*) filter (where state in ('open','in_progress','snoozed') and taxonomy->>'category' = 'schedule') as schedule_count,
      count(*) filter (where state in ('open','in_progress','snoozed') and taxonomy->>'category' = 'quote') as quote_count,
      count(*) filter (where state in ('open','in_progress','snoozed') and taxonomy->>'category' = 'settlement') as settlement_count,
      count(*) filter (where state in ('open','in_progress','snoozed') and taxonomy->>'category' = 'customer') as customer_count,
      count(*) filter (where state in ('open','in_progress','snoozed') and taxonomy->>'category' = 'operations') as operations_count
    from classified
  ), selected_view as materialized (
    select *
    from classified
    where (p_category is null or taxonomy->>'category' = p_category)
      and (
        (p_view = 'now' and (state in ('open','in_progress') or (state = 'snoozed' and snoozed_until <= p_now)))
        or (p_view = 'snoozed' and state = 'snoozed' and snoozed_until > p_now)
        or (p_view = 'completed' and state in ('resolved','dismissed'))
      )
  ), remaining as materialized (
    select *
    from selected_view
    where p_after is null or (p0_rank, overdue_rank, priority_rank, first_opened_at, id)
      > (v_after_p0_rank, v_after_overdue_rank, v_after_priority_rank, v_after_opened_at, v_after_id)
  ), bounded as materialized (
    select * from remaining
    order by p0_rank, overdue_rank, priority_rank, first_opened_at, id
    limit p_limit
  ), remaining_count as (
    select count(*) as value from remaining
  ), last_bounded as (
    select * from bounded
    order by p0_rank desc, overdue_rank desc, priority_rank desc, first_opened_at desc, id desc
    limit 1
  )
  select jsonb_build_object(
    'summary', jsonb_build_object(
      'now', summary_values.now_count,
      'snoozed', summary_values.snoozed_count,
      'completed', summary_values.completed_count,
      'p0', summary_values.p0_count,
      'byCategory', jsonb_build_object(
        'schedule', summary_values.schedule_count,
        'quote', summary_values.quote_count,
        'settlement', summary_values.settlement_count,
        'customer', summary_values.customer_count,
        'operations', summary_values.operations_count
      )
    ),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', item.id::text,
        'version', item.version,
        'category', item.taxonomy->>'category',
        'workType', item.work_type,
        'workTypeLabel', item.taxonomy->>'workTypeLabel',
        'priority', item.priority,
        'state', item.state,
        'title', item.title,
        'summary', item.summary,
        'recommendedAction', coalesce(item.payload->>'recommended_action',''),
        'dueAt', case when item.due_at is null then null else to_char(item.due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'snoozedUntil', case when item.snoozed_until is null then null else to_char(item.snoozed_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'firstOpenedAt', to_char(item.first_opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'updatedAt', to_char(item.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by item.p0_rank, item.overdue_rank, item.priority_rank, item.first_opened_at, item.id)
      from bounded as item
    ), '[]'::jsonb),
    'nextCursor', case when remaining_count.value > p_limit then (
      select jsonb_build_object(
        'p0Rank', last_bounded.p0_rank,
        'overdueRank', last_bounded.overdue_rank,
        'priorityRank', last_bounded.priority_rank,
        'openedAt', to_char(last_bounded.first_opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'id', last_bounded.id::text
      ) from last_bounded
    ) else null end,
    'omittedCount', greatest(remaining_count.value - p_limit, 0)
  ) into v_result
  from summary_values cross join remaining_count;

  return v_result;
end;
$$;

create schema if not exists work_orchestrator_private;
revoke all on schema work_orchestrator_private from public, anon, authenticated;
grant usage on schema work_orchestrator_private to service_role;

alter function public.upsert_work_item_v2(jsonb) set schema work_orchestrator_private;
revoke execute on function work_orchestrator_private.upsert_work_item_v2(jsonb)
  from public, anon, authenticated;
grant execute on function work_orchestrator_private.upsert_work_item_v2(jsonb)
  to service_role;

create or replace function public.upsert_work_item_v2(
  p_candidate jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_work_type text;
  v_validated_candidate jsonb;
  v_result jsonb;
  v_row public.work_items_v2%rowtype;
begin
  v_work_type := case
    when p_candidate is not null and jsonb_typeof(p_candidate) = 'object'
      and jsonb_typeof(p_candidate->'work_type') = 'string'
      then p_candidate->>'work_type'
    else null
  end;
  if v_work_type in ('schedule_register','schedule_change') then
    v_validated_candidate := jsonb_set(p_candidate, '{work_type}', to_jsonb('schedule_check'::text), false);
  else
    v_validated_candidate := p_candidate;
  end if;

  v_result := work_orchestrator_private.upsert_work_item_v2(v_validated_candidate);
  if v_work_type in ('schedule_register','schedule_change')
    and v_result->'applied' = 'true'::jsonb
    and v_result->'created' = 'true'::jsonb then
    update public.work_items_v2
    set work_type = v_work_type
    where id = (v_result->'row'->>'id')::uuid
      and work_type = 'schedule_check'
    returning * into v_row;
    if not found then
      raise exception 'work item type promotion failed' using errcode = '40001';
    end if;
    v_result := jsonb_set(v_result, '{row}', to_jsonb(v_row), false);
  end if;
  return v_result;
end;
$$;

create or replace function public.request_work_item_action_v2(
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
    or not public.is_valid_work_actor_v2(p_requested_by)
    or p_action is null or jsonb_typeof(p_action) <> 'object'
    or not (p_action ? 'type') or jsonb_typeof(p_action->'type') <> 'string' then
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
      if not isfinite(v_snoozed_until) or v_snoozed_until <= now() then raise exception 'non-future snooze'; end if;
    exception when others then
      raise exception 'invalid work action request' using errcode = '22023';
    end;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('work-action:' || p_id::text || ':' || p_expected_version::text, 91420260830));
  update public.work_items_v2
  set pending_action = jsonb_build_object(
        'type', v_action_type, 'action', p_action, 'status', 'pending',
        'requested_at', now(), 'requested_by', p_requested_by, 'expected_version', p_expected_version
      ),
      version = version + 1
  where id = p_id and version = p_expected_version
    and state in ('open','in_progress','snoozed')
    and not exists (
      select 1 from public.digest_runs as unfinished
      where unfinished.state in ('building','delivering','failed')
        and unfinished.manifest_prepared_at is not null
        and jsonb_array_length(unfinished.item_snapshot) > 0
        and exists (select 1 from public.digest_message_parts as stored_part where stored_part.digest_run_id = unfinished.id)
        and exists (
          select 1 from jsonb_array_elements(unfinished.item_snapshot) as snapshot(entry)
          where snapshot.entry->>'id' = p_id::text
            and (snapshot.entry->>'version')::integer = p_expected_version
        )
    )
  returning * into v_row;
  return jsonb_build_object('applied', found, 'row', case when found then to_jsonb(v_row) else null end);
end;
$$;

create or replace function public.is_processable_pending_work_action_v2(
  p_pending jsonb,
  p_current_version integer
) returns boolean language plpgsql stable security invoker set search_path = '' as $$
declare
  v_type text; v_action jsonb; v_expected_version integer;
  v_requested_at timestamptz; v_snoozed_until timestamptz;
begin
  if p_pending is null or jsonb_typeof(p_pending) <> 'object'
    or not (p_pending ?& array['type','action','status','requested_at','requested_by','expected_version'])
    or (p_pending - array['type','action','status','requested_at','requested_by','expected_version']::text[]) <> '{}'::jsonb
    or jsonb_typeof(p_pending->'type') <> 'string' or jsonb_typeof(p_pending->'action') <> 'object'
    or jsonb_typeof(p_pending->'status') <> 'string' or p_pending->>'status' <> 'pending'
    or jsonb_typeof(p_pending->'requested_at') <> 'string' or length(p_pending->>'requested_at') > 40
    or (p_pending->>'requested_at') !~ '^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    or jsonb_typeof(p_pending->'requested_by') <> 'string'
    or not public.is_valid_work_actor_v2(p_pending->>'requested_by')
    or jsonb_typeof(p_pending->'expected_version') <> 'number'
    or (p_pending->>'expected_version') !~ '^[1-9][0-9]*$' then return false;
  end if;
  begin
    v_expected_version := (p_pending->>'expected_version')::integer;
    v_requested_at := (p_pending->>'requested_at')::timestamptz;
  exception when others then return false;
  end;
  if p_current_version is null or p_current_version <= 1 or v_expected_version <> p_current_version - 1
    or not isfinite(v_requested_at) or v_requested_at > now() then return false;
  end if;
  v_type := p_pending->>'type'; v_action := p_pending->'action';
  if v_type not in ('progress','snooze','ack_p0','dismiss')
    or v_action->>'type' is distinct from v_type
    or (v_type <> 'snooze' and (v_action - 'type') <> '{}'::jsonb)
    or (v_type = 'snooze' and (
      not (v_action ?& array['type','snoozedUntil'])
      or (v_action - array['type','snoozedUntil']::text[]) <> '{}'::jsonb
      or jsonb_typeof(v_action->'snoozedUntil') <> 'string'
      or length(v_action->>'snoozedUntil') > 40
      or (v_action->>'snoozedUntil') !~ '^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    )) then return false;
  end if;
  if v_type = 'snooze' then
    begin v_snoozed_until := (v_action->>'snoozedUntil')::timestamptz;
    exception when others then return false; end;
    if not isfinite(v_snoozed_until) or v_snoozed_until <= now() then return false; end if;
  end if;
  return true;
end;
$$;

create or replace function public.is_valid_pending_work_action_at_v2(
  p_pending jsonb,
  p_current_version integer,
  p_now timestamptz
) returns boolean language plpgsql stable security invoker set search_path = '' as $$
declare
  v_type text; v_action jsonb; v_expected_version integer;
  v_requested_at timestamptz; v_snoozed_until timestamptz;
begin
  if p_now is null or not isfinite(p_now)
    or p_pending is null or jsonb_typeof(p_pending) <> 'object'
    or not (p_pending ?& array['type','action','status','requested_at','requested_by','expected_version'])
    or (p_pending - array['type','action','status','requested_at','requested_by','expected_version']::text[]) <> '{}'::jsonb
    or jsonb_typeof(p_pending->'type') <> 'string' or jsonb_typeof(p_pending->'action') <> 'object'
    or jsonb_typeof(p_pending->'status') <> 'string' or p_pending->>'status' <> 'pending'
    or jsonb_typeof(p_pending->'requested_at') <> 'string' or length(p_pending->>'requested_at') > 40
    or (p_pending->>'requested_at') !~ '^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    or jsonb_typeof(p_pending->'requested_by') <> 'string'
    or not public.is_valid_work_actor_v2(p_pending->>'requested_by')
    or jsonb_typeof(p_pending->'expected_version') <> 'number'
    or (p_pending->>'expected_version') !~ '^[1-9][0-9]*$' then return false;
  end if;
  begin
    v_expected_version := (p_pending->>'expected_version')::integer;
    v_requested_at := (p_pending->>'requested_at')::timestamptz;
  exception when others then return false;
  end;
  if p_current_version is null or p_current_version <= 1 or v_expected_version <> p_current_version - 1
    or not isfinite(v_requested_at) or v_requested_at > p_now then return false;
  end if;
  v_type := p_pending->>'type'; v_action := p_pending->'action';
  if v_type not in ('progress','snooze','ack_p0','request_resolve','dismiss')
    or v_action->>'type' is distinct from v_type
    or (v_type <> 'snooze' and (v_action - 'type') <> '{}'::jsonb)
    or (v_type = 'snooze' and (
      not (v_action ?& array['type','snoozedUntil'])
      or (v_action - array['type','snoozedUntil']::text[]) <> '{}'::jsonb
      or jsonb_typeof(v_action->'snoozedUntil') <> 'string'
      or length(v_action->>'snoozedUntil') > 40
      or (v_action->>'snoozedUntil') !~ '^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    )) then return false;
  end if;
  if v_type = 'snooze' then
    begin v_snoozed_until := (v_action->>'snoozedUntil')::timestamptz;
    exception when others then return false; end;
    if not isfinite(v_snoozed_until) or v_snoozed_until <= p_now then return false; end if;
  end if;
  return true;
end;
$$;

revoke execute on function public.owner_work_taxonomy_v2(text) from public, anon, authenticated, service_role;
revoke execute on function public.is_valid_work_actor_v2(text) from public, anon, authenticated, service_role;
revoke execute on function public.list_heybilli_owner_work_v2(timestamptz,text,text,integer,jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.upsert_work_item_v2(jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.request_work_item_action_v2(uuid,integer,jsonb,text) from public, anon, authenticated, service_role;
revoke execute on function public.is_processable_pending_work_action_v2(jsonb,integer) from public, anon, authenticated, service_role;
revoke execute on function public.is_valid_pending_work_action_at_v2(jsonb,integer,timestamptz) from public, anon, authenticated, service_role;

grant execute on function public.owner_work_taxonomy_v2(text) to service_role;
grant execute on function public.is_valid_work_actor_v2(text) to service_role;
grant execute on function public.list_heybilli_owner_work_v2(timestamptz,text,text,integer,jsonb) to service_role;
grant execute on function public.upsert_work_item_v2(jsonb) to service_role;
grant execute on function public.request_work_item_action_v2(uuid,integer,jsonb,text) to service_role;
grant execute on function public.is_processable_pending_work_action_v2(jsonb,integer) to service_role;
grant execute on function public.is_valid_pending_work_action_at_v2(jsonb,integer,timestamptz) to service_role;
