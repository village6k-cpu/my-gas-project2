set lock_timeout = '5s';

alter table public.message_notification_receipts
  add column cleanup_attempts integer not null default 0 check (cleanup_attempts >= 0),
  add column cleanup_owner text,
  add column cleanup_token uuid,
  add column cleanup_expires_at timestamptz,
  add column cleanup_attempted_at timestamptz,
  add column cleaned_at timestamptz,
  add column cleanup_already_absent boolean not null default false;

create index message_notification_receipts_cleanup_claim_idx
  on public.message_notification_receipts (cleanup_state, cleanup_expires_at, updated_at)
  where cleanup_state in ('idle','pending','failed','blocked_p0');

create function public.claim_notice_cleanup_batch_v2(
  p_now timestamptz,
  p_cleanup_owner text,
  p_lease_seconds integer,
  p_limit integer
) returns jsonb
language plpgsql
security invoker set search_path = ''
as $$
declare
  v_row public.message_notification_receipts%rowtype;
  v_claimed public.message_notification_receipts%rowtype;
  v_result jsonb := '[]'::jsonb;
  v_acknowledged boolean;
begin
  if p_now is null or not isfinite(p_now)
    or p_cleanup_owner is null or p_cleanup_owner <> btrim(p_cleanup_owner)
    or length(p_cleanup_owner) not between 1 and 200
    or p_lease_seconds is null or p_lease_seconds not between 1 and 900
    or p_limit is null or p_limit not between 1 and 25 then
    raise exception 'invalid notice cleanup input';
  end if;

  for v_row in
    select receipt.*
    from public.message_notification_receipts as receipt
    where receipt.notification_state in ('delivered','cleanup_pending')
      and receipt.cleanup_state in ('idle','pending','failed','blocked_p0')
      and (
        receipt.cleanup_state <> 'pending'
        or receipt.cleanup_expires_at <= p_now
      )
      and (
        (
          receipt.notification_state = 'cleanup_pending'
          and receipt.cleanup_after <= p_now
          and receipt.payload->'automation_notice_update'->>'status' = 'updated'
        )
        or (
          receipt.notification_state = 'delivered'
          and exists (
            select 1
            from public.work_items_v2 as work
            where receipt.source_event_key = any(work.source_event_keys)
              and exists (
                select 1
                from public.digest_runs as digest
                cross join lateral jsonb_array_elements(digest.item_snapshot) as snapshot(entry)
                where digest.state in ('delivered','replaced')
                  and digest.delivered_at is not null
                  and snapshot.entry->>'id' = work.id::text
              )
          )
        )
        or (
          receipt.urgency = 'p0'
          and not exists (
            select 1
            from public.work_items_v2 as acknowledged_work
            where receipt.source_event_key = any(acknowledged_work.source_event_keys)
              and acknowledged_work.priority = 'p0'
              and public.is_effective_p0_ack_v2(acknowledged_work.payload, p_now)
          )
        )
      )
    order by
      case when receipt.urgency = 'p0' and receipt.cleanup_state = 'blocked_p0' then 1 else 0 end,
      receipt.updated_at,
      receipt.id
    for update skip locked
    limit p_limit
  loop
    select exists (
      select 1
      from public.work_items_v2 as work
      where v_row.source_event_key = any(work.source_event_keys)
        and work.priority = 'p0'
        and public.is_effective_p0_ack_v2(work.payload, p_now)
    ) into v_acknowledged;

    if v_row.urgency = 'p0' and not v_acknowledged then
      update public.message_notification_receipts
      set cleanup_state = 'blocked_p0', cleanup_owner = null, cleanup_token = null,
          cleanup_expires_at = null, cleanup_error = null,
          cleanup_already_absent = false
      where id = v_row.id
      returning * into v_claimed;
    else
      update public.message_notification_receipts
      set cleanup_state = 'pending', cleanup_attempts = cleanup_attempts + 1,
          cleanup_owner = p_cleanup_owner, cleanup_token = gen_random_uuid(),
          cleanup_expires_at = p_now + make_interval(secs => p_lease_seconds),
          cleanup_attempted_at = p_now, cleaned_at = null, cleanup_error = null,
          cleanup_already_absent = false
      where id = v_row.id
        and (
          cleanup_state in ('idle','failed','blocked_p0')
          or (cleanup_state = 'pending' and cleanup_expires_at <= p_now)
        )
      returning * into v_claimed;
    end if;

    if found then
      v_result := v_result || jsonb_build_array(jsonb_build_object(
        'id', v_claimed.id,
        'cleanup_state', v_claimed.cleanup_state,
        'cleanup_attempts', v_claimed.cleanup_attempts,
        'cleanup_owner', v_claimed.cleanup_owner,
        'cleanup_token', v_claimed.cleanup_token,
        'cleanup_expires_at', v_claimed.cleanup_expires_at,
        'slack_channel_id', v_claimed.slack_channel_id,
        'slack_message_ts', v_claimed.slack_message_ts
      ));
    end if;
  end loop;

  return v_result;
end;
$$;

create function public.mark_notice_cleanup_deleted_v2(
  p_id uuid,
  p_cleanup_owner text,
  p_cleanup_token uuid,
  p_expected_cleanup_attempts integer,
  p_deleted_at timestamptz,
  p_already_absent boolean
) returns jsonb
language plpgsql
security invoker set search_path = ''
as $$
declare
  v_row public.message_notification_receipts%rowtype;
begin
  if p_id is null or p_cleanup_token is null or p_already_absent is null
    or p_cleanup_owner is null or p_cleanup_owner <> btrim(p_cleanup_owner)
    or length(p_cleanup_owner) not between 1 and 200
    or p_expected_cleanup_attempts is null or p_expected_cleanup_attempts < 1
    or p_deleted_at is null or not isfinite(p_deleted_at) then
    raise exception 'invalid notice cleanup input';
  end if;

  update public.message_notification_receipts
  set notification_state = 'deleted', cleanup_state = 'deleted',
      cleanup_owner = null, cleanup_token = null, cleanup_expires_at = null,
      cleaned_at = p_deleted_at, cleanup_error = null,
      cleanup_already_absent = p_already_absent
  where id = p_id
    and cleanup_state = 'pending'
    and cleanup_owner = p_cleanup_owner
    and cleanup_token = p_cleanup_token
    and cleanup_attempts = p_expected_cleanup_attempts
    and cleanup_expires_at > p_deleted_at
  returning * into v_row;

  if not found then
    return jsonb_build_object('applied', false, 'row', null);
  end if;
  return jsonb_build_object(
    'applied', true,
    'row', jsonb_build_object(
      'id', v_row.id,
      'cleanup_state', v_row.cleanup_state,
      'cleanup_attempts', v_row.cleanup_attempts,
      'cleanup_owner', v_row.cleanup_owner,
      'cleanup_token', v_row.cleanup_token,
      'cleanup_expires_at', v_row.cleanup_expires_at,
      'cleanup_error', v_row.cleanup_error,
      'cleanup_already_absent', v_row.cleanup_already_absent
    )
  );
end;
$$;

create function public.mark_notice_cleanup_failed_v2(
  p_id uuid,
  p_cleanup_owner text,
  p_cleanup_token uuid,
  p_expected_cleanup_attempts integer,
  p_failed_at timestamptz,
  p_error text
) returns jsonb
language plpgsql
security invoker set search_path = ''
as $$
declare
  v_row public.message_notification_receipts%rowtype;
begin
  if p_id is null or p_cleanup_token is null
    or p_cleanup_owner is null or p_cleanup_owner <> btrim(p_cleanup_owner)
    or length(p_cleanup_owner) not between 1 and 200
    or p_expected_cleanup_attempts is null or p_expected_cleanup_attempts < 1
    or p_failed_at is null or not isfinite(p_failed_at)
    or p_error is null or p_error not in (
      'missing_coordinates','bot_identity_mismatch','cant_delete_message',
      'rate_limited','cleanup_unconfirmed','slack_api_error'
    ) then
    raise exception 'invalid notice cleanup input';
  end if;

  update public.message_notification_receipts
  set cleanup_state = 'failed', cleanup_owner = null, cleanup_token = null,
      cleanup_expires_at = null, cleaned_at = null, cleanup_error = p_error,
      cleanup_already_absent = false
  where id = p_id
    and cleanup_state = 'pending'
    and cleanup_owner = p_cleanup_owner
    and cleanup_token = p_cleanup_token
    and cleanup_attempts = p_expected_cleanup_attempts
    and cleanup_expires_at > p_failed_at
  returning * into v_row;

  if not found then
    return jsonb_build_object('applied', false, 'row', null);
  end if;
  return jsonb_build_object(
    'applied', true,
    'row', jsonb_build_object(
      'id', v_row.id,
      'cleanup_state', v_row.cleanup_state,
      'cleanup_attempts', v_row.cleanup_attempts,
      'cleanup_owner', v_row.cleanup_owner,
      'cleanup_token', v_row.cleanup_token,
      'cleanup_expires_at', v_row.cleanup_expires_at,
      'cleanup_error', v_row.cleanup_error,
      'cleanup_already_absent', v_row.cleanup_already_absent
    )
  );
end;
$$;

revoke execute on function public.claim_notice_cleanup_batch_v2(timestamptz,text,integer,integer)
  from public, anon, authenticated;
revoke execute on function public.mark_notice_cleanup_deleted_v2(uuid,text,uuid,integer,timestamptz,boolean)
  from public, anon, authenticated;
revoke execute on function public.mark_notice_cleanup_failed_v2(uuid,text,uuid,integer,timestamptz,text)
  from public, anon, authenticated;

grant execute on function public.claim_notice_cleanup_batch_v2(timestamptz,text,integer,integer)
  to service_role;
grant execute on function public.mark_notice_cleanup_deleted_v2(uuid,text,uuid,integer,timestamptz,boolean)
  to service_role;
grant execute on function public.mark_notice_cleanup_failed_v2(uuid,text,uuid,integer,timestamptz,text)
  to service_role;
