-- 빌리지 village 스키마 잠금 (인증 추가 후 실행)
-- anon(비로그인) 차단 · authenticated(로그인 직원)만 허용 · GAS는 service_role(secret 키)로 RLS 우회
-- ⚠️ 실행 전에 반드시 GAS에 서비스키부터 등록(initSupabaseConfig)하세요. 안 그러면 동기화가 끊깁니다.
-- Supabase Dashboard > SQL Editor 에 붙여넣고 Run.

-- 1) proto_all(anon 허용) 제거 → authenticated 전용 정책
do $$ begin
  drop policy if exists proto_all on village.trades;
  drop policy if exists proto_all on village.schedule_items;
  drop policy if exists proto_all on village.handover_notes;
  create policy auth_rw on village.trades         for all to authenticated using (true) with check (true);
  create policy auth_rw on village.schedule_items for all to authenticated using (true) with check (true);
  create policy auth_rw on village.handover_notes for all to authenticated using (true) with check (true);
end $$;

-- 2) anon 테이블 권한 회수 → publishable 키가 유출돼도 로그인 없인 데이터 접근 불가
revoke all on all tables in schema village from anon;
alter default privileges in schema village revoke all on tables from anon;

-- 3) service_role(GAS 동기화) 권한 보장 (RLS 자동 우회)
grant usage on schema village to service_role;
grant all on all tables in schema village to service_role;
alter default privileges in schema village grant all on tables to service_role;

-- 확인: 로그인하면 데이터 보이고, 로그아웃/비로그인은 빈 결과여야 정상.
