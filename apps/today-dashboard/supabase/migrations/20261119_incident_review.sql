-- Owner-only review history. Operational source rows stay immutable here.
create table village.incident_reviews (
  case_key text not null,
  revision int not null check (revision > 0),
  evidence_hash text not null,
  state text not null check (state in ('확인 필요','처리 중','해결','제외')),
  note text not null,
  reviewer uuid not null,
  reviewed_at timestamptz not null default now(),
  primary key(case_key,revision)
);
alter table village.incident_reviews enable row level security;
revoke all on village.incident_reviews from public,anon,authenticated;
grant select,insert on village.incident_reviews to service_role;

create view village.incident_evidence with (security_invoker=true) as
with signals as (
 select t.trade_id, t.return_at as occurred_at, '반납 검수' as source,
   coalesce(i.actual_name,i.name,c.key) as item, null::text as link,
   concat_ws(' · ',case when c.value->>'lost' ~ '^[1-9]' then '분실 '||(c.value->>'lost') end,
   case when c.value->>'damaged' ~ '^[1-9]' then '파손 '||(c.value->>'damaged') end,
   case when c.value->>'reportedMissing' ~ '^[1-9]' then '미반납 보고 '||(c.value->>'reportedMissing') end,
   nullif(c.value->>'memo','')) as body,
   null::text as standalone
 from village.trades t cross join lateral jsonb_each(t.return_counts) c
 left join village.schedule_items i on i.trade_id=t.trade_id and i.schedule_id=c.key
 where c.value->>'lost' ~ '^[1-9]' or c.value->>'damaged' ~ '^[1-9]' or c.value->>'reportedMissing' ~ '^[1-9]'
 union all
 select trade_id, coalesce(return_done_at,return_at), '거래 특이사항',null,null, concat_ws(E'\n',nullif(note_checkout,''),nullif(note_checkin,'')),null
 from village.trades
 union all
 select trade_id,updated_at,'품목 특이사항',coalesce(actual_name,name),null,concat_ws(E'\n',nullif(memo_checkout,''),nullif(memo_checkin,'')),null
 from village.schedule_items where removed_at is null
 union all
 select matched_trade_id,to_timestamp(message_ts::double precision),'Slack',null,permalink,
 concat_ws(E'\n',nullif(raw_context#>>'{root,text}',''),
 (select string_agg(r->>'text',E'\n' order by n) from jsonb_array_elements(coalesce(raw_context->'replies','[]')) with ordinality a(r,n)),
 case when applied_plan->>'summary' is not null then '동기화 요약 · '||(applied_plan->>'summary') end),
 channel_id||':'||thread_ts
 from village.slack_ops_events where channel_id in ('C0B6ZJZ2XU3','C0BMNA501R9')
), filtered as (
 select distinct coalesce(trade_id,'slack:'||standalone) as case_key, trade_id,occurred_at,source,item,link,body
 from signals where source='반납 검수' or body ~* '분실|파손|미반납|미회수|누락|없어졌|고장|불량|끊어|손상|수리|미납|미수금|미입금|부족|재고.?차이'
), grouped as (
 select case_key,max(trade_id) as trade_id,max(occurred_at) as occurred_at,
 jsonb_agg(jsonb_build_object('source',source,'item',item,'link',link,'body',body)
 order by occurred_at,source,item,body,link) as evidence
 from filtered group by case_key
)
select g.*, md5(g.evidence::text) as evidence_hash, next_use.checkout_at as next_at, next_use.trade_id as next_trade_id, next_use.name as next_item
from grouped g left join lateral (
 select t.checkout_at,t.trade_id,i.name from village.schedule_items i join village.trades t using (trade_id)
 where i.removed_at is null and t.checkout_at>=now() and t.contract_status='예약' and t.trade_id<>g.trade_id and i.checkout_state<>'excluded'
 and i.name in (select e->>'item' from jsonb_array_elements(g.evidence) e where e->>'item' is not null)
 order by t.checkout_at,t.trade_id,i.name limit 1
) next_use on true;
revoke all on village.incident_evidence from public,anon,authenticated;
grant select on village.incident_evidence to service_role;
