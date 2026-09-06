set lock_timeout = '5s';

with reset_targets as materialized (
  select work.id
  from public.work_items_v2 as work
  where work.first_opened_at < '2026-09-05T15:00:00.000Z'::timestamptz
  for update
), cleared_receipt_links as (
  update public.message_notification_receipts as receipt
  set cleanup_work_id = null,
      cleanup_work_version = null
  where receipt.cleanup_work_id in (select target.id from reset_targets as target)
  returning receipt.id
)
delete from public.work_items_v2 as work
using reset_targets as target
where work.id = target.id;
