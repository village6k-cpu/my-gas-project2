set lock_timeout = '5s';

alter table public.message_notification_receipts
  add column cleanup_attempts integer not null default 0 check (cleanup_attempts >= 0),
  add column cleanup_owner text,
  add column cleanup_token uuid,
  add column cleanup_expires_at timestamptz,
  add column cleanup_attempted_at timestamptz,
  add column cleaned_at timestamptz,
  add column cleanup_already_absent boolean not null default false,
  add column cleanup_generation_initialized boolean,
  add column cleanup_work_id uuid,
  add column cleanup_work_version integer,
  add constraint message_notification_receipts_cleanup_work_link_check check (
    (cleanup_work_id is null and cleanup_work_version is null)
    or (cleanup_work_id is not null and cleanup_work_version > 0)
  );

update public.message_notification_receipts
set cleanup_generation_initialized = false;

alter table public.message_notification_receipts
  alter column cleanup_generation_initialized set default true,
  alter column cleanup_generation_initialized set not null;

create table public.notice_cleanup_work_sources_v2 (
  work_id uuid not null references public.work_items_v2(id) on delete cascade,
  source_event_key text not null,
  minimum_work_version integer not null check (minimum_work_version > 0),
  created_at timestamptz not null default now(),
  primary key (work_id, source_event_key)
);

insert into public.notice_cleanup_work_sources_v2 (
  work_id, source_event_key, minimum_work_version
)
select work.id, source_key, work.version
from public.work_items_v2 as work
cross join lateral unnest(work.source_event_keys) as source_key
on conflict (work_id, source_event_key) do nothing;

create function public.capture_notice_cleanup_work_sources_v2()
returns trigger
language plpgsql
security invoker set search_path = ''
as $$
declare
  v_source_key text;
  v_source_keys text[];
begin
  if tg_op = 'INSERT' then
    v_source_keys := new.source_event_keys;
  elsif tg_op = 'DELETE' then
    v_source_keys := old.source_event_keys;
  else
    select coalesce(array_agg(source_key order by source_key), '{}'::text[])
    into v_source_keys
    from (
      select source_key from unnest(new.source_event_keys) as source_key
      where not (source_key = any(old.source_event_keys))
      union
      select source_key from unnest(old.source_event_keys) as source_key
      where not (source_key = any(new.source_event_keys))
    ) as changed_keys;
  end if;
  for v_source_key in
    select source_key
    from unnest(v_source_keys) as source_key
    order by source_key
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'notice-cleanup-source:' || v_source_key,
      91420260901
    ));
    if tg_op <> 'DELETE' and v_source_key = any(new.source_event_keys) then
      insert into public.notice_cleanup_work_sources_v2 (
        work_id, source_event_key, minimum_work_version
      )
      values (new.id, v_source_key, new.version)
      on conflict (work_id, source_event_key) do nothing;
    end if;
  end loop;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger capture_notice_cleanup_work_sources_v2
after insert or delete or update of source_event_keys, version on public.work_items_v2
for each row execute function public.capture_notice_cleanup_work_sources_v2();

with unique_links as (
  select receipt.id as receipt_id,
    (array_agg(work.id order by work.id))[1] as work_id,
    (array_agg(membership.minimum_work_version order by work.id))[1] as work_version
  from public.message_notification_receipts as receipt
  join public.work_items_v2 as work
    on receipt.source_event_key = any(work.source_event_keys)
  join public.notice_cleanup_work_sources_v2 as membership
    on membership.work_id = work.id
    and membership.source_event_key = receipt.source_event_key
  group by receipt.id
  having count(*) = 1
)
update public.message_notification_receipts as receipt
set cleanup_work_id = link.work_id,
    cleanup_work_version = link.work_version
from unique_links as link
where receipt.id = link.receipt_id;

create function public.link_notice_cleanup_from_receipt_v2()
returns trigger
language plpgsql
security invoker set search_path = ''
as $$
declare
  v_work_id uuid;
  v_work_version integer;
  v_match_count integer;
begin
  select (array_agg(work.id order by work.id))[1],
    (array_agg(membership.minimum_work_version order by work.id))[1], count(*)::integer
  into v_work_id, v_work_version, v_match_count
  from public.work_items_v2 as work
  join public.notice_cleanup_work_sources_v2 as membership
    on membership.work_id = work.id
    and membership.source_event_key = new.source_event_key
  where new.source_event_key = any(work.source_event_keys);

  if v_match_count = 1 then
    update public.message_notification_receipts
    set cleanup_work_id = v_work_id,
        cleanup_work_version = v_work_version
    where id = new.id
      and cleanup_work_id is null
      and cleanup_work_version is null;
  end if;
  return new;
end;
$$;

create trigger link_notice_cleanup_from_receipt_v2
after insert on public.message_notification_receipts
for each row execute function public.link_notice_cleanup_from_receipt_v2();

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
  v_digest_eligible boolean;
  v_match_count integer;
  v_work_id uuid;
  v_work_version integer;
  v_candidate_ids uuid[];
  v_source_key text;
begin
  if p_now is null or not isfinite(p_now)
    or p_cleanup_owner is null or p_cleanup_owner <> btrim(p_cleanup_owner)
    or length(p_cleanup_owner) not between 1 and 200
    or p_lease_seconds is null or p_lease_seconds not between 1 and 900
    or p_limit is null or p_limit not between 1 and 25 then
    raise exception 'invalid notice cleanup input';
  end if;

  select coalesce(array_agg(candidate.id order by
      candidate.sort_priority, candidate.updated_at, candidate.id), array[]::uuid[])
  into v_candidate_ids
  from (
    select receipt.id,
      case when receipt.urgency = 'p0' and receipt.cleanup_state = 'blocked_p0' then 1 else 0 end
        as sort_priority,
      receipt.updated_at
    from public.message_notification_receipts as receipt
    where receipt.notification_state in ('delivered','cleanup_pending')
      and receipt.cleanup_state in ('idle','pending','failed','blocked_p0')
      and (
        receipt.cleanup_state <> 'pending'
        or (
          receipt.cleanup_generation_initialized = false
          and receipt.notification_state = 'delivered'
          and receipt.cleanup_attempts = 0
          and receipt.cleanup_owner is null
          and receipt.cleanup_token is null
          and receipt.cleanup_expires_at is null
          and receipt.cleanup_attempted_at is null
          and receipt.cleaned_at is null
          and receipt.cleanup_error is null
          and receipt.cleanup_already_absent = false
        )
        or (
          receipt.cleanup_owner is not null
          and receipt.cleanup_token is not null
          and receipt.cleanup_expires_at is not null
          and receipt.cleanup_expires_at <= p_now
        )
      )
      and (
        (
          receipt.notification_state = 'cleanup_pending'
          and receipt.cleanup_after <= p_now
          and receipt.payload->'automation_notice_update'->>'status' = 'updated'
        )
        or (
          receipt.notification_state = 'delivered'
          and (
            select count(*)
            from public.work_items_v2 as candidate_work
            where receipt.source_event_key = any(candidate_work.source_event_keys)
          ) = 1
          and (
            receipt.urgency = 'p0'
            or exists (
              select 1
              from public.work_items_v2 as candidate_work
              left join public.notice_cleanup_work_sources_v2 as membership
                on membership.work_id = candidate_work.id
                and membership.source_event_key = receipt.source_event_key
              join public.digest_runs as digest on digest.state in ('delivered','replaced')
                and digest.delivered_at is not null
                and digest.delivered_at >= receipt.created_at
              cross join lateral jsonb_array_elements(digest.item_snapshot) as snapshot(entry)
              where receipt.source_event_key = any(candidate_work.source_event_keys)
                and snapshot.entry->>'id' = candidate_work.id::text
                and case
                  when snapshot.entry->>'version' ~ '^[1-9][0-9]*$'
                    then (snapshot.entry->>'version')::integer
                      >= coalesce(membership.minimum_work_version, candidate_work.version)
                  else false
                end
            )
          )
        )
      )
    order by
      case when receipt.urgency = 'p0' and receipt.cleanup_state = 'blocked_p0' then 1 else 0 end,
      receipt.updated_at,
      receipt.id
    for update of receipt skip locked
    limit p_limit
  ) as candidate;

  for v_source_key in
    select distinct receipt.source_event_key
    from public.message_notification_receipts as receipt
    where receipt.id = any(v_candidate_ids)
    order by receipt.source_event_key
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'notice-cleanup-source:' || v_source_key,
      91420260901
    ));
  end loop;

  for v_row in
    select receipt.*
    from public.message_notification_receipts as receipt
    where receipt.id = any(v_candidate_ids)
    order by array_position(v_candidate_ids, receipt.id)
  loop
    v_acknowledged := false;
    v_digest_eligible := v_row.notification_state = 'cleanup_pending';
    v_match_count := 0;
    v_work_id := null;
    v_work_version := null;

    if v_row.notification_state = 'delivered' or v_row.urgency = 'p0' then
      select count(*)::integer,
        (array_agg(work.id order by work.id))[1],
        (array_agg(work.version order by work.id))[1]
      into v_match_count, v_work_id, v_work_version
      from public.work_items_v2 as work
      where v_row.source_event_key = any(work.source_event_keys);

      if v_match_count <> 1 then
        update public.message_notification_receipts
        set cleanup_work_id = null, cleanup_work_version = null
        where id = v_row.id
          and (cleanup_work_id is not null or cleanup_work_version is not null);
        continue;
      end if;

      insert into public.notice_cleanup_work_sources_v2 (
        work_id, source_event_key, minimum_work_version
      ) values (v_work_id, v_row.source_event_key, v_work_version)
      on conflict (work_id, source_event_key) do nothing;
      select membership.minimum_work_version
      into v_work_version
      from public.notice_cleanup_work_sources_v2 as membership
      where membership.work_id = v_work_id
        and membership.source_event_key = v_row.source_event_key;

      update public.message_notification_receipts
      set cleanup_work_id = v_work_id, cleanup_work_version = v_work_version
      where id = v_row.id
        and (
          cleanup_work_id is distinct from v_work_id
          or cleanup_work_version is distinct from v_work_version
        );

      select exists (
        select 1
        from public.work_items_v2 as work
        where work.id = v_work_id
          and v_row.source_event_key = any(work.source_event_keys)
          and work.priority = 'p0'
          and public.is_effective_p0_ack_v2(work.payload, p_now)
      ) into v_acknowledged;
      select exists (
        select 1
        from public.digest_runs as digest
        cross join lateral jsonb_array_elements(digest.item_snapshot) as snapshot(entry)
        where digest.state in ('delivered','replaced')
          and digest.delivered_at is not null
          and digest.delivered_at >= v_row.created_at
          and snapshot.entry->>'id' = v_work_id::text
          and case
            when snapshot.entry->>'version' ~ '^[1-9][0-9]*$'
              then (snapshot.entry->>'version')::integer >= v_work_version
            else false
          end
      ) into v_digest_eligible;
    end if;

    if v_row.urgency = 'p0' and not v_acknowledged then
      update public.message_notification_receipts
      set cleanup_state = 'blocked_p0', cleanup_owner = null, cleanup_token = null,
          cleanup_expires_at = null, cleanup_attempted_at = null, cleaned_at = null,
          cleanup_error = null,
          cleanup_already_absent = false, cleanup_generation_initialized = true
      where id = v_row.id
      returning * into v_claimed;
    elsif v_digest_eligible then
      update public.message_notification_receipts
      set cleanup_state = 'pending', cleanup_attempts = cleanup_attempts + 1,
          cleanup_owner = p_cleanup_owner, cleanup_token = gen_random_uuid(),
          cleanup_expires_at = p_now + make_interval(secs => p_lease_seconds),
          cleanup_attempted_at = p_now, cleaned_at = null, cleanup_error = null,
          cleanup_already_absent = false, cleanup_generation_initialized = true
      where id = v_row.id
        and (
          cleanup_state in ('idle','failed','blocked_p0')
          or (
            cleanup_state = 'pending'
            and cleanup_generation_initialized = false
            and notification_state = 'delivered'
            and cleanup_attempts = 0
            and cleanup_owner is null
            and cleanup_token is null
            and cleanup_expires_at is null
            and cleanup_attempted_at is null
            and cleaned_at is null
            and cleanup_error is null
            and cleanup_already_absent = false
          )
          or (
            cleanup_state = 'pending'
            and cleanup_owner is not null
            and cleanup_token is not null
            and cleanup_expires_at is not null
            and cleanup_expires_at <= p_now
          )
        )
      returning * into v_claimed;
    else
      continue;
    end if;

    if found then
      v_result := v_result || jsonb_build_array(jsonb_build_object(
        'id', v_claimed.id,
        'notification_state', v_claimed.notification_state,
        'cleanup_state', v_claimed.cleanup_state,
        'cleanup_attempts', v_claimed.cleanup_attempts,
        'cleanup_owner', v_claimed.cleanup_owner,
        'cleanup_token', v_claimed.cleanup_token,
        'cleanup_expires_at', v_claimed.cleanup_expires_at,
        'cleanup_attempted_at', v_claimed.cleanup_attempted_at,
        'cleaned_at', v_claimed.cleaned_at,
        'cleanup_error', v_claimed.cleanup_error,
        'cleanup_already_absent', v_claimed.cleanup_already_absent,
        'coordinate_status', case
          when v_claimed.slack_channel_id ~ '^[A-Z0-9][A-Z0-9_-]{0,79}$'
            and v_claimed.slack_message_ts ~ '^[0-9]{1,20}\.[0-9]{1,20}$'
            then 'valid'
          else 'missing_coordinates'
        end,
        'slack_channel_id', case
          when v_claimed.slack_channel_id ~ '^[A-Z0-9][A-Z0-9_-]{0,79}$'
            and v_claimed.slack_message_ts ~ '^[0-9]{1,20}\.[0-9]{1,20}$'
            then v_claimed.slack_channel_id
          else null
        end,
        'slack_message_ts', case
          when v_claimed.slack_channel_id ~ '^[A-Z0-9][A-Z0-9_-]{0,79}$'
            and v_claimed.slack_message_ts ~ '^[0-9]{1,20}\.[0-9]{1,20}$'
            then v_claimed.slack_message_ts
          else null
        end
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
  p_already_absent boolean
) returns jsonb
language plpgsql
security invoker set search_path = ''
as $$
declare
  v_row public.message_notification_receipts%rowtype;
  v_completed_at timestamptz;
begin
  if p_id is null or p_cleanup_token is null or p_already_absent is null
    or p_cleanup_owner is null or p_cleanup_owner <> btrim(p_cleanup_owner)
    or length(p_cleanup_owner) not between 1 and 200
    or p_expected_cleanup_attempts is null or p_expected_cleanup_attempts < 1 then
    raise exception 'invalid notice cleanup input';
  end if;

  select * into v_row
  from public.message_notification_receipts
  where id = p_id
    and cleanup_state = 'pending'
    and cleanup_owner = p_cleanup_owner
    and cleanup_token = p_cleanup_token
    and cleanup_attempts = p_expected_cleanup_attempts
  for update;

  if not found then
    return jsonb_build_object('applied', false, 'row', null);
  end if;
  v_completed_at := clock_timestamp();

  update public.message_notification_receipts
  set notification_state = 'deleted', cleanup_state = 'deleted',
      cleanup_owner = null, cleanup_token = null, cleanup_expires_at = null,
      cleaned_at = v_completed_at, cleanup_error = null,
      cleanup_already_absent = p_already_absent
  where id = p_id
    and cleanup_state = 'pending'
    and cleanup_owner = p_cleanup_owner
    and cleanup_token = p_cleanup_token
    and cleanup_attempts = p_expected_cleanup_attempts
    and cleanup_expires_at > v_completed_at
  returning * into v_row;

  if not found then
    return jsonb_build_object('applied', false, 'row', null);
  end if;
  return jsonb_build_object(
    'applied', true,
    'row', jsonb_build_object(
      'id', v_row.id,
      'notification_state', v_row.notification_state,
      'cleanup_state', v_row.cleanup_state,
      'cleanup_attempts', v_row.cleanup_attempts,
      'cleanup_owner', v_row.cleanup_owner,
      'cleanup_token', v_row.cleanup_token,
      'cleanup_expires_at', v_row.cleanup_expires_at,
      'cleanup_attempted_at', v_row.cleanup_attempted_at,
      'cleaned_at', v_row.cleaned_at,
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
  p_error text
) returns jsonb
language plpgsql
security invoker set search_path = ''
as $$
declare
  v_row public.message_notification_receipts%rowtype;
  v_completed_at timestamptz;
begin
  if p_id is null or p_cleanup_token is null
    or p_cleanup_owner is null or p_cleanup_owner <> btrim(p_cleanup_owner)
    or length(p_cleanup_owner) not between 1 and 200
    or p_expected_cleanup_attempts is null or p_expected_cleanup_attempts < 1
    or p_error is null or p_error not in (
      'missing_coordinates','bot_identity_mismatch','cant_delete_message',
      'rate_limited','cleanup_unconfirmed','slack_api_error'
    ) then
    raise exception 'invalid notice cleanup input';
  end if;

  select * into v_row
  from public.message_notification_receipts
  where id = p_id
    and cleanup_state = 'pending'
    and cleanup_owner = p_cleanup_owner
    and cleanup_token = p_cleanup_token
    and cleanup_attempts = p_expected_cleanup_attempts
  for update;

  if not found then
    return jsonb_build_object('applied', false, 'row', null);
  end if;
  v_completed_at := clock_timestamp();

  update public.message_notification_receipts
  set cleanup_state = 'failed', cleanup_owner = null, cleanup_token = null,
      cleanup_expires_at = null, cleaned_at = null, cleanup_error = p_error,
      cleanup_already_absent = false
  where id = p_id
    and cleanup_state = 'pending'
    and cleanup_owner = p_cleanup_owner
    and cleanup_token = p_cleanup_token
    and cleanup_attempts = p_expected_cleanup_attempts
    and cleanup_expires_at > v_completed_at
  returning * into v_row;

  if not found then
    return jsonb_build_object('applied', false, 'row', null);
  end if;
  return jsonb_build_object(
    'applied', true,
    'row', jsonb_build_object(
      'id', v_row.id,
      'notification_state', v_row.notification_state,
      'cleanup_state', v_row.cleanup_state,
      'cleanup_attempts', v_row.cleanup_attempts,
      'cleanup_owner', v_row.cleanup_owner,
      'cleanup_token', v_row.cleanup_token,
      'cleanup_expires_at', v_row.cleanup_expires_at,
      'cleanup_attempted_at', v_row.cleanup_attempted_at,
      'cleaned_at', v_row.cleaned_at,
      'cleanup_error', v_row.cleanup_error,
      'cleanup_already_absent', v_row.cleanup_already_absent
    )
  );
end;
$$;

revoke execute on function public.claim_notice_cleanup_batch_v2(timestamptz,text,integer,integer)
  from public, anon, authenticated;
revoke execute on function public.mark_notice_cleanup_deleted_v2(uuid,text,uuid,integer,boolean)
  from public, anon, authenticated;
revoke execute on function public.mark_notice_cleanup_failed_v2(uuid,text,uuid,integer,text)
  from public, anon, authenticated;
revoke execute on function public.link_notice_cleanup_from_receipt_v2()
  from public, anon, authenticated;
revoke execute on function public.capture_notice_cleanup_work_sources_v2()
  from public, anon, authenticated;
revoke all on table public.notice_cleanup_work_sources_v2
  from public, anon, authenticated;

grant execute on function public.claim_notice_cleanup_batch_v2(timestamptz,text,integer,integer)
  to service_role;
grant execute on function public.mark_notice_cleanup_deleted_v2(uuid,text,uuid,integer,boolean)
  to service_role;
grant execute on function public.mark_notice_cleanup_failed_v2(uuid,text,uuid,integer,text)
  to service_role;
grant execute on function public.link_notice_cleanup_from_receipt_v2()
  to service_role;
grant execute on function public.capture_notice_cleanup_work_sources_v2()
  to service_role;
grant select, insert, update, delete on table public.notice_cleanup_work_sources_v2
  to service_role;
