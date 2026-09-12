-- GAS-owned supply allocation display, separate from operator checkout/return notes.
alter table village.schedule_items add column if not exists supply_note text not null default '';
comment on column village.schedule_items.supply_note is '스케줄상세 비고의 상위 대체/외부 조달 기록. 예약명·단가·반출/반납 기준선은 보존.';
