create function public.complete_heybilli_work_item_v2(
  p_id uuid,
  p_expected_version integer,
  p_completed_by text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.work_items_v2%rowtype;
  v_completed_at timestamptz;
begin
  if p_id is null
    or p_expected_version is null
    or p_expected_version < 1
    or p_completed_by is null
    or p_completed_by !~ '^heybilli:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or not public.is_valid_work_actor_v2(p_completed_by) then
    raise exception 'invalid Heybilli completion' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('work-action:' || p_id::text || ':' || p_expected_version::text, 91420260830)
  );
  v_completed_at := clock_timestamp();

  update public.work_items_v2
  set state = 'resolved',
      snoozed_until = null,
      resolution_kind = 'owner_completed',
      resolution_evidence = '{}'::jsonb,
      resolved_at = v_completed_at,
      resolved_by = p_completed_by,
      pending_action = '{}'::jsonb,
      version = version + 1,
      updated_at = v_completed_at
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
          select 1
          from public.digest_message_parts as stored_part
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

  return jsonb_build_object(
    'applied', found,
    'row', case when found then to_jsonb(v_row) else null end
  );
end;
$$;

revoke execute on function public.complete_heybilli_work_item_v2(uuid,integer,text)
  from public, anon, authenticated, service_role;
grant execute on function public.complete_heybilli_work_item_v2(uuid,integer,text)
  to service_role;
