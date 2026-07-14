select
  namespace.nspname as schema_name,
  relation.relname as table_name,
  relation.relrowsecurity as rls_enabled,
  relation.relforcerowsecurity as rls_forced
from pg_catalog.pg_class as relation
join pg_catalog.pg_namespace as namespace
  on namespace.oid = relation.relnamespace
where namespace.nspname = 'village'
  and relation.relname in (
    'equipment_ledger',
    'inventory_audit_sessions',
    'inventory_audit_snapshot_items',
    'inventory_audit_snapshot_rental_exceptions',
    'inventory_audit_observations',
    'inventory_audit_decisions'
  )
order by relation.relname;

select
  schemaname,
  tablename,
  policyname,
  permissive,
  roles,
  cmd,
  qual,
  with_check
from pg_catalog.pg_policies
where (schemaname = 'village' and tablename in (
  'equipment_ledger',
  'inventory_audit_sessions',
  'inventory_audit_snapshot_items',
  'inventory_audit_snapshot_rental_exceptions',
  'inventory_audit_observations',
  'inventory_audit_decisions'
))
or (schemaname = 'storage' and tablename = 'objects' and policyname like 'inventory_audit_evidence_%')
order by schemaname, tablename, policyname;

select
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
from storage.buckets
where id = 'inventory-audit-evidence';

select
  namespace.nspname as schema_name,
  procedure.proname as function_name,
  pg_catalog.pg_get_function_identity_arguments(procedure.oid) as identity_arguments,
  procedure.prosecdef as security_definer,
  procedure.proconfig as function_settings,
  procedure.proacl as function_acl
from pg_catalog.pg_proc as procedure
join pg_catalog.pg_namespace as namespace
  on namespace.oid = procedure.pronamespace
where namespace.nspname = 'village'
  and procedure.proname in (
    'inventory_audit_ledger_writes_allowed',
    'start_inventory_audit',
    'save_inventory_audit_observation',
    'delete_inventory_audit_observation',
    'submit_inventory_audit',
    'cancel_inventory_audit',
    'reserve_inventory_audit_evidence',
    'complete_inventory_audit_evidence',
    'request_inventory_audit_recount',
    'approve_inventory_audit'
  )
order by procedure.proname;
