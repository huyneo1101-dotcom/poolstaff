-- ============================================================
-- PoolStaff — Supabase schema
-- Chạy 1 lần: Supabase Dashboard → SQL Editor → New query → dán toàn bộ → Run
-- Dùng chung project hiện có. An toàn chạy lại (có DROP POLICY IF EXISTS).
-- Mỗi dòng lưu cả object dưới dạng jsonb (data) — không cần map từng cột.
-- ============================================================

-- 1) BẢNG ---------------------------------------------------
create table if not exists ps_orders (
  id text primary key, data jsonb, updated_at timestamptz default now()
);
create table if not exists ps_feedback (
  id text primary key, data jsonb, updated_at timestamptz default now()
);
create table if not exists ps_customers (
  id text primary key, data jsonb, updated_at timestamptz default now()
);
create table if not exists ps_kv (
  k text primary key, v jsonb, updated_at timestamptz default now()
);
create table if not exists ps_broadcasts (
  id text primary key, data jsonb, updated_at timestamptz default now()
);
-- Yêu cầu tại bàn: khách báo "đã chơi xong" / "xếp bi" / "đồ chưa mang ra"
create table if not exists ps_alerts (
  id text primary key, data jsonb, updated_at timestamptz default now()
);
-- Giải đấu (tổ chức giải tạo, khách xem & đăng ký)
create table if not exists ps_tours (
  id text primary key, data jsonb, updated_at timestamptz default now()
);
-- Khách đăng ký giải
create table if not exists ps_signups (
  id text primary key, data jsonb, updated_at timestamptz default now()
);
-- Kết quả trận trong giải (để tính bảng xếp hạng)
create table if not exists ps_results (
  id text primary key, data jsonb, updated_at timestamptz default now()
);
-- Khách đặt bàn trước (quán duyệt)
create table if not exists ps_bookings (
  id text primary key, data jsonb, updated_at timestamptz default now()
);
-- Phiên chơi tại bàn: mở bàn → tắt bàn → chốt bill (nguồn tính doanh số)
create table if not exists ps_sessions (
  id text primary key, data jsonb, updated_at timestamptz default now()
);
-- Lịch bảo trì/bảo dưỡng lặp theo chu kỳ
create table if not exists ps_maint (
  id text primary key, data jsonb, updated_at timestamptz default now()
);
-- To-do tăng doanh số (có subtask)
create table if not exists ps_growth (
  id text primary key, data jsonb, updated_at timestamptz default now()
);
-- Highlight: khách xin cắt clip pha bóng đẹp, quản lý gửi lại link video
create table if not exists ps_highlights (
  id text primary key, data jsonb, updated_at timestamptz default now()
);

-- 2) RLS + POLICY (prototype: cho phép anon đọc/ghi) --------
alter table ps_orders     enable row level security;
alter table ps_feedback   enable row level security;
alter table ps_customers  enable row level security;
alter table ps_kv         enable row level security;
alter table ps_broadcasts enable row level security;
alter table ps_alerts     enable row level security;
alter table ps_tours      enable row level security;
alter table ps_signups    enable row level security;
alter table ps_results    enable row level security;
alter table ps_bookings   enable row level security;
alter table ps_sessions   enable row level security;
alter table ps_maint      enable row level security;
alter table ps_growth     enable row level security;
alter table ps_highlights enable row level security;

drop policy if exists ps_orders_all     on ps_orders;
drop policy if exists ps_feedback_all    on ps_feedback;
drop policy if exists ps_customers_all   on ps_customers;
drop policy if exists ps_kv_all          on ps_kv;
drop policy if exists ps_broadcasts_all  on ps_broadcasts;
drop policy if exists ps_alerts_all      on ps_alerts;
drop policy if exists ps_tours_all       on ps_tours;
drop policy if exists ps_signups_all     on ps_signups;
drop policy if exists ps_results_all     on ps_results;
drop policy if exists ps_bookings_all    on ps_bookings;
drop policy if exists ps_sessions_all    on ps_sessions;
drop policy if exists ps_maint_all       on ps_maint;
drop policy if exists ps_growth_all      on ps_growth;
drop policy if exists ps_highlights_all  on ps_highlights;

create policy ps_orders_all     on ps_orders     for all using (true) with check (true);
create policy ps_feedback_all   on ps_feedback   for all using (true) with check (true);
create policy ps_customers_all  on ps_customers  for all using (true) with check (true);
create policy ps_kv_all         on ps_kv         for all using (true) with check (true);
create policy ps_broadcasts_all on ps_broadcasts for all using (true) with check (true);
create policy ps_alerts_all     on ps_alerts     for all using (true) with check (true);
create policy ps_tours_all      on ps_tours      for all using (true) with check (true);
create policy ps_signups_all    on ps_signups    for all using (true) with check (true);
create policy ps_results_all    on ps_results    for all using (true) with check (true);
create policy ps_bookings_all   on ps_bookings   for all using (true) with check (true);
create policy ps_sessions_all   on ps_sessions   for all using (true) with check (true);
create policy ps_maint_all      on ps_maint      for all using (true) with check (true);
create policy ps_growth_all     on ps_growth     for all using (true) with check (true);
create policy ps_highlights_all on ps_highlights for all using (true) with check (true);

-- 3) REALTIME — chỉ thêm bảng nào chưa có (chạy lại nhiều lần không lỗi) --
do $$
declare t text;
begin
  foreach t in array array['ps_orders','ps_feedback','ps_customers','ps_kv','ps_broadcasts','ps_alerts',
                           'ps_tours','ps_signups','ps_results','ps_bookings',
                           'ps_sessions','ps_maint','ps_growth','ps_highlights']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename=t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- 4) KIỂM TRA — chạy xong phải thấy đủ 14 bảng --------------
select tablename as bang_da_bat_realtime
from pg_publication_tables
where pubname='supabase_realtime' and tablename like 'ps_%'
order by 1;
