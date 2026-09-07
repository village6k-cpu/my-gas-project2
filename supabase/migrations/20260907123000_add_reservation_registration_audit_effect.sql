alter table public.kakao_automation_audit_events
  drop constraint if exists kakao_automation_audit_events_event_key_check_next,
  drop constraint if exists kakao_automation_audit_events_effect_type_check_next;

alter table public.kakao_automation_audit_events
  add constraint kakao_automation_audit_events_event_key_check_next
    check (event_key ~ '^kakao:(auto_reply|confirmation_request|reservation_registration|registered_reservation_change|document_send):[0-9a-f]{64}$') not valid,
  add constraint kakao_automation_audit_events_effect_type_check_next
    check (effect_type in ('auto_reply','confirmation_request','reservation_registration','registered_reservation_change','document_send')) not valid;

-- Validate existing rows without holding the long ACCESS EXCLUSIVE table lock.
alter table public.kakao_automation_audit_events
  validate constraint kakao_automation_audit_events_event_key_check_next;
alter table public.kakao_automation_audit_events
  validate constraint kakao_automation_audit_events_effect_type_check_next;

-- Only the final name swap needs the short exclusive DDL lock.
begin;

alter table public.kakao_automation_audit_events
  drop constraint if exists kakao_automation_audit_events_event_key_check,
  drop constraint if exists kakao_automation_audit_events_effect_type_check;

alter table public.kakao_automation_audit_events
  rename constraint kakao_automation_audit_events_event_key_check_next
    to kakao_automation_audit_events_event_key_check;
alter table public.kakao_automation_audit_events
  rename constraint kakao_automation_audit_events_effect_type_check_next
    to kakao_automation_audit_events_effect_type_check;

commit;
