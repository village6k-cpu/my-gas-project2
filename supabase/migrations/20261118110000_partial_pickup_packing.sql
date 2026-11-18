-- A partially picked rental may still prepare other equipment. Keep shipped rows and return counts frozen.
CREATE OR REPLACE FUNCTION village.save_packing_manifest(p_trade_id text, p_version integer, p_next jsonb, p_actor uuid, p_action text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare t village.trades; s jsonb; old_source jsonb; new_source jsonb; target_id text; item village.schedule_items; changed integer; dispatched boolean; taken_ids text[];
begin
  select * into strict t from village.trades where trade_id = p_trade_id for update;
  if coalesce((t.packing_manifest->>'version')::integer,0) <> p_version then
    raise exception '다른 직원이 수정했습니다. 최신 내역을 확인하고 다시 저장해주세요' using errcode='40001';
  end if;
  if t.packing_completion_until > now() then raise exception '반출·반납 완료 처리 중입니다. 잠시 후 다시 시도해주세요'; end if;
  if t.return_done or t.contract_status in ('반납완료','취소') then raise exception '마감·취소 거래입니다'; end if;
  select coalesce(array_agg(schedule_id),array[]::text[]) into taken_ids
    from village.schedule_items where trade_id=p_trade_id and (taken_qty>0 or actual_taken_qty>0);
  dispatched := t.packing_dispatched_at is not null or t.setup_done or t.contract_status <> '예약' or
    (cardinality(taken_ids)>0 and t.packing_manifest is not null and
      (t.packing_manifest->>'phase' is distinct from 'draft' or t.packing_manifest->>'schemaVersion' is distinct from '2'));
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
    if dispatched or target_id=any(taken_ids) then
      if p_action <> 'reconcileConfirmed' or t.packing_manifest->>'phase' <> 'sealed' or p_next->>'phase' <> 'sealed' then raise exception '교체 구성품의 실제 반출 여부를 확인해주세요'; end if;
      if exists(select 1 from jsonb_array_elements(p_next->'entries') e where e->>'ownerId'=target_id and (e->>'qty')::integer>0 and
        (e->>'checked' is distinct from 'true' or e->>'unresolved'='true')) then raise exception '실제 반출한 구성품을 모두 확인해주세요'; end if;
    elsif p_action <> 'reconcile' or p_next->>'phase' <> 'draft' or exists(
      select 1 from jsonb_array_elements(p_next->'entries') e where e->>'ownerId'=target_id and e->>'checked'='true'
    ) then raise exception '교체 구성품을 준비 상태에서 다시 체크해주세요'; end if;
  end if;
  if p_action not in ('receive','reconcile','reconcileConfirmed') and dispatched then
    raise exception '이미 반출한 구성품은 변경할 수 없습니다';
  end if;
  if p_action<>'receive' and (t.packing_manifest is null or t.packing_manifest->>'phase'='draft') and
      (cardinality(taken_ids)>0 or coalesce(t.packing_manifest->'counts','{}'::jsonb)<>'{}'::jsonb) then
    if coalesce(t.packing_manifest->'counts','{}'::jsonb) is distinct from p_next->'counts' then
      raise exception '반납 검수 수량을 변경할 수 없습니다';
    end if;
    if exists (
      select 1 from (
        select value from jsonb_array_elements(t.packing_manifest->'entries')
        where value->>'sourceId'=any(taken_ids) or value->>'ownerId'=any(taken_ids) or value->>'id'=any(taken_ids)
          or (t.packing_manifest->'counts') ? (value->>'partId')
      ) prior full join (
        select value from jsonb_array_elements(p_next->'entries')
        where value->>'sourceId'=any(taken_ids) or value->>'ownerId'=any(taken_ids) or value->>'id'=any(taken_ids)
          or (t.packing_manifest->'counts') ? (value->>'partId')
      ) proposed on prior.value->>'id'=proposed.value->>'id'
      where prior.value is distinct from proposed.value and not coalesce(
        prior.value->'checked'='false'::jsonb and proposed.value->'checked'='true'::jsonb
          and not ((t.packing_manifest->'counts') ? (prior.value->>'partId'))
          and prior.value - 'checked'=proposed.value - 'checked', false)
    ) then raise exception '이미 반출하거나 반납 검수한 구성품의 기록은 변경할 수 없습니다'; end if;
    if t.packing_manifest is not null and exists (
      select 1 from unnest(taken_ids) as frozen(id)
      where (select value from jsonb_array_elements(t.packing_manifest->'sources') where value->>'id'=frozen.id)
        is distinct from (select value from jsonb_array_elements(p_next->'sources') where value->>'id'=frozen.id)
        or t.packing_manifest->'deviceModels'->frozen.id is distinct from p_next->'deviceModels'->frozen.id
    ) then raise exception '이미 반출한 장비의 원본을 변경할 수 없습니다'; end if;
  end if;
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
