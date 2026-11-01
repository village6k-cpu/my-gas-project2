-- Device replacement reconciles one owner. Dispatched changes require explicit staff confirmation.
CREATE OR REPLACE FUNCTION village.save_packing_manifest(p_trade_id text, p_version integer, p_next jsonb, p_actor uuid, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare t village.trades; s jsonb; old_source jsonb; new_source jsonb; target_id text; item village.schedule_items; changed integer; dispatched boolean;
begin
  select * into strict t from village.trades where trade_id = p_trade_id for update;
  if coalesce((t.packing_manifest->>'version')::integer,0) <> p_version then
    raise exception '다른 직원이 수정했습니다. 최신 내역을 확인하고 다시 저장해주세요' using errcode='40001';
  end if;
  if t.packing_completion_until > now() then raise exception '반출·반납 완료 처리 중입니다. 잠시 후 다시 시도해주세요'; end if;
  if t.return_done or t.contract_status in ('반납완료','취소') then raise exception '마감·취소 거래입니다'; end if;
  dispatched := t.packing_dispatched_at is not null or t.setup_done or t.contract_status <> '예약' or exists (
    select 1 from village.schedule_items where trade_id=p_trade_id and taken_qty>0
  );
  if p_action in ('reconcile','reconcileConfirmed') then
    if t.packing_manifest is null or t.packing_manifest->>'schemaVersion' <> '2' then raise exception '구성품 목록을 먼저 확인해주세요'; end if;
    if jsonb_array_length(p_next->'sources') <> jsonb_array_length(t.packing_manifest->'sources') then raise exception '교체 대상 외 예약 원본을 변경할 수 없습니다'; end if;
    select count(*), min(a.value->>'id') into changed,target_id
      from jsonb_array_elements(t.packing_manifest->'sources') a
      join jsonb_array_elements(p_next->'sources') b on a.value->>'id'=b.value->>'id'
      where a.value is distinct from b.value;
    if changed <> 1 then raise exception '한 번에 교체 장비 하나만 확인해주세요'; end if;
    select value into old_source from jsonb_array_elements(t.packing_manifest->'sources') where value->>'id'=target_id;
    select value into new_source from jsonb_array_elements(p_next->'sources') where value->>'id'=target_id;
    if old_source->>'device' <> 'true' then raise exception '본체 교체만 이 경로로 처리할 수 있습니다'; end if;
    select * into strict item from village.schedule_items where trade_id=p_trade_id and schedule_id=target_id
      and removed_at is null and checkout_state <> 'excluded' for update;
    if new_source is distinct from old_source || jsonb_build_object('name',coalesce(nullif(item.actual_name,''),item.name),'qty',item.qty) then
      raise exception '다른 직원이 장비를 변경했습니다. 최신 장비를 확인해주세요' using errcode='40001';
    end if;
    if (select jsonb_agg(value order by ord) from jsonb_array_elements(p_next->'sources') with ordinality a(value,ord) where value->>'id'<>target_id)
      is distinct from (select jsonb_agg(value order by ord) from jsonb_array_elements(t.packing_manifest->'sources') with ordinality a(value,ord) where value->>'id'<>target_id)
      or p_next - 'entries' - 'sources' - 'version' - 'phase' - 'sealedAt'
        is distinct from t.packing_manifest - 'entries' - 'sources' - 'version' - 'phase' - 'sealedAt'
      or (select jsonb_agg(value order by ord) from jsonb_array_elements(p_next->'entries') with ordinality a(value,ord) where value->>'ownerId' is distinct from target_id)
        is distinct from (select jsonb_agg(value order by ord) from jsonb_array_elements(t.packing_manifest->'entries') with ordinality a(value,ord) where value->>'ownerId' is distinct from target_id)
    then raise exception '교체 장비 외 검수 내역을 변경할 수 없습니다'; end if;
    for s in select value from jsonb_array_elements(t.packing_manifest->'entries') where value->>'ownerId'=target_id loop
      if not exists(select 1 from jsonb_array_elements(p_next->'entries') n where n->>'ownerId'=target_id and n->>'id'=s->>'id') then raise exception '이전 구성품 기록을 삭제할 수 없습니다'; end if;
      if coalesce((t.packing_manifest->'counts'->(s->>'partId')->>'good')::integer,0)
       + coalesce((t.packing_manifest->'counts'->(s->>'partId')->>'damaged')::integer,0)
       + coalesce((t.packing_manifest->'counts'->(s->>'partId')->>'lost')::integer,0)>0 then raise exception '교체 전 구성품의 반납 기록을 먼저 확인해주세요'; end if;
    end loop;
    if dispatched then
      if p_action <> 'reconcileConfirmed' or t.packing_manifest->>'phase' <> 'sealed' or p_next->>'phase' <> 'sealed' then raise exception '교체 구성품의 실제 반출 여부를 확인해주세요'; end if;
      if exists(select 1 from jsonb_array_elements(p_next->'entries') e where e->>'ownerId'=target_id and (e->>'qty')::integer>0 and
        (e->>'checked' is distinct from 'true' or e->>'unresolved'='true')) then raise exception '실제 반출한 구성품을 모두 확인해주세요'; end if;
    elsif p_action <> 'reconcile' or p_next->>'phase' <> 'draft' or exists(
      select 1 from jsonb_array_elements(p_next->'entries') e where e->>'ownerId'=target_id and e->>'checked'='true'
    ) then raise exception '교체 구성품을 준비 상태에서 다시 체크해주세요'; end if;
  end if;
  if p_action not in ('receive','reconcile','reconcileConfirmed') and (t.packing_dispatched_at is not null or t.setup_done or t.contract_status <> '예약' or exists (
    select 1 from village.schedule_items where trade_id=p_trade_id and taken_qty>0
  )) then raise exception '이미 반출한 구성품은 변경할 수 없습니다'; end if;
  if (p_next->>'version')::integer <> p_version+1 or jsonb_typeof(p_next->'entries') <> 'array' then raise exception 'invalid packing revision'; end if;
  if p_action='receive' and (t.packing_manifest->>'phase' <> 'sealed' or
    p_next - 'counts' - 'version' is distinct from t.packing_manifest - 'counts' - 'version') then
    raise exception '반출 기준선을 변경할 수 없습니다';
  end if;
  if p_action in ('start','seal') then
    for s in select * from jsonb_array_elements(p_next->'sources') loop
      if not exists (select 1 from village.schedule_items i where i.trade_id=p_trade_id and i.schedule_id=s->>'id'
        and i.name=s->>'name' and i.qty=(s->>'qty')::integer and i.removed_at is null and i.checkout_state <> 'excluded') then
        raise exception '예약 구성품이 변경되었습니다. 다시 확인해주세요' using errcode='40001';
      end if;
    end loop;
  end if;
  update village.trades set packing_manifest=p_next where trade_id=p_trade_id;
  insert into village.packing_audit(trade_id,version,actor,action,manifest)
    values(p_trade_id,p_version+1,p_actor,p_action,p_next);
  return p_next;
end $function$
;

CREATE OR REPLACE FUNCTION village.guard_packing_manifest()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
begin
  if (tg_op = 'INSERT' and new.packing_manifest is not null) or
     (tg_op = 'UPDATE' and (new.packing_manifest is distinct from old.packing_manifest or
       new.packing_completion_token is distinct from old.packing_completion_token or
       new.packing_completion_until is distinct from old.packing_completion_until or
       new.packing_dispatched_at is distinct from old.packing_dispatched_at)) then
    if current_user not in ('service_role','postgres') then
      raise exception '구성품은 전용 저장 API를 사용해주세요';
    end if;
  end if;
  if new.packing_manifest is not null then
    if tg_op = 'UPDATE' and old.packing_dispatched_at is not null then new.packing_dispatched_at := old.packing_dispatched_at; end if;
    if new.setup_done or new.contract_status = '반출' then new.packing_dispatched_at := coalesce(new.packing_dispatched_at, now()); end if;
    if new.setup_done and new.packing_manifest->>'phase' <> 'sealed' then
      raise exception '구성품 준비를 확정해주세요';
    end if;
    if tg_op='UPDATE' and ((new.return_done and not old.return_done) or
      (new.contract_status='반납완료' and old.contract_status<>'반납완료')) and exists (
      select 1 from jsonb_array_elements(new.packing_manifest->'sources') s
      join village.schedule_items i on i.trade_id=new.trade_id and i.schedule_id=s->>'id'
      where s->>'device'='true' and i.removed_at is null and i.checkout_state<>'excluded'
        and (s->>'name'<>coalesce(nullif(i.actual_name,''),i.name) or (s->>'qty')::integer<>i.qty)
    ) then raise exception '교체 장비의 구성품 반출 확인을 먼저 완료해주세요'; end if;
    if (new.return_done or new.contract_status = '반납완료') and
       not village.packing_return_complete(new.packing_manifest) then
      raise exception '구성품 미반납 수량이 남아 있습니다';
    end if;
  end if;
  return new;
end $function$
;
