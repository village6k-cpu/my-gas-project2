create function work_orchestrator_private.is_owner_case_payload_v2(
  p_payload jsonb
) returns boolean language sql immutable security invoker set search_path = '' as $$
  select p_payload is not null
    and jsonb_typeof(p_payload) = 'object'
    and p_payload ?& array[
      'owner_case_key','owner_case_title','owner_request_summary','owner_problem_summary',
      'owner_next_action_summary','owner_task_key','owner_case_context_status'
    ]
    and jsonb_typeof(p_payload->'owner_case_key') = 'string'
    and jsonb_typeof(p_payload->'owner_case_title') = 'string'
    and jsonb_typeof(p_payload->'owner_request_summary') = 'string'
    and jsonb_typeof(p_payload->'owner_problem_summary') = 'string'
    and jsonb_typeof(p_payload->'owner_next_action_summary') = 'string'
    and jsonb_typeof(p_payload->'owner_task_key') = 'string'
    and jsonb_typeof(p_payload->'owner_case_context_status') = 'string'
    and length(p_payload->>'owner_case_key') between 1 and 160
    and btrim(p_payload->>'owner_case_key') = p_payload->>'owner_case_key'
    and length(p_payload->>'owner_case_title') between 1 and 120
    and btrim(p_payload->>'owner_case_title') = p_payload->>'owner_case_title'
    and length(p_payload->>'owner_request_summary') between 1 and 500
    and btrim(p_payload->>'owner_request_summary') = p_payload->>'owner_request_summary'
    and length(p_payload->>'owner_problem_summary') between 1 and 500
    and btrim(p_payload->>'owner_problem_summary') = p_payload->>'owner_problem_summary'
    and length(p_payload->>'owner_next_action_summary') between 1 and 500
    and btrim(p_payload->>'owner_next_action_summary') = p_payload->>'owner_next_action_summary'
    and length(p_payload->>'owner_task_key') between 1 and 160
    and btrim(p_payload->>'owner_task_key') = p_payload->>'owner_task_key'
    and p_payload->>'owner_case_context_status' in ('available','unavailable')
    and (p_payload->>'owner_case_title') !~* '(오류|실패|충돌|timeout|error|exception|automation|confirmation_request|rq-[0-9]|01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4})'
    and (p_payload->>'owner_request_summary') !~* '(timeout|error|exception|automation|confirmation_request|rq-[0-9]|01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4})'
    and (p_payload->>'owner_problem_summary') !~* '(timeout|error|exception|automation|confirmation_request|rq-[0-9]|01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4})'
    and (p_payload->>'owner_next_action_summary') !~* '(timeout|error|exception|automation|confirmation_request|rq-[0-9]|01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4})';
$$;

create or replace function public.upsert_work_item_v2(
  p_candidate jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_work_type text;
  v_payload jsonb;
  v_owner_payload jsonb := '{}'::jsonb;
  v_validated_candidate jsonb;
  v_result jsonb;
  v_row public.work_items_v2%rowtype;
begin
  if p_candidate is null or jsonb_typeof(p_candidate) <> 'object'
    or jsonb_typeof(p_candidate->'payload') <> 'object' then
    raise exception 'invalid work item candidate' using errcode = '22023';
  end if;
  v_payload := p_candidate->'payload';
  if v_payload ?| array[
    'owner_case_key','owner_case_title','owner_request_summary','owner_problem_summary',
    'owner_next_action_summary','owner_task_key','owner_case_context_status'
  ] then
    if not work_orchestrator_private.is_owner_case_payload_v2(v_payload) then
      raise exception 'invalid work item candidate' using errcode = '22023';
    end if;
    v_owner_payload := jsonb_build_object(
      'owner_case_key', v_payload->>'owner_case_key',
      'owner_case_title', v_payload->>'owner_case_title',
      'owner_request_summary', v_payload->>'owner_request_summary',
      'owner_problem_summary', v_payload->>'owner_problem_summary',
      'owner_next_action_summary', v_payload->>'owner_next_action_summary',
      'owner_task_key', v_payload->>'owner_task_key',
      'owner_case_context_status', v_payload->>'owner_case_context_status'
    );
    p_candidate := jsonb_set(p_candidate, '{payload}', v_payload - array[
      'owner_case_key','owner_case_title','owner_request_summary','owner_problem_summary',
      'owner_next_action_summary','owner_task_key','owner_case_context_status'
    ]::text[], false);
  end if;

  v_work_type := case when jsonb_typeof(p_candidate->'work_type') = 'string'
    then p_candidate->>'work_type' else null end;
  if v_work_type in ('schedule_register','schedule_change') then
    v_validated_candidate := jsonb_set(p_candidate, '{work_type}', to_jsonb('schedule_check'::text), false);
  else
    v_validated_candidate := p_candidate;
  end if;
  v_result := work_orchestrator_private.upsert_work_item_v2(v_validated_candidate);
  if v_work_type in ('schedule_register','schedule_change')
    and v_result->'applied' = 'true'::jsonb and v_result->'created' = 'true'::jsonb then
    update public.work_items_v2 set work_type = v_work_type
    where id = (v_result->'row'->>'id')::uuid and work_type = 'schedule_check'
    returning * into v_row;
    if not found then raise exception 'work item type promotion failed' using errcode = '40001'; end if;
    v_result := jsonb_set(v_result, '{row}', to_jsonb(v_row), false);
  end if;
  if v_owner_payload <> '{}'::jsonb and v_result->'applied' = 'true'::jsonb then
    update public.work_items_v2
    set payload = payload || v_owner_payload
    where id = (v_result->'row'->>'id')::uuid
    returning * into v_row;
    if not found then raise exception 'work item owner metadata update failed' using errcode = '40001'; end if;
    v_result := jsonb_set(v_result, '{row}', to_jsonb(v_row), false);
  end if;
  return v_result;
end;
$$;

create function public.list_heybilli_owner_case_context_v2(
  p_room_key text,
  p_limit integer
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare v_result jsonb;
begin
  if p_room_key is null or btrim(p_room_key) = '' or p_room_key <> btrim(p_room_key)
    or length(p_room_key) > 500 or p_limit is null or p_limit not between 1 and 20 then
    raise exception 'invalid owner case context query' using errcode = '22023';
  end if;
  with valid_rows as materialized (
    select w.*, public.owner_work_taxonomy_v2(w.work_type) as taxonomy
    from public.work_items_v2 as w
    where w.room_key = p_room_key
      and w.state in ('open','in_progress','snoozed')
      and jsonb_typeof(w.payload->'requires_human_action') = 'boolean'
      and (w.payload->>'requires_human_action')::boolean is true
      and public.owner_work_taxonomy_v2(w.work_type) is not null
      and work_orchestrator_private.is_owner_case_payload_v2(w.payload)
  ), bounded_cases as materialized (
    select owner_case_key, min(first_opened_at) as opened_at
    from (select payload->>'owner_case_key' as owner_case_key, first_opened_at from valid_rows) as source
    group by owner_case_key order by min(first_opened_at), owner_case_key limit p_limit
  ), latest_case as materialized (
    select distinct on (v.payload->>'owner_case_key')
      v.payload->>'owner_case_key' as owner_case_key, v.payload, v.updated_at
    from valid_rows as v join bounded_cases as b on b.owner_case_key = v.payload->>'owner_case_key'
    order by v.payload->>'owner_case_key', v.updated_at desc, v.id desc
  ), tasks as materialized (
    select v.payload->>'owner_case_key' as owner_case_key,
      v.payload->>'owner_task_key' as task_key,
      (array_agg(work_orchestrator_private.owner_safe_task_label_v2(v.title, v.taxonomy->>'workTypeLabel') order by v.updated_at desc, v.id desc))[1] as task_label
    from valid_rows as v join bounded_cases as b on b.owner_case_key = v.payload->>'owner_case_key'
    group by v.payload->>'owner_case_key', v.payload->>'owner_task_key'
  )
  select jsonb_build_object('status','available','cases',coalesce(jsonb_agg(jsonb_build_object(
    'caseKey', latest.owner_case_key,
    'title', latest.payload->>'owner_case_title',
    'requestSummary', latest.payload->>'owner_request_summary',
    'problemSummary', latest.payload->>'owner_problem_summary',
    'nextActionSummary', latest.payload->>'owner_next_action_summary',
    'tasks', coalesce((select jsonb_agg(jsonb_build_object('taskKey',t.task_key,'taskLabel',t.task_label) order by t.task_key) from tasks as t where t.owner_case_key=latest.owner_case_key),'[]'::jsonb)
  ) order by bounded.opened_at, latest.owner_case_key),'[]'::jsonb)) into v_result
  from bounded_cases as bounded join latest_case as latest on latest.owner_case_key=bounded.owner_case_key;
  return v_result;
end;
$$;

revoke execute on function work_orchestrator_private.is_owner_case_payload_v2(jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.list_heybilli_owner_case_context_v2(text,integer) from public, anon, authenticated, service_role;
grant execute on function public.list_heybilli_owner_case_context_v2(text,integer) to service_role;

create or replace function public.list_heybilli_owner_cases_v2(
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
      or jsonb_typeof(p_after->'p0Rank') <> 'number' or (p_after->>'p0Rank') !~ '^[01]$'
      or jsonb_typeof(p_after->'overdueRank') <> 'number' or (p_after->>'overdueRank') !~ '^[01]$'
      or jsonb_typeof(p_after->'priorityRank') <> 'number' or (p_after->>'priorityRank') !~ '^[0-3]$'
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
      or to_char(v_after_opened_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') <> p_after->>'openedAt'
      or v_after_id::text <> p_after->>'id' then
      raise exception 'invalid Heybilli owner case query' using errcode = '22023';
    end if;
  end if;

  with eligible as materialized (
    select w.id,w.title,w.work_type,w.priority,w.state,w.due_at,w.snoozed_until,
      w.first_opened_at,w.updated_at,w.version,w.payload,
      coalesce(nullif(btrim(w.room_key),''),w.id::text) as room_partition,
      case when work_orchestrator_private.is_owner_case_payload_v2(w.payload)
        then w.payload->>'owner_case_key' else w.id::text end as case_partition,
      case when work_orchestrator_private.is_owner_case_payload_v2(w.payload)
        then w.payload->>'owner_task_key' else w.id::text end as task_partition,
      public.owner_work_taxonomy_v2(w.work_type) as taxonomy,
      (w.state in ('open','in_progress') or (w.state='snoozed' and w.snoozed_until<=p_now)) as is_now,
      (w.state='snoozed' and w.snoozed_until>p_now) as is_future_snoozed,
      (w.state in ('resolved','dismissed')) as is_completed,
      work_orchestrator_private.is_owner_case_payload_v2(w.payload) as has_owner_case
    from public.work_items_v2 as w
    where jsonb_typeof(w.payload->'requires_human_action')='boolean'
      and (w.payload->>'requires_human_action')::boolean is true
      and public.owner_work_taxonomy_v2(w.work_type) is not null
      and length(w.title) between 1 and 300
      and isfinite(w.actionable_at) and isfinite(w.first_opened_at) and isfinite(w.last_activity_at)
      and isfinite(w.created_at) and isfinite(w.updated_at)
      and (w.due_at is null or isfinite(w.due_at))
      and (w.snoozed_until is null or isfinite(w.snoozed_until))
  ), deduped as materialized (
    select * from (
      select eligible.*, row_number() over (partition by room_partition,case_partition,task_partition order by updated_at desc,id desc) as task_rank
      from eligible
    ) ranked where task_rank=1
  ), grouped as materialized (
    select
      (array_agg(id order by first_opened_at,id))[1] as id,
      min(first_opened_at) as received_at,
      max(updated_at) as updated_at,
      (array_agg(title order by updated_at desc,id desc))[1] as latest_title,
      (array_agg(taxonomy->>'workTypeLabel' order by first_opened_at,id))[1] as primary_work_label,
      (array_agg(payload->>'owner_case_title' order by updated_at desc,id desc) filter (where has_owner_case))[1] as owner_title,
      (array_agg(payload->>'owner_request_summary' order by updated_at desc,id desc) filter (where has_owner_case))[1] as request_summary,
      (array_agg(payload->>'owner_problem_summary' order by updated_at desc,id desc) filter (where has_owner_case))[1] as problem_summary,
      (array_agg(payload->>'owner_next_action_summary' order by updated_at desc,id desc) filter (where has_owner_case))[1] as next_action_summary,
      bool_or(is_now) as has_now,bool_or(is_future_snoozed) as has_future_snoozed,bool_and(is_completed) as all_completed,
      bool_or(is_now and priority='p0' and not public.is_effective_p0_ack_v2(payload,p_now)) as has_unacknowledged_p0,
      bool_or(is_now and due_at is not null and due_at<p_now) as has_overdue,
      bool_or(not is_completed and priority='p0') as has_p0_priority,
      bool_or(not is_completed and priority='urgent') as has_urgent_priority,
      bool_or(not is_completed and priority='normal') as has_normal_priority,
      min(case when not is_completed then case priority when 'urgent' then 0 when 'p0' then 1 when 'normal' then 2 else 3 end else 3 end) as priority_rank,
      bool_or((taxonomy->>'category')='schedule') as has_schedule,
      bool_or((taxonomy->>'category')='quote') as has_quote,
      bool_or((taxonomy->>'category')='settlement') as has_settlement,
      bool_or((taxonomy->>'category')='customer') as has_customer,
      bool_or((taxonomy->>'category')='operations') as has_operations,
      count(*) filter (where is_completed)::integer as completed_step_count,count(*)::integer as total_step_count,
      jsonb_agg(jsonb_build_object(
        'id',id::text,'version',version,'category',taxonomy->>'category','workTypeLabel',taxonomy->>'workTypeLabel',
        'priority',priority,'state',state,
        'taskLabel',work_orchestrator_private.owner_safe_task_label_v2(title,taxonomy->>'workTypeLabel'),
        'dueAt',case when due_at is null then null else to_char(due_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'snoozedUntil',case when snoozed_until is null then null else to_char(snoozed_until at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
        'updatedAt',to_char(updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      ) order by first_opened_at,id) as steps
    from deduped group by room_partition,case_partition
  ), classified_cases as materialized (
    select grouped.*,
      case when has_now then 'now' when has_future_snoozed then 'snoozed' else 'completed' end as case_state,
      case when has_unacknowledged_p0 then 0 else 1 end as p0_rank,
      case when has_overdue then 0 else 1 end as overdue_rank,
      case when has_p0_priority then 'p0' when has_urgent_priority then 'urgent' when has_normal_priority then 'normal' else 'low' end as case_priority,
      array_remove(array[case when has_schedule then 'schedule' end,case when has_quote then 'quote' end,
        case when has_settlement then 'settlement' end,case when has_customer then 'customer' end,
        case when has_operations then 'operations' end],null) as categories
    from grouped
  ), summary_values as (
    select count(*) filter(where case_state='now') as now_count,
      count(*) filter(where case_state='snoozed') as snoozed_count,
      count(*) filter(where case_state='completed') as completed_count,
      count(*) filter(where case_state='now' and p0_rank=0) as p0_count,
      count(*) filter(where case_state in ('now','snoozed') and 'schedule'=any(categories)) as schedule_count,
      count(*) filter(where case_state in ('now','snoozed') and 'quote'=any(categories)) as quote_count,
      count(*) filter(where case_state in ('now','snoozed') and 'settlement'=any(categories)) as settlement_count,
      count(*) filter(where case_state in ('now','snoozed') and 'customer'=any(categories)) as customer_count,
      count(*) filter(where case_state in ('now','snoozed') and 'operations'=any(categories)) as operations_count
    from classified_cases
  ), selected_view as materialized (
    select * from classified_cases where case_state=p_view and (p_category is null or p_category=any(categories))
  ), remaining as materialized (
    select * from selected_view where p_after is null or (p0_rank,overdue_rank,priority_rank,received_at,id)>
      (v_after_p0_rank,v_after_overdue_rank,v_after_priority_rank,v_after_opened_at,v_after_id)
  ), bounded as materialized (
    select * from remaining order by p0_rank,overdue_rank,priority_rank,received_at,id limit p_limit
  ), remaining_count as (select count(*) as value from remaining),
  last_bounded as (select * from bounded order by p0_rank desc,overdue_rank desc,priority_rank desc,received_at desc,id desc limit 1)
  select jsonb_build_object(
    'summary',jsonb_build_object('now',summary_values.now_count,'snoozed',summary_values.snoozed_count,
      'completed',summary_values.completed_count,'p0',summary_values.p0_count,'byCategory',jsonb_build_object(
        'schedule',summary_values.schedule_count,'quote',summary_values.quote_count,'settlement',summary_values.settlement_count,
        'customer',summary_values.customer_count,'operations',summary_values.operations_count)),
    'cases',coalesce((select jsonb_agg(jsonb_build_object(
      'id',item.id::text,'state',item.case_state,'priority',item.case_priority,
      'title',coalesce(item.owner_title,work_orchestrator_private.owner_safe_case_title_v2(item.latest_title)),
      'ownerBrief',coalesce(item.next_action_summary,item.primary_work_label),
      'requestSummary',coalesce(item.request_summary,'요청 내용을 확인하세요.'),
      'problemSummary',coalesce(item.problem_summary,'현재 확인이 필요한 문의입니다.'),
      'nextActionSummary',coalesce(item.next_action_summary,item.primary_work_label),
      'receivedAt',to_char(item.received_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt',to_char(item.updated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'categories',to_jsonb(item.categories),'completedStepCount',item.completed_step_count,
      'totalStepCount',item.total_step_count,'steps',item.steps
    ) order by item.p0_rank,item.overdue_rank,item.priority_rank,item.received_at,item.id) from bounded item),'[]'::jsonb),
    'nextCursor',case when remaining_count.value>p_limit then (select jsonb_build_object(
      'p0Rank',last_bounded.p0_rank,'overdueRank',last_bounded.overdue_rank,'priorityRank',last_bounded.priority_rank,
      'openedAt',to_char(last_bounded.received_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'id',last_bounded.id::text
    ) from last_bounded) else null end,
    'omittedCount',greatest(remaining_count.value-p_limit,0)
  ) into v_result from summary_values cross join remaining_count;
  return v_result;
end;
$$;

create function public.reconcile_heybilli_owner_cases_v2(
  p_assignments jsonb,
  p_apply boolean default false
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_assignment jsonb;
  v_id uuid;
  v_expected_version integer;
  v_owner_payload jsonb;
  v_row public.work_items_v2%rowtype;
  v_planned integer;
  v_updated integer := 0;
  v_stale integer := 0;
  v_rows jsonb := '[]'::jsonb;
begin
  if p_apply is null or p_assignments is null or jsonb_typeof(p_assignments) <> 'array' then
    raise exception 'invalid owner case reconciliation' using errcode = '22023';
  end if;
  v_planned := jsonb_array_length(p_assignments);
  if v_planned not between 1 and 100 then
    raise exception 'invalid owner case reconciliation' using errcode = '22023';
  end if;

  for v_assignment in select value from jsonb_array_elements(p_assignments) loop
    if jsonb_typeof(v_assignment) <> 'object'
      or not (v_assignment ?& array['id','expectedVersion','caseKey','title','requestSummary','problemSummary','nextActionSummary','taskKey'])
      or (v_assignment - array['id','expectedVersion','caseKey','title','requestSummary','problemSummary','nextActionSummary','taskKey']::text[]) <> '{}'::jsonb
      or jsonb_typeof(v_assignment->'id') <> 'string'
      or jsonb_typeof(v_assignment->'expectedVersion') <> 'number'
      or jsonb_typeof(v_assignment->'caseKey') <> 'string'
      or jsonb_typeof(v_assignment->'title') <> 'string'
      or jsonb_typeof(v_assignment->'requestSummary') <> 'string'
      or jsonb_typeof(v_assignment->'problemSummary') <> 'string'
      or jsonb_typeof(v_assignment->'nextActionSummary') <> 'string'
      or jsonb_typeof(v_assignment->'taskKey') <> 'string' then
      raise exception 'invalid owner case reconciliation' using errcode = '22023';
    end if;
    begin
      v_id := (v_assignment->>'id')::uuid;
      v_expected_version := (v_assignment->>'expectedVersion')::integer;
    exception when others then
      raise exception 'invalid owner case reconciliation' using errcode = '22023';
    end;
    if v_id::text <> v_assignment->>'id'
      or v_expected_version < 1
      or to_jsonb(v_expected_version) <> v_assignment->'expectedVersion' then
      raise exception 'invalid owner case reconciliation' using errcode = '22023';
    end if;
    v_owner_payload := jsonb_build_object(
      'owner_case_key',v_assignment->>'caseKey',
      'owner_case_title',v_assignment->>'title',
      'owner_request_summary',v_assignment->>'requestSummary',
      'owner_problem_summary',v_assignment->>'problemSummary',
      'owner_next_action_summary',v_assignment->>'nextActionSummary',
      'owner_task_key',v_assignment->>'taskKey',
      'owner_case_context_status','available'
    );
    if not work_orchestrator_private.is_owner_case_payload_v2(v_owner_payload) then
      raise exception 'invalid owner case reconciliation' using errcode = '22023';
    end if;
  end loop;
  if exists (
    select 1 from jsonb_array_elements(p_assignments) as item
    group by item->>'id' having count(*) > 1
  ) or exists (
    select item->>'caseKey'
    from jsonb_array_elements(p_assignments) as item
    join public.work_items_v2 as work
      on work.id=(item->>'id')::uuid and work.version=(item->>'expectedVersion')::integer
    group by item->>'caseKey'
    having count(distinct work.room_key) > 1
  ) then
    raise exception 'invalid owner case reconciliation' using errcode = '22023';
  end if;

  for v_assignment in
    select value from jsonb_array_elements(p_assignments) order by value->>'id'
  loop
    v_id := (v_assignment->>'id')::uuid;
    v_expected_version := (v_assignment->>'expectedVersion')::integer;
    v_owner_payload := jsonb_build_object(
      'owner_case_key',v_assignment->>'caseKey',
      'owner_case_title',v_assignment->>'title',
      'owner_request_summary',v_assignment->>'requestSummary',
      'owner_problem_summary',v_assignment->>'problemSummary',
      'owner_next_action_summary',v_assignment->>'nextActionSummary',
      'owner_task_key',v_assignment->>'taskKey',
      'owner_case_context_status','available'
    );
    if not p_apply then
      if not exists (
        select 1 from public.work_items_v2
        where id=v_id and version=v_expected_version
          and state in ('open','in_progress','snoozed') and pending_action='{}'::jsonb
      ) then v_stale := v_stale + 1; end if;
      continue;
    end if;
    update public.work_items_v2
    set payload=payload || v_owner_payload, version=version+1, updated_at=clock_timestamp()
    where id=v_id and version=v_expected_version
      and state in ('open','in_progress','snoozed') and pending_action='{}'::jsonb
    returning * into v_row;
    if not found then
      v_stale := v_stale + 1;
    else
      v_updated := v_updated + 1;
      v_rows := v_rows || jsonb_build_array(jsonb_build_object(
        'id',v_row.id::text,'version',v_row.version,
        'caseKey',v_assignment->>'caseKey','taskKey',v_assignment->>'taskKey'
      ));
    end if;
  end loop;
  return jsonb_build_object(
    'applied',p_apply,'planned',v_planned,'updated',v_updated,'stale',v_stale,'rows',v_rows
  );
end;
$$;

revoke execute on function public.upsert_work_item_v2(jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.list_heybilli_owner_cases_v2(timestamptz,text,text,integer,jsonb) from public, anon, authenticated, service_role;
revoke execute on function public.reconcile_heybilli_owner_cases_v2(jsonb,boolean) from public, anon, authenticated, service_role;
grant execute on function public.upsert_work_item_v2(jsonb) to service_role;
grant execute on function public.list_heybilli_owner_cases_v2(timestamptz,text,text,integer,jsonb) to service_role;
grant execute on function public.reconcile_heybilli_owner_cases_v2(jsonb,boolean) to service_role;
