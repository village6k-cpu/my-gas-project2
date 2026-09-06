set lock_timeout = '5s';

create function work_orchestrator_private.owner_safe_case_title_v2(
  p_title text
) returns text language sql immutable security invoker set search_path = '' as $$
  select case
    when p_title is not null
      and length(btrim(p_title)) between 1 and 300
      and pg_catalog.split_part(btrim(p_title), ' ', 1) ~ '^[가-힣A-Za-z][가-힣A-Za-z0-9._-]{0,29}$'
      and lower(pg_catalog.split_part(btrim(p_title), ' ', 1)) !~ '(error|timeout|exception|automation)'
      then pg_catalog.split_part(btrim(p_title), ' ', 1) || ' 문의'
    else '고객 문의'
  end;
$$;

create function work_orchestrator_private.owner_safe_task_label_v2(
  p_title text,
  p_fallback text
) returns text language sql immutable security invoker set search_path = '' as $$
  select case
    when p_title is not null
      and length(btrim(p_title)) between 1 and 80
      and lower(p_title) !~ '(오류|실패|충돌|timeout|error|exception|automation|confirmation_request|rq-[0-9]|[a-z_]{8,})'
      and p_title !~ '01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4}'
      then btrim(p_title)
    else p_fallback
  end;
$$;

create function public.list_heybilli_owner_cases_v2(
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
    raise exception 'invalid Heybilli owner case query' using errcode = '22023';
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
      raise exception 'invalid Heybilli owner case query' using errcode = '22023';
    end if;
    begin
      v_after_p0_rank := (p_after->>'p0Rank')::integer;
      v_after_overdue_rank := (p_after->>'overdueRank')::integer;
      v_after_priority_rank := (p_after->>'priorityRank')::integer;
      v_after_opened_at := (p_after->>'openedAt')::timestamptz;
      v_after_id := (p_after->>'id')::uuid;
    exception when others then
      raise exception 'invalid Heybilli owner case query' using errcode = '22023';
    end;
    if not isfinite(v_after_opened_at)
      or to_char(v_after_opened_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> p_after->>'openedAt'
      or v_after_id::text <> p_after->>'id' then
      raise exception 'invalid Heybilli owner case query' using errcode = '22023';
    end if;
  end if;

  if exists (
    select 1
    from public.work_items_v2 as w
    where jsonb_typeof(w.payload->'requires_human_action') = 'boolean'
      and (w.payload->>'requires_human_action')::boolean is true
      and public.owner_work_taxonomy_v2(w.work_type) is not null
      and (
        length(w.title) not between 1 and 300
        or not isfinite(w.actionable_at) or not isfinite(w.first_opened_at)
        or not isfinite(w.last_activity_at) or not isfinite(w.created_at) or not isfinite(w.updated_at)
        or (w.due_at is not null and not isfinite(w.due_at))
        or (w.snoozed_until is not null and not isfinite(w.snoozed_until))
      )
  ) then
    raise exception 'invalid Heybilli owner case evidence' using errcode = '22023';
  end if;

  with eligible as materialized (
    select
      w.id, w.title, w.work_type, w.priority, w.state, w.due_at, w.snoozed_until,
      w.first_opened_at, w.updated_at, w.version, w.payload,
      coalesce(nullif(btrim(w.room_key), ''), w.id::text) as room_partition,
      public.owner_work_taxonomy_v2(w.work_type) as taxonomy,
      (w.state in ('open','in_progress') or (w.state = 'snoozed' and w.snoozed_until <= p_now)) as is_now,
      (w.state = 'snoozed' and w.snoozed_until > p_now) as is_future_snoozed,
      (w.state in ('resolved','dismissed')) as is_completed
    from public.work_items_v2 as w
    where jsonb_typeof(w.payload->'requires_human_action') = 'boolean'
      and (w.payload->>'requires_human_action')::boolean is true
      and public.owner_work_taxonomy_v2(w.work_type) is not null
  ), with_previous as (
    select eligible.*,
      lag(first_opened_at) over (partition by room_partition order by first_opened_at, id) as previous_opened_at
    from eligible
  ), marked as (
    select with_previous.*,
      case when previous_opened_at is null or first_opened_at - previous_opened_at > interval '30 minutes'
        then 1 else 0 end as new_case
    from with_previous
  ), assigned as (
    select marked.*,
      sum(case when new_case = 1 then 1 else 0 end)
        over (partition by room_partition order by first_opened_at, id rows unbounded preceding) as case_number
    from marked
  ), grouped as materialized (
    select
      (array_agg(id order by first_opened_at, id))[1] as id,
      min(first_opened_at) as received_at,
      max(updated_at) as updated_at,
      (array_agg(title order by first_opened_at, id))[1] as first_title,
      (array_agg(taxonomy->>'workTypeLabel' order by first_opened_at, id))[1] as primary_work_label,
      bool_or(is_now) as has_now,
      bool_or(is_future_snoozed) as has_future_snoozed,
      bool_and(is_completed) as all_completed,
      bool_or(is_now and priority = 'p0' and not public.is_effective_p0_ack_v2(payload, p_now)) as has_unacknowledged_p0,
      bool_or(is_now and due_at is not null and due_at < p_now) as has_overdue,
      bool_or(not is_completed and priority = 'p0') as has_p0_priority,
      bool_or(not is_completed and priority = 'urgent') as has_urgent_priority,
      bool_or(not is_completed and priority = 'normal') as has_normal_priority,
      min(case when not is_completed then case priority when 'urgent' then 0 when 'p0' then 1 when 'normal' then 2 else 3 end else 3 end) as priority_rank,
      bool_or((taxonomy->>'category') = 'schedule') as has_schedule,
      bool_or((taxonomy->>'category') = 'quote') as has_quote,
      bool_or((taxonomy->>'category') = 'settlement') as has_settlement,
      bool_or((taxonomy->>'category') = 'customer') as has_customer,
      bool_or((taxonomy->>'category') = 'operations') as has_operations,
      count(*) filter (where is_completed)::integer as completed_step_count,
      count(*)::integer as total_step_count,
      jsonb_agg(jsonb_build_object(
        'id', id::text,
        'version', version,
        'category', taxonomy->>'category',
        'workTypeLabel', taxonomy->>'workTypeLabel',
        'priority', priority,
        'state', state,
        'taskLabel', work_orchestrator_private.owner_safe_task_label_v2(title, taxonomy->>'workTypeLabel'),
        'dueAt', case when due_at is null then null else to_char(due_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'snoozedUntil', case when snoozed_until is null then null else to_char(snoozed_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'updatedAt', to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by first_opened_at, id) as steps
    from assigned
    group by room_partition, case_number
  ), classified_cases as materialized (
    select grouped.*,
      case when has_now then 'now' when has_future_snoozed then 'snoozed' else 'completed' end as case_state,
      case when has_unacknowledged_p0 then 0 else 1 end as p0_rank,
      case when has_overdue then 0 else 1 end as overdue_rank,
      case when has_p0_priority then 'p0' when has_urgent_priority then 'urgent'
           when has_normal_priority then 'normal' else 'low' end as case_priority,
      array_remove(array[
        case when has_schedule then 'schedule' end,
        case when has_quote then 'quote' end,
        case when has_settlement then 'settlement' end,
        case when has_customer then 'customer' end,
        case when has_operations then 'operations' end
      ], null) as categories
    from grouped
  ), summary_values as (
    select
      count(*) filter (where case_state = 'now') as now_count,
      count(*) filter (where case_state = 'snoozed') as snoozed_count,
      count(*) filter (where case_state = 'completed') as completed_count,
      count(*) filter (where case_state = 'now' and p0_rank = 0) as p0_count,
      count(*) filter (where case_state in ('now','snoozed') and 'schedule' = any(categories)) as schedule_count,
      count(*) filter (where case_state in ('now','snoozed') and 'quote' = any(categories)) as quote_count,
      count(*) filter (where case_state in ('now','snoozed') and 'settlement' = any(categories)) as settlement_count,
      count(*) filter (where case_state in ('now','snoozed') and 'customer' = any(categories)) as customer_count,
      count(*) filter (where case_state in ('now','snoozed') and 'operations' = any(categories)) as operations_count
    from classified_cases
  ), selected_view as materialized (
    select * from classified_cases
    where case_state = p_view
      and (p_category is null or p_category = any(categories))
  ), remaining as materialized (
    select * from selected_view
    where p_after is null or (p0_rank, overdue_rank, priority_rank, received_at, id)
      > (v_after_p0_rank, v_after_overdue_rank, v_after_priority_rank, v_after_opened_at, v_after_id)
  ), bounded as materialized (
    select * from remaining
    order by p0_rank, overdue_rank, priority_rank, received_at, id
    limit p_limit
  ), remaining_count as (
    select count(*) as value from remaining
  ), last_bounded as (
    select * from bounded
    order by p0_rank desc, overdue_rank desc, priority_rank desc, received_at desc, id desc
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
    'cases', coalesce((select jsonb_agg(jsonb_build_object(
      'id', item.id::text,
      'state', item.case_state,
      'priority', item.case_priority,
      'title', work_orchestrator_private.owner_safe_case_title_v2(item.first_title),
      'ownerBrief', case
        when item.total_step_count = 1 then item.primary_work_label
        else item.primary_work_label || ' 외 ' || (item.total_step_count - 1)::text || '개 업무'
      end,
      'receivedAt', to_char(item.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt', to_char(item.updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'categories', to_jsonb(item.categories),
      'completedStepCount', item.completed_step_count,
      'totalStepCount', item.total_step_count,
      'steps', item.steps
    ) order by item.p0_rank, item.overdue_rank, item.priority_rank, item.received_at, item.id) from bounded as item), '[]'::jsonb),
    'nextCursor', case when remaining_count.value > p_limit then (
      select jsonb_build_object(
        'p0Rank', last_bounded.p0_rank,
        'overdueRank', last_bounded.overdue_rank,
        'priorityRank', last_bounded.priority_rank,
        'openedAt', to_char(last_bounded.received_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'id', last_bounded.id::text
      ) from last_bounded
    ) else null end,
    'omittedCount', greatest(remaining_count.value - p_limit, 0)
  ) into v_result
  from summary_values cross join remaining_count;

  return v_result;
end;
$$;

revoke execute on function work_orchestrator_private.owner_safe_case_title_v2(text)
  from public, anon, authenticated, service_role;
revoke execute on function work_orchestrator_private.owner_safe_task_label_v2(text,text)
  from public, anon, authenticated, service_role;
revoke execute on function public.list_heybilli_owner_cases_v2(timestamptz,text,text,integer,jsonb)
  from public, anon, authenticated, service_role;

grant execute on function work_orchestrator_private.owner_safe_case_title_v2(text) to service_role;
grant execute on function work_orchestrator_private.owner_safe_task_label_v2(text,text) to service_role;
grant execute on function public.list_heybilli_owner_cases_v2(timestamptz,text,text,integer,jsonb) to service_role;
