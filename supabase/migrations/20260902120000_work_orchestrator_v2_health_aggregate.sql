set lock_timeout = '5s';

create function public.is_valid_pending_work_action_at_v2(
  p_pending jsonb,
  p_current_version integer,
  p_now timestamptz
) returns boolean language plpgsql stable security invoker set search_path = '' as $$
declare
  v_type text;
  v_action jsonb;
  v_expected_version integer;
  v_requested_at timestamptz;
  v_snoozed_until timestamptz;
begin
  if p_now is null or not isfinite(p_now)
    or p_pending is null or jsonb_typeof(p_pending) <> 'object'
    or not (p_pending ?& array['type','action','status','requested_at','requested_by','expected_version'])
    or (p_pending - array['type','action','status','requested_at','requested_by','expected_version']::text[]) <> '{}'::jsonb
    or jsonb_typeof(p_pending->'type') <> 'string'
    or jsonb_typeof(p_pending->'action') <> 'object'
    or jsonb_typeof(p_pending->'status') <> 'string' or p_pending->>'status' <> 'pending'
    or jsonb_typeof(p_pending->'requested_at') <> 'string'
    or length(p_pending->>'requested_at') > 40
    or (p_pending->>'requested_at') !~ '^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    or jsonb_typeof(p_pending->'requested_by') <> 'string'
    or (p_pending->>'requested_by') !~ '^[UW][A-Z0-9]{2,79}$'
    or jsonb_typeof(p_pending->'expected_version') <> 'number'
    or (p_pending->>'expected_version') !~ '^[1-9][0-9]*$' then
    return false;
  end if;
  begin
    v_expected_version := (p_pending->>'expected_version')::integer;
    v_requested_at := (p_pending->>'requested_at')::timestamptz;
  exception when others then
    return false;
  end;
  if p_current_version is null or p_current_version <= 1
    or v_expected_version <> p_current_version - 1
    or not isfinite(v_requested_at) or v_requested_at > p_now then
    return false;
  end if;
  v_type := p_pending->>'type';
  v_action := p_pending->'action';
  if v_type not in ('progress','snooze','ack_p0','request_resolve','dismiss')
    or v_action->>'type' is distinct from v_type
    or (v_type <> 'snooze' and (v_action - 'type') <> '{}'::jsonb)
    or (v_type = 'snooze' and (
      not (v_action ?& array['type','snoozedUntil'])
      or (v_action - array['type','snoozedUntil']::text[]) <> '{}'::jsonb
      or jsonb_typeof(v_action->'snoozedUntil') <> 'string'
      or length(v_action->>'snoozedUntil') > 40
      or (v_action->>'snoozedUntil') !~ '^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    )) then
    return false;
  end if;
  if v_type = 'snooze' then
    begin
      v_snoozed_until := (v_action->>'snoozedUntil')::timestamptz;
    exception when others then
      return false;
    end;
    if not isfinite(v_snoozed_until) or v_snoozed_until <= p_now then return false; end if;
  end if;
  return true;
end;
$$;

create function public.read_work_orchestrator_health_v2(
  p_now timestamptz
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  v_result jsonb;
  v_invalid_evidence_count bigint;
begin
  if p_now is null or not isfinite(p_now) then
    raise exception 'invalid work orchestrator health clock' using errcode = '22023';
  end if;

  select sum(invalid_by_table.invalid_count)::bigint into v_invalid_evidence_count
  from (
    select coalesce(sum(
      (receipt.notification_state in ('pending','delivering','failed')
        and not isfinite(receipt.created_at))::integer
      + (receipt.cleanup_state = 'idle'
        and receipt.notification_state = 'cleanup_pending'
        and receipt.cleanup_after is not null
        and not isfinite(receipt.cleanup_after))::integer
      + (receipt.cleanup_state in ('pending','failed')
        and receipt.cleanup_attempted_at is not null
        and not isfinite(receipt.cleanup_attempted_at))::integer
      + (receipt.cleanup_state in ('pending','failed')
        and receipt.cleanup_attempted_at is null
        and receipt.cleanup_after is null
        and not isfinite(receipt.updated_at))::integer
      + (receipt.cleanup_state in ('pending','failed')
        and receipt.cleanup_attempted_at is null
        and receipt.cleanup_after is not null
        and not isfinite(receipt.cleanup_after))::integer
      + (receipt.cleanup_state = 'pending'
        and receipt.cleanup_expires_at is not null
        and not isfinite(receipt.cleanup_expires_at))::integer
    ), 0)::bigint as invalid_count
    from public.message_notification_receipts as receipt
    union all
    select coalesce(sum(
      (work.state in ('open','in_progress','snoozed')
        and not isfinite(work.actionable_at))::integer
      + (work.state in ('open','in_progress','snoozed')
        and not isfinite(work.first_opened_at))::integer
    ), 0)::bigint as invalid_count
    from public.work_items_v2 as work
    union all
    select coalesce(sum(
      (digest.state in ('delivered','replaced')
        and digest.delivered_at is not null
        and not isfinite(digest.delivered_at))::integer
      + (digest.state in ('delivered','replaced','diverged')
        and not isfinite(digest.scheduled_at))::integer
      + (digest.state in ('delivered','replaced','diverged')
        and digest.manifest_prepared_at is not null
        and not isfinite(digest.manifest_prepared_at))::integer
      + (digest.state in ('failed','diverged')
        and not isfinite(digest.updated_at))::integer
      + (digest.state in ('building','delivering','failed')
        and digest.lease_expires_at is not null
        and not isfinite(digest.lease_expires_at))::integer
    ), 0)::bigint as invalid_count
    from public.digest_runs as digest
    union all
    select coalesce(sum(
      (part.delivery_state = 'delivered'
        and part.cleanup_state in ('idle','deleting','failed')
        and part.delivered_at is not null
        and not isfinite(part.delivered_at))::integer
      + (part.delivery_state = 'delivered'
        and part.cleanup_state in ('idle','deleting','failed')
        and part.cleanup_attempted_at is not null
        and not isfinite(part.cleanup_attempted_at))::integer
      + (part.cleanup_state = 'deleting'
        and part.cleanup_expires_at is not null
        and not isfinite(part.cleanup_expires_at))::integer
    ), 0)::bigint as invalid_count
    from public.digest_message_parts as part
  ) as invalid_by_table;

  with recursive
  notification_metrics as (
    select
      count(*) filter (where notification_state in ('pending','delivering','failed'))::bigint as undelivered_count,
      count(*) filter (where notification_state = 'pending')::bigint as pending_count,
      count(*) filter (where notification_state = 'delivering')::bigint as delivering_count,
      count(*) filter (where notification_state = 'failed')::bigint as failed_count,
      min(created_at) filter (
        where notification_state in ('pending','delivering','failed') and isfinite(created_at)
      ) as oldest_at
    from public.message_notification_receipts
  ),
  automation_metrics as (
    select
      count(*) filter (where automation_state = 'not_attempted')::bigint as not_attempted_count,
      count(*) filter (where automation_state = 'running')::bigint as running_count,
      count(*) filter (where automation_state = 'succeeded')::bigint as succeeded_count,
      count(*) filter (where automation_state = 'failed')::bigint as failed_count,
      count(*) filter (where automation_state = 'needs_human')::bigint as needs_human_count
    from public.work_items_v2
  ),
  work_classification as (
    select
      work.id,
      work.state,
      work.priority,
      work.actionable_at,
      work.first_opened_at,
      work.pending_action,
      work.version,
      public.is_effective_p0_ack_v2(work.payload, p_now) as acknowledged,
      case
        when jsonb_typeof(work.payload->'p0_delivery') <> 'object' then false
        when (work.payload->'p0_delivery'->>'status') not in (
          'claimed','reconcile_pending','reconciling','retry_pending','delivered'
        ) then false
        when jsonb_typeof(work.payload->'p0_delivery'->'generation') <> 'number'
          or jsonb_typeof(work.payload->'p0_delivery'->'attempt') <> 'number'
          or (work.payload->'p0_delivery'->>'generation') !~ '^[1-9][0-9]*$'
          or (work.payload->'p0_delivery'->>'attempt') !~ '^[1-9][0-9]*$'
          or (work.payload->'p0_delivery'->>'generation')::numeric
            <> (work.payload->'p0_delivery'->>'attempt')::numeric
          or (work.payload->'p0_delivery'->>'client_message_id')
            !~ '^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then false
        when work.payload->'p0_delivery'->>'status' = 'claimed' then
          (select count(*) from pg_catalog.jsonb_object_keys(work.payload->'p0_delivery')) = 6
          and public.is_canonical_p0_timestamp_v2(work.payload->'p0_delivery'->>'claimed_at')
          and public.is_canonical_p0_timestamp_v2(work.payload->'p0_delivery'->>'claim_expires_at')
        when work.payload->'p0_delivery'->>'status' in ('reconcile_pending','retry_pending') then
          (select count(*) from pg_catalog.jsonb_object_keys(work.payload->'p0_delivery')) = 8
          and public.is_canonical_p0_timestamp_v2(work.payload->'p0_delivery'->>'claimed_at')
          and public.is_canonical_p0_timestamp_v2(work.payload->'p0_delivery'->>'claim_expires_at')
          and public.is_canonical_p0_timestamp_v2(work.payload->'p0_delivery'->>'last_attempt_at')
          and public.is_canonical_p0_timestamp_v2(work.payload->'p0_delivery'->>'next_at')
        when work.payload->'p0_delivery'->>'status' = 'reconciling' then
          (select count(*) from pg_catalog.jsonb_object_keys(work.payload->'p0_delivery')) = 12
          and public.is_canonical_p0_timestamp_v2(work.payload->'p0_delivery'->>'claimed_at')
          and public.is_canonical_p0_timestamp_v2(work.payload->'p0_delivery'->>'claim_expires_at')
          and public.is_canonical_p0_timestamp_v2(work.payload->'p0_delivery'->>'last_attempt_at')
          and public.is_canonical_p0_timestamp_v2(work.payload->'p0_delivery'->>'next_at')
          and public.is_canonical_p0_timestamp_v2(work.payload->'p0_delivery'->>'reconcile_claimed_at')
          and public.is_canonical_p0_timestamp_v2(work.payload->'p0_delivery'->>'reconcile_expires_at')
          and (work.payload->'p0_delivery'->>'reconcile_owner')
            ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          and (work.payload->'p0_delivery'->>'reconcile_token')
            ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        when work.payload->'p0_delivery'->>'status' = 'delivered' then
          (select count(*) from pg_catalog.jsonb_object_keys(work.payload->'p0_delivery')) = 10
          and public.is_canonical_p0_timestamp_v2(work.payload->'p0_delivery'->>'claimed_at')
          and public.is_canonical_p0_timestamp_v2(work.payload->'p0_delivery'->>'claim_expires_at')
          and public.is_canonical_p0_timestamp_v2(work.payload->'p0_delivery'->>'last_attempt_at')
          and public.is_canonical_p0_timestamp_v2(work.payload->'p0_delivery'->>'next_at')
          and public.is_canonical_p0_timestamp_v2(work.payload->'p0_delivery'->>'delivered_at')
          and jsonb_typeof(work.payload->'p0_delivery'->'readback') = 'object'
          and (select count(*) from pg_catalog.jsonb_object_keys(
            work.payload->'p0_delivery'->'readback'
          )) = 3
          and (work.payload->'p0_delivery'->'readback'->>'channel_id')
            ~ '^[A-Z0-9][A-Z0-9_-]{0,79}$'
          and (work.payload->'p0_delivery'->'readback'->>'message_ts')
            ~ '^[0-9]{1,20}\.[0-9]{1,20}$'
          and public.is_canonical_p0_timestamp_v2(
            work.payload->'p0_delivery'->'readback'->>'confirmed_at'
          )
        else false
      end as valid_p0_alert,
      work.payload->'p0_delivery' as p0_delivery
    from public.work_items_v2 as work
  ),
  work_metrics as (
    select
      count(*) filter (
        where state in ('open','in_progress','snoozed')
          and (actionable_at <= p_now or (priority = 'p0' and not acknowledged))
      )::bigint as actionable_count,
      count(*) filter (where state = 'snoozed')::bigint as snoozed_count,
      count(*) filter (
        where state in ('open','in_progress','snoozed')
          and first_opened_at <= p_now - interval '24 hours'
      )::bigint as overdue_count,
      count(*) filter (
        where state in ('open','in_progress','snoozed') and priority = 'p0'
      )::bigint as p0_count,
      count(*) filter (
        where state in ('open','in_progress','snoozed') and priority = 'p0' and not acknowledged
      )::bigint as unacknowledged_p0_count,
      count(*) filter (
        where state in ('open','in_progress','snoozed') and priority = 'p0'
          and not acknowledged and not valid_p0_alert
      )::bigint as unacknowledged_p0_missing_alert_count
    from work_classification
  ),
  latest_delivered_digest as (
    select delivered_at, item_snapshot
    from public.digest_runs
    where state in ('delivered','replaced') and delivered_at is not null
      and isfinite(delivered_at) and isfinite(scheduled_at)
    order by delivered_at desc, scheduled_at desc, id desc
    limit 1
  ),
  latest_digest_omissions as (
    select count(work.id)::bigint as omitted_count
    from latest_delivered_digest as digest
    join public.work_items_v2 as work on
      work.state in ('open','in_progress','snoozed')
      and work.first_opened_at <= digest.delivered_at
      and (
        work.actionable_at <= digest.delivered_at
        or (
          work.priority = 'p0'
          and not public.is_effective_p0_ack_v2(work.payload, digest.delivered_at)
        )
      )
    where not exists (
      select 1
      from jsonb_array_elements(digest.item_snapshot) as snapshot(entry)
      where snapshot.entry->>'id' = work.id::text
    )
  ),
  digest_metrics as (
    select
      count(*) filter (where state = 'building')::bigint as building_count,
      count(*) filter (where state = 'delivering')::bigint as delivering_count,
      count(*) filter (where state = 'delivered')::bigint as delivered_count,
      count(*) filter (where state = 'failed')::bigint as failed_count,
      count(*) filter (where state = 'diverged')::bigint as diverged_count,
      count(*) filter (where state = 'replaced')::bigint as replaced_count,
      count(*) filter (where state = 'retired')::bigint as retired_count,
      max(delivered_at) filter (
        where state in ('delivered','replaced') and isfinite(delivered_at)
      ) as last_success_at,
      max(updated_at) filter (where state in ('failed','diverged') and isfinite(updated_at))
        as last_failure_at
    from public.digest_runs
  ),
  notice_cleanup_base as (
    select cleanup_state,
      (
        cleanup_state in ('pending','failed')
        or (
          cleanup_state = 'idle' and notification_state = 'cleanup_pending'
          and cleanup_after is not null and cleanup_after <= p_now
        )
      ) as in_backlog,
      coalesce(cleanup_attempted_at, cleanup_after, updated_at) as backlog_at,
      cleanup_expires_at
    from public.message_notification_receipts
  ),
  notice_cleanup_metrics as (
    select
      count(*) filter (where cleanup_state = 'idle')::bigint as idle_count,
      count(*) filter (where cleanup_state = 'pending')::bigint as pending_count,
      count(*) filter (where cleanup_state = 'failed')::bigint as failed_count,
      count(*) filter (where cleanup_state = 'blocked_p0')::bigint as blocked_p0_count,
      count(*) filter (where cleanup_state = 'deleted')::bigint as deleted_count,
      count(*) filter (where in_backlog)::bigint as backlog_count,
      min(backlog_at) filter (where in_backlog and isfinite(backlog_at)) as oldest_backlog_at
    from notice_cleanup_base
  ),
  cleanup_chain(
    successor_digest_id, link_owner_id, previous_digest_id, previous_cleanup_state,
    successor_destination_key, successor_scheduled_at, successor_generation, depth, path
  ) as (
    select successor.id, successor.id, successor.previous_digest_id,
      successor.previous_cleanup_state, successor.destination_key, successor.scheduled_at,
      successor.generation, 1, array[successor.id, successor.previous_digest_id]::uuid[]
    from public.digest_runs as successor
    where successor.state in ('delivered','replaced')
      and successor.delivered_at is not null
      and successor.manifest_prepared_at is not null
      and successor.previous_digest_id is not null
    union all
    select chain.successor_digest_id, previous.id, previous.previous_digest_id,
      previous.previous_cleanup_state, chain.successor_destination_key,
      chain.successor_scheduled_at, chain.successor_generation, chain.depth + 1,
      chain.path || previous.previous_digest_id
    from cleanup_chain as chain
    join public.digest_runs as previous on previous.id = chain.previous_digest_id
    where previous.state = 'diverged'
      and previous.previous_digest_id is not null
      and not previous.previous_digest_id = any(chain.path)
  ),
  digest_cleanup_eligible_targets as (
    select chain.previous_digest_id
    from cleanup_chain as chain
    join public.digest_runs as previous on previous.id = chain.previous_digest_id
    where previous.destination_key = chain.successor_destination_key
      and previous.state in ('delivered','diverged','replaced')
      and previous.manifest_prepared_at is not null
      and (
        previous.scheduled_at < chain.successor_scheduled_at
        or (previous.scheduled_at = chain.successor_scheduled_at
          and previous.generation < chain.successor_generation)
      )
      and (previous.state = 'diverged' or previous.delivered_at is not null)
      and exists (
        select 1 from public.digest_message_parts as exact_part
        where exact_part.digest_run_id = previous.id
          and exact_part.delivery_state = 'delivered'
          and exact_part.slack_channel_id is not null
          and exact_part.slack_message_ts is not null
      )
      and (
        chain.previous_cleanup_state in ('idle','deleting','failed')
        or exists (
          select 1 from public.digest_message_parts as pending_part
          where pending_part.digest_run_id = previous.id
            and pending_part.delivery_state = 'delivered'
            and pending_part.slack_channel_id is not null
            and pending_part.slack_message_ts is not null
            and pending_part.cleanup_state in ('idle','deleting','failed')
        )
      )
  ),
  digest_cleanup_backlog as (
    select distinct part.id, coalesce(part.cleanup_attempted_at, part.delivered_at) as backlog_at
    from digest_cleanup_eligible_targets as target
    join public.digest_message_parts as part on part.digest_run_id = target.previous_digest_id
    where part.delivery_state = 'delivered'
      and part.slack_channel_id is not null
      and part.slack_message_ts is not null
      and part.cleanup_state in ('idle','deleting','failed')
  ),
  digest_cleanup_metrics as (
    select
      count(*) filter (where cleanup_state = 'idle')::bigint as idle_count,
      count(*) filter (where cleanup_state = 'deleting')::bigint as deleting_count,
      count(*) filter (where cleanup_state = 'failed')::bigint as failed_count,
      count(*) filter (where cleanup_state = 'deleted')::bigint as deleted_count,
      count(*) filter (where cleanup_state = 'already_absent')::bigint as already_absent_count
    from public.digest_message_parts
  ),
  digest_cleanup_backlog_metrics as (
    select count(*)::bigint as backlog_count,
      min(backlog_at) filter (where isfinite(backlog_at)) as oldest_backlog_at
    from digest_cleanup_backlog
  ),
  action_metrics as (
    select count(*)::bigint as stale_conflict_count
    from public.work_items_v2
    where pending_action <> '{}'::jsonb
      and (
        state not in ('open','in_progress','snoozed')
        or not public.is_valid_pending_work_action_at_v2(pending_action, version, p_now)
      )
  ),
  digest_leases as (
    select lease_expires_at
    from public.digest_runs
    where state in ('building','delivering','failed') and lease_expires_at is not null
      and isfinite(lease_expires_at)
  ),
  p0_leases as (
    select case
      when valid_p0_alert and p0_delivery->>'status' = 'claimed'
        then (p0_delivery->>'claim_expires_at')::timestamptz
      when valid_p0_alert and p0_delivery->>'status' = 'reconciling'
        then (p0_delivery->>'reconcile_expires_at')::timestamptz
      else null
    end as lease_expires_at
    from work_classification
    where state in ('open','in_progress','snoozed') and priority = 'p0'
  ),
  notice_cleanup_leases as (
    select cleanup_expires_at as lease_expires_at
    from public.message_notification_receipts
    where cleanup_state = 'pending' and cleanup_expires_at is not null
      and isfinite(cleanup_expires_at)
  ),
  digest_cleanup_leases as (
    select cleanup_expires_at as lease_expires_at
    from public.digest_message_parts
    where cleanup_state = 'deleting' and cleanup_expires_at is not null
      and isfinite(cleanup_expires_at)
  ),
  digest_lease_metrics as (
    select count(*) filter (where lease_expires_at > p_now)::bigint as active_count,
      count(*) filter (where lease_expires_at <= p_now)::bigint as expired_count,
      min(lease_expires_at) filter (where lease_expires_at <= p_now) as oldest_expired_at
    from digest_leases
  ),
  p0_lease_metrics as (
    select count(*) filter (where lease_expires_at > p_now)::bigint as active_count,
      count(*) filter (where lease_expires_at <= p_now)::bigint as expired_count,
      min(lease_expires_at) filter (where lease_expires_at <= p_now) as oldest_expired_at
    from p0_leases where lease_expires_at is not null
  ),
  notice_cleanup_lease_metrics as (
    select count(*) filter (where lease_expires_at > p_now)::bigint as active_count,
      count(*) filter (where lease_expires_at <= p_now)::bigint as expired_count,
      min(lease_expires_at) filter (where lease_expires_at <= p_now) as oldest_expired_at
    from notice_cleanup_leases
  ),
  digest_cleanup_lease_metrics as (
    select count(*) filter (where lease_expires_at > p_now)::bigint as active_count,
      count(*) filter (where lease_expires_at <= p_now)::bigint as expired_count,
      min(lease_expires_at) filter (where lease_expires_at <= p_now) as oldest_expired_at
    from digest_cleanup_leases
  )
  select jsonb_build_object(
    'measured_at', to_char(p_now at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'invalid_evidence_count', v_invalid_evidence_count,
    'notifications', jsonb_build_object(
      'undelivered_count', notification_metrics.undelivered_count,
      'pending_count', notification_metrics.pending_count,
      'delivering_count', notification_metrics.delivering_count,
      'failed_count', notification_metrics.failed_count,
      'oldest_undelivered_at', case when notification_metrics.oldest_at is null then null else
        to_char(notification_metrics.oldest_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'oldest_undelivered_age_seconds', case when notification_metrics.oldest_at is null then null else
        floor(extract(epoch from (p_now - notification_metrics.oldest_at)))::bigint end
    ),
    'automation', to_jsonb(automation_metrics),
    'work', to_jsonb(work_metrics),
    'digests', jsonb_build_object(
      'building_count', digest_metrics.building_count,
      'delivering_count', digest_metrics.delivering_count,
      'delivered_count', digest_metrics.delivered_count,
      'failed_count', digest_metrics.failed_count,
      'diverged_count', digest_metrics.diverged_count,
      'replaced_count', digest_metrics.replaced_count,
      'retired_count', digest_metrics.retired_count,
      'last_success_at', case when digest_metrics.last_success_at is null then null else
        to_char(digest_metrics.last_success_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'last_failure_at', case when digest_metrics.last_failure_at is null then null else
        to_char(digest_metrics.last_failure_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
      'latest_delivered_eligible_omitted_count', coalesce(latest_digest_omissions.omitted_count, 0)
    ),
    'cleanup', jsonb_build_object(
      'notice', jsonb_build_object(
        'idle_count', notice_cleanup_metrics.idle_count,
        'pending_count', notice_cleanup_metrics.pending_count,
        'failed_count', notice_cleanup_metrics.failed_count,
        'blocked_p0_count', notice_cleanup_metrics.blocked_p0_count,
        'deleted_count', notice_cleanup_metrics.deleted_count,
        'backlog_count', notice_cleanup_metrics.backlog_count,
        'oldest_backlog_age_seconds', case when notice_cleanup_metrics.oldest_backlog_at is null then null else
          floor(extract(epoch from (p_now - notice_cleanup_metrics.oldest_backlog_at)))::bigint end
      ),
      'digest', jsonb_build_object(
        'idle_count', digest_cleanup_metrics.idle_count,
        'deleting_count', digest_cleanup_metrics.deleting_count,
        'failed_count', digest_cleanup_metrics.failed_count,
        'deleted_count', digest_cleanup_metrics.deleted_count,
        'already_absent_count', digest_cleanup_metrics.already_absent_count,
        'backlog_count', digest_cleanup_backlog_metrics.backlog_count,
        'oldest_backlog_age_seconds', case when digest_cleanup_backlog_metrics.oldest_backlog_at is null then null else
          floor(extract(epoch from (p_now - digest_cleanup_backlog_metrics.oldest_backlog_at)))::bigint end
      )
    ),
    'actions', to_jsonb(action_metrics),
    'leases', jsonb_build_object(
      'digest', jsonb_build_object(
        'active_count', digest_lease_metrics.active_count,
        'expired_count', digest_lease_metrics.expired_count,
        'oldest_expired_age_seconds', case when digest_lease_metrics.oldest_expired_at is null then null else
          floor(extract(epoch from (p_now - digest_lease_metrics.oldest_expired_at)))::bigint end
      ),
      'p0', jsonb_build_object(
        'active_count', p0_lease_metrics.active_count,
        'expired_count', p0_lease_metrics.expired_count,
        'oldest_expired_age_seconds', case when p0_lease_metrics.oldest_expired_at is null then null else
          floor(extract(epoch from (p_now - p0_lease_metrics.oldest_expired_at)))::bigint end
      ),
      'notice_cleanup', jsonb_build_object(
        'active_count', notice_cleanup_lease_metrics.active_count,
        'expired_count', notice_cleanup_lease_metrics.expired_count,
        'oldest_expired_age_seconds', case when notice_cleanup_lease_metrics.oldest_expired_at is null then null else
          floor(extract(epoch from (p_now - notice_cleanup_lease_metrics.oldest_expired_at)))::bigint end
      ),
      'digest_cleanup', jsonb_build_object(
        'active_count', digest_cleanup_lease_metrics.active_count,
        'expired_count', digest_cleanup_lease_metrics.expired_count,
        'oldest_expired_age_seconds', case when digest_cleanup_lease_metrics.oldest_expired_at is null then null else
          floor(extract(epoch from (p_now - digest_cleanup_lease_metrics.oldest_expired_at)))::bigint end
      )
    )
  ) into v_result
  from notification_metrics, automation_metrics, work_metrics, digest_metrics,
    latest_digest_omissions, notice_cleanup_metrics, digest_cleanup_metrics,
    digest_cleanup_backlog_metrics, action_metrics, digest_lease_metrics, p0_lease_metrics,
    notice_cleanup_lease_metrics, digest_cleanup_lease_metrics;

  return v_result;
end;
$$;

revoke execute on function public.read_work_orchestrator_health_v2(timestamptz)
  from public, anon, authenticated;
revoke execute on function public.is_valid_pending_work_action_at_v2(jsonb,integer,timestamptz)
  from public, anon, authenticated;
grant execute on function public.read_work_orchestrator_health_v2(timestamptz)
  to service_role;
grant execute on function public.is_valid_pending_work_action_at_v2(jsonb,integer,timestamptz)
  to service_role;
