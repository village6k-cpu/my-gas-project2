begin;

-- Inventory-audit rows remain separate from the operational ledger until approval.
create table village.inventory_audit_sessions (
  id uuid primary key default gen_random_uuid(),
  mode text not null default 'full_shop',
  status text not null default 'draft',
  cutoff_at timestamptz not null default now(),
  started_by uuid not null,
  started_by_email text not null,
  movement_frozen boolean not null default true,
  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  approved_at timestamptz,
  approved_by uuid,
  approved_by_email text,
  parent_session_id uuid references village.inventory_audit_sessions(id) on delete restrict,
  mirror_status text not null default 'not_ready',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_audit_sessions_mode_check
    check (mode = 'full_shop'),
  constraint inventory_audit_sessions_status_check
    check (status in ('draft', 'submitted', 'in_review', 'recount_requested', 'approved', 'cancelled')),
  constraint inventory_audit_sessions_email_check
    check (nullif(btrim(started_by_email), '') is not null),
  constraint inventory_audit_sessions_full_shop_freeze_check
    check (mode <> 'full_shop' or status <> 'draft' or movement_frozen),
  constraint inventory_audit_sessions_mirror_status_check
    check (mirror_status in ('not_ready', 'pending', 'synced', 'failed')),
  constraint inventory_audit_sessions_approval_identity_check
    check (
      (approved_at is null and approved_by is null and approved_by_email is null)
      or
      (approved_at is not null and approved_by is not null and nullif(btrim(approved_by_email), '') is not null)
    )
);

create unique index inventory_audit_one_full_shop_draft
  on village.inventory_audit_sessions (mode)
  where mode = 'full_shop' and status = 'draft';
create index inventory_audit_sessions_started_by_idx
  on village.inventory_audit_sessions (started_by, status, created_at desc);
create index inventory_audit_sessions_parent_idx
  on village.inventory_audit_sessions (parent_session_id)
  where parent_session_id is not null;

create table village.inventory_audit_snapshot_items (
  session_id uuid not null references village.inventory_audit_sessions(id) on delete cascade,
  equipment_id text not null references village.equipment_ledger(equipment_id) on delete restrict,
  name text not null,
  aliases jsonb not null default '[]'::jsonb,
  major text,
  category text,
  ledger_stock_total integer,
  ledger_stock_maint integer not null,
  ledger_state text not null,
  ledger_open_issues jsonb not null default '[]'::jsonb,
  ledger_updated_at timestamptz not null,
  active_rental_qty integer not null default 0,
  active_rental_refs jsonb not null default '[]'::jsonb,
  rental_match_status text not null default 'none',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, equipment_id),
  constraint inventory_audit_snapshot_counts_nonnegative
    check (
      (ledger_stock_total is null or ledger_stock_total >= 0)
      and ledger_stock_maint >= 0
      and active_rental_qty >= 0
      and (ledger_stock_total is null or ledger_stock_maint <= ledger_stock_total)
    ),
  constraint inventory_audit_snapshot_aliases_array
    check (jsonb_typeof(aliases) = 'array'),
  constraint inventory_audit_snapshot_issues_array
    check (jsonb_typeof(ledger_open_issues) = 'array'),
  constraint inventory_audit_snapshot_rental_refs_array
    check (jsonb_typeof(active_rental_refs) = 'array'),
  constraint inventory_audit_snapshot_rental_match_check
    check (rental_match_status in ('matched', 'ambiguous', 'unmatched', 'none'))
);

-- Active-rental rows that cannot be attached safely to one ledger item remain
-- hidden from staff but available to the owner review. Source identity is
-- immutable; only the resolution columns may change after the cutoff.
create table village.inventory_audit_snapshot_rental_exceptions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references village.inventory_audit_sessions(id) on delete cascade,
  trade_id text not null,
  schedule_id text not null,
  raw_name text not null,
  normalized_name text not null,
  reported_qty integer not null,
  reason text not null,
  candidate_equipment_ids jsonb not null default '[]'::jsonb,
  source_ref jsonb not null default '{}'::jsonb,
  resolution text,
  resolved_equipment_id text references village.equipment_ledger(equipment_id) on delete restrict,
  reviewed_by uuid,
  reviewed_by_email text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (session_id, schedule_id),
  constraint inventory_audit_rental_exception_source_check
    check (
      nullif(btrim(trade_id), '') is not null
      and nullif(btrim(schedule_id), '') is not null
      and nullif(btrim(raw_name), '') is not null
      and nullif(btrim(normalized_name), '') is not null
    ),
  constraint inventory_audit_rental_exception_qty_nonnegative
    check (reported_qty >= 0),
  constraint inventory_audit_rental_exception_reason_check
    check (reason in (
      'ambiguous_name',
      'unmatched_name',
      'conflicting_checkout_evidence',
      'invalid_quantity'
    )),
  constraint inventory_audit_rental_exception_candidates_array
    check (jsonb_typeof(candidate_equipment_ids) = 'array'),
  constraint inventory_audit_rental_exception_source_ref_object
    check (jsonb_typeof(source_ref) = 'object'),
  constraint inventory_audit_rental_exception_resolution_check
    check (resolution is null or resolution in ('existing_equipment', 'not_inventory')),
  constraint inventory_audit_rental_exception_resolution_shape
    check (
      (
        resolution is null
        and resolved_equipment_id is null
        and reviewed_by is null
        and reviewed_by_email is null
        and reviewed_at is null
      )
      or
      (
        resolution = 'existing_equipment'
        and nullif(btrim(resolved_equipment_id), '') is not null
        and reviewed_by is not null
        and nullif(btrim(reviewed_by_email), '') is not null
        and reviewed_at is not null
      )
      or
      (
        resolution = 'not_inventory'
        and resolved_equipment_id is null
        and reviewed_by is not null
        and nullif(btrim(reviewed_by_email), '') is not null
        and reviewed_at is not null
      )
    )
);

create index inventory_audit_rental_exceptions_session_idx
  on village.inventory_audit_snapshot_rental_exceptions (session_id, reason);
create index inventory_audit_rental_exceptions_resolved_equipment_idx
  on village.inventory_audit_snapshot_rental_exceptions (resolved_equipment_id)
  where resolved_equipment_id is not null;

create function village.protect_inventory_audit_rental_exception_source()
returns trigger
language plpgsql
set search_path = village, public
as $$
begin
  if (
    new.id,
    new.session_id,
    new.trade_id,
    new.schedule_id,
    new.raw_name,
    new.normalized_name,
    new.reported_qty,
    new.reason,
    new.candidate_equipment_ids,
    new.source_ref,
    new.created_at
  ) is distinct from (
    old.id,
    old.session_id,
    old.trade_id,
    old.schedule_id,
    old.raw_name,
    old.normalized_name,
    old.reported_qty,
    old.reason,
    old.candidate_equipment_ids,
    old.source_ref,
    old.created_at
  ) then
    raise exception 'inventory audit rental exception source is immutable'
      using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke execute on function village.protect_inventory_audit_rental_exception_source()
  from public, anon, authenticated;

create trigger inventory_audit_rental_exception_protect_source
  before update on village.inventory_audit_snapshot_rental_exceptions
  for each row execute function village.protect_inventory_audit_rental_exception_source();

create table village.inventory_audit_observations (
  id uuid primary key,
  session_id uuid not null references village.inventory_audit_sessions(id) on delete cascade,
  equipment_id text references village.equipment_ledger(equipment_id) on delete restrict,
  temporary_code text,
  temporary_label text,
  location text not null,
  count_normal integer not null default 0,
  count_maintenance integer not null default 0,
  count_damaged integer not null default 0,
  count_condition_unknown integer not null default 0,
  missing_components jsonb not null default '[]'::jsonb,
  note text not null default '',
  identification_status text not null,
  evidence_refs jsonb not null default '[]'::jsonb,
  observed_by uuid not null,
  observed_by_email text not null,
  client_updated_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_audit_observation_location_check
    check (nullif(btrim(location), '') is not null),
  constraint inventory_audit_observation_email_check
    check (nullif(btrim(observed_by_email), '') is not null),
  constraint inventory_audit_observation_counts_nonnegative
    check (
      count_normal >= 0
      and count_maintenance >= 0
      and count_damaged >= 0
      and count_condition_unknown >= 0
    ),
  constraint inventory_audit_observation_identification_check
    check (identification_status in ('confirmed', 'uncertain', 'unlisted')),
  constraint inventory_audit_observation_identity_exclusive
    check (
      (
        equipment_id is not null
        and temporary_code is null
        and temporary_label is null
        and identification_status = 'confirmed'
      )
      or
      (
        equipment_id is null
        and nullif(btrim(temporary_code), '') is not null
        and identification_status in ('uncertain', 'unlisted')
      )
    ),
  constraint inventory_audit_observation_components_array
    check (jsonb_typeof(missing_components) = 'array'),
  constraint inventory_audit_observation_evidence_array
    check (jsonb_typeof(evidence_refs) = 'array')
);

create index inventory_audit_observations_session_idx
  on village.inventory_audit_observations (session_id, equipment_id);
create index inventory_audit_observations_owner_idx
  on village.inventory_audit_observations (observed_by, session_id);
create index inventory_audit_observations_temporary_idx
  on village.inventory_audit_observations (session_id, temporary_code)
  where temporary_code is not null;

create table village.inventory_audit_decisions (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references village.inventory_audit_sessions(id) on delete cascade,
  equipment_id text references village.equipment_ledger(equipment_id) on delete restrict,
  source_observation_id uuid references village.inventory_audit_observations(id) on delete restrict,
  decision text not null,
  resolution text,
  resolved_equipment_id text,
  new_equipment_payload jsonb,
  final_stock_total integer,
  final_stock_maint integer,
  final_state text,
  final_open_issues jsonb not null default '[]'::jsonb,
  other_confirmed_offsite_qty integer not null default 0,
  review_note text not null default '',
  reviewed_by uuid not null,
  reviewed_by_email text not null,
  reviewed_at timestamptz not null default now(),
  reviewed_ledger_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_audit_decision_kind_check
    check (decision in ('apply_audit', 'keep_ledger', 'recount')),
  constraint inventory_audit_decision_resolution_check
    check (resolution is null or resolution in ('existing_equipment', 'create_equipment', 'not_inventory')),
  constraint inventory_audit_decision_identity_exclusive
    check ((equipment_id is not null) <> (source_observation_id is not null)),
  constraint inventory_audit_decision_counts_nonnegative
    check (
      (final_stock_total is null or final_stock_total >= 0)
      and (final_stock_maint is null or final_stock_maint >= 0)
      and other_confirmed_offsite_qty >= 0
      and (
        final_stock_total is null
        or final_stock_maint is null
        or final_stock_maint <= final_stock_total
      )
    ),
  constraint inventory_audit_decision_issues_array
    check (jsonb_typeof(final_open_issues) = 'array'),
  constraint inventory_audit_decision_payload_object
    check (new_equipment_payload is null or jsonb_typeof(new_equipment_payload) = 'object'),
  constraint inventory_audit_decision_reviewer_email_check
    check (nullif(btrim(reviewed_by_email), '') is not null),
  constraint inventory_audit_decision_reviewed_ledger_version_check
    check (
      (equipment_id is null and resolution is distinct from 'existing_equipment')
      or reviewed_ledger_updated_at is not null
    ),
  constraint inventory_audit_decision_resolution_shape
    check (
      (resolution is null and resolved_equipment_id is null and new_equipment_payload is null)
      or (resolution = 'existing_equipment' and nullif(btrim(resolved_equipment_id), '') is not null and new_equipment_payload is null)
      or (resolution = 'create_equipment' and new_equipment_payload is not null)
      or (resolution = 'not_inventory' and resolved_equipment_id is null and new_equipment_payload is null)
    )
);

create unique index inventory_audit_decisions_equipment_unique
  on village.inventory_audit_decisions (session_id, equipment_id)
  where equipment_id is not null;
create unique index inventory_audit_decisions_observation_unique
  on village.inventory_audit_decisions (session_id, source_observation_id)
  where source_observation_id is not null;
create index inventory_audit_decisions_session_idx
  on village.inventory_audit_decisions (session_id, decision);
create index inventory_audit_decisions_resolved_equipment_idx
  on village.inventory_audit_decisions (resolved_equipment_id)
  where resolved_equipment_id is not null;

create trigger inventory_audit_sessions_touch_updated_at
  before update on village.inventory_audit_sessions
  for each row execute function village.touch_updated_at();
create trigger inventory_audit_snapshot_items_touch_updated_at
  before update on village.inventory_audit_snapshot_items
  for each row execute function village.touch_updated_at();
create trigger inventory_audit_observations_touch_updated_at
  before update on village.inventory_audit_observations
  for each row execute function village.touch_updated_at();
create trigger inventory_audit_decisions_touch_updated_at
  before update on village.inventory_audit_decisions
  for each row execute function village.touch_updated_at();

alter table village.inventory_audit_sessions enable row level security;
alter table village.inventory_audit_snapshot_items enable row level security;
alter table village.inventory_audit_snapshot_rental_exceptions enable row level security;
alter table village.inventory_audit_observations enable row level security;
alter table village.inventory_audit_decisions enable row level security;

revoke all on village.inventory_audit_sessions from public;
revoke all on village.inventory_audit_snapshot_items from public;
revoke all on village.inventory_audit_snapshot_rental_exceptions from public;
revoke all on village.inventory_audit_observations from public;
revoke all on village.inventory_audit_decisions from public;
revoke all on village.inventory_audit_sessions from anon, authenticated;
revoke all on village.inventory_audit_snapshot_items from anon, authenticated;
revoke all on village.inventory_audit_snapshot_rental_exceptions from anon, authenticated;
revoke all on village.inventory_audit_observations from anon, authenticated;
revoke all on village.inventory_audit_decisions from anon, authenticated;

grant usage on schema village to authenticated, service_role;
grant select on village.inventory_audit_sessions to authenticated;
grant select on village.inventory_audit_observations to authenticated;
grant all on village.inventory_audit_sessions to service_role;
grant all on village.inventory_audit_snapshot_items to service_role;
grant all on village.inventory_audit_snapshot_rental_exceptions to service_role;
grant all on village.inventory_audit_observations to service_role;
grant all on village.inventory_audit_decisions to service_role;

create policy inventory_audit_sessions_owner_select
  on village.inventory_audit_sessions
  for select
  to authenticated
  using ((select auth.uid()) = started_by);

create policy inventory_audit_observations_owner_select
  on village.inventory_audit_observations
  for select
  to authenticated
  using (
    (select auth.uid()) = observed_by
    and exists (
      select 1
      from village.inventory_audit_sessions as audit_session
      where audit_session.id = session_id
        and audit_session.started_by = (select auth.uid())
    )
  );

-- A private bucket; rows are inserted without conflict-replacement semantics.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
select
  'inventory-audit-evidence',
  'inventory-audit-evidence',
  false,
  10485760,
  array['image/jpeg']::text[]
where not exists (
  select 1 from storage.buckets where id = 'inventory-audit-evidence'
);

update storage.buckets
set public = false,
    file_size_limit = 10485760,
    allowed_mime_types = array['image/jpeg']::text[]
where id = 'inventory-audit-evidence';

drop policy if exists inventory_audit_evidence_select on storage.objects;
drop policy if exists inventory_audit_evidence_insert on storage.objects;
drop policy if exists inventory_audit_evidence_update on storage.objects;
drop policy if exists inventory_audit_evidence_delete on storage.objects;

-- This no-argument definer sees every session despite caller RLS. The advisory
-- lock serializes ordinary ledger writes with audit start/recount/approval.
create function village.inventory_audit_ledger_writes_allowed()
returns boolean
language plpgsql
security definer
set search_path = village, public
as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('village.inventory_audit.full_shop', 0)
  );

  return not exists (
    select 1
    from village.inventory_audit_sessions
    where mode = 'full_shop'
      and status = 'draft'
  );
end;
$$;

revoke execute on function village.inventory_audit_ledger_writes_allowed() from public, anon;
revoke execute on function village.inventory_audit_ledger_writes_allowed() from service_role;
grant execute on function village.inventory_audit_ledger_writes_allowed() to authenticated;

drop policy if exists auth_rw on village.equipment_ledger;
drop policy if exists equipment_ledger_authenticated_select on village.equipment_ledger;
drop policy if exists equipment_ledger_authenticated_insert on village.equipment_ledger;
drop policy if exists equipment_ledger_authenticated_update on village.equipment_ledger;
drop policy if exists equipment_ledger_authenticated_delete on village.equipment_ledger;

create policy equipment_ledger_authenticated_select
  on village.equipment_ledger
  for select
  to authenticated
  using (true);

create policy equipment_ledger_authenticated_insert
  on village.equipment_ledger
  for insert
  to authenticated
  with check ((select village.inventory_audit_ledger_writes_allowed()));

create policy equipment_ledger_authenticated_update
  on village.equipment_ledger
  for update
  to authenticated
  using ((select village.inventory_audit_ledger_writes_allowed()))
  with check ((select village.inventory_audit_ledger_writes_allowed()));

create policy equipment_ledger_authenticated_delete
  on village.equipment_ledger
  for delete
  to authenticated
  using ((select village.inventory_audit_ledger_writes_allowed()));

drop function if exists village.start_inventory_audit(uuid, text, boolean, jsonb);

create function village.start_inventory_audit(
  p_started_by uuid,
  p_started_by_email text,
  p_movement_frozen boolean,
  p_rental_snapshot jsonb,
  p_rental_exceptions jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = village, public
as $$
declare
  v_session_id uuid;
  v_cutoff_at timestamptz;
  v_snapshot_count integer;
begin
  if p_started_by is null or nullif(btrim(p_started_by_email), '') is null then
    raise exception 'inventory audit starter identity is required' using errcode = '22023';
  end if;
  if p_movement_frozen is distinct from true then
    raise exception 'full_shop inventory audit requires movement_frozen=true' using errcode = '22023';
  end if;
  if p_rental_snapshot is null or jsonb_typeof(p_rental_snapshot) <> 'array' then
    raise exception 'rental snapshot must be a JSON array' using errcode = '22023';
  end if;
  if p_rental_exceptions is null or jsonb_typeof(p_rental_exceptions) <> 'array' then
    raise exception 'rental exceptions must be a JSON array' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('village.inventory_audit.full_shop', 0)
  );

  select audit_session.id
  into v_session_id
  from village.inventory_audit_sessions as audit_session
  where audit_session.mode = 'full_shop'
    and audit_session.status = 'draft'
    and audit_session.started_by = p_started_by
  for update;

  if v_session_id is not null then
    select count(*)::integer
    into v_snapshot_count
    from village.inventory_audit_snapshot_items
    where session_id = v_session_id;

    return jsonb_build_object(
      'session_id', v_session_id,
      'reused', true,
      'snapshot_count', v_snapshot_count
    );
  end if;

  if exists (
    select 1
    from village.inventory_audit_sessions
    where mode = 'full_shop'
      and status = 'draft'
  ) then
    raise exception 'full_shop inventory audit draft already active' using errcode = 'P0001';
  end if;

  v_cutoff_at := pg_catalog.clock_timestamp();

  insert into village.inventory_audit_sessions (
    mode,
    status,
    cutoff_at,
    started_by,
    started_by_email,
    movement_frozen,
    started_at
  ) values (
    'full_shop',
    'draft',
    v_cutoff_at,
    p_started_by,
    btrim(p_started_by_email),
    true,
    v_cutoff_at
  )
  returning id into v_session_id;

  insert into village.inventory_audit_snapshot_items (
    session_id,
    equipment_id,
    name,
    aliases,
    major,
    category,
    ledger_stock_total,
    ledger_stock_maint,
    ledger_state,
    ledger_open_issues,
    ledger_updated_at,
    active_rental_qty,
    active_rental_refs,
    rental_match_status
  )
  select
    v_session_id,
    ledger.equipment_id,
    ledger.name,
    ledger.aliases,
    ledger.major,
    ledger.category,
    ledger.stock_total,
    ledger.stock_maint,
    ledger.state,
    ledger.open_issues,
    ledger.updated_at,
    coalesce(rental.active_rental_qty, 0),
    coalesce(rental.active_rental_refs, '[]'::jsonb),
    coalesce(rental.rental_match_status, 'none')
  from village.equipment_ledger as ledger
  left join lateral (
    select rental_row.*
    from jsonb_to_recordset(p_rental_snapshot) as rental_row (
      equipment_id text,
      active_rental_qty integer,
      active_rental_refs jsonb,
      rental_match_status text
    )
    where rental_row.equipment_id = ledger.equipment_id
    limit 1
  ) as rental on true
  where ledger.state <> '보관종료'
    and ledger.equipment_id <> 'SYS-000';

  get diagnostics v_snapshot_count = row_count;
  if v_snapshot_count = 0 then
    raise exception 'cannot start inventory audit with an empty active ledger' using errcode = 'P0001';
  end if;

  insert into village.inventory_audit_snapshot_rental_exceptions (
    id,
    session_id,
    trade_id,
    schedule_id,
    raw_name,
    normalized_name,
    reported_qty,
    reason,
    candidate_equipment_ids,
    source_ref
  )
  select
    coalesce(rental_exception.id, gen_random_uuid()),
    v_session_id,
    btrim(rental_exception.trade_id),
    btrim(rental_exception.schedule_id),
    btrim(rental_exception.raw_name),
    btrim(rental_exception.normalized_name),
    rental_exception.reported_qty,
    rental_exception.reason,
    coalesce(rental_exception.candidate_equipment_ids, '[]'::jsonb),
    coalesce(rental_exception.source_ref, '{}'::jsonb)
  from jsonb_to_recordset(p_rental_exceptions) as rental_exception (
    id uuid,
    trade_id text,
    schedule_id text,
    raw_name text,
    normalized_name text,
    reported_qty integer,
    reason text,
    candidate_equipment_ids jsonb,
    source_ref jsonb
  );

  return jsonb_build_object(
    'session_id', v_session_id,
    'reused', false,
    'snapshot_count', v_snapshot_count,
    'cutoff_at', v_cutoff_at
  );
end;
$$;

revoke execute on function village.start_inventory_audit(uuid, text, boolean, jsonb, jsonb) from public, anon, authenticated;
grant execute on function village.start_inventory_audit(uuid, text, boolean, jsonb, jsonb) to service_role;

create function village.save_inventory_audit_observation(
  p_session_id uuid,
  p_observation_id uuid,
  p_actor_id uuid,
  p_actor_email text,
  p_equipment_id text,
  p_temporary_code text,
  p_temporary_label text,
  p_location text,
  p_count_normal integer,
  p_count_maintenance integer,
  p_count_damaged integer,
  p_count_condition_unknown integer,
  p_missing_components jsonb,
  p_note text,
  p_identification_status text,
  p_client_updated_at timestamptz,
  p_expected_client_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = village, public
as $$
declare
  v_session village.inventory_audit_sessions%rowtype;
  v_existing village.inventory_audit_observations%rowtype;
  v_result village.inventory_audit_observations%rowtype;
  v_equipment_id text := nullif(btrim(p_equipment_id), '');
  v_temporary_code text := nullif(btrim(p_temporary_code), '');
  v_temporary_label text := nullif(btrim(p_temporary_label), '');
  v_location text := btrim(p_location);
  v_missing_components jsonb := coalesce(p_missing_components, '[]'::jsonb);
  v_note text := coalesce(p_note, '');
  v_created boolean := false;
  v_reused boolean := false;
begin
  if p_session_id is null
     or p_observation_id is null
     or p_actor_id is null
     or nullif(btrim(p_actor_email), '') is null then
    raise exception 'inventory audit observation actor and ids are required'
      using errcode = '22023';
  end if;
  if nullif(v_location, '') is null or p_client_updated_at is null then
    raise exception 'inventory audit observation location and client timestamp are required'
      using errcode = '22023';
  end if;
  if p_count_normal is null
     or p_count_maintenance is null
     or p_count_damaged is null
     or p_count_condition_unknown is null
     or p_count_normal < 0
     or p_count_maintenance < 0
     or p_count_damaged < 0
     or p_count_condition_unknown < 0 then
    raise exception 'inventory audit observation counts must be nonnegative integers'
      using errcode = '22023';
  end if;
  if jsonb_typeof(v_missing_components) <> 'array' then
    raise exception 'inventory audit missing components must be a JSON array'
      using errcode = '22023';
  end if;
  if not (
    (
      p_identification_status = 'confirmed'
      and v_equipment_id is not null
      and v_temporary_code is null
      and v_temporary_label is null
    )
    or
    (
      p_identification_status in ('uncertain', 'unlisted')
      and v_equipment_id is null
      and v_temporary_code is not null
    )
  ) then
    raise exception 'inventory audit observation identity is invalid'
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
  if v_session.started_by <> p_actor_id then
    raise exception 'inventory audit session belongs to another user' using errcode = '42501';
  end if;

  select *
  into v_existing
  from village.inventory_audit_observations
  where id = p_observation_id
  for update;

  if found then
    if v_existing.session_id <> p_session_id or v_existing.observed_by <> p_actor_id then
      raise exception 'inventory audit observation belongs to another session or user'
        using errcode = '42501';
    end if;

    if row(
      v_existing.equipment_id,
      v_existing.temporary_code,
      v_existing.temporary_label,
      v_existing.location,
      v_existing.count_normal,
      v_existing.count_maintenance,
      v_existing.count_damaged,
      v_existing.count_condition_unknown,
      v_existing.missing_components,
      v_existing.note,
      v_existing.identification_status,
      v_existing.client_updated_at
    ) is not distinct from row(
      v_equipment_id,
      v_temporary_code,
      v_temporary_label,
      v_location,
      p_count_normal,
      p_count_maintenance,
      p_count_damaged,
      p_count_condition_unknown,
      v_missing_components,
      v_note,
      p_identification_status,
      p_client_updated_at
    ) then
      v_result := v_existing;
      v_reused := true;
    else
      if v_session.status <> 'draft' then
        raise exception 'inventory audit observations are immutable after submission'
          using errcode = 'P0001';
      end if;
      if v_existing.client_updated_at is distinct from p_expected_client_updated_at then
        raise exception 'inventory audit observation has a stale client base'
          using errcode = '40001';
      end if;
      if p_client_updated_at <= v_existing.client_updated_at then
        raise exception 'inventory audit observation client timestamp must advance'
          using errcode = '40001';
      end if;

      if v_equipment_id is not null and not exists (
        select 1
        from village.inventory_audit_snapshot_items as snapshot
        where snapshot.session_id = p_session_id
          and snapshot.equipment_id = v_equipment_id
      ) then
        raise exception 'confirmed equipment is outside the inventory audit snapshot'
          using errcode = '22023';
      end if;

      update village.inventory_audit_observations
      set equipment_id = v_equipment_id,
          temporary_code = v_temporary_code,
          temporary_label = v_temporary_label,
          location = v_location,
          count_normal = p_count_normal,
          count_maintenance = p_count_maintenance,
          count_damaged = p_count_damaged,
          count_condition_unknown = p_count_condition_unknown,
          missing_components = v_missing_components,
          note = v_note,
          identification_status = p_identification_status,
          evidence_refs = v_existing.evidence_refs,
          client_updated_at = p_client_updated_at
      where id = p_observation_id
      returning * into v_result;
    end if;
  else
    if v_session.status <> 'draft' then
      raise exception 'inventory audit observations are immutable after submission'
        using errcode = 'P0001';
    end if;
    if p_expected_client_updated_at is not null then
      raise exception 'inventory audit observation create has a stale client base'
        using errcode = '40001';
    end if;
    if v_equipment_id is not null and not exists (
      select 1
      from village.inventory_audit_snapshot_items as snapshot
      where snapshot.session_id = p_session_id
        and snapshot.equipment_id = v_equipment_id
    ) then
      raise exception 'confirmed equipment is outside the inventory audit snapshot'
        using errcode = '22023';
    end if;

    insert into village.inventory_audit_observations (
      id,
      session_id,
      equipment_id,
      temporary_code,
      temporary_label,
      location,
      count_normal,
      count_maintenance,
      count_damaged,
      count_condition_unknown,
      missing_components,
      note,
      identification_status,
      observed_by,
      observed_by_email,
      client_updated_at
    ) values (
      p_observation_id,
      p_session_id,
      v_equipment_id,
      v_temporary_code,
      v_temporary_label,
      v_location,
      p_count_normal,
      p_count_maintenance,
      p_count_damaged,
      p_count_condition_unknown,
      v_missing_components,
      v_note,
      p_identification_status,
      p_actor_id,
      btrim(p_actor_email),
      p_client_updated_at
    )
    returning * into v_result;
    v_created := true;
  end if;

  return jsonb_build_object(
    'created', v_created,
    'reused', v_reused,
    'observation', jsonb_build_object(
      'id', v_result.id,
      'session_id', v_result.session_id,
      'equipment_id', v_result.equipment_id,
      'temporary_code', v_result.temporary_code,
      'temporary_label', v_result.temporary_label,
      'location', v_result.location,
      'count_normal', v_result.count_normal,
      'count_maintenance', v_result.count_maintenance,
      'count_damaged', v_result.count_damaged,
      'count_condition_unknown', v_result.count_condition_unknown,
      'missing_components', v_result.missing_components,
      'note', v_result.note,
      'identification_status', v_result.identification_status,
      'evidence_refs', v_result.evidence_refs,
      'client_updated_at', v_result.client_updated_at,
      'created_at', v_result.created_at,
      'updated_at', v_result.updated_at
    )
  );
end;
$$;

revoke execute on function village.save_inventory_audit_observation(
  uuid, uuid, uuid, text, text, text, text, text,
  integer, integer, integer, integer, jsonb, text, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function village.save_inventory_audit_observation(
  uuid, uuid, uuid, text, text, text, text, text,
  integer, integer, integer, integer, jsonb, text, text, timestamptz, timestamptz
) to service_role;

create function village.delete_inventory_audit_observation(
  p_session_id uuid,
  p_observation_id uuid,
  p_actor_id uuid,
  p_expected_client_updated_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = village, public
as $$
declare
  v_session village.inventory_audit_sessions%rowtype;
  v_existing village.inventory_audit_observations%rowtype;
begin
  if p_session_id is null or p_observation_id is null or p_actor_id is null then
    raise exception 'inventory audit observation delete ids are required'
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
  if v_session.started_by <> p_actor_id then
    raise exception 'inventory audit session belongs to another user' using errcode = '42501';
  end if;

  select *
  into v_existing
  from village.inventory_audit_observations
  where id = p_observation_id
  for update;

  if not found then
    return jsonb_build_object(
      'observation_id', p_observation_id,
      'deleted', true,
      'reused', true
    );
  end if;
  if v_existing.session_id <> p_session_id or v_existing.observed_by <> p_actor_id then
    raise exception 'inventory audit observation belongs to another session or user'
      using errcode = '42501';
  end if;
  if v_session.status <> 'draft' then
    raise exception 'inventory audit observations are immutable after submission'
      using errcode = 'P0001';
  end if;
  if v_existing.client_updated_at is distinct from p_expected_client_updated_at then
    raise exception 'inventory audit observation delete has a stale client base'
      using errcode = '40001';
  end if;
  if jsonb_array_length(v_existing.evidence_refs) > 0 then
    raise exception 'inventory audit observation with evidence cannot be deleted'
      using errcode = 'P0001';
  end if;

  delete from village.inventory_audit_observations
  where id = p_observation_id;

  return jsonb_build_object(
    'observation_id', p_observation_id,
    'deleted', true,
    'reused', false
  );
end;
$$;

revoke execute on function village.delete_inventory_audit_observation(uuid, uuid, uuid, timestamptz)
  from public, anon, authenticated;
grant execute on function village.delete_inventory_audit_observation(uuid, uuid, uuid, timestamptz)
  to service_role;

create function village.submit_inventory_audit(
  p_session_id uuid,
  p_actor_id uuid,
  p_pending_observation_writes integer,
  p_pending_evidence_uploads integer
)
returns jsonb
language plpgsql
security definer
set search_path = village, public
as $$
declare
  v_session village.inventory_audit_sessions%rowtype;
  v_submitted_at timestamptz;
  v_observation_count integer;
begin
  if p_session_id is null or p_actor_id is null then
    raise exception 'inventory audit submit ids are required' using errcode = '22023';
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
  if v_session.started_by <> p_actor_id then
    raise exception 'inventory audit session belongs to another user' using errcode = '42501';
  end if;
  if v_session.status = 'submitted' then
    return jsonb_build_object(
      'session_id', p_session_id,
      'status', 'submitted',
      'submitted_at', v_session.submitted_at,
      'reused', true
    );
  end if;
  if v_session.status <> 'draft' then
    raise exception 'inventory audit session cannot be submitted from status %', v_session.status
      using errcode = 'P0001';
  end if;
  if p_pending_observation_writes is distinct from 0
     or p_pending_evidence_uploads is distinct from 0 then
    raise exception 'inventory audit cannot submit with pending client writes or evidence uploads'
      using errcode = 'P0001';
  end if;

  select count(*)::integer
  into v_observation_count
  from village.inventory_audit_observations
  where session_id = p_session_id;

  if v_observation_count = 0 then
    raise exception 'inventory audit requires at least one observation before submission'
      using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from village.inventory_audit_observations as observation
    cross join lateral jsonb_array_elements(observation.evidence_refs) as evidence(ref)
    where observation.session_id = p_session_id
      and coalesce(evidence.ref ->> 'status', 'pending') <> 'uploaded'
  ) then
    raise exception 'inventory audit has pending server evidence'
      using errcode = 'P0001';
  end if;

  v_submitted_at := pg_catalog.clock_timestamp();
  update village.inventory_audit_sessions
  set status = 'submitted',
      movement_frozen = false,
      submitted_at = v_submitted_at
  where id = p_session_id;

  return jsonb_build_object(
    'session_id', p_session_id,
    'status', 'submitted',
    'submitted_at', v_submitted_at,
    'observation_count', v_observation_count,
    'reused', false
  );
end;
$$;

revoke execute on function village.submit_inventory_audit(uuid, uuid, integer, integer)
  from public, anon, authenticated;
grant execute on function village.submit_inventory_audit(uuid, uuid, integer, integer)
  to service_role;

create function village.cancel_inventory_audit(
  p_session_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = village, public
as $$
declare
  v_session village.inventory_audit_sessions%rowtype;
begin
  if p_session_id is null or p_actor_id is null then
    raise exception 'inventory audit cancel ids are required' using errcode = '22023';
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
  if v_session.started_by <> p_actor_id then
    raise exception 'inventory audit session belongs to another user' using errcode = '42501';
  end if;
  if v_session.status = 'cancelled' then
    return jsonb_build_object(
      'session_id', p_session_id,
      'status', 'cancelled',
      'reused', true
    );
  end if;
  if v_session.status <> 'draft' then
    raise exception 'inventory audit session cannot be cancelled from status %', v_session.status
      using errcode = 'P0001';
  end if;
  if exists (
    select 1
    from village.inventory_audit_observations as observation
    cross join lateral jsonb_array_elements(observation.evidence_refs) as evidence(ref)
    where observation.session_id = p_session_id
      and coalesce(evidence.ref ->> 'status', 'pending') <> 'uploaded'
  ) then
    raise exception 'inventory audit cannot cancel with pending evidence'
      using errcode = 'P0001';
  end if;

  update village.inventory_audit_sessions
  set status = 'cancelled',
      movement_frozen = false
  where id = p_session_id;

  return jsonb_build_object(
    'session_id', p_session_id,
    'status', 'cancelled',
    'reused', false
  );
end;
$$;

revoke execute on function village.cancel_inventory_audit(uuid, uuid)
  from public, anon, authenticated;
grant execute on function village.cancel_inventory_audit(uuid, uuid)
  to service_role;

create function village.reserve_inventory_audit_evidence(
  p_session_id uuid,
  p_observation_id uuid,
  p_evidence_id uuid,
  p_actor_id uuid,
  p_content_type text,
  p_size_bytes integer
)
returns jsonb
language plpgsql
security definer
set search_path = village, public
as $$
declare
  v_session village.inventory_audit_sessions%rowtype;
  v_observation village.inventory_audit_observations%rowtype;
  v_existing_ref jsonb;
  v_ref jsonb;
  v_path text;
  v_created_at timestamptz;
begin
  if p_session_id is null
     or p_observation_id is null
     or p_evidence_id is null
     or p_actor_id is null then
    raise exception 'inventory audit evidence ids are required' using errcode = '22023';
  end if;
  if p_content_type <> 'image/jpeg'
     or p_size_bytes is null
     or p_size_bytes <= 0
     or p_size_bytes > 10485760 then
    raise exception 'inventory audit evidence must be a JPEG up to 10 MB'
      using errcode = '22023';
  end if;

  v_path := p_session_id::text || '/' || p_observation_id::text || '/' || p_evidence_id::text || '.jpg';

  select *
  into v_session
  from village.inventory_audit_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'inventory audit session not found' using errcode = 'P0002';
  end if;
  if v_session.started_by <> p_actor_id then
    raise exception 'inventory audit session belongs to another user' using errcode = '42501';
  end if;

  select *
  into v_observation
  from village.inventory_audit_observations
  where id = p_observation_id
  for update;

  if not found then
    raise exception 'inventory audit observation not found' using errcode = 'P0002';
  end if;
  if v_observation.session_id <> p_session_id or v_observation.observed_by <> p_actor_id then
    raise exception 'inventory audit observation belongs to another session or user'
      using errcode = '42501';
  end if;

  select evidence.ref
  into v_existing_ref
  from jsonb_array_elements(v_observation.evidence_refs) as evidence(ref)
  where evidence.ref ->> 'id' = p_evidence_id::text
  limit 1;

  if found then
    if v_existing_ref ->> 'path' = v_path
       and v_existing_ref ->> 'content_type' = p_content_type
       and (v_existing_ref ->> 'size_bytes')::integer = p_size_bytes
       and v_existing_ref ->> 'status' in ('pending', 'uploaded') then
      return jsonb_build_object(
        'evidence', v_existing_ref,
        'created', false,
        'reused', true
      );
    end if;
    raise exception 'inventory audit evidence id was reused with conflicting metadata'
      using errcode = '40001';
  end if;

  if v_session.status <> 'draft' then
    raise exception 'inventory audit evidence cannot be reserved after submission'
      using errcode = 'P0001';
  end if;

  v_created_at := pg_catalog.clock_timestamp();
  v_ref := jsonb_build_object(
    'id', p_evidence_id,
    'path', v_path,
    'status', 'pending',
    'content_type', p_content_type,
    'size_bytes', p_size_bytes,
    'created_at', v_created_at
  );

  update village.inventory_audit_observations
  set evidence_refs = evidence_refs || jsonb_build_array(v_ref)
  where id = p_observation_id;

  return jsonb_build_object(
    'evidence', v_ref,
    'created', true,
    'reused', false
  );
end;
$$;

revoke execute on function village.reserve_inventory_audit_evidence(uuid, uuid, uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function village.reserve_inventory_audit_evidence(uuid, uuid, uuid, uuid, text, integer)
  to service_role;

create function village.complete_inventory_audit_evidence(
  p_session_id uuid,
  p_observation_id uuid,
  p_evidence_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = village, public
as $$
declare
  v_session village.inventory_audit_sessions%rowtype;
  v_observation village.inventory_audit_observations%rowtype;
  v_existing_ref jsonb;
  v_completed_ref jsonb;
  v_refs jsonb;
  v_path text;
  v_uploaded_at timestamptz;
begin
  if p_session_id is null
     or p_observation_id is null
     or p_evidence_id is null
     or p_actor_id is null then
    raise exception 'inventory audit evidence ids are required' using errcode = '22023';
  end if;

  v_path := p_session_id::text || '/' || p_observation_id::text || '/' || p_evidence_id::text || '.jpg';

  select *
  into v_session
  from village.inventory_audit_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'inventory audit session not found' using errcode = 'P0002';
  end if;
  if v_session.started_by <> p_actor_id then
    raise exception 'inventory audit session belongs to another user' using errcode = '42501';
  end if;

  select *
  into v_observation
  from village.inventory_audit_observations
  where id = p_observation_id
  for update;

  if not found then
    raise exception 'inventory audit observation not found' using errcode = 'P0002';
  end if;
  if v_observation.session_id <> p_session_id or v_observation.observed_by <> p_actor_id then
    raise exception 'inventory audit observation belongs to another session or user'
      using errcode = '42501';
  end if;

  select evidence.ref
  into v_existing_ref
  from jsonb_array_elements(v_observation.evidence_refs) as evidence(ref)
  where evidence.ref ->> 'id' = p_evidence_id::text
  limit 1;

  if not found then
    raise exception 'inventory audit evidence reservation not found' using errcode = 'P0002';
  end if;
  if v_existing_ref ->> 'path' <> v_path then
    raise exception 'inventory audit evidence reservation path is invalid'
      using errcode = '40001';
  end if;
  if v_existing_ref ->> 'status' = 'uploaded' then
    return jsonb_build_object(
      'evidence', v_existing_ref,
      'completed', true,
      'reused', true
    );
  end if;
  if v_session.status <> 'draft' then
    raise exception 'inventory audit evidence cannot be completed after submission'
      using errcode = 'P0001';
  end if;
  if v_existing_ref ->> 'status' <> 'pending' then
    raise exception 'inventory audit evidence reservation status is invalid'
      using errcode = '40001';
  end if;
  if not exists (
    select 1
    from storage.objects as stored_object
    where stored_object.bucket_id = 'inventory-audit-evidence'
      and stored_object.name = v_path
  ) then
    raise exception 'inventory audit evidence object not found' using errcode = 'P0002';
  end if;

  v_uploaded_at := pg_catalog.clock_timestamp();
  select jsonb_agg(
    case
      when evidence.ref ->> 'id' = p_evidence_id::text then
        (evidence.ref - 'status') || jsonb_build_object(
          'status', 'uploaded',
          'uploaded_at', v_uploaded_at
        )
      else evidence.ref
    end
    order by evidence.ordinality
  )
  into v_refs
  from jsonb_array_elements(v_observation.evidence_refs)
    with ordinality as evidence(ref, ordinality);

  update village.inventory_audit_observations
  set evidence_refs = v_refs
  where id = p_observation_id;

  select evidence.ref
  into strict v_completed_ref
  from jsonb_array_elements(v_refs) as evidence(ref)
  where evidence.ref ->> 'id' = p_evidence_id::text;

  return jsonb_build_object(
    'evidence', v_completed_ref,
    'completed', true,
    'reused', false
  );
end;
$$;

revoke execute on function village.complete_inventory_audit_evidence(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function village.complete_inventory_audit_evidence(uuid, uuid, uuid, uuid)
  to service_role;

create function village.abort_inventory_audit_evidence(
  p_session_id uuid,
  p_observation_id uuid,
  p_evidence_id uuid,
  p_actor_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = village, public
as $$
declare
  v_session village.inventory_audit_sessions%rowtype;
  v_observation village.inventory_audit_observations%rowtype;
  v_existing_ref jsonb;
  v_refs jsonb;
begin
  if p_session_id is null
     or p_observation_id is null
     or p_evidence_id is null
     or p_actor_id is null then
    raise exception 'inventory audit evidence ids are required' using errcode = '22023';
  end if;

  select *
  into v_session
  from village.inventory_audit_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'inventory audit session not found' using errcode = 'P0002';
  end if;
  if v_session.started_by <> p_actor_id then
    raise exception 'inventory audit session belongs to another user' using errcode = '42501';
  end if;

  select *
  into v_observation
  from village.inventory_audit_observations
  where id = p_observation_id
  for update;

  if not found then
    raise exception 'inventory audit observation not found' using errcode = 'P0002';
  end if;
  if v_observation.session_id <> p_session_id or v_observation.observed_by <> p_actor_id then
    raise exception 'inventory audit observation belongs to another session or user'
      using errcode = '42501';
  end if;

  select evidence.ref
  into v_existing_ref
  from jsonb_array_elements(v_observation.evidence_refs) as evidence(ref)
  where evidence.ref ->> 'id' = p_evidence_id::text
  limit 1;

  if not found then
    return jsonb_build_object(
      'evidence_id', p_evidence_id,
      'aborted', true,
      'reused', true
    );
  end if;
  if v_existing_ref ->> 'status' = 'uploaded' then
    raise exception 'uploaded evidence cannot be aborted' using errcode = 'P0001';
  end if;
  if v_existing_ref ->> 'status' <> 'pending' then
    raise exception 'inventory audit evidence reservation status is invalid'
      using errcode = '40001';
  end if;

  select coalesce(
    jsonb_agg(evidence.ref order by evidence.ordinality)
      filter (where evidence.ref ->> 'id' <> p_evidence_id::text),
    '[]'::jsonb
  )
  into v_refs
  from jsonb_array_elements(v_observation.evidence_refs)
    with ordinality as evidence(ref, ordinality);

  update village.inventory_audit_observations
  set evidence_refs = v_refs
  where id = p_observation_id;

  return jsonb_build_object(
    'evidence_id', p_evidence_id,
    'aborted', true,
    'reused', false
  );
end;
$$;

revoke execute on function village.abort_inventory_audit_evidence(uuid, uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function village.abort_inventory_audit_evidence(uuid, uuid, uuid, uuid)
  to service_role;

create function village.request_inventory_audit_recount(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = village, public
as $$
declare
  v_source village.inventory_audit_sessions%rowtype;
  v_child_id uuid;
  v_child_status text;
  v_snapshot_count integer;
  v_cutoff_at timestamptz;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('village.inventory_audit.full_shop', 0)
  );

  select *
  into v_source
  from village.inventory_audit_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'inventory audit session not found' using errcode = 'P0002';
  end if;

  if v_source.status = 'recount_requested' then
    select id, status
    into v_child_id, v_child_status
    from village.inventory_audit_sessions
    where parent_session_id = p_session_id
    order by created_at desc
    limit 1;

    if v_child_id is null then
      raise exception 'recount_requested session has no child session' using errcode = 'P0001';
    end if;

    select count(*)::integer
    into v_snapshot_count
    from village.inventory_audit_snapshot_items
    where session_id = v_child_id;

    return jsonb_build_object(
      'session_id', v_child_id,
      'status', v_child_status,
      'reused', true,
      'snapshot_count', v_snapshot_count
    );
  end if;

  if v_source.status not in ('submitted', 'in_review') then
    raise exception 'inventory audit session cannot request recount from status %', v_source.status
      using errcode = 'P0001';
  end if;

  perform 1
  from village.inventory_audit_snapshot_rental_exceptions
  where session_id = p_session_id
  order by id
  for update;

  if exists (
    select 1
    from village.inventory_audit_snapshot_rental_exceptions as rental_exception
    where rental_exception.session_id = p_session_id
      and rental_exception.resolution is null
  ) then
    raise exception 'unresolved rental exception blocks recount'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from village.inventory_audit_snapshot_rental_exceptions as rental_exception
    where rental_exception.session_id = p_session_id
      and rental_exception.resolution = 'existing_equipment'
      and not exists (
        select 1
        from village.inventory_audit_snapshot_items as snapshot
        where snapshot.session_id = rental_exception.session_id
          and snapshot.equipment_id = rental_exception.resolved_equipment_id
      )
  ) then
    raise exception 'resolved equipment for rental exception is outside the source snapshot'
      using errcode = 'P0001';
  end if;

  perform 1
  from village.inventory_audit_decisions
  where session_id = p_session_id
  order by id
  for update;

  if not exists (
    select 1
    from village.inventory_audit_decisions
    where session_id = p_session_id
      and decision = 'recount'
  ) then
    raise exception 'recount request requires at least one recount decision' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from village.inventory_audit_decisions as decision_row
    where decision_row.session_id = p_session_id
      and decision_row.decision = 'recount'
      and (
        coalesce(decision_row.equipment_id, decision_row.resolved_equipment_id) is null
        or not exists (
          select 1
          from village.inventory_audit_snapshot_items as snapshot
          where snapshot.session_id = p_session_id
            and snapshot.equipment_id = coalesce(
              decision_row.equipment_id,
              decision_row.resolved_equipment_id
            )
        )
      )
  ) then
    raise exception 'unresolved recount decision cannot create child session'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from village.inventory_audit_sessions
    where mode = 'full_shop'
      and status = 'draft'
  ) then
    raise exception 'full_shop inventory audit draft already active' using errcode = 'P0001';
  end if;

  v_cutoff_at := pg_catalog.clock_timestamp();
  insert into village.inventory_audit_sessions (
    mode,
    status,
    cutoff_at,
    started_by,
    started_by_email,
    movement_frozen,
    started_at,
    parent_session_id
  ) values (
    'full_shop',
    'draft',
    v_cutoff_at,
    v_source.started_by,
    v_source.started_by_email,
    true,
    v_cutoff_at,
    p_session_id
  )
  returning id into v_child_id;

  insert into village.inventory_audit_snapshot_items (
    session_id,
    equipment_id,
    name,
    aliases,
    major,
    category,
    ledger_stock_total,
    ledger_stock_maint,
    ledger_state,
    ledger_open_issues,
    ledger_updated_at,
    active_rental_qty,
    active_rental_refs,
    rental_match_status
  )
  select
    v_child_id,
    ledger.equipment_id,
    ledger.name,
    ledger.aliases,
    ledger.major,
    ledger.category,
    ledger.stock_total,
    ledger.stock_maint,
    ledger.state,
    ledger.open_issues,
    ledger.updated_at,
    snapshot.active_rental_qty,
    snapshot.active_rental_refs,
    snapshot.rental_match_status
  from village.inventory_audit_snapshot_items as snapshot
  join village.equipment_ledger as ledger
    on ledger.equipment_id = snapshot.equipment_id
  where snapshot.session_id = p_session_id
    and exists (
      select 1
      from village.inventory_audit_decisions as decision_row
      where decision_row.session_id = p_session_id
        and decision_row.decision = 'recount'
        and coalesce(decision_row.equipment_id, decision_row.resolved_equipment_id) = snapshot.equipment_id
    );

  get diagnostics v_snapshot_count = row_count;
  if v_snapshot_count = 0 then
    raise exception 'recount decisions must resolve to at least one existing equipment item'
      using errcode = 'P0001';
  end if;

  update village.inventory_audit_sessions
  set status = 'recount_requested',
      movement_frozen = false
  where id = p_session_id;

  return jsonb_build_object(
    'session_id', v_child_id,
    'reused', false,
    'snapshot_count', v_snapshot_count,
    'cutoff_at', v_cutoff_at
  );
end;
$$;

revoke execute on function village.request_inventory_audit_recount(uuid) from public, anon, authenticated;
grant execute on function village.request_inventory_audit_recount(uuid) to service_role;

create function village.approve_inventory_audit(
  p_session_id uuid,
  p_approved_by uuid,
  p_approved_by_email text
)
returns jsonb
language plpgsql
security definer
set search_path = village, public
as $$
declare
  v_session village.inventory_audit_sessions%rowtype;
  v_snapshot village.inventory_audit_snapshot_items%rowtype;
  v_decision village.inventory_audit_decisions%rowtype;
  v_ledger village.equipment_ledger%rowtype;
  v_before jsonb;
  v_after jsonb;
  v_target_id text;
  v_verify_status text;
  v_observed_at timestamptz;
  v_observed_by_email text;
  v_approved_at timestamptz;
  v_updated_count integer := 0;
  v_created_count integer := 0;
begin
  if p_approved_by is null or nullif(btrim(p_approved_by_email), '') is null then
    raise exception 'inventory audit approver identity is required' using errcode = '22023';
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

  if v_session.status = 'approved' then
    return jsonb_build_object(
      'session_id', p_session_id,
      'status', 'approved',
      'reused', true
    );
  end if;

  if v_session.status not in ('submitted', 'in_review') then
    raise exception 'inventory audit session cannot be approved from status %', v_session.status
      using errcode = 'P0001';
  end if;

  perform 1
  from village.inventory_audit_decisions
  where session_id = p_session_id
  order by id
  for update;

  perform 1
  from village.inventory_audit_snapshot_rental_exceptions
  where session_id = p_session_id
  order by id
  for update;

  if exists (
    select 1
    from village.inventory_audit_snapshot_rental_exceptions as rental_exception
    where rental_exception.session_id = p_session_id
      and rental_exception.resolution is null
  ) then
    raise exception 'unresolved rental exception blocks approval'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from village.inventory_audit_snapshot_rental_exceptions as rental_exception
    where rental_exception.session_id = p_session_id
      and rental_exception.resolution = 'existing_equipment'
      and not exists (
        select 1
        from village.inventory_audit_snapshot_items as snapshot
        where snapshot.session_id = rental_exception.session_id
          and snapshot.equipment_id = rental_exception.resolved_equipment_id
      )
  ) then
    raise exception 'resolved equipment for rental exception is outside the session snapshot'
      using errcode = 'P0001';
  end if;

  perform 1
  from village.equipment_ledger as ledger
  join village.inventory_audit_snapshot_items as snapshot
    on snapshot.equipment_id = ledger.equipment_id
  where snapshot.session_id = p_session_id
  order by ledger.equipment_id
  for update of ledger;

  if exists (
    select 1
    from village.inventory_audit_snapshot_items as snapshot
    where snapshot.session_id = p_session_id
      and not exists (
        select 1
        from village.inventory_audit_decisions as decision_row
        where decision_row.session_id = snapshot.session_id
          and (
            decision_row.equipment_id = snapshot.equipment_id
            or (
              decision_row.source_observation_id is not null
              and decision_row.resolution = 'existing_equipment'
              and decision_row.resolved_equipment_id = snapshot.equipment_id
            )
          )
      )
  ) then
    raise exception 'missing audit decision for one or more snapshot items' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from village.inventory_audit_decisions
    where session_id = p_session_id
      and decision = 'recount'
  ) then
    raise exception 'recount decisions must be completed before approval' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from village.inventory_audit_observations as observation
    left join village.inventory_audit_decisions as decision_row
      on decision_row.session_id = observation.session_id
      and decision_row.source_observation_id = observation.id
    where observation.session_id = p_session_id
      and observation.equipment_id is null
      and (
        decision_row.id is null
        or decision_row.resolution is null
        or decision_row.decision = 'recount'
      )
  ) then
    raise exception 'unresolved temporary observation blocks approval' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from village.inventory_audit_decisions as decision_row
    join village.inventory_audit_observations as observation
      on observation.id = decision_row.source_observation_id
    where decision_row.session_id = p_session_id
      and observation.session_id <> p_session_id
  ) then
    raise exception 'temporary observation decision belongs to another session' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from village.inventory_audit_decisions as decision_row
    left join village.inventory_audit_snapshot_items as snapshot
      on snapshot.session_id = decision_row.session_id
      and snapshot.equipment_id = decision_row.equipment_id
    where decision_row.session_id = p_session_id
      and decision_row.equipment_id is not null
      and snapshot.equipment_id is null
  ) then
    raise exception 'audit decision references equipment outside the session snapshot' using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from village.inventory_audit_decisions as decision_row
    left join village.inventory_audit_snapshot_items as snapshot
      on snapshot.session_id = decision_row.session_id
      and snapshot.equipment_id = decision_row.resolved_equipment_id
    where decision_row.session_id = p_session_id
      and decision_row.source_observation_id is not null
      and decision_row.resolution = 'existing_equipment'
      and snapshot.equipment_id is null
  ) then
    raise exception 'resolved existing equipment is outside the session snapshot' using errcode = 'P0001';
  end if;

  if exists (
    select effective_target.equipment_id
    from (
      select coalesce(decision_row.equipment_id, decision_row.resolved_equipment_id) as equipment_id
      from village.inventory_audit_decisions as decision_row
      where decision_row.session_id = p_session_id
        and (
          decision_row.equipment_id is not null
          or decision_row.resolution = 'existing_equipment'
        )
    ) as effective_target
    where effective_target.equipment_id is not null
    group by effective_target.equipment_id
    having count(*) > 1
  ) then
    raise exception 'multiple inventory audit decisions target equipment'
      using errcode = 'P0001';
  end if;

  v_approved_at := pg_catalog.clock_timestamp();

  for v_snapshot in
    select snapshot.*
    from village.inventory_audit_snapshot_items as snapshot
    where snapshot.session_id = p_session_id
    order by snapshot.equipment_id
  loop
    select decision_row.*
    into strict v_decision
    from village.inventory_audit_decisions as decision_row
    where decision_row.session_id = p_session_id
      and (
        decision_row.equipment_id = v_snapshot.equipment_id
        or (
          decision_row.source_observation_id is not null
          and decision_row.resolution = 'existing_equipment'
          and decision_row.resolved_equipment_id = v_snapshot.equipment_id
        )
      );

    select *
    into strict v_ledger
    from village.equipment_ledger
    where equipment_id = v_snapshot.equipment_id;

    if v_decision.reviewed_ledger_updated_at is distinct from v_ledger.updated_at then
      raise exception 'ledger version conflict for equipment %', v_snapshot.equipment_id
        using errcode = '40001';
    end if;

    if v_decision.decision = 'apply_audit'
       and (
         v_decision.final_stock_total is null
         or v_decision.final_stock_maint is null
         or v_decision.final_stock_maint > v_decision.final_stock_total
       ) then
      raise exception 'apply_audit decision requires valid final counts for equipment %', v_snapshot.equipment_id
        using errcode = 'P0001';
    end if;

    v_before := jsonb_build_object(
      'stock_total', v_ledger.stock_total,
      'stock_maint', v_ledger.stock_maint,
      'state', v_ledger.state,
      'open_issues', v_ledger.open_issues,
      'updated_at', v_ledger.updated_at
    );

    v_observed_at := null;
    v_observed_by_email := null;

    if v_decision.decision = 'apply_audit' then
      select observation.client_updated_at, observation.observed_by_email
      into v_observed_at, v_observed_by_email
      from village.inventory_audit_observations as observation
      where observation.session_id = p_session_id
        and (
          observation.id = v_decision.source_observation_id
          or (
            v_decision.source_observation_id is null
            and observation.equipment_id = v_snapshot.equipment_id
          )
        )
      order by observation.client_updated_at desc, observation.id desc
      limit 1;
    end if;

    v_verify_status := case
      when jsonb_array_length(
        case
          when v_decision.decision = 'apply_audit' then v_decision.final_open_issues
          else v_ledger.open_issues
        end
      ) > 0
        or case
          when v_decision.decision = 'apply_audit' then v_decision.final_stock_maint
          else v_ledger.stock_maint
        end > 0
        or case
          when v_decision.decision = 'apply_audit' then coalesce(v_decision.final_state, v_ledger.state)
          else v_ledger.state
        end <> '정상'
      then 'attention'
      else 'verified'
    end;

    update village.equipment_ledger
    set stock_total = case
          when v_decision.decision = 'apply_audit' then v_decision.final_stock_total
          else stock_total
        end,
        stock_maint = case
          when v_decision.decision = 'apply_audit' then v_decision.final_stock_maint
          else stock_maint
        end,
        state = case
          when v_decision.decision = 'apply_audit' then coalesce(v_decision.final_state, state)
          else state
        end,
        open_issues = case
          when v_decision.decision = 'apply_audit' then v_decision.final_open_issues
          else open_issues
        end,
        verify_status = v_verify_status,
        last_verified_at = case
          when v_decision.decision = 'apply_audit' and v_observed_at is not null
            then v_observed_at
          else last_verified_at
        end,
        last_verified_by = case
          when v_decision.decision = 'apply_audit' and v_observed_at is not null
            then v_observed_by_email
          else last_verified_by
        end
    where equipment_id = v_snapshot.equipment_id
    returning * into v_ledger;

    v_after := jsonb_build_object(
      'stock_total', v_ledger.stock_total,
      'stock_maint', v_ledger.stock_maint,
      'state', v_ledger.state,
      'open_issues', v_ledger.open_issues,
      'updated_at', v_ledger.updated_at
    );

    insert into village.equipment_events (equipment_id, type, payload, actor)
    values (
      v_snapshot.equipment_id,
      'inventory_audit_approved',
      jsonb_build_object(
        'audit_session_id', p_session_id,
        'audit_decision_id', v_decision.id,
        'decision', v_decision.decision,
        'before', v_before,
        'after', v_after,
        'counted_by', jsonb_build_object(
          'id', v_session.started_by,
          'email', v_session.started_by_email
        ),
        'approved_by', jsonb_build_object(
          'id', p_approved_by,
          'email', btrim(p_approved_by_email)
        ),
        'approved_at', v_approved_at
      ),
      btrim(p_approved_by_email)
    );

    v_updated_count := v_updated_count + 1;
  end loop;

  for v_decision in
    select decision_row.*
    from village.inventory_audit_decisions as decision_row
    where decision_row.session_id = p_session_id
      and decision_row.source_observation_id is not null
      and decision_row.resolution = 'create_equipment'
    order by decision_row.id
  loop
    v_target_id := coalesce(
      nullif(btrim(v_decision.resolved_equipment_id), ''),
      nullif(btrim(v_decision.new_equipment_payload ->> 'equipment_id'), '')
    );

    if v_target_id is null
       or v_decision.decision <> 'apply_audit'
       or nullif(btrim(v_decision.new_equipment_payload ->> 'name'), '') is null
       or v_decision.final_stock_total is null
       or v_decision.final_stock_maint is null
       or v_decision.final_stock_maint > v_decision.final_stock_total then
      raise exception 'create_equipment resolution requires id, name, and valid final counts'
        using errcode = 'P0001';
    end if;

    v_verify_status := case
      when jsonb_array_length(v_decision.final_open_issues) > 0
        or v_decision.final_stock_maint > 0
        or coalesce(
          v_decision.final_state,
          nullif(btrim(v_decision.new_equipment_payload ->> 'state'), ''),
          '정상'
        ) <> '정상'
      then 'attention'
      else 'verified'
    end;

    select observation.client_updated_at, observation.observed_by_email
    into strict v_observed_at, v_observed_by_email
    from village.inventory_audit_observations as observation
    where observation.id = v_decision.source_observation_id
      and observation.session_id = p_session_id;

    if exists (
      select 1 from village.equipment_ledger where equipment_id = v_target_id
    ) then
      raise exception 'new equipment id % already exists', v_target_id using errcode = '23505';
    end if;

    insert into village.equipment_ledger (
      equipment_id,
      major,
      category,
      name,
      aliases,
      stock_total,
      stock_maint,
      price,
      state,
      note,
      verify_status,
      last_verified_at,
      last_verified_by,
      open_issues,
      source
    ) values (
      v_target_id,
      nullif(btrim(v_decision.new_equipment_payload ->> 'major'), ''),
      nullif(btrim(v_decision.new_equipment_payload ->> 'category'), ''),
      btrim(v_decision.new_equipment_payload ->> 'name'),
      coalesce(v_decision.new_equipment_payload -> 'aliases', '[]'::jsonb),
      v_decision.final_stock_total,
      v_decision.final_stock_maint,
      case
        when v_decision.new_equipment_payload ? 'price'
          then (v_decision.new_equipment_payload ->> 'price')::integer
        else null
      end,
      coalesce(v_decision.final_state, nullif(btrim(v_decision.new_equipment_payload ->> 'state'), ''), '정상'),
      nullif(btrim(v_decision.new_equipment_payload ->> 'note'), ''),
      v_verify_status,
      v_observed_at,
      v_observed_by_email,
      v_decision.final_open_issues,
      'inventory-audit:' || p_session_id::text
    );

    update village.inventory_audit_decisions
    set resolved_equipment_id = v_target_id
    where id = v_decision.id;

    insert into village.equipment_events (equipment_id, type, payload, actor)
    values (
      v_target_id,
      'inventory_audit_created',
      jsonb_build_object(
        'audit_session_id', p_session_id,
        'audit_decision_id', v_decision.id,
        'source_observation_id', v_decision.source_observation_id,
        'before', null,
        'after', jsonb_build_object(
          'stock_total', v_decision.final_stock_total,
          'stock_maint', v_decision.final_stock_maint,
          'state', coalesce(v_decision.final_state, v_decision.new_equipment_payload ->> 'state', '정상'),
          'open_issues', v_decision.final_open_issues
        ),
        'counted_by', jsonb_build_object(
          'id', v_session.started_by,
          'email', v_session.started_by_email
        ),
        'approved_by', jsonb_build_object(
          'id', p_approved_by,
          'email', btrim(p_approved_by_email)
        ),
        'approved_at', v_approved_at
      ),
      btrim(p_approved_by_email)
    );

    v_created_count := v_created_count + 1;
  end loop;

  update village.inventory_audit_sessions
  set status = 'approved',
      movement_frozen = false,
      approved_at = v_approved_at,
      approved_by = p_approved_by,
      approved_by_email = btrim(p_approved_by_email),
      mirror_status = 'pending'
  where id = p_session_id;

  return jsonb_build_object(
    'session_id', p_session_id,
    'status', 'approved',
    'reused', false,
    'updated_equipment_count', v_updated_count,
    'created_equipment_count', v_created_count,
    'approved_at', v_approved_at
  );
end;
$$;

revoke execute on function village.approve_inventory_audit(uuid, uuid, text) from public, anon, authenticated;
grant execute on function village.approve_inventory_audit(uuid, uuid, text) to service_role;

commit;
