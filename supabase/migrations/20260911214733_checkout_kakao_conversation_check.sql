-- 반출 카드의 수동 대화 확인 표시. 예약/장비/반출 완료 상태와 독립적으로 저장한다.
alter table village.trades
  add column if not exists kakao_conversation_checked boolean not null default false;

comment on column village.trades.kakao_conversation_checked is
  '직원이 해당 거래의 카카오톡 대화 내용을 직접 확인했는지 표시';
