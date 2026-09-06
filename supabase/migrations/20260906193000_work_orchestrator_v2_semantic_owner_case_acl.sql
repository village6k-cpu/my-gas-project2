revoke execute on function work_orchestrator_private.is_owner_case_payload_v2(jsonb)
  from public, anon, authenticated, service_role;
grant execute on function work_orchestrator_private.is_owner_case_payload_v2(jsonb)
  to service_role;
