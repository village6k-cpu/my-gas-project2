begin;

alter table village.inventory_audit_sessions
  add column mirror_attempt_count integer not null default 0,
  add column mirror_last_attempt_at timestamptz,
  add column mirror_synced_at timestamptz,
  add column mirror_last_error_code text,
  add column mirror_last_ledger_row_count integer,
  add column mirror_last_sheet_row_count integer,
  add column mirror_last_update_count integer,
  add column mirror_last_append_count integer,
  add column mirror_last_updated_count integer,
  add column mirror_last_appended_count integer,
  add constraint inventory_audit_sessions_mirror_attempt_count_nonnegative
    check (mirror_attempt_count >= 0),
  add constraint inventory_audit_sessions_mirror_counts_nonnegative
    check (
      (mirror_last_ledger_row_count is null or mirror_last_ledger_row_count >= 0)
      and (mirror_last_sheet_row_count is null or mirror_last_sheet_row_count >= 0)
      and (mirror_last_update_count is null or mirror_last_update_count >= 0)
      and (mirror_last_append_count is null or mirror_last_append_count >= 0)
      and (mirror_last_updated_count is null or mirror_last_updated_count >= 0)
      and (mirror_last_appended_count is null or mirror_last_appended_count >= 0)
    );

create table village.inventory_audit_mirror_attempts (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null
    references village.inventory_audit_sessions(id) on delete restrict,
  attempt_token uuid not null unique,
  status text not null default 'running',
  claimed_by uuid not null,
  claimed_by_email text not null,
  claimed_at timestamptz not null default now(),
  lease_expires_at timestamptz not null,
  completed_at timestamptz,
  ledger_row_count integer,
  sheet_row_count integer,
  update_count integer,
  append_count integer,
  wrote boolean,
  updated_count integer,
  appended_count integer,
  already_current boolean,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_audit_mirror_attempts_status_check
    check (status in ('running', 'synced', 'failed')),
  constraint inventory_audit_mirror_attempts_email_check
    check (nullif(btrim(claimed_by_email), '') is not null),
  constraint inventory_audit_mirror_attempts_lease_check
    check (lease_expires_at > claimed_at),
  constraint inventory_audit_mirror_attempts_counts_nonnegative
    check (
      (ledger_row_count is null or ledger_row_count >= 0)
      and (sheet_row_count is null or sheet_row_count >= 0)
      and (update_count is null or update_count >= 0)
      and (append_count is null or append_count >= 0)
      and (updated_count is null or updated_count >= 0)
      and (appended_count is null or appended_count >= 0)
    ),
  constraint inventory_audit_mirror_attempts_terminal_shape
    check (
      (
        status = 'running'
        and completed_at is null
        and error_code is null
      )
      or
      (
        status = 'synced'
        and completed_at is not null
        and error_code is null
        and ledger_row_count is not null
        and sheet_row_count is not null
        and update_count is not null
        and append_count is not null
        and wrote is not null
        and updated_count is not null
        and appended_count is not null
        and already_current is not null
      )
      or
      (
        status = 'failed'
        and completed_at is not null
        and error_code is not null
      )
    )
);

create unique index inventory_audit_mirror_one_running
  on village.inventory_audit_mirror_attempts ((true))
  where status = 'running';
create index inventory_audit_mirror_attempts_session_idx
  on village.inventory_audit_mirror_attempts (session_id, created_at desc);

create trigger inventory_audit_mirror_attempts_touch_updated_at
before update on village.inventory_audit_mirror_attempts
for each row execute function village.touch_updated_at();

alter table village.inventory_audit_mirror_attempts enable row level security;
revoke all on village.inventory_audit_mirror_attempts from public, anon, authenticated;
grant all on village.inventory_audit_mirror_attempts to service_role;

create function village.claim_inventory_audit_mirror(
  p_session_id uuid,
  p_claimed_by uuid,
  p_claimed_by_email text
)
returns jsonb
language plpgsql
security definer
set search_path = village, public
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_session village.inventory_audit_sessions%rowtype;
  v_running village.inventory_audit_mirror_attempts%rowtype;
  v_attempt_token uuid := gen_random_uuid();
begin
  if p_session_id is null
     or p_claimed_by is null
     or nullif(btrim(p_claimed_by_email), '') is null then
    raise exception 'inventory audit mirror claim identity is required'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('village.inventory_audit.mirror', 0)
  );

  with expired as (
    update village.inventory_audit_mirror_attempts as attempt
    set status = 'failed',
        completed_at = v_now,
        error_code = 'mirror_lease_expired'
    where attempt.status = 'running'
      and attempt.lease_expires_at <= v_now
    returning attempt.session_id
  )
  update village.inventory_audit_sessions as audit_session
  set mirror_status = 'failed',
      mirror_last_error_code = 'mirror_lease_expired'
  where audit_session.id in (select session_id from expired)
    and audit_session.status = 'approved'
    and audit_session.mirror_status = 'pending';

  select *
  into v_session
  from village.inventory_audit_sessions
  where id = p_session_id
  for update;

  if not found then
    raise exception 'inventory audit session not found' using errcode = 'P0002';
  end if;

  if v_session.status <> 'approved' then
    return jsonb_build_object(
      'state', 'unapproved',
      'session_id', p_session_id,
      'session_status', v_session.status
    );
  end if;

  if v_session.mirror_status = 'synced' then
    return jsonb_build_object(
      'state', 'synced',
      'session_id', p_session_id,
      'reused', true,
      'ledger_row_count', v_session.mirror_last_ledger_row_count,
      'sheet_row_count', v_session.mirror_last_sheet_row_count,
      'update_count', v_session.mirror_last_update_count,
      'append_count', v_session.mirror_last_append_count,
      'updated_count', v_session.mirror_last_updated_count,
      'appended_count', v_session.mirror_last_appended_count,
      'synced_at', v_session.mirror_synced_at
    );
  end if;

  select *
  into v_running
  from village.inventory_audit_mirror_attempts as attempt
  where attempt.status = 'running'
    and attempt.lease_expires_at > v_now
  order by attempt.claimed_at
  limit 1
  for update;

  if found then
    return jsonb_build_object(
      'state', 'busy',
      'session_id', p_session_id,
      'retry_after_seconds',
        greatest(1, ceil(extract(epoch from (v_running.lease_expires_at - v_now)))::integer)
    );
  end if;

  insert into village.inventory_audit_mirror_attempts (
    session_id,
    attempt_token,
    status,
    claimed_by,
    claimed_by_email,
    claimed_at,
    lease_expires_at
  ) values (
    p_session_id,
    v_attempt_token,
    'running',
    p_claimed_by,
    btrim(p_claimed_by_email),
    v_now,
    v_now + interval '10 minutes'
  );

  update village.inventory_audit_sessions
  set mirror_status = 'pending',
      mirror_attempt_count = mirror_attempt_count + 1,
      mirror_last_attempt_at = v_now,
      mirror_last_error_code = null,
      mirror_last_ledger_row_count = null,
      mirror_last_sheet_row_count = null,
      mirror_last_update_count = null,
      mirror_last_append_count = null,
      mirror_last_updated_count = null,
      mirror_last_appended_count = null
  where id = p_session_id;

  return jsonb_build_object(
    'state', 'claimed',
    'session_id', p_session_id,
    'attempt_token', v_attempt_token,
    'lease_expires_at', v_now + interval '10 minutes'
  );
end;
$$;

revoke execute on function village.claim_inventory_audit_mirror(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function village.claim_inventory_audit_mirror(uuid, uuid, text)
  to service_role;

create function village.complete_inventory_audit_mirror(
  p_session_id uuid,
  p_attempt_token uuid,
  p_ledger_row_count integer,
  p_sheet_row_count integer,
  p_update_count integer,
  p_append_count integer,
  p_wrote boolean,
  p_updated_count integer,
  p_appended_count integer,
  p_already_current boolean,
  p_ledger_version_token jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = village, public
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_changed integer := 0;
  v_existing_status text;
  v_token_count bigint := 0;
  v_token_distinct_count bigint := 0;
  v_ledger_count bigint := 0;
begin
  if p_session_id is null
     or p_attempt_token is null
     or p_ledger_row_count is null or p_ledger_row_count < 0
     or p_sheet_row_count is null or p_sheet_row_count < 0
     or p_update_count is null or p_update_count < 0
     or p_append_count is null or p_append_count < 0
     or p_updated_count is null or p_updated_count < 0
     or p_appended_count is null or p_appended_count < 0
     or p_wrote is null
     or p_already_current is null
     or p_ledger_version_token is null
     or jsonb_typeof(p_ledger_version_token) <> 'array' then
    raise exception 'inventory audit mirror completion values are invalid'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(p_ledger_version_token) as token(value)
    where jsonb_typeof(token.value) <> 'object'
      or nullif(btrim(token.value ->> 'equipment_id'), '') is null
      or nullif(btrim(token.value ->> 'updated_at'), '') is null
  ) then
    raise exception 'inventory audit mirror ledger version token is invalid'
      using errcode = '22023';
  end if;
  if p_update_count <> p_updated_count
     or p_append_count <> p_appended_count then
    raise exception 'inventory audit mirror completion counts do not match'
      using errcode = '22023';
  end if;
  if p_already_current
     and (p_wrote or p_update_count <> 0 or p_append_count <> 0) then
    raise exception 'already-current mirror completion cannot contain writes'
      using errcode = '22023';
  end if;
  if not p_already_current and not p_wrote then
    raise exception 'changed mirror completion must contain a verified write'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('village.inventory_audit.mirror', 0)
  );

  lock table village.equipment_ledger in share mode;

  select
    count(*),
    count(distinct btrim(token.value ->> 'equipment_id'))
  into v_token_count, v_token_distinct_count
  from jsonb_array_elements(p_ledger_version_token) as token(value);

  if v_token_count <> v_token_distinct_count then
    raise exception 'inventory audit mirror ledger version token contains duplicate ids'
      using errcode = '22023';
  end if;

  select count(*)
  into v_ledger_count
  from village.equipment_ledger;

  if v_token_count <> p_ledger_row_count
     or v_ledger_count <> p_ledger_row_count
     or exists (
       with token as (
         select
           btrim(entry.value ->> 'equipment_id') as equipment_id,
           (entry.value ->> 'updated_at')::timestamptz as updated_at
         from jsonb_array_elements(p_ledger_version_token) as entry(value)
       )
       select 1
       from village.equipment_ledger as ledger
       full join token on token.equipment_id = ledger.equipment_id
       where ledger.equipment_id is null
          or token.equipment_id is null
          or ledger.updated_at is distinct from token.updated_at
     ) then
    raise exception 'inventory audit mirror ledger version changed'
      using errcode = '40001';
  end if;

  update village.inventory_audit_mirror_attempts as attempt
  set status = 'synced',
      completed_at = v_now,
      ledger_row_count = p_ledger_row_count,
      sheet_row_count = p_sheet_row_count,
      update_count = p_update_count,
      append_count = p_append_count,
      wrote = p_wrote,
      updated_count = p_updated_count,
      appended_count = p_appended_count,
      already_current = p_already_current,
      error_code = null
  where attempt.session_id = p_session_id
    and attempt.attempt_token = p_attempt_token
    and attempt.status = 'running'
    and attempt.lease_expires_at > v_now;
  get diagnostics v_changed = row_count;

  if v_changed <> 1 then
    select status
    into v_existing_status
    from village.inventory_audit_mirror_attempts
    where session_id = p_session_id
      and attempt_token = p_attempt_token;

    if v_existing_status = 'synced' then
      return jsonb_build_object(
        'state', 'synced',
        'session_id', p_session_id,
        'reused', true
      );
    end if;
    return jsonb_build_object(
      'state', 'stale',
      'session_id', p_session_id
    );
  end if;

  update village.inventory_audit_sessions
  set mirror_status = 'synced',
      mirror_synced_at = v_now,
      mirror_last_error_code = null,
      mirror_last_ledger_row_count = p_ledger_row_count,
      mirror_last_sheet_row_count = p_sheet_row_count,
      mirror_last_update_count = p_update_count,
      mirror_last_append_count = p_append_count,
      mirror_last_updated_count = p_updated_count,
      mirror_last_appended_count = p_appended_count
  where id = p_session_id
    and status = 'approved';
  get diagnostics v_changed = row_count;

  if v_changed <> 1 then
    raise exception 'approved inventory audit session missing during mirror completion'
      using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'state', 'synced',
    'session_id', p_session_id,
    'reused', false,
    'synced_at', v_now
  );
end;
$$;

revoke execute on function village.complete_inventory_audit_mirror(
  uuid, uuid, integer, integer, integer, integer, boolean, integer, integer, boolean, jsonb
) from public, anon, authenticated;
grant execute on function village.complete_inventory_audit_mirror(
  uuid, uuid, integer, integer, integer, integer, boolean, integer, integer, boolean, jsonb
) to service_role;

create function village.fail_inventory_audit_mirror(
  p_session_id uuid,
  p_attempt_token uuid,
  p_error_code text
)
returns jsonb
language plpgsql
security definer
set search_path = village, public
as $$
declare
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_changed integer := 0;
  v_error_code text := lower(btrim(coalesce(p_error_code, '')));
begin
  if p_session_id is null or p_attempt_token is null then
    raise exception 'inventory audit mirror failure identity is required'
      using errcode = '22023';
  end if;
  if v_error_code not in (
    'mirror_service_unavailable',
    'mirror_ledger_read_failed',
    'mirror_upstream_timeout',
    'mirror_upstream_failed',
    'mirror_sheet_contract_invalid',
    'mirror_duplicate_equipment_id',
    'mirror_result_mismatch',
    'mirror_verification_failed',
    'mirror_attempt_stale',
    'mirror_ledger_changed',
    'mirror_lease_expired'
  ) then
    v_error_code := 'mirror_upstream_failed';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('village.inventory_audit.mirror', 0)
  );

  update village.inventory_audit_mirror_attempts as attempt
  set status = 'failed',
      completed_at = v_now,
      error_code = v_error_code
  where attempt.session_id = p_session_id
    and attempt.attempt_token = p_attempt_token
    and attempt.status = 'running';
  get diagnostics v_changed = row_count;

  if v_changed <> 1 then
    return jsonb_build_object(
      'state', 'stale',
      'session_id', p_session_id
    );
  end if;

  update village.inventory_audit_sessions
  set mirror_status = 'failed',
      mirror_last_error_code = v_error_code
  where id = p_session_id
    and status = 'approved'
    and mirror_status = 'pending';

  return jsonb_build_object(
    'state', 'failed',
    'session_id', p_session_id,
    'error_code', v_error_code
  );
end;
$$;

revoke execute on function village.fail_inventory_audit_mirror(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function village.fail_inventory_audit_mirror(uuid, uuid, text)
  to service_role;

commit;
