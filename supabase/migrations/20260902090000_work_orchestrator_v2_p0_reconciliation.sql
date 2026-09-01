set lock_timeout = '5s';

create or replace function public.is_due_p0_delivery_v2(
  p_payload jsonb,
  p_first_opened_at timestamptz,
  p_now timestamptz
) returns boolean language plpgsql stable security invoker set search_path = '' as $$
declare
  v_delivery jsonb;
  v_status text;
  v_attempt integer;
  v_due_at timestamptz;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object'
    or p_first_opened_at is null or not isfinite(p_first_opened_at)
    or p_now is null or not isfinite(p_now) then
    return true;
  end if;
  v_delivery := p_payload->'p0_delivery';
  if v_delivery is null then
    return p_first_opened_at + interval '10 minutes' <= p_now;
  end if;
  if jsonb_typeof(v_delivery) <> 'object'
    or not (v_delivery ?& array['status','generation','attempt','client_message_id'])
    or jsonb_typeof(v_delivery->'generation') <> 'number'
    or jsonb_typeof(v_delivery->'attempt') <> 'number'
    or jsonb_typeof(v_delivery->'client_message_id') <> 'string' then
    return true;
  end if;
  begin
    v_status := v_delivery->>'status';
    v_attempt := (v_delivery->>'attempt')::integer;
    if (v_delivery->>'generation')::integer <> v_attempt
      or v_attempt < 1
      or (v_delivery->>'client_message_id') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      return true;
    end if;
    if v_status = 'claimed' then
      if not public.is_canonical_p0_timestamp_v2(v_delivery->>'claimed_at')
        or not public.is_canonical_p0_timestamp_v2(v_delivery->>'claim_expires_at') then return true; end if;
      v_due_at := (v_delivery->>'claim_expires_at')::timestamptz;
      return v_due_at <= p_now;
    elsif v_status = 'reconcile_pending' then
      if not public.is_canonical_p0_timestamp_v2(v_delivery->>'claimed_at')
        or not public.is_canonical_p0_timestamp_v2(v_delivery->>'claim_expires_at')
        or not public.is_canonical_p0_timestamp_v2(v_delivery->>'last_attempt_at')
        or not public.is_canonical_p0_timestamp_v2(v_delivery->>'next_at') then return true; end if;
      v_due_at := (v_delivery->>'next_at')::timestamptz;
      return v_due_at <= p_now;
    elsif v_status = 'reconciling' then
      if not public.is_canonical_p0_timestamp_v2(v_delivery->>'claimed_at')
        or not public.is_canonical_p0_timestamp_v2(v_delivery->>'claim_expires_at')
        or not public.is_canonical_p0_timestamp_v2(v_delivery->>'last_attempt_at')
        or not public.is_canonical_p0_timestamp_v2(v_delivery->>'next_at')
        or not public.is_canonical_p0_timestamp_v2(v_delivery->>'reconcile_claimed_at')
        or not public.is_canonical_p0_timestamp_v2(v_delivery->>'reconcile_expires_at')
        or (v_delivery->>'reconcile_owner') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or (v_delivery->>'reconcile_token') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then return true; end if;
      v_due_at := (v_delivery->>'reconcile_expires_at')::timestamptz;
      return v_due_at <= p_now;
    elsif v_attempt >= 3 then
      return false;
    elsif v_status in ('retry_pending','delivered') then
      if not public.is_canonical_p0_timestamp_v2(v_delivery->>'next_at')
        or (v_status = 'retry_pending' and not public.is_canonical_p0_timestamp_v2(v_delivery->>'last_attempt_at'))
        or (v_status = 'delivered' and (
          not public.is_canonical_p0_timestamp_v2(v_delivery->>'delivered_at')
          or jsonb_typeof(v_delivery->'readback') <> 'object'
          or (v_delivery->'readback'->>'channel_id') !~ '^[A-Z0-9][A-Z0-9_-]{0,79}$'
          or (v_delivery->'readback'->>'message_ts') !~ '^[0-9]{1,20}\.[0-9]{1,20}$'
          or not public.is_canonical_p0_timestamp_v2(v_delivery->'readback'->>'confirmed_at')
        )) then return true; end if;
      v_due_at := (v_delivery->>'next_at')::timestamptz;
      return v_due_at <= p_now;
    end if;
    return true;
  exception when others then
    return true;
  end;
end;
$$;

create function public.claim_p0_reconciliation_v2(
  p_id uuid,
  p_expected_version integer,
  p_expected_status text,
  p_expected_generation integer,
  p_client_message_id uuid,
  p_reconcile_owner uuid,
  p_lease_seconds integer,
  p_now timestamptz
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.work_items_v2%rowtype;
  v_previous jsonb;
  v_delivery jsonb;
  v_due_at timestamptz;
begin
  if p_id is null or p_expected_version is null or p_expected_version < 1
    or p_expected_status not in ('claimed','reconcile_pending','reconciling')
    or p_expected_generation is null or p_expected_generation < 1
    or p_client_message_id is null
    or p_client_message_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_reconcile_owner is null
    or p_lease_seconds is null or p_lease_seconds not between 1 and 900
    or p_now is null or not isfinite(p_now) then
    raise exception 'invalid P0 reconciliation claim' using errcode = '22023';
  end if;
  select * into v_row from public.work_items_v2 where id = p_id for update;
  if not found or v_row.version <> p_expected_version or v_row.priority <> 'p0'
    or v_row.state not in ('open','in_progress','snoozed')
    or public.is_effective_p0_ack_v2(v_row.payload, p_now) then
    return jsonb_build_object('claimed', false, 'row', null);
  end if;
  v_previous := v_row.payload->'p0_delivery';
  if v_previous is null or coalesce(v_previous->>'status', '') <> p_expected_status
    or coalesce(v_previous->>'generation', '') <> p_expected_generation::text
    or coalesce(v_previous->>'attempt', '') <> p_expected_generation::text
    or coalesce(v_previous->>'client_message_id', '') <> p_client_message_id::text then
    return jsonb_build_object('claimed', false, 'row', null);
  end if;
  if jsonb_typeof(v_previous) <> 'object'
    or (p_expected_status = 'claimed' and (
      (select count(*) from pg_catalog.jsonb_object_keys(v_previous)) <> 6
      or not (v_previous ?& array['status','generation','attempt','client_message_id','claimed_at','claim_expires_at'])
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'claimed_at')
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'claim_expires_at')
    ))
    or (p_expected_status = 'reconcile_pending' and (
      (select count(*) from pg_catalog.jsonb_object_keys(v_previous)) <> 8
      or not (v_previous ?& array['status','generation','attempt','client_message_id','claimed_at','claim_expires_at','last_attempt_at','next_at'])
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'claimed_at')
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'claim_expires_at')
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'last_attempt_at')
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'next_at')
    ))
    or (p_expected_status = 'reconciling' and (
      (select count(*) from pg_catalog.jsonb_object_keys(v_previous)) <> 12
      or not (v_previous ?& array[
        'status','generation','attempt','client_message_id','claimed_at','claim_expires_at',
        'last_attempt_at','next_at','reconcile_owner','reconcile_token',
        'reconcile_claimed_at','reconcile_expires_at'
      ])
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'claimed_at')
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'claim_expires_at')
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'last_attempt_at')
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'next_at')
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'reconcile_claimed_at')
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'reconcile_expires_at')
      or (v_previous->>'reconcile_owner') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      or (v_previous->>'reconcile_token') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    )) then
    return jsonb_build_object('claimed', false, 'row', null);
  end if;
  begin
    v_due_at := case p_expected_status
      when 'claimed' then (v_previous->>'claim_expires_at')::timestamptz
      when 'reconcile_pending' then (v_previous->>'next_at')::timestamptz
      else (v_previous->>'reconcile_expires_at')::timestamptz
    end;
  exception when others then
    return jsonb_build_object('claimed', false, 'row', null);
  end;
  if v_due_at > p_now then return jsonb_build_object('claimed', false, 'row', null); end if;
  v_delivery := (v_previous - 'reconcile_owner' - 'reconcile_token'
    - 'reconcile_claimed_at' - 'reconcile_expires_at') || jsonb_build_object(
      'status', 'reconciling',
      'last_attempt_at', coalesce(v_previous->>'last_attempt_at', v_previous->>'claimed_at'),
      'next_at', coalesce(v_previous->>'next_at',
        to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      'reconcile_owner', p_reconcile_owner::text,
      'reconcile_token', gen_random_uuid()::text,
      'reconcile_claimed_at', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'reconcile_expires_at', to_char((p_now + make_interval(secs => p_lease_seconds)) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  update public.work_items_v2
  set payload = jsonb_set(payload, '{p0_delivery}', v_delivery, false)
  where id = p_id returning * into v_row;
  return jsonb_build_object('claimed', true, 'row', to_jsonb(v_row));
end;
$$;

revoke execute on function public.settle_p0_delivery_v2(uuid,integer,text,integer,uuid,text,timestamptz,text,text)
  from public, anon, authenticated, service_role;
drop function public.settle_p0_delivery_v2(uuid,integer,text,integer,uuid,text,timestamptz,text,text);

create function public.settle_p0_delivery_v2(
  p_id uuid,
  p_expected_version integer,
  p_expected_status text,
  p_expected_generation integer,
  p_client_message_id uuid,
  p_status text,
  p_recorded_at timestamptz,
  p_channel_id text,
  p_message_ts text,
  p_reconcile_owner uuid,
  p_reconcile_token uuid
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.work_items_v2%rowtype;
  v_previous jsonb;
  v_delivery jsonb;
  v_attempt integer;
  v_next_at timestamptz;
begin
  if p_id is null or p_expected_version is null or p_expected_version < 1
    or p_expected_status not in ('claimed','reconciling')
    or p_expected_generation is null or p_expected_generation < 1
    or p_client_message_id is null
    or p_client_message_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_status not in ('delivered','reconcile_pending','retry_pending')
    or p_recorded_at is null or not isfinite(p_recorded_at)
    or (p_expected_status = 'reconciling' and (p_reconcile_owner is null or p_reconcile_token is null))
    or (p_expected_status = 'claimed' and (p_reconcile_owner is not null or p_reconcile_token is not null))
    or (p_status = 'delivered' and (
      p_channel_id is null or p_channel_id !~ '^[A-Z0-9][A-Z0-9_-]{0,79}$'
      or p_message_ts is null or p_message_ts !~ '^[0-9]{1,20}\.[0-9]{1,20}$'
    )) or (p_status <> 'delivered' and (p_channel_id is not null or p_message_ts is not null)) then
    raise exception 'invalid P0 delivery settlement' using errcode = '22023';
  end if;
  select * into v_row from public.work_items_v2 where id = p_id for update;
  if not found or v_row.version <> p_expected_version or v_row.priority <> 'p0'
    or v_row.state not in ('open','in_progress','snoozed')
    or public.is_effective_p0_ack_v2(v_row.payload, p_recorded_at) then
    return jsonb_build_object('applied', false, 'row', null);
  end if;
  v_previous := v_row.payload->'p0_delivery';
  if v_previous is null or coalesce(v_previous->>'status', '') <> p_expected_status
    or coalesce(v_previous->>'generation', '') <> p_expected_generation::text
    or coalesce(v_previous->>'attempt', '') <> p_expected_generation::text
    or coalesce(v_previous->>'client_message_id', '') <> p_client_message_id::text
    or (p_expected_status = 'reconciling' and (
      coalesce(v_previous->>'reconcile_owner', '') <> p_reconcile_owner::text
      or coalesce(v_previous->>'reconcile_token', '') <> p_reconcile_token::text
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'reconcile_expires_at')
    )) then
    return jsonb_build_object('applied', false, 'row', null);
  end if;
  if jsonb_typeof(v_previous) <> 'object'
    or (p_expected_status = 'claimed' and (
      (select count(*) from pg_catalog.jsonb_object_keys(v_previous)) <> 6
      or not (v_previous ?& array['status','generation','attempt','client_message_id','claimed_at','claim_expires_at'])
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'claimed_at')
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'claim_expires_at')
    ))
    or (p_expected_status = 'reconciling' and (
      (select count(*) from pg_catalog.jsonb_object_keys(v_previous)) <> 12
      or not (v_previous ?& array[
        'status','generation','attempt','client_message_id','claimed_at','claim_expires_at',
        'last_attempt_at','next_at','reconcile_owner','reconcile_token',
        'reconcile_claimed_at','reconcile_expires_at'
      ])
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'claimed_at')
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'claim_expires_at')
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'last_attempt_at')
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'next_at')
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'reconcile_claimed_at')
      or not public.is_canonical_p0_timestamp_v2(v_previous->>'reconcile_expires_at')
    )) then
    return jsonb_build_object('applied', false, 'row', null);
  end if;
  if p_expected_status = 'reconciling'
    and (v_previous->>'reconcile_expires_at')::timestamptz < p_recorded_at then
    return jsonb_build_object('applied', false, 'row', null);
  end if;
  begin
    v_attempt := (v_previous->>'attempt')::integer;
  exception when others then
    return jsonb_build_object('applied', false, 'row', null);
  end;
  v_next_at := p_recorded_at + make_interval(secs => least(
    3600, 600 * (2 ^ case when p_status = 'delivered' then v_attempt else greatest(0, v_attempt - 1) end)::integer
  ));
  v_delivery := (v_previous - 'reconcile_owner' - 'reconcile_token'
    - 'reconcile_claimed_at' - 'reconcile_expires_at' - 'delivered_at' - 'readback')
    || jsonb_build_object(
      'status', p_status,
      'last_attempt_at', to_char(p_recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'next_at', to_char(v_next_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    );
  if p_status = 'delivered' then
    v_delivery := v_delivery || jsonb_build_object(
      'delivered_at', to_char(p_recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'readback', jsonb_build_object(
        'channel_id', p_channel_id, 'message_ts', p_message_ts,
        'confirmed_at', to_char(p_recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      )
    );
  end if;
  update public.work_items_v2
  set payload = jsonb_set(payload, '{p0_delivery}', v_delivery, false)
  where id = p_id returning * into v_row;
  return jsonb_build_object('applied', true, 'row', to_jsonb(v_row));
end;
$$;

revoke execute on function public.claim_p0_reconciliation_v2(uuid,integer,text,integer,uuid,uuid,integer,timestamptz)
  from public, anon, authenticated;
revoke execute on function public.settle_p0_delivery_v2(uuid,integer,text,integer,uuid,text,timestamptz,text,text,uuid,uuid)
  from public, anon, authenticated;
grant execute on function public.claim_p0_reconciliation_v2(uuid,integer,text,integer,uuid,uuid,integer,timestamptz)
  to service_role;
grant execute on function public.settle_p0_delivery_v2(uuid,integer,text,integer,uuid,text,timestamptz,text,text,uuid,uuid)
  to service_role;
