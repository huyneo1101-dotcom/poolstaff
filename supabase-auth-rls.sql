-- ============================================================
-- PoolStaff — SIẾT BẢO MẬT: Supabase Auth + RLS thật
--
-- Trước: ai có link cũng đọc/ghi/XOÁ được SĐT khách, doanh số.
-- Sau:   - Nhân viên phải ĐĂNG NHẬP (tài khoản quán) mới đọc/ghi.
--        - Khách chỉ GỬI được đơn/góp ý/đặt bàn, KHÔNG đọc danh sách khách,
--          KHÔNG xoá được gì. Xem hồ sơ mình qua 2 hàm riêng ở cuối file.
--
-- Cách chạy: Supabase → SQL Editor → New query → dán TOÀN BỘ → Run
-- An toàn: không xoá dữ liệu, chạy lại nhiều lần được.
-- ============================================================

-- ---------- 0) TÀI KHOẢN QUÁN (làm 1 lần, ngoài file này) ----
-- Supabase → Authentication → Users → Add user:
--   Email: quan@poolstaff.local | Password: <KHOÁ QUÁN> | ✅ Auto Confirm User

-- ---------- 1) XOÁ SẠCH POLICY CŨ ---------------------------
do $$
declare r record;
begin
  for r in select tablename, policyname from pg_policies
           where schemaname='public' and tablename like 'ps%' loop
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
  end loop;
end $$;

-- ---------- 2) BẬT RLS CHO MỌI BẢNG ps_* --------------------
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname='public' and tablename like 'ps%' loop
    execute format('alter table public.%I enable row level security', r.tablename);
  end loop;
end $$;

-- ---------- 3) NHÂN VIÊN (đã đăng nhập): TOÀN QUYỀN ---------
do $$
declare r record;
begin
  for r in select tablename from pg_tables where schemaname='public' and tablename like 'ps%' loop
    execute format(
      'create policy %I on public.%I for all to authenticated using (true) with check (true)',
      r.tablename||'_staff', r.tablename);
  end loop;
end $$;

-- ---------- 4) KHÁCH (chưa đăng nhập): QUYỀN TỐI THIỂU ------
-- 4a) Chỉ ĐỌC dữ liệu công khai: thực đơn/bàn/giá, giải đấu, thông báo
create policy ps_kv_read         on public.ps_kv         for select to anon using (true);
create policy ps_tours_read      on public.ps_tours      for select to anon using (true);
create policy ps_broadcasts_read on public.ps_broadcasts for select to anon using (true);

-- 4b) Chỉ GỬI LÊN (không đọc, không sửa, không xoá)
create policy ps_orders_add     on public.ps_orders     for insert to anon with check (true);
create policy ps_feedback_add   on public.ps_feedback   for insert to anon with check (true);
create policy ps_bookings_add   on public.ps_bookings   for insert to anon with check (true);
create policy ps_signups_add    on public.ps_signups    for insert to anon with check (true);
create policy ps_alerts_add     on public.ps_alerts     for insert to anon with check (true);

-- Bảng thêm sau (có thì tạo, chưa có thì bỏ qua)
do $$
begin
  if exists (select 1 from pg_tables where schemaname='public' and tablename='ps_highlights') then
    execute 'create policy ps_highlights_add on public.ps_highlights for insert to anon with check (true)';
  end if;
end $$;

-- ---------- 5) HAI HÀM CHO APP KHÁCH ------------------------
-- Khách không đọc được bảng ps_customers → dùng 2 hàm dưới.
-- SECURITY DEFINER: hàm chạy quyền chủ bảng nhưng chỉ trả đúng phần của khách đó.

create or replace function ps_cust_login(p_phone text, p_name text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare rec jsonb; nid text; ph text;
begin
  ph := regexp_replace(coalesce(p_phone,''),'\s','','g');
  if length(ph) < 8 then raise exception 'so dien thoai khong hop le'; end if;

  select data into rec from ps_customers
   where regexp_replace(coalesce(data->>'phone',''),'\s','','g') = ph limit 1;
  if rec is not null then return rec; end if;

  nid := 'c'||substr(md5(ph||clock_timestamp()::text),1,7);
  rec := jsonb_build_object('id',nid,'name',coalesce(nullif(trim(p_name),''),'Khách '||right(ph,3)),
        'phone',ph,'points',0,'visits',0,'vip',false,'games','[]'::jsonb,'photo','','note','',
        'history','[]'::jsonb,'hours',0,'rewards','[]'::jsonb);
  insert into ps_customers(id,data) values (nid,rec);
  return rec;
end $$;

create or replace function ps_cust_data(p_cust_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare out jsonb;
begin
  if coalesce(p_cust_id,'')='' then raise exception 'thieu ma khach'; end if;
  select jsonb_build_object(
    'customer', (select data from ps_customers where id=p_cust_id),
    'orders',   coalesce((select jsonb_agg(data) from ps_orders   where data->>'by'    = 'c:'||p_cust_id),'[]'::jsonb),
    'bookings', coalesce((select jsonb_agg(data) from ps_bookings where data->>'custId'= p_cust_id),'[]'::jsonb),
    'signups',  coalesce((select jsonb_agg(data) from ps_signups  where data->>'custId'= p_cust_id),'[]'::jsonb)
  ) into out;
  return out;
end $$;

grant execute on function ps_cust_login(text,text) to anon, authenticated;
grant execute on function ps_cust_data(text)       to anon, authenticated;

-- ---------- 6) KIỂM TRA -------------------------------------
-- ĐÚNG khi: mỗi bảng có 1 dòng {authenticated} = ALL
--           ps_kv/ps_tours/ps_broadcasts thêm 1 dòng {anon} = SELECT
--           ps_orders/feedback/bookings/signups/alerts thêm 1 dòng {anon} = INSERT
--   ⚠️ KHÔNG được có dòng nào {anon} mà thao tác = ALL
select tablename as bang, cmd as thao_tac, roles::text as ai_dung_duoc, policyname as ten_quyen
from pg_policies
where schemaname='public' and tablename like 'ps%'
order by tablename, roles::text, cmd;
