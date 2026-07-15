begin;

create function village.resolve_inventory_audit_rental_group(
  p_session_id uuid,
  p_exception_ids uuid[],
  p_resolution text,
  p_equipment_id text,
  p_reviewer uuid,
  p_reviewer_email text
)
returns jsonb
language plpgsql
security definer
set search_path = village, public
as $$
declare
  v_session village.inventory_audit_sessions%rowtype;
  v_expected_count integer;
  v_resolved_count integer;
begin
  if p_session_id is null
     or p_reviewer is null
     or nullif(btrim(p_reviewer_email), '') is null then
    raise exception 'inventory audit rental reviewer identity is required'
      using errcode = '22023';
  end if;
  if p_resolution not in ('existing_equipment', 'not_inventory') then
    raise exception 'inventory audit rental resolution is invalid'
      using errcode = '22023';
  end if;
  if coalesce(cardinality(p_exception_ids), 0) = 0 then
    raise exception 'inventory audit rental exception ids are required'
      using errcode = '22023';
  end if;

  select count(distinct exception_id)
  into v_expected_count
  from unnest(p_exception_ids) as exception_id;

  select *
  into v_session
  from village.inventory_audit_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'inventory audit session not found' using errcode = 'P0002';
  end if;
  if v_session.status not in ('submitted', 'in_review') then
    raise exception 'inventory audit rental exceptions cannot be reviewed from status %', v_session.status
      using errcode = 'P0001';
  end if;

  perform 1
  from village.inventory_audit_snapshot_rental_exceptions
  where session_id = p_session_id
    and id = any(p_exception_ids)
  order by id
  for update;

  select count(*)
  into v_resolved_count
  from village.inventory_audit_snapshot_rental_exceptions
  where session_id = p_session_id
    and id = any(p_exception_ids);

  if v_resolved_count <> v_expected_count then
    raise exception 'one or more rental exceptions are outside the audit session'
      using errcode = '42501';
  end if;

  if p_resolution = 'existing_equipment' then
    if nullif(btrim(p_equipment_id), '') is null then
      raise exception 'existing equipment resolution requires equipment id'
        using errcode = '22023';
    end if;
    if not exists (
      select 1
      from village.inventory_audit_snapshot_items
      where session_id = p_session_id
        and equipment_id = btrim(p_equipment_id)
    ) then
      raise exception 'resolved equipment is outside the audit snapshot'
        using errcode = 'P0001';
    end if;
  elsif nullif(btrim(p_equipment_id), '') is not null then
    raise exception 'not inventory resolution cannot include equipment id'
      using errcode = '22023';
  end if;

  update village.inventory_audit_snapshot_rental_exceptions
  set resolution = p_resolution,
      resolved_equipment_id = case
        when p_resolution = 'existing_equipment' then btrim(p_equipment_id)
        else null
      end,
      reviewed_by = p_reviewer,
      reviewed_by_email = btrim(p_reviewer_email),
      reviewed_at = pg_catalog.clock_timestamp()
  where session_id = p_session_id
    and id = any(p_exception_ids);

  return jsonb_build_object(
    'session_id', p_session_id,
    'resolved_count', v_resolved_count,
    'resolution', p_resolution,
    'equipment_id', case
      when p_resolution = 'existing_equipment' then btrim(p_equipment_id)
      else null
    end
  );
end;
$$;

revoke execute on function village.resolve_inventory_audit_rental_group(uuid, uuid[], text, text, uuid, text)
  from public, anon, authenticated;
grant execute on function village.resolve_inventory_audit_rental_group(uuid, uuid[], text, text, uuid, text)
  to service_role;

create function village.save_inventory_audit_review(
  p_session_id uuid,
  p_reviewer uuid,
  p_reviewer_email text,
  p_decisions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = village, public
as $$
declare
  v_session village.inventory_audit_sessions%rowtype;
  v_snapshot_count integer;
  v_input_count integer;
  v_distinct_count integer;
begin
  if p_session_id is null
     or p_reviewer is null
     or nullif(btrim(p_reviewer_email), '') is null then
    raise exception 'inventory audit reviewer identity is required'
      using errcode = '22023';
  end if;
  if p_decisions is null or jsonb_typeof(p_decisions) <> 'array' then
    raise exception 'inventory audit decisions must be an array'
      using errcode = '22023';
  end if;

  select *
  into v_session
  from village.inventory_audit_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'inventory audit session not found' using errcode = 'P0002';
  end if;
  if v_session.status not in ('submitted', 'in_review') then
    raise exception 'inventory audit review cannot be saved from status %', v_session.status
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from village.inventory_audit_snapshot_rental_exceptions
    where session_id = p_session_id
      and resolution is null
  ) then
    raise exception 'unresolved rental exception blocks review'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from village.inventory_audit_observations
    where session_id = p_session_id
      and equipment_id is null
  ) then
    raise exception 'temporary observation requires owner resolution'
      using errcode = 'P0001';
  end if;

  select count(*)
  into v_snapshot_count
  from village.inventory_audit_snapshot_items
  where session_id = p_session_id;

  v_input_count := jsonb_array_length(p_decisions);
  with decision_input as (
    select input.equipment_id
    from jsonb_to_recordset(p_decisions) as input(equipment_id text)
  )
  select count(distinct decision_input.equipment_id)
  into v_distinct_count
  from decision_input;

  if v_input_count <> v_snapshot_count or v_distinct_count <> v_snapshot_count then
    raise exception 'inventory audit review must include each snapshot item exactly once'
      using errcode = '22023';
  end if;

  if exists (
    with decision_input as (
      select input.*
      from jsonb_to_recordset(p_decisions) as input(
        equipment_id text,
        decision text,
        final_stock_total integer,
        final_stock_maint integer,
        final_state text,
        final_open_issues jsonb,
        other_confirmed_offsite_qty integer,
        review_note text
      )
    )
    select 1
    from decision_input
    left join village.inventory_audit_snapshot_items as snapshot
      on snapshot.session_id = p_session_id
      and snapshot.equipment_id = decision_input.equipment_id
    where snapshot.equipment_id is null
      or decision_input.decision not in ('apply_audit', 'keep_ledger', 'recount')
      or coalesce(decision_input.other_confirmed_offsite_qty, 0) < 0
      or (
        decision_input.decision = 'apply_audit'
        and (
          decision_input.final_stock_total is null
          or decision_input.final_stock_maint is null
          or decision_input.final_stock_total < 0
          or decision_input.final_stock_maint < 0
          or decision_input.final_stock_maint > decision_input.final_stock_total
        )
      )
      or (
        decision_input.final_open_issues is not null
        and jsonb_typeof(decision_input.final_open_issues) <> 'array'
      )
  ) then
    raise exception 'inventory audit review contains an invalid decision'
      using errcode = '22023';
  end if;

  perform 1
  from village.equipment_ledger as ledger
  join village.inventory_audit_snapshot_items as snapshot
    on snapshot.equipment_id = ledger.equipment_id
  where snapshot.session_id = p_session_id
  order by ledger.equipment_id
  for update of ledger;

  delete from village.inventory_audit_decisions
  where session_id = p_session_id
    and equipment_id is not null;

  insert into village.inventory_audit_decisions (
    session_id,
    equipment_id,
    source_observation_id,
    decision,
    resolution,
    resolved_equipment_id,
    new_equipment_payload,
    final_stock_total,
    final_stock_maint,
    final_state,
    final_open_issues,
    other_confirmed_offsite_qty,
    review_note,
    reviewed_by,
    reviewed_by_email,
    reviewed_at,
    reviewed_ledger_updated_at
  )
  select
    p_session_id,
    decision_input.equipment_id,
    null,
    decision_input.decision,
    null,
    null,
    null,
    decision_input.final_stock_total,
    decision_input.final_stock_maint,
    decision_input.final_state,
    coalesce(decision_input.final_open_issues, '[]'::jsonb),
    coalesce(decision_input.other_confirmed_offsite_qty, 0),
    coalesce(decision_input.review_note, ''),
    p_reviewer,
    btrim(p_reviewer_email),
    pg_catalog.clock_timestamp(),
    ledger.updated_at
  from jsonb_to_recordset(p_decisions) as decision_input(
    equipment_id text,
    decision text,
    final_stock_total integer,
    final_stock_maint integer,
    final_state text,
    final_open_issues jsonb,
    other_confirmed_offsite_qty integer,
    review_note text
  )
  join village.equipment_ledger as ledger
    on ledger.equipment_id = decision_input.equipment_id
  order by decision_input.equipment_id;

  if not found then
    raise exception 'inventory audit review did not create decisions'
      using errcode = 'P0001';
  end if;

  update village.inventory_audit_sessions
  set status = 'in_review'
  where id = p_session_id;

  return jsonb_build_object(
    'session_id', p_session_id,
    'status', 'in_review',
    'decision_count', v_snapshot_count
  );
end;
$$;

revoke execute on function village.save_inventory_audit_review(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function village.save_inventory_audit_review(uuid, uuid, text, jsonb)
  to service_role;

commit;
