-- 후속조치 테이블(ai_follow_up_items, public 스키마) — 로그인 직원만 읽기/상태변경 허용.
-- 카톡 AI봇은 service_role로 계속 쓰므로(RLS 우회) 영향 없음. anon(비로그인)은 차단 유지.
-- Supabase Dashboard > SQL Editor 에 붙여넣고 Run.

alter table public.ai_follow_up_items enable row level security; -- 이미 켜져 있으면 무시됨

do $$ begin
  drop policy if exists fu_auth_read on public.ai_follow_up_items;
  drop policy if exists fu_auth_update on public.ai_follow_up_items;
  create policy fu_auth_read   on public.ai_follow_up_items for select to authenticated using (true);
  create policy fu_auth_update on public.ai_follow_up_items for update to authenticated using (true) with check (true);
end $$;

grant usage on schema public to authenticated;
grant select, update on public.ai_follow_up_items to authenticated;
