-- Durable, source-keyed reports. Slack never adjusts physical inventory counts.
create table village.slack_equipment_reports (
  channel_id text not null,
  message_ts text not null,
  equipment_id text not null references village.equipment_ledger(equipment_id),
  source_hash text not null,
  report jsonb not null,
  previous_labels jsonb not null default '[]'::jsonb,
  mirrored_segments jsonb,
  active boolean not null default true,
  synced_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (channel_id, message_ts, equipment_id),
  foreign key (channel_id, message_ts) references village.slack_ops_events(channel_id, message_ts)
);
alter table village.slack_equipment_reports enable row level security;
revoke all on village.slack_equipment_reports from public, anon, authenticated;
grant select, insert, update on village.slack_equipment_reports to service_role;

create function village.record_slack_equipment_reports(
  p_channel_id text, p_message_ts text, p_source_hash text,
  p_reports jsonb, p_finish boolean default false
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_event village.slack_ops_events%rowtype;
  v_row village.equipment_ledger%rowtype;
  v_old village.slack_equipment_reports%rowtype;
  v_report jsonb;
  v_issues jsonb;
  v_key text;
  v_id text;
  v_changed integer := 0;
begin
  if jsonb_typeof(p_reports) is distinct from 'array' or jsonb_array_length(p_reports) > 12 then
    raise exception 'invalid_equipment_reports';
  end if;
  select * into v_event from village.slack_ops_events
    where channel_id = p_channel_id and message_ts = p_message_ts for update;
  if not found or v_event.source_hash <> p_source_hash then raise exception 'slack_source_changed'; end if;
  if (select count(*) from jsonb_array_elements(p_reports)) <>
     (select count(distinct value->>'equipmentId') from jsonb_array_elements(p_reports)) then
    raise exception 'duplicate_equipment_report';
  end if;
  -- Acquire all affected equipment locks in one order, including replaced mappings.
  for v_id in
    select value->>'equipmentId' from jsonb_array_elements(p_reports)
    union select equipment_id from village.slack_equipment_reports
      where channel_id = p_channel_id and message_ts = p_message_ts
    order by 1
  loop
    select * into v_row from village.equipment_ledger where equipment_id = v_id for update;
    if not found then raise exception 'equipment_not_found'; end if;
    select value into v_report from jsonb_array_elements(p_reports) where value->>'equipmentId' = v_id;
    select * into v_old from village.slack_equipment_reports
      where channel_id = p_channel_id and message_ts = p_message_ts and equipment_id = v_id;
    if v_report is not null and (coalesce(v_report->>'kind','') not in ('inventory','loss','damage')
      or coalesce(length(v_report->>'label'),0) not between 1 and 1000
      or coalesce(length(v_report->>'quote'),0) not between 1 and 700) then
      raise exception 'invalid_equipment_report';
    end if;
    v_key := 'slack:' || p_channel_id || ':' || p_message_ts || ':' || v_id;
    select coalesce(jsonb_agg(value), '[]'::jsonb) into v_issues
      from jsonb_array_elements(coalesce(v_row.open_issues,'[]'::jsonb))
      where value->>'key' is distinct from v_key;
    if v_report is not null then
      v_issues := v_issues || jsonb_build_array(jsonb_build_object(
        'key',v_key,'label',v_report->>'label','at',to_char(to_timestamp(p_message_ts::numeric) at time zone 'Asia/Seoul','YYYY-MM-DD'),
        'source','slack','kind',v_report->>'kind'));
    end if;
    -- JSON array order is presentation, not a new business report.
    if not (v_issues @> coalesce(v_row.open_issues,'[]'::jsonb)
      and coalesce(v_row.open_issues,'[]'::jsonb) @> v_issues) then
      update village.equipment_ledger set open_issues = v_issues, updated_at = clock_timestamp()
        where equipment_id = v_id;
      insert into village.equipment_events(equipment_id,type,payload,actor)
        values(v_id,'slack_report',jsonb_build_object('sourceKey',v_key,'sourceHash',p_source_hash,'report',v_report,'previous',v_old.report),'slack-heybilli-sync');
      v_changed := v_changed + 1;
    end if;
    if v_report is not null then
      insert into village.slack_equipment_reports(channel_id,message_ts,equipment_id,source_hash,report)
        values(p_channel_id,p_message_ts,v_id,p_source_hash,v_report)
      on conflict(channel_id,message_ts,equipment_id) do update set
        previous_labels=case when slack_equipment_reports.report->>'label' is distinct from excluded.report->>'label'
          then slack_equipment_reports.previous_labels || jsonb_build_array(slack_equipment_reports.report->>'label')
          else slack_equipment_reports.previous_labels end,
        source_hash=excluded.source_hash,report=excluded.report,active=true,synced_at=null,last_error=null,updated_at=clock_timestamp()
      where slack_equipment_reports.source_hash is distinct from excluded.source_hash
        or slack_equipment_reports.report is distinct from excluded.report or not slack_equipment_reports.active;
    elsif v_old.active then
      update village.slack_equipment_reports set active=false,source_hash=p_source_hash,synced_at=null,last_error=null,updated_at=clock_timestamp()
        where channel_id=p_channel_id and message_ts=p_message_ts and equipment_id=v_id;
    end if;
  end loop;
  -- Trade application is a separate sink. Never replace its durable applied_plan.
  if p_finish then
    update village.slack_ops_events set status='applied',applied_at=now(),last_error=null,updated_at=now()
      where channel_id=p_channel_id and message_ts=p_message_ts;
  end if;
  return jsonb_build_object('ok',true,'changedCount',v_changed,'reportCount',jsonb_array_length(p_reports));
end;
$$;
revoke all on function village.record_slack_equipment_reports(text,text,text,jsonb,boolean) from public, anon, authenticated;
grant execute on function village.record_slack_equipment_reports(text,text,text,jsonb,boolean) to service_role;

-- Copy sheet-only handwriting into the canonical note with a revision check.
create function village.preserve_slack_equipment_sheet_note(
  p_equipment_id text, p_expected_updated_at timestamptz, p_note text
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_updated_at timestamptz;
begin
  if p_note is null or length(p_note) > 45000 then raise exception 'invalid_equipment_note'; end if;
  update village.equipment_ledger set note=p_note,updated_at=clock_timestamp()
    where equipment_id=p_equipment_id and updated_at=p_expected_updated_at
    returning updated_at into v_updated_at;
  if not found then raise exception 'equipment_note_revision_changed'; end if;
  insert into village.equipment_events(equipment_id,type,payload,actor)
    values(p_equipment_id,'slack_sheet_note_preserved',jsonb_build_object('note',p_note),'slack-heybilli-sync');
  return jsonb_build_object('updated_at',v_updated_at);
end;
$$;
revoke all on function village.preserve_slack_equipment_sheet_note(text,timestamptz,text) from public, anon, authenticated;
grant execute on function village.preserve_slack_equipment_sheet_note(text,timestamptz,text) to service_role;
