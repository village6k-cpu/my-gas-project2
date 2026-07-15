begin;

create table village.inventory_audit_item_approvals (
  session_id uuid not null,
  equipment_id text not null,
  decision text not null,
  final_stock_total integer,
  final_stock_maint integer not null,
  final_state text not null,
  final_open_issues jsonb not null default '[]'::jsonb,
  source_observation_ids jsonb not null default '[]'::jsonb,
  ledger_before jsonb not null,
  ledger_after jsonb not null,
  approved_by uuid not null,
  approved_by_email text not null,
  approved_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, equipment_id),
  foreign key (session_id, equipment_id)
    references village.inventory_audit_snapshot_items(session_id, equipment_id)
    on delete restrict,
  constraint inventory_audit_item_approvals_decision_check
    check (decision in ('apply_audit', 'keep_ledger')),
  constraint inventory_audit_item_approvals_counts_check
    check (
      (final_stock_total is null or final_stock_total >= 0)
      and final_stock_maint >= 0
      and (final_stock_total is null or final_stock_maint <= final_stock_total)
    ),
  constraint inventory_audit_item_approvals_issues_array
    check (jsonb_typeof(final_open_issues) = 'array'),
  constraint inventory_audit_item_approvals_observations_array
    check (jsonb_typeof(source_observation_ids) = 'array'),
  constraint inventory_audit_item_approvals_ledger_objects
    check (jsonb_typeof(ledger_before) = 'object' and jsonb_typeof(ledger_after) = 'object'),
  constraint inventory_audit_item_approvals_email_check
    check (nullif(btrim(approved_by_email), '') is not null)
);

create trigger inventory_audit_item_approvals_touch_updated_at
before update on village.inventory_audit_item_approvals
for each row execute function village.touch_updated_at();

alter table village.inventory_audit_item_approvals enable row level security;
revoke all on village.inventory_audit_item_approvals from public;
revoke all on village.inventory_audit_item_approvals from anon, authenticated;
grant all on village.inventory_audit_item_approvals to service_role;

create function village.protect_approved_inventory_audit_observation()
returns trigger
language plpgsql
security definer
set search_path = village, public
as $$
begin
  if tg_op in ('UPDATE', 'DELETE')
     and old.equipment_id is not null
     and exists (
       select 1
       from village.inventory_audit_item_approvals as approval
       where approval.session_id = old.session_id
         and approval.equipment_id = old.equipment_id
     ) then
    raise exception 'inventory audit item is already owner-approved'
      using errcode = 'P0001';
  end if;

  if tg_op in ('INSERT', 'UPDATE')
     and new.equipment_id is not null
     and exists (
       select 1
       from village.inventory_audit_item_approvals as approval
       where approval.session_id = new.session_id
         and approval.equipment_id = new.equipment_id
     ) then
    raise exception 'inventory audit item is already owner-approved'
      using errcode = 'P0001';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger inventory_audit_observations_protect_approved
before insert or update or delete on village.inventory_audit_observations
for each row execute function village.protect_approved_inventory_audit_observation();

create function village.approve_inventory_audit_items(
  p_session_id uuid,
  p_approved_by uuid,
  p_approved_by_email text,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = village, public
as $$
declare
  v_session village.inventory_audit_sessions%rowtype;
  v_snapshot village.inventory_audit_snapshot_items%rowtype;
  v_ledger village.equipment_ledger%rowtype;
  v_input record;
  v_input_count integer;
  v_distinct_count integer;
  v_approved_count integer := 0;
  v_remaining_count integer;
  v_before jsonb;
  v_after jsonb;
  v_source_observation_ids jsonb;
  v_observed_at timestamptz;
  v_observed_by_email text;
  v_verify_status text;
  v_approved_at timestamptz := pg_catalog.clock_timestamp();
begin
  if p_session_id is null
     or p_approved_by is null
     or nullif(btrim(p_approved_by_email), '') is null then
    raise exception 'inventory audit checkpoint approver identity is required'
      using errcode = '22023';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array'
     or jsonb_array_length(p_items) = 0 then
    raise exception 'inventory audit checkpoint items are required'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('village.inventory_audit.full_shop', 0)
  );

  select *
  into v_session
  from village.inventory_audit_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'inventory audit session not found' using errcode = 'P0002';
  end if;
  if v_session.status <> 'draft' then
    raise exception 'inventory audit checkpoint requires an active draft'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from village.inventory_audit_snapshot_rental_exceptions
    where session_id = p_session_id
      and resolution is null
  ) then
    raise exception 'unresolved rental exception blocks checkpoint approval'
      using errcode = 'P0001';
  end if;

  v_input_count := jsonb_array_length(p_items);
  with item_input as (
    select input.equipment_id
    from jsonb_to_recordset(p_items) as input(equipment_id text)
  )
  select count(distinct item_input.equipment_id)
  into v_distinct_count
  from item_input;

  if v_input_count <> v_distinct_count then
    raise exception 'inventory audit checkpoint contains duplicate equipment'
      using errcode = '22023';
  end if;

  if exists (
    with item_input as (
      select input.*
      from jsonb_to_recordset(p_items) as input(
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
    from item_input
    left join village.inventory_audit_snapshot_items as snapshot
      on snapshot.session_id = p_session_id
      and snapshot.equipment_id = item_input.equipment_id
    where snapshot.equipment_id is null
       or item_input.decision not in ('apply_audit', 'keep_ledger')
       or coalesce(item_input.other_confirmed_offsite_qty, 0) < 0
       or (
         item_input.decision = 'apply_audit'
         and (
           item_input.final_stock_total is null
           or item_input.final_stock_total < 0
           or item_input.final_stock_maint is null
           or item_input.final_stock_maint < 0
           or item_input.final_stock_maint > item_input.final_stock_total
         )
       )
       or (
         item_input.final_open_issues is not null
         and jsonb_typeof(item_input.final_open_issues) <> 'array'
       )
  ) then
    raise exception 'inventory audit checkpoint contains an invalid item decision'
      using errcode = '22023';
  end if;

  if exists (
    with item_input as (
      select input.equipment_id
      from jsonb_to_recordset(p_items) as input(equipment_id text)
    )
    select 1
    from item_input
    join village.inventory_audit_item_approvals as approval
      on approval.session_id = p_session_id
      and approval.equipment_id = item_input.equipment_id
  ) then
    raise exception 'inventory audit checkpoint item is already approved'
      using errcode = 'P0001';
  end if;

  if exists (
    with item_input as (
      select input.equipment_id
      from jsonb_to_recordset(p_items) as input(equipment_id text)
    )
    select 1
    from item_input
    where not exists (
      select 1
      from village.inventory_audit_observations as observation
      where observation.session_id = p_session_id
        and observation.equipment_id = item_input.equipment_id
    )
  ) then
    raise exception 'inventory audit checkpoint requires a counted observation'
      using errcode = 'P0001';
  end if;

  perform 1
  from village.inventory_audit_observations as observation
  where observation.session_id = p_session_id
    and observation.equipment_id in (
      select input.equipment_id
      from jsonb_to_recordset(p_items) as input(equipment_id text)
    )
  order by observation.id
  for update;

  if exists (
    select 1
    from village.inventory_audit_observations as observation
    cross join lateral jsonb_array_elements(observation.evidence_refs) as evidence(ref)
    where observation.session_id = p_session_id
      and observation.equipment_id in (
        select input.equipment_id
        from jsonb_to_recordset(p_items) as input(equipment_id text)
      )
      and coalesce(evidence.ref ->> 'status', 'pending') not in ('uploaded', 'aborted')
  ) then
    raise exception 'pending evidence blocks checkpoint approval'
      using errcode = 'P0001';
  end if;

  perform 1
  from village.equipment_ledger as ledger
  where ledger.equipment_id in (
    select input.equipment_id
    from jsonb_to_recordset(p_items) as input(equipment_id text)
  )
  order by ledger.equipment_id
  for update;

  for v_input in
    select input.*
    from jsonb_to_recordset(p_items) as input(
      equipment_id text,
      decision text,
      final_stock_total integer,
      final_stock_maint integer,
      final_state text,
      final_open_issues jsonb,
      other_confirmed_offsite_qty integer,
      review_note text
    )
    order by input.equipment_id
  loop
    select *
    into strict v_snapshot
    from village.inventory_audit_snapshot_items
    where session_id = p_session_id
      and equipment_id = v_input.equipment_id;

    select *
    into strict v_ledger
    from village.equipment_ledger
    where equipment_id = v_input.equipment_id;

    if v_snapshot.ledger_updated_at is distinct from v_ledger.updated_at then
      raise exception 'ledger version conflict for equipment %', v_input.equipment_id
        using errcode = '40001';
    end if;

    select
      jsonb_agg(observation.id order by observation.client_updated_at, observation.id),
      max(observation.client_updated_at),
      (array_agg(observation.observed_by_email order by observation.client_updated_at desc, observation.id desc))[1]
    into v_source_observation_ids, v_observed_at, v_observed_by_email
    from village.inventory_audit_observations as observation
    where observation.session_id = p_session_id
      and observation.equipment_id = v_input.equipment_id;

    v_before := jsonb_build_object(
      'stock_total', v_ledger.stock_total,
      'stock_maint', v_ledger.stock_maint,
      'state', v_ledger.state,
      'open_issues', v_ledger.open_issues,
      'updated_at', v_ledger.updated_at
    );

    if v_input.decision = 'apply_audit' then
      v_verify_status := case
        when jsonb_array_length(coalesce(v_input.final_open_issues, '[]'::jsonb)) > 0
          or v_input.final_stock_maint > 0
          or coalesce(nullif(btrim(v_input.final_state), ''), v_ledger.state) <> '정상'
        then 'attention'
        else 'verified'
      end;

      update village.equipment_ledger
      set stock_total = v_input.final_stock_total,
          stock_maint = v_input.final_stock_maint,
          state = coalesce(nullif(btrim(v_input.final_state), ''), state),
          open_issues = coalesce(v_input.final_open_issues, '[]'::jsonb),
          verify_status = v_verify_status,
          last_verified_at = v_observed_at,
          last_verified_by = v_observed_by_email
      where equipment_id = v_input.equipment_id
      returning * into v_ledger;
    end if;

    v_after := jsonb_build_object(
      'stock_total', v_ledger.stock_total,
      'stock_maint', v_ledger.stock_maint,
      'state', v_ledger.state,
      'open_issues', v_ledger.open_issues,
      'updated_at', v_ledger.updated_at
    );

    insert into village.equipment_events (equipment_id, type, payload, actor)
    values (
      v_input.equipment_id,
      'inventory_audit_item_approved',
      jsonb_build_object(
        'audit_session_id', p_session_id,
        'decision', v_input.decision,
        'source_observation_ids', v_source_observation_ids,
        'other_confirmed_offsite_qty', coalesce(v_input.other_confirmed_offsite_qty, 0),
        'review_note', coalesce(v_input.review_note, ''),
        'before', v_before,
        'after', v_after,
        'approved_by', jsonb_build_object(
          'id', p_approved_by,
          'email', btrim(p_approved_by_email)
        ),
        'approved_at', v_approved_at
      ),
      btrim(p_approved_by_email)
    );

    insert into village.inventory_audit_item_approvals (
      session_id,
      equipment_id,
      decision,
      final_stock_total,
      final_stock_maint,
      final_state,
      final_open_issues,
      source_observation_ids,
      ledger_before,
      ledger_after,
      approved_by,
      approved_by_email,
      approved_at
    ) values (
      p_session_id,
      v_input.equipment_id,
      v_input.decision,
      v_ledger.stock_total,
      v_ledger.stock_maint,
      v_ledger.state,
      v_ledger.open_issues,
      v_source_observation_ids,
      v_before,
      v_after,
      p_approved_by,
      btrim(p_approved_by_email),
      v_approved_at
    );

    update village.inventory_audit_snapshot_items
    set ledger_stock_total = v_ledger.stock_total,
        ledger_stock_maint = v_ledger.stock_maint,
        ledger_state = v_ledger.state,
        ledger_open_issues = v_ledger.open_issues,
        ledger_updated_at = v_ledger.updated_at
    where session_id = p_session_id
      and equipment_id = v_input.equipment_id;

    v_approved_count := v_approved_count + 1;
  end loop;

  select count(*)::integer
  into v_remaining_count
  from village.inventory_audit_snapshot_items as snapshot
  where snapshot.session_id = p_session_id
    and not exists (
      select 1
      from village.inventory_audit_item_approvals as approval
      where approval.session_id = snapshot.session_id
        and approval.equipment_id = snapshot.equipment_id
    );

  return jsonb_build_object(
    'session_id', p_session_id,
    'status', 'draft',
    'approved_equipment_count', v_approved_count,
    'remaining_equipment_count', v_remaining_count,
    'approved_at', v_approved_at
  );
end;
$$;

revoke execute on function village.approve_inventory_audit_items(uuid, uuid, text, jsonb)
  from public, anon, authenticated;
grant execute on function village.approve_inventory_audit_items(uuid, uuid, text, jsonb)
  to service_role;

create or replace function village.resolve_inventory_audit_rental_group(
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
  if v_session.status not in ('draft', 'submitted', 'in_review') then
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

commit;
