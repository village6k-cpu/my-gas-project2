-- An authenticated staff completion is authoritative independently of itemized counts.
-- Keep preparation records, component counts, service-only writes and completion leases.
CREATE OR REPLACE FUNCTION village.lock_packing_completion(p_trade_id text, p_kind text, p_done boolean, p_token text)
 RETURNS boolean
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare t village.trades;
begin
  select * into strict t from village.trades where trade_id=p_trade_id for update;
  if t.packing_manifest is null then return false; end if;
  if t.packing_completion_until>now() and t.packing_completion_token is distinct from p_token then
    raise exception '다른 완료 처리가 진행 중입니다' using errcode='55P03';
  end if;
  -- Preparation remains a checkout prerequisite; it must never block a staff return.
  if p_done and p_kind='setup' and t.packing_manifest->>'phase' <> 'sealed' then
    raise exception '구성품 준비를 먼저 확정해주세요';
  end if;
  update village.trades set packing_completion_token=p_token, packing_completion_until=now()+interval '120 seconds' where trade_id=p_trade_id;
  return true;
end $function$;

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
    if new.setup_done and not new.return_done and new.contract_status <> '반납완료'
       and new.packing_manifest->>'phase' <> 'sealed' then
      raise exception '구성품 준비를 확정해주세요';
    end if;
    -- Return completion records staff intent only. Never seal a draft or fill missing
    -- good/damaged/lost counts to manufacture a matching total.
  end if;
  return new;
end $function$;
