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

-- 2) RLS + POLICY (prototype: cho phép anon đọc/ghi) --------
alter table ps_orders     enable row level security;
alter table ps_feedback   enable row level security;
alter table ps_customers  enable row level security;
alter table ps_kv         enable row level security;
alter table ps_broadcasts enable row level security;

drop policy if exists ps_orders_all     on ps_orders;
drop policy if exists ps_feedback_all    on ps_feedback;
drop policy if exists ps_customers_all   on ps_customers;
drop policy if exists ps_kv_all          on ps_kv;
drop policy if exists ps_broadcasts_all  on ps_broadcasts;

create policy ps_orders_all     on ps_orders     for all using (true) with check (true);
create policy ps_feedback_all   on ps_feedback   for all using (true) with check (true);
create policy ps_customers_all  on ps_customers  for all using (true) with check (true);
create policy ps_kv_all         on ps_kv         for all using (true) with check (true);
create policy ps_broadcasts_all on ps_broadcasts for all using (true) with check (true);

-- 3) REALTIME (nếu báo "already member of publication" thì bỏ qua dòng đó) --
alter publication supabase_realtime add table ps_orders;
alter publication supabase_realtime add table ps_feedback;
alter publication supabase_realtime add table ps_customers;
alter publication supabase_realtime add table ps_kv;
alter publication supabase_realtime add table ps_broadcasts;
