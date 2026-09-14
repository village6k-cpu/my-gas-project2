-- AI identity decisions are metadata. Existing stock rows and audit snapshots remain untouched.
create table village.inventory_identity_reviews (
 id uuid not null unique default gen_random_uuid(), source_key text primary key, source_name text not null,
 action text not null check(action in ('link_existing','ask_owner')), source_hash text not null,
 equipment_id text references village.equipment_ledger(equipment_id), equipment_name text,
 evidence jsonb not null check(jsonb_typeof(evidence)='object'), question_text text, question_channel text,
 question_ts text, posted_at timestamptz, attempted_at timestamptz, lease_owner uuid, lease_until timestamptz, cancelled_at timestamptz, last_claimed_at timestamptz,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
alter table village.inventory_identity_reviews enable row level security;
revoke all on village.inventory_identity_reviews from public,anon,authenticated;
grant select,insert,update on village.inventory_identity_reviews to service_role;
create table village.inventory_identity_aliases (
 name_key text primary key, source_name text not null, equipment_id text not null references village.equipment_ledger(equipment_id) on delete cascade,
 equipment_name text not null, review_id uuid not null references village.inventory_identity_reviews(id), created_at timestamptz not null default now()
);
alter table village.inventory_identity_aliases enable row level security;
revoke all on village.inventory_identity_aliases from public,anon,authenticated;
grant select on village.inventory_identity_aliases to authenticated;
grant select,insert,update on village.inventory_identity_aliases to service_role;
create policy inventory_identity_aliases_authenticated_read on village.inventory_identity_aliases for select to authenticated using(true);

create function village.record_inventory_identity_review(p_decision jsonb) returns jsonb
language plpgsql security invoker set search_path='' as $$
declare prior village.inventory_identity_reviews%rowtype; asset village.equipment_ledger%rowtype; key_name text; result_id uuid; decision_action text:=p_decision->>'action';
begin
 if jsonb_typeof(p_decision) is distinct from 'object' or coalesce(p_decision->>'sourceId','') !~ '^[0-9a-f]{64}$' or coalesce(length(p_decision->>'sourceName'),0) not between 1 and 200 or coalesce(length(p_decision->>'reason'),0) not between 1 and 2000 then raise exception 'invalid_identity_decision'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('village.inventory_audit.full_shop',0));
 key_name:=lower(regexp_replace(normalize(p_decision->>'sourceName',NFKC),'[^0-9A-Za-z가-힣]','','g'));
 if key_name='' then raise exception 'invalid_identity_name'; end if;
 select * into prior from village.inventory_identity_reviews where source_key=p_decision->>'sourceId' for update;
 if decision_action='link_existing' then
  select * into asset from village.equipment_ledger where equipment_id=p_decision->>'equipmentId';
  if not found or asset.name is distinct from p_decision->>'equipmentName' or asset.updated_at is distinct from (p_decision->>'expectedUpdatedAt')::timestamptz then raise exception 'identity_target_changed'; end if;
  if exists(select 1 from village.equipment_ledger e where lower(regexp_replace(normalize(e.category,NFKC),'[^0-9A-Za-z가-힣]','','g'))=key_name) then raise exception 'model_choice_not_global_alias'; end if;
  if exists(select 1 from village.equipment_ledger e where e.equipment_id<>asset.equipment_id and (lower(regexp_replace(normalize(e.name,NFKC),'[^0-9A-Za-z가-힣]','','g'))=key_name or exists(select 1 from jsonb_array_elements_text(e.aliases) a where lower(regexp_replace(normalize(a,NFKC),'[^0-9A-Za-z가-힣]','','g'))=key_name))) then raise exception 'identity_alias_collision'; end if;
  if exists(
   select 1 from village.inventory_audit_decisions d join village.inventory_audit_sessions a on a.id=d.session_id
   where a.status not in ('approved','cancelled') and d.resolution='create_equipment'
    and coalesce(nullif(btrim(d.resolved_equipment_id),''),nullif(btrim(d.new_equipment_payload->>'equipment_id'),'')) is distinct from asset.equipment_id
    and (lower(regexp_replace(normalize(d.new_equipment_payload->>'name',NFKC),'[^0-9A-Za-z가-힣]','','g'))=key_name
     or exists(select 1 from jsonb_array_elements_text(case when jsonb_typeof(d.new_equipment_payload->'aliases')='array' then d.new_equipment_payload->'aliases' else '[]'::jsonb end) n
      where lower(regexp_replace(normalize(n,NFKC),'[^0-9A-Za-z가-힣]','','g'))=key_name))
  ) then raise exception 'identity_name_pending_in_audit'; end if;
  if exists(select 1 from village.inventory_identity_aliases where name_key=key_name and equipment_id<>asset.equipment_id) then raise exception 'identity_alias_collision'; end if;
  if prior.action='link_existing' and prior.equipment_id is distinct from asset.equipment_id then raise exception 'identity_decision_changed'; end if;
  insert into village.inventory_identity_reviews(source_key,source_name,source_hash,action,equipment_id,equipment_name,evidence)
  values(p_decision->>'sourceId',p_decision->>'sourceName',p_decision->>'sourceHash','link_existing',asset.equipment_id,asset.name,p_decision)
  on conflict(source_key) do update set action='link_existing',equipment_id=excluded.equipment_id,equipment_name=excluded.equipment_name,evidence=excluded.evidence,source_hash=excluded.source_hash,updated_at=now()
  returning id into result_id;
  insert into village.inventory_identity_aliases(name_key,source_name,equipment_id,equipment_name,review_id) values(key_name,p_decision->>'sourceName',asset.equipment_id,asset.name,result_id)
  on conflict(name_key) do update set equipment_name=excluded.equipment_name,review_id=excluded.review_id;
  if prior.action is distinct from 'link_existing' then insert into village.equipment_events(equipment_id,type,payload,actor) values(asset.equipment_id,'ai_identity_linked',p_decision,'inventory-native-ai'); end if;
  return jsonb_build_object('ok',true,'action','link_existing','id',result_id,'equipmentId',asset.equipment_id,'sourceName',p_decision->>'sourceName');
 elsif decision_action='ask_owner' then
  if coalesce(length(p_decision->>'question'),0) not between 1 and 1500 or coalesce(p_decision->>'channel','') !~ '^[CG][A-Z0-9]+$' then raise exception 'invalid_inventory_question'; end if;
  if prior.id is not null and prior.cancelled_at is null then return jsonb_build_object('ok',true,'action',prior.action,'id',prior.id,'duplicate',true); end if;
  insert into village.inventory_identity_reviews(source_key,source_name,source_hash,action,evidence,question_text,question_channel)
  values(p_decision->>'sourceId',p_decision->>'sourceName',p_decision->>'sourceHash','ask_owner',p_decision,p_decision->>'question',p_decision->>'channel')
  on conflict(source_key) do update set source_hash=excluded.source_hash,evidence=excluded.evidence,question_text=excluded.question_text,question_channel=excluded.question_channel,cancelled_at=null,attempted_at=null,lease_owner=null,lease_until=null,created_at=now(),updated_at=now() returning id into result_id;
  return jsonb_build_object('ok',true,'action','ask_owner','id',result_id,'pending',true);
 else raise exception 'invalid_identity_action'; end if;
end;
$$;
revoke all on function village.record_inventory_identity_review(jsonb) from public,anon,authenticated;
grant execute on function village.record_inventory_identity_review(jsonb) to service_role;

-- New stock creation must not duplicate a previously resolved identity, including concurrent creates.
create function village.prevent_inventory_identity_duplicate() returns trigger language plpgsql security invoker set search_path='' as $$
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('village.inventory_audit.full_shop',0));
 if exists(select 1 from village.inventory_identity_aliases a where a.equipment_id<>new.equipment_id and (a.name_key=lower(regexp_replace(normalize(new.name,NFKC),'[^0-9A-Za-z가-힣]','','g')) or exists(select 1 from jsonb_array_elements_text(new.aliases) n where a.name_key=lower(regexp_replace(normalize(n,NFKC),'[^0-9A-Za-z가-힣]','','g'))))) then raise exception 'equipment_identity_already_exists'; end if;
 return new;
end;
$$;
create trigger equipment_identity_duplicate_guard before insert or update of name,aliases on village.equipment_ledger for each row execute function village.prevent_inventory_identity_duplicate();

create function village.claim_inventory_identity_question(p_owner uuid,p_id uuid default null) returns jsonb language plpgsql security invoker set search_path='' as $$
declare r village.inventory_identity_reviews%rowtype;
begin
 if p_owner is null then raise exception 'question_owner_required'; end if;
 select * into r from village.inventory_identity_reviews where action='ask_owner' and posted_at is null and cancelled_at is null and (p_id is null or id=p_id) and (lease_until is null or lease_until<now()) order by last_claimed_at nulls first,created_at for update skip locked limit 1;
 if not found then return null; end if;
 update village.inventory_identity_reviews set lease_owner=p_owner,lease_until=now()+interval '2 minutes',last_claimed_at=now() where id=r.id returning * into r;
 return to_jsonb(r);
end;
$$;
create function village.mark_inventory_identity_question_attempt(p_id uuid,p_owner uuid) returns boolean language plpgsql security invoker set search_path='' as $$
begin
 update village.inventory_identity_reviews set attempted_at=now() where id=p_id and lease_owner=p_owner and lease_until>now() and action='ask_owner' and posted_at is null and cancelled_at is null and (attempted_at is null or attempted_at<now()-interval '60 seconds');
 return found;
end;
$$;
create function village.complete_inventory_identity_question(p_id uuid,p_owner uuid,p_ts text) returns boolean language plpgsql security invoker set search_path='' as $$
begin
 if coalesce(p_ts,'') !~ '^[0-9]+[.][0-9]+$' then raise exception 'invalid_slack_receipt'; end if;
 update village.inventory_identity_reviews set question_ts=p_ts,posted_at=now(),lease_owner=null,lease_until=null where id=p_id and lease_owner=p_owner and lease_until>now() and posted_at is null and action='ask_owner';
 return found;
end;
$$;
revoke all on function village.claim_inventory_identity_question(uuid,uuid),village.mark_inventory_identity_question_attempt(uuid,uuid),village.complete_inventory_identity_question(uuid,uuid,text) from public,anon,authenticated;
grant execute on function village.claim_inventory_identity_question(uuid,uuid),village.mark_inventory_identity_question_attempt(uuid,uuid),village.complete_inventory_identity_question(uuid,uuid,text) to service_role;