set lock_timeout = '5s';

create or replace function work_orchestrator_private.is_owner_case_payload_v2(
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
    and (p_payload->>'owner_case_title') !~* '(오류|실패|충돌|timeout|error|exception|automation|worker|payload|stack|trace|internal|bridge|gateway|confirmation_request|\mrq\M|rq[-/]|거래[[:space:]]*id|^네[.!]?$|01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4})'
    and (p_payload->>'owner_request_summary') !~* '(timeout|error|exception|automation|worker|payload|stack|trace|internal|bridge|gateway|confirmation_request|\mrq\M|rq[-/]|거래[[:space:]]*id|^네[.!]?$|01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4})'
    and (p_payload->>'owner_problem_summary') !~* '(timeout|error|exception|automation|worker|payload|stack|trace|internal|bridge|gateway|confirmation_request|\mrq\M|rq[-/]|거래[[:space:]]*id|^네[.!]?$|01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4})'
    and (p_payload->>'owner_next_action_summary') !~* '(timeout|error|exception|automation|worker|payload|stack|trace|internal|bridge|gateway|confirmation_request|\mrq\M|rq[-/]|거래[[:space:]]*id|^네[.!]?$|01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4})';
$$;

revoke execute on function work_orchestrator_private.is_owner_case_payload_v2(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function work_orchestrator_private.is_owner_case_payload_v2(jsonb) to service_role;
