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
-- Yêu cầu tại bàn: khách báo "đã chơi xong" / "xếp bi", NV báo quầy "đã dọn xong → tắt tiền giờ"
create table if not exists ps_alerts (
  id text primary key, data jsonb, updated_at timestamptz default now()
);

-- 2) RLS + POLICY (prototype: cho phép anon đọc/ghi) --------
alter table ps_orders     enable row level security;
alter table ps_feedback   enable row level security;
alter table ps_customers  enable row level security;
alter table ps_kv         enable row level security;
alter table ps_broadcasts enable row level security;
alter table ps_alerts     enable row level security;

drop policy if exists ps_orders_all     on ps_orders;
drop policy if exists ps_feedback_all    on ps_feedback;
drop policy if exists ps_customers_all   on ps_customers;
drop policy if exists ps_kv_all          on ps_kv;
drop policy if exists ps_broadcasts_all  on ps_broadcasts;
drop policy if exists ps_alerts_all      on ps_alerts;

create policy ps_orders_all     on ps_orders     for all using (true) with check (true);
create policy ps_feedback_all   on ps_feedback   for all using (true) with check (true);
create policy ps_customers_all  on ps_customers  for all using (true) with check (true);
create policy ps_kv_all         on ps_kv         for all using (true) with check (true);
create policy ps_broadcasts_all on ps_broadcasts for all using (true) with check (true);
create policy ps_alerts_all     on ps_alerts     for all using (true) with check (true);

-- 3) REALTIME — chỉ thêm bảng nào chưa có (chạy lại nhiều lần không lỗi) --
do $$
declare t text;
begin
  foreach t in array array['ps_orders','ps_feedback','ps_customers','ps_kv','ps_broadcasts','ps_alerts']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename=t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- 4) KIỂM TRA — chạy xong phải thấy đủ 6 bảng ---------------
select tablename as bang_da_bat_realtime
from pg_publication_tables
where pubname='supabase_realtime' and tablename like 'ps_%'
order by 1;
