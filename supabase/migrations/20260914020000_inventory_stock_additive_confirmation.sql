-- Preserve audit sessions and existing stock. Only independently confirmed new catalog assets may be added.
create or replace function village.confirm_missing_inventory_stock(p_source_key text,p_item jsonb,p_evidence jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare v_id text; v_prior village.inventory_stock_confirmations%rowtype; v_name text; v_prefix text; v_total integer; v_maint integer; v_count integer;
begin
 if coalesce(length(p_source_key),0) not between 8 and 250 or jsonb_typeof(p_item) is distinct from 'object' or jsonb_typeof(p_evidence) is distinct from 'object' then raise exception 'invalid_stock_confirmation'; end if;
 p_evidence:=p_evidence||jsonb_build_object('confirmedItem',p_item);
 v_name:=p_item->>'name'; v_total:=(p_item->>'stock_total')::integer; v_maint:=(p_item->>'stock_maint')::integer;
 if coalesce(length(v_name),0) not between 1 and 200 or v_total is null or v_total<0 or v_total>9999 or v_maint is null or v_maint<0 or v_maint>v_total then raise exception 'invalid_stock_count'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('village.inventory_audit.full_shop',0));
 -- Owner-confirmed additions never change snapshot items or pending audit creations.
 if exists(
  select 1 from village.inventory_audit_decisions d join village.inventory_audit_sessions a on a.id=d.session_id
  where a.status not in ('approved','cancelled') and d.resolution='create_equipment' and (
   lower(regexp_replace(d.new_equipment_payload->>'name','[^0-9A-Za-z가-힣]','','g'))=lower(regexp_replace(v_name,'[^0-9A-Za-z가-힣]','','g'))
   or exists(select 1 from jsonb_array_elements_text(coalesce(d.new_equipment_payload->'aliases','[]'::jsonb)) alias
    where lower(regexp_replace(alias,'[^0-9A-Za-z가-힣]','','g'))=lower(regexp_replace(v_name,'[^0-9A-Za-z가-힣]','','g')))
  )
 ) then raise exception 'equipment_pending_in_audit'; end if;
 select * into v_prior from village.inventory_stock_confirmations where source_key=p_source_key for update;
 if found then
   if v_prior.evidence is distinct from p_evidence then raise exception 'stock_confirmation_evidence_changed'; end if;
   return jsonb_build_object('ok',true,'duplicate',true,'equipmentId',v_prior.equipment_id);
 end if;
 -- Existing UI writes share the audit advisory lock through RLS. Avoid a table
 -- lock upgrade here: UI DML already holds RowExclusive before entering RLS.
 select count(*),min(equipment_id) into v_count,v_id from village.equipment_ledger e
 where lower(regexp_replace(e.name,'[^0-9A-Za-z가-힣]','','g'))=lower(regexp_replace(v_name,'[^0-9A-Za-z가-힣]','','g'))
 or exists(select 1 from jsonb_array_elements_text(e.aliases) a where lower(regexp_replace(a,'[^0-9A-Za-z가-힣]','','g'))=lower(regexp_replace(v_name,'[^0-9A-Za-z가-힣]','','g')));
 if v_count>0 then raise exception 'equipment_already_exists'; end if;
 select split_part(equipment_id,'-',1) into v_prefix from village.equipment_ledger
 where category=p_item->>'category' and equipment_id ~ '^[A-Z]+-[0-9]+$' group by 1 order by count(*) desc,1 limit 1;
 v_prefix:=coalesce(v_prefix,'EQ');
 select coalesce(max(split_part(equipment_id,'-',2)::integer),0)+1 into v_count
 from (
  select equipment_id from village.equipment_ledger
  union all
  select coalesce(nullif(btrim(d.resolved_equipment_id),''),nullif(btrim(d.new_equipment_payload->>'equipment_id'),''))
  from village.inventory_audit_decisions d join village.inventory_audit_sessions a on a.id=d.session_id
  where a.status not in ('approved','cancelled') and d.resolution='create_equipment'
 ) reserved where equipment_id ~ ('^'||v_prefix||'-[0-9]+$');
 v_id:=v_prefix||'-'||lpad(v_count::text,greatest(3,length(v_count::text)),'0');
 insert into village.equipment_ledger(equipment_id,name,major,category,stock_total,stock_maint,price,state,note,verify_status,last_verified_at,last_verified_by,source)
 values(v_id,v_name,p_item->>'major',p_item->>'category',v_total,v_maint,(p_item->>'price')::integer,case when v_maint>0 then '정비중' else '정상' end,'','verified',now(),p_evidence->>'ownerId','owner-stock-confirmation');
 insert into village.equipment_events(equipment_id,type,payload,actor) values(v_id,'owner_stock_confirmed',jsonb_build_object('sourceKey',p_source_key,'item',p_item,'evidence',p_evidence),'inventory-stock-intake');
 insert into village.inventory_stock_confirmations(source_key,equipment_id,evidence) values(p_source_key,v_id,p_evidence);
 return jsonb_build_object('ok',true,'duplicate',false,'equipmentId',v_id);
end;
$$;
revoke all on function village.confirm_missing_inventory_stock(text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function village.confirm_missing_inventory_stock(text,jsonb,jsonb) to service_role;
