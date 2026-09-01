set lock_timeout = '5s';

create function public.is_canonical_p0_timestamp_v2(p_value text)
returns boolean language plpgsql immutable security invoker set search_path = '' as $$
declare
  v_value timestamptz;
begin
  if p_value is null or left(p_value, 4) = '0000'
    or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$' then
    return false;
  end if;
  begin
    v_value := p_value::timestamptz;
  exception when others then
    return false;
  end;
  return isfinite(v_value)
    and to_char(v_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') = p_value;
end;
$$;

create function public.is_due_p0_delivery_v2(
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
    if v_status = 'reconcile_pending' then
      if not public.is_canonical_p0_timestamp_v2(v_delivery->>'claimed_at')
        or not public.is_canonical_p0_timestamp_v2(v_delivery->>'claim_expires_at')
        or not public.is_canonical_p0_timestamp_v2(v_delivery->>'last_attempt_at') then
        return true;
      end if;
      return true;
    elsif v_status = 'claimed' then
      if not public.is_canonical_p0_timestamp_v2(v_delivery->>'claimed_at')
        or not public.is_canonical_p0_timestamp_v2(v_delivery->>'claim_expires_at') then
        return true;
      end if;
      v_due_at := (v_delivery->>'claim_expires_at')::timestamptz;
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
        )) then
        return true;
      end if;
      v_due_at := (v_delivery->>'next_at')::timestamptz;
      return v_due_at <= p_now;
    end if;
    return true;
  exception when others then
    return true;
  end;
end;
$$;

create function public.list_due_p0_work_v2(
  p_now timestamptz,
  p_limit integer
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_result jsonb;
begin
  if p_now is null or not isfinite(p_now) or p_limit is null or p_limit not between 1 and 50 then
    raise exception 'invalid P0 work query' using errcode = '22023';
  end if;
  with eligible as materialized (
    select
      w.id, w.work_key, w.room_key, w.title, w.summary, w.work_type, w.priority, w.state,
      w.owner_id, w.actionable_at, w.due_at, w.snoozed_until, w.first_opened_at,
      w.last_activity_at, w.digest_inclusion_count, w.consecutive_unhandled_digests,
      w.last_digest_at, w.next_reminder_at, w.version, w.payload
    from public.work_items_v2 as w
    where w.priority = 'p0'
      and w.state in ('open','in_progress','snoozed')
      and not public.is_effective_p0_ack_v2(w.payload, p_now)
      and public.is_due_p0_delivery_v2(w.payload, w.first_opened_at, p_now)
  ), bounded as (
    select * from eligible
    order by first_opened_at, id
    limit p_limit
  ), counts as (
    select (select count(*) from eligible)::integer as eligible_count,
      (select count(*) from bounded)::integer as selected_count
  )
  select jsonb_build_object(
    'eligible_count', counts.eligible_count,
    'selected_count', counts.selected_count,
    'omitted_count', counts.eligible_count - counts.selected_count,
    'rows', coalesce((
      select jsonb_agg(to_jsonb(row_value) order by row_value.first_opened_at, row_value.id)
      from bounded as row_value
    ), '[]'::jsonb)
  ) into v_result from counts;
  return v_result;
end;
$$;

create function public.claim_p0_delivery_v2(
  p_id uuid,
  p_expected_version integer,
  p_expected_generation integer,
  p_generation integer,
  p_attempt integer,
  p_client_message_id uuid,
  p_claimed_at timestamptz,
  p_claim_expires_at timestamptz
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.work_items_v2%rowtype;
  v_current_generation integer;
  v_delivery jsonb;
begin
  if p_id is null or p_expected_version is null or p_expected_version < 1
    or p_expected_generation is null or p_expected_generation < 0
    or p_generation <> p_expected_generation + 1 or p_attempt <> p_generation
    or p_client_message_id is null
    or p_client_message_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_claimed_at is null or not isfinite(p_claimed_at)
    or p_claim_expires_at is null or not isfinite(p_claim_expires_at)
    or p_claim_expires_at <= p_claimed_at or p_claim_expires_at > p_claimed_at + interval '15 minutes' then
    raise exception 'invalid P0 delivery claim' using errcode = '22023';
  end if;
  select * into v_row from public.work_items_v2 where id = p_id for update;
  if not found or v_row.version <> p_expected_version or v_row.priority <> 'p0'
    or v_row.state not in ('open','in_progress','snoozed')
    or public.is_effective_p0_ack_v2(v_row.payload, p_claimed_at)
    or not public.is_due_p0_delivery_v2(v_row.payload, v_row.first_opened_at, p_claimed_at) then
    return jsonb_build_object('applied', false, 'row', null);
  end if;
  begin
    v_current_generation := coalesce((v_row.payload->'p0_delivery'->>'generation')::integer, 0);
  exception when others then
    return jsonb_build_object('applied', false, 'row', null);
  end;
  if v_current_generation <> p_expected_generation then
    return jsonb_build_object('applied', false, 'row', null);
  end if;
  if v_row.payload ? 'p0_delivery'
    and coalesce(v_row.payload->'p0_delivery'->>'status', '') not in ('delivered','retry_pending') then
    return jsonb_build_object('applied', false, 'row', null);
  end if;
  v_delivery := jsonb_build_object(
    'status', 'claimed', 'generation', p_generation, 'attempt', p_attempt,
    'client_message_id', p_client_message_id::text,
    'claimed_at', to_char(p_claimed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'claim_expires_at', to_char(p_claim_expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  );
  update public.work_items_v2
  set payload = jsonb_set(payload, '{p0_delivery}', v_delivery, true)
  where id = p_id returning * into v_row;
  return jsonb_build_object('applied', true, 'row', to_jsonb(v_row));
end;
$$;

create function public.settle_p0_delivery_v2(
  p_id uuid,
  p_expected_version integer,
  p_expected_status text,
  p_expected_generation integer,
  p_client_message_id uuid,
  p_status text,
  p_recorded_at timestamptz,
  p_channel_id text,
  p_message_ts text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.work_items_v2%rowtype;
  v_previous jsonb;
  v_delivery jsonb;
  v_attempt integer;
  v_next_at timestamptz;
begin
  if p_id is null or p_expected_version is null or p_expected_version < 1
    or p_expected_status not in ('claimed','reconcile_pending')
    or p_expected_generation is null or p_expected_generation < 1
    or p_client_message_id is null
    or p_client_message_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    or p_status not in ('delivered','reconcile_pending','retry_pending')
    or p_recorded_at is null or not isfinite(p_recorded_at)
    or (p_status = 'delivered' and (
      p_channel_id is null or p_channel_id !~ '^[A-Z0-9][A-Z0-9_-]{0,79}$'
      or p_message_ts is null or p_message_ts !~ '^[0-9]{1,20}\.[0-9]{1,20}$'
    )) or (p_status <> 'delivered' and (p_channel_id is not null or p_message_ts is not null)) then
    raise exception 'invalid P0 delivery settlement' using errcode = '22023';
  end if;
  select * into v_row from public.work_items_v2 where id = p_id for update;
  v_previous := v_row.payload->'p0_delivery';
  if not found or v_row.version <> p_expected_version or v_previous is null
    or v_previous->>'status' <> p_expected_status
    or v_previous->>'generation' <> p_expected_generation::text
    or v_previous->>'client_message_id' <> p_client_message_id::text then
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
  v_delivery := v_previous || jsonb_build_object(
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

create function public.read_p0_delivery_v2(
  p_id uuid,
  p_expected_version integer,
  p_expected_generation integer,
  p_client_message_id uuid
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_row public.work_items_v2%rowtype;
begin
  if p_id is null or p_expected_version is null or p_expected_version < 1
    or p_expected_generation is null or p_expected_generation < 1 or p_client_message_id is null
    or p_client_message_id::text !~ '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'invalid P0 delivery readback' using errcode = '22023';
  end if;
  select * into v_row from public.work_items_v2
  where id = p_id and version = p_expected_version
    and payload->'p0_delivery'->>'generation' = p_expected_generation::text
    and payload->'p0_delivery'->>'client_message_id' = p_client_message_id::text;
  return jsonb_build_object('matched', found, 'row', case when found then to_jsonb(v_row) else null end);
end;
$$;

revoke execute on function public.is_canonical_p0_timestamp_v2(text) from public, anon, authenticated;
revoke execute on function public.is_due_p0_delivery_v2(jsonb,timestamptz,timestamptz) from public, anon, authenticated;
revoke execute on function public.list_due_p0_work_v2(timestamptz,integer) from public, anon, authenticated;
revoke execute on function public.claim_p0_delivery_v2(uuid,integer,integer,integer,integer,uuid,timestamptz,timestamptz) from public, anon, authenticated;
revoke execute on function public.settle_p0_delivery_v2(uuid,integer,text,integer,uuid,text,timestamptz,text,text) from public, anon, authenticated;
revoke execute on function public.read_p0_delivery_v2(uuid,integer,integer,uuid) from public, anon, authenticated;

grant execute on function public.is_canonical_p0_timestamp_v2(text) to service_role;
grant execute on function public.is_due_p0_delivery_v2(jsonb,timestamptz,timestamptz) to service_role;
grant execute on function public.list_due_p0_work_v2(timestamptz,integer) to service_role;
grant execute on function public.claim_p0_delivery_v2(uuid,integer,integer,integer,integer,uuid,timestamptz,timestamptz) to service_role;
grant execute on function public.settle_p0_delivery_v2(uuid,integer,text,integer,uuid,text,timestamptz,text,text) to service_role;
grant execute on function public.read_p0_delivery_v2(uuid,integer,integer,uuid) to service_role;
