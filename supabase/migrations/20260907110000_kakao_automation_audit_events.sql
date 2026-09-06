create table public.kakao_automation_audit_events (
  event_key text primary key
    check (event_key ~ '^kakao:(auto_reply|confirmation_request|registered_reservation_change|document_send):[0-9a-f]{64}$'),
  job_id text not null
    check (char_length(job_id) between 1 and 160)
    check (job_id !~* '01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4}')
    check (job_id !~* '(bearer[[:space:]]+[a-z0-9._~-]+|(token|secret|password|apikey|api[_ -]?key)[[:space:]]*[:=]|(계좌|은행|account)(번호)?[^0-9]{0,20}[0-9][0-9 -]{7,}[0-9])'),
  room_revision integer not null check (room_revision > 0),
  operation_id text null
    check (operation_id is null or char_length(operation_id) between 1 and 160)
    check (operation_id is null or operation_id !~* '01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4}')
    check (operation_id is null or operation_id !~* '(bearer[[:space:]]+[a-z0-9._~-]+|(token|secret|password|apikey|api[_ -]?key)[[:space:]]*[:=]|(계좌|은행|account)(번호)?[^0-9]{0,20}[0-9][0-9 -]{7,}[0-9])'),
  receipt_id text null
    check (receipt_id is null or char_length(receipt_id) between 1 and 200)
    check (receipt_id is null or receipt_id !~* '01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4}')
    check (receipt_id is null or receipt_id !~* '(bearer[[:space:]]+[a-z0-9._~-]+|(token|secret|password|apikey|api[_ -]?key)[[:space:]]*[:=]|(계좌|은행|account)(번호)?[^0-9]{0,20}[0-9][0-9 -]{7,}[0-9])'),
  occurred_at timestamptz not null check (isfinite(occurred_at)),
  recorded_at timestamptz not null default now() check (isfinite(recorded_at)),
  effect_type text not null
    check (effect_type in ('auto_reply','confirmation_request','registered_reservation_change','document_send')),
  action_type text not null
    check (action_type in ('send','create','update','add','remove','replace','quantity_change','date_time_change')),
  outcome text not null
    check (outcome in ('success','partial_success','failed','blocked','no_action')),
  customer_label text not null
    check (char_length(customer_label) between 1 and 120)
    check (customer_label !~* '01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4}')
    check (customer_label !~* '(bearer[[:space:]]+[a-z0-9._~-]+|(token|secret|password|apikey|api[_ -]?key)[[:space:]]*[:=]|(계좌|은행|account)(번호)?[^0-9]{0,20}[0-9][0-9 -]{7,}[0-9])'),
  target_type text not null check (target_type in ('room','request','trade','document')),
  target_id text null
    check (target_id is null or char_length(target_id) between 1 and 160)
    check (target_id is null or target_id !~* '01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4}')
    check (target_id is null or target_id !~* '(bearer[[:space:]]+[a-z0-9._~-]+|(token|secret|password|apikey|api[_ -]?key)[[:space:]]*[:=]|(계좌|은행|account)(번호)?[^0-9]{0,20}[0-9][0-9 -]{7,}[0-9])'),
  summary text not null
    check (char_length(summary) between 1 and 500)
    check (summary !~* '01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4}')
    check (summary !~* '(bearer[[:space:]]+[a-z0-9._~-]+|(token|secret|password|apikey|api[_ -]?key)[[:space:]]*[:=]|(계좌|은행|account)(번호)?[^0-9]{0,20}[0-9][0-9 -]{7,}[0-9])'),
  change_items jsonb not null default '[]'::jsonb
    check (jsonb_typeof(change_items) = 'array')
    check (jsonb_array_length(change_items) <= 20)
    check (octet_length(change_items::text) <= 8000)
    check (change_items::text !~* '01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4}')
    check (change_items::text !~* '(bearer[[:space:]]+[a-z0-9._~-]+|(token|secret|password|apikey|api[_ -]?key)[[:space:]]*[:=]|(계좌|은행|account)(번호)?[^0-9]{0,20}[0-9][0-9 -]{7,}[0-9])'),
  outbound_text text null
    check (outbound_text is null or char_length(outbound_text) between 1 and 2000)
    check (outbound_text is null or outbound_text !~* '01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4}')
    check (outbound_text is null or outbound_text !~* '(bearer[[:space:]]+[a-z0-9._~-]+|(token|secret|password|apikey|api[_ -]?key)[[:space:]]*[:=]|(계좌|은행|account)(번호)?[^0-9]{0,20}[0-9][0-9 -]{7,}[0-9])'),
  evidence jsonb not null
    check (jsonb_typeof(evidence) = 'object')
    check (octet_length(evidence::text) <= 4000)
    check (evidence::text !~* '01[016789][ -]?[0-9]{3,4}[ -]?[0-9]{4}')
    check (evidence::text !~* '(bearer[[:space:]]+[a-z0-9._~-]+|(token|secret|password|apikey|api[_ -]?key)[[:space:]]*[:=]|(계좌|은행|account)(번호)?[^0-9]{0,20}[0-9][0-9 -]{7,}[0-9])'),
  source_message_at timestamptz null check (source_message_at is null or isfinite(source_message_at)),
  historical_import boolean not null default false
);

create index kakao_automation_audit_occurred_idx
  on public.kakao_automation_audit_events (occurred_at desc, event_key desc);
create index kakao_automation_audit_outcome_idx
  on public.kakao_automation_audit_events (outcome, occurred_at desc);
create index kakao_automation_audit_effect_idx
  on public.kakao_automation_audit_events (effect_type, occurred_at desc);
create index kakao_automation_audit_customer_idx
  on public.kakao_automation_audit_events (lower(customer_label));
create index kakao_automation_audit_target_idx
  on public.kakao_automation_audit_events (target_id, occurred_at desc);

create function public.reject_kakao_automation_audit_event_mutation()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'kakao_automation_audit_event_immutable';
end;
$$;

create trigger reject_kakao_automation_audit_event_mutation
before update or delete on public.kakao_automation_audit_events
for each row execute function public.reject_kakao_automation_audit_event_mutation();

create table public.kakao_automation_audit_projection_status (
  singleton boolean primary key default true check (singleton),
  pending_count integer not null default 0 check (pending_count >= 0),
  conflict_count integer not null default 0 check (conflict_count >= 0),
  oldest_pending_at timestamptz null check (oldest_pending_at is null or isfinite(oldest_pending_at)),
  last_success_at timestamptz null check (last_success_at is null or isfinite(last_success_at)),
  updated_at timestamptz not null default now() check (isfinite(updated_at))
);

insert into public.kakao_automation_audit_projection_status (singleton)
values (true)
on conflict (singleton) do nothing;

alter table public.kakao_automation_audit_events enable row level security;
alter table public.kakao_automation_audit_projection_status enable row level security;

revoke all on table public.kakao_automation_audit_events from public, anon, authenticated, service_role;
revoke all on table public.kakao_automation_audit_projection_status from public, anon, authenticated, service_role;
revoke all on function public.reject_kakao_automation_audit_event_mutation() from public, anon, authenticated, service_role;

grant select, insert on table public.kakao_automation_audit_events to service_role;
grant select, insert, update on table public.kakao_automation_audit_projection_status to service_role;
