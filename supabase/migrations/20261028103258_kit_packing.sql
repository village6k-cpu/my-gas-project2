-- Opt-in packing facts. No reservation, price, or past checkout rows are rewritten.
alter table village.trades add column if not exists packing_manifest jsonb;
alter table village.trades add column if not exists packing_completion_token text;
alter table village.trades add column if not exists packing_completion_until timestamptz;
alter table village.trades add column if not exists packing_dispatched_at timestamptz;

create table village.packing_audit (
  trade_id text not null, version integer not null, actor uuid not null,
  action text not null, manifest jsonb not null, created_at timestamptz not null default now(),
  primary key(trade_id, version)
);
alter table village.packing_audit enable row level security;
revoke all on village.packing_audit from public, anon, authenticated;
grant select, insert on village.packing_audit to service_role;

create function village.packing_return_complete(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select p->>'phase' = 'sealed' and not exists (
    select 1 from (
      select e->>'partId' id, sum((e->>'qty')::integer) qty
      from jsonb_array_elements(p->'entries') e group by e->>'partId'
    ) g where g.qty <> coalesce((p->'counts'->g.id->>'good')::integer,0)
      + coalesce((p->'counts'->g.id->>'damaged')::integer,0)
      + coalesce((p->'counts'->g.id->>'lost')::integer,0)
  )
$$;
revoke all on function village.packing_return_complete(jsonb) from public, anon;
grant execute on function village.packing_return_complete(jsonb) to authenticated, service_role;

create function village.guard_packing_manifest() returns trigger
language plpgsql set search_path = '' as $$
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
    if (new.return_done or new.contract_status = '반납완료') and
       not village.packing_return_complete(new.packing_manifest) then
      raise exception '구성품 미반납 수량이 남아 있습니다';
    end if;
  end if;
  return new;
end $$;
create trigger trg_packing_guard before insert or update on village.trades
for each row execute function village.guard_packing_manifest();

create function village.save_packing_manifest(p_trade_id text, p_version integer, p_next jsonb, p_actor uuid, p_action text)
returns jsonb language plpgsql set search_path = '' as $$
declare t village.trades; s jsonb;
begin
  select * into strict t from village.trades where trade_id = p_trade_id for update;
  if coalesce((t.packing_manifest->>'version')::integer,0) <> p_version then
    raise exception '다른 직원이 수정했습니다. 최신 내역을 확인하고 다시 저장해주세요' using errcode='40001';
  end if;
  if t.packing_completion_until > now() then raise exception '반출·반납 완료 처리 중입니다. 잠시 후 다시 시도해주세요'; end if;
  if t.return_done or t.contract_status in ('반납완료','취소') then raise exception '마감·취소 거래입니다'; end if;
  if p_action <> 'receive' and (t.packing_dispatched_at is not null or t.setup_done or t.contract_status <> '예약' or exists (
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
end $$;
revoke all on function village.save_packing_manifest(text,integer,jsonb,uuid,text) from public, anon, authenticated;
grant execute on function village.save_packing_manifest(text,integer,jsonb,uuid,text) to service_role;

create function village.lock_packing_completion(p_trade_id text, p_kind text, p_done boolean, p_token text)
returns boolean language plpgsql set search_path = '' as $$
declare t village.trades;
begin
  select * into strict t from village.trades where trade_id=p_trade_id for update;
  if t.packing_manifest is null then return false; end if;
  if t.packing_completion_until>now() and t.packing_completion_token is distinct from p_token then
    raise exception '다른 완료 처리가 진행 중입니다' using errcode='55P03';
  end if;
  if p_done and t.packing_manifest->>'phase' <> 'sealed' then raise exception '구성품 준비를 먼저 확정해주세요'; end if;
  if p_done and p_kind='return' and not village.packing_return_complete(t.packing_manifest) then
    raise exception '구성품 미반납 수량이 남아 있습니다';
  end if;
  update village.trades set packing_completion_token=p_token, packing_completion_until=now()+interval '120 seconds' where trade_id=p_trade_id;
  return true;
end $$;
revoke all on function village.lock_packing_completion(text,text,boolean,text) from public, anon, authenticated;
grant execute on function village.lock_packing_completion(text,text,boolean,text) to service_role;
