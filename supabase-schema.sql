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
-- Tủ gửi gậy của khách (thuê theo tháng)
create table if not exists ps_lockers (
  id text primary key, data jsonb, updated_at timestamptz default now()
);
-- Gậy (cơ) của quán cho khách mượn
create table if not exists ps_cues (
  id text primary key, data jsonb, updated_at timestamptz default now()
);

-- 2) RLS — BẬT KHOÁ CHO MỌI BẢNG ---------------------------
--
--  ⚠️ PHẦN CẤP QUYỀN ĐÃ CHUYỂN SANG FILE  supabase-auth-rls.sql
--
--  File này CHỈ tạo bảng. Trước đây nó mở quyền cho tất cả mọi người
--  (ai có link cũng đọc/ghi/xoá được SĐT khách, doanh số) — đã bỏ.
--
--  👉 Chạy xong file này PHẢI chạy tiếp  supabase-auth-rls.sql
--     để bật đăng nhập + khoá dữ liệu. Chưa chạy thì app không đọc/ghi được.

do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname='public' and tablename like 'ps%' loop
    execute format('alter table public.%I enable row level security', r.tablename);
  end loop;
end $$;

-- 3) REALTIME — chỉ thêm bảng nào chưa có (chạy lại nhiều lần không lỗi) --
do $$
declare t text;
begin
  foreach t in array array['ps_orders','ps_feedback','ps_customers','ps_kv','ps_broadcasts','ps_alerts',
                           'ps_tours','ps_signups','ps_results','ps_bookings',
                           'ps_sessions','ps_maint','ps_growth','ps_highlights','ps_lockers','ps_cues']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename=t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- 4) KIỂM TRA — chạy xong phải thấy đủ 16 bảng --------------
select tablename as bang_da_bat_realtime
from pg_publication_tables
where pubname='supabase_realtime' and tablename like 'ps_%'
order by 1;
