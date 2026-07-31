-- 완료/해제 요청이 여러 Vercel 인스턴스에서 역순으로 도착해도 최신 GAS 상태만 남긴다.
alter table village.trades
  add column if not exists setup_state_revision bigint not null default 0,
  add column if not exists return_state_revision bigint not null default 0;

create or replace function village.apply_trade_completion(
  p_trade_id text,
  p_kind text,
  p_done boolean,
  p_done_at timestamptz,
  p_contract_status text,
  p_revision bigint
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_trade village.trades%rowtype;
  v_applied boolean := false;
begin
  if p_kind not in ('setup', 'return') then
    raise exception 'invalid completion kind';
  end if;
  if p_revision is null or p_revision <= 0 then
    raise exception 'invalid completion revision';
  end if;

  select * into v_trade
  from village.trades
  where trade_id = p_trade_id
  for update;

  if not found then
    raise exception 'trade not found';
  end if;

  if p_kind = 'setup' and p_revision > v_trade.setup_state_revision then
    update village.trades
    set setup_done = p_done,
        setup_done_at = case when p_done then p_done_at else null end,
        setup_state_revision = p_revision
    where trade_id = p_trade_id
    returning * into v_trade;
    v_applied := true;
  elsif p_kind = 'return' and p_revision > v_trade.return_state_revision then
    update village.trades
    set return_done = p_done,
        return_done_at = case when p_done then p_done_at else null end,
        contract_status = coalesce(nullif(btrim(p_contract_status), ''), case when p_done then '반납완료' else '반출' end),
        return_state_revision = p_revision
    where trade_id = p_trade_id
    returning * into v_trade;
    v_applied := true;
  end if;

  return jsonb_build_object(
    'applied', v_applied,
    'revision', case when p_kind = 'setup' then v_trade.setup_state_revision else v_trade.return_state_revision end,
    'done', case when p_kind = 'setup' then v_trade.setup_done else v_trade.return_done end,
    'doneAt', case when p_kind = 'setup' then v_trade.setup_done_at else v_trade.return_done_at end,
    'contractStatus', v_trade.contract_status
  );
end;
$$;

revoke execute on function village.apply_trade_completion(text, text, boolean, timestamptz, text, bigint)
  from public, anon, authenticated;
grant execute on function village.apply_trade_completion(text, text, boolean, timestamptz, text, bigint)
  to service_role;
