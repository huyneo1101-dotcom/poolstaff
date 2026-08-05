-- ============================================================
-- PoolStaff — SIẾT BẢO MẬT (bước 2): Supabase Auth + RLS thật
--
-- Trước: RLS mở toàn bộ → ai có link cũng đọc/ghi/xoá được SĐT khách, doanh số.
-- Sau:   - Nhân viên phải ĐĂNG NHẬP (tài khoản dùng chung của quán) mới đọc/ghi được.
--        - Khách (chưa đăng nhập) chỉ GỬI được đơn/góp ý/đặt bàn, KHÔNG đọc được
--          danh sách khách hay doanh số. Xem hồ sơ của chính mình qua hàm riêng.
--
-- ⚠️ CHẠY SAU KHI ĐÃ DEPLOY BẢN APP MỚI (bản có đăng nhập bằng khoá quán),
--    nếu không app đang chạy sẽ mất kết nối cloud.
--
-- Cách chạy: Supabase → SQL Editor → New query → dán toàn bộ → Run
-- An toàn: KHÔNG xoá dữ liệu, chạy lại nhiều lần được.
-- ============================================================

-- ---------- 0) TẠO TÀI KHOẢN QUÁN ----------------------------
-- Tự làm 1 lần trong Supabase → Authentication → Users → "Add user":
--    Email:    quan@poolstaff.local     (email nội bộ, không cần thật)
--    Password: <KHOÁ QUÁN của bạn>      (chính là chuỗi trong KHOA-QUAN.txt)
--    ✅ Tick "Auto Confirm User"
-- Nhân viên nhập khoá này 1 lần trên mỗi máy là xong.

-- ---------- 1) PHÂN NHÓM BẢNG --------------------------------
-- NỘI BỘ (chỉ nhân viên đã đăng nhập): khách, doanh thu, vận hành, nhân sự
-- KHÁCH GỬI LÊN (anon được INSERT, không được đọc/sửa/xoá)
-- CÔNG KHAI (anon đọc được: thực đơn, bàn, khuyến mãi, giải, thông báo)

do $$
declare
  t text; pname text;
  internal text[] := array['ps_customers','ps_sessions','ps_growth','ps_maint',
                           'ps_lockers','ps_cues','ps_results','ps_violations_dummy'];
  submit  text[] := array['ps_orders','ps_feedback','ps_bookings','ps_signups',
                          'ps_alerts','ps_highlights'];
  publicr text[] := array['ps_kv','ps_tours','ps_broadcasts'];
begin
  -- dọn sạch policy cũ của mọi bảng ps_*
  for t in select tablename from pg_tables where schemaname='public' and tablename like 'ps\_%' loop
    execute format('alter table public.%I enable row level security', t);
    for pname in select policyname from pg_policies where schemaname='public' and tablename=t loop
      execute format('drop policy if exists %I on public.%I', pname, t);
    end loop;
  end loop;

  -- NỘI BỘ: chỉ tài khoản đã đăng nhập
  foreach t in array internal loop
    if exists (select 1 from pg_tables where schemaname='public' and tablename=t) then
      execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)', t||'_staff', t);
    end if;
  end loop;

  -- KHÁCH GỬI LÊN: nhân viên toàn quyền; khách chỉ được thêm mới
  foreach t in array submit loop
    if exists (select 1 from pg_tables where schemaname='public' and tablename=t) then
      execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)', t||'_staff', t);
      execute format('create policy %I on public.%I for insert to anon with check (true)', t||'_guest_add', t);
    end if;
  end loop;

  -- CÔNG KHAI: ai cũng đọc (thực đơn/bàn/giá/giải/thông báo), chỉ nhân viên sửa
  foreach t in array publicr loop
    if exists (select 1 from pg_tables where schemaname='public' and tablename=t) then
      execute format('create policy %I on public.%I for all to authenticated using (true) with check (true)', t||'_staff', t);
      execute format('create policy %I on public.%I for select to anon using (true)', t||'_read', t);
    end if;
  end loop;
end $$;

-- ---------- 2) HÀM CHO APP KHÁCH -----------------------------
-- Khách không đọc được bảng ps_customers, nên dùng 2 hàm dưới đây.
-- SECURITY DEFINER = hàm chạy với quyền chủ bảng, nhưng chỉ trả đúng phần của khách đó.

-- Đăng nhập khách bằng SĐT: có thì trả hồ sơ, chưa có thì tạo mới.
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
        'history','[]'::jsonb,'hours',0);
  insert into ps_customers(id,data) values (nid,rec);
  return rec;
end $$;

-- Lấy dữ liệu riêng của 1 khách (hồ sơ + đơn/đặt bàn/đăng ký giải/highlight/tủ của khách đó)
create or replace function ps_cust_data(p_cust_id text)
returns jsonb language plpgsql security definer set search_path=public as $$
declare out jsonb;
begin
  if coalesce(p_cust_id,'')='' then raise exception 'thieu ma khach'; end if;
  select jsonb_build_object(
    'customer', (select data from ps_customers where id=p_cust_id),
    'orders',   coalesce((select jsonb_agg(data) from ps_orders    where data->>'by'  = 'c:'||p_cust_id),'[]'::jsonb),
    'bookings', coalesce((select jsonb_agg(data) from ps_bookings  where data->>'custId'= p_cust_id),'[]'::jsonb),
    'signups',  coalesce((select jsonb_agg(data) from ps_signups   where data->>'custId'= p_cust_id),'[]'::jsonb),
    'highlights',coalesce((select jsonb_agg(data) from ps_highlights where data->>'custId'= p_cust_id),'[]'::jsonb),
    'lockers',  coalesce((select jsonb_agg(data) from ps_lockers   where data->>'custId'= p_cust_id),'[]'::jsonb)
  ) into out;
  return out;
end $$;

grant execute on function ps_cust_login(text,text) to anon, authenticated;
grant execute on function ps_cust_data(text)       to anon, authenticated;

-- ---------- 3) KIỂM TRA --------------------------------------
-- Cột "ai dung duoc": authenticated = chỉ nhân viên; anon = khách cũng dùng được
select tablename as bang, policyname as ten_quyen, cmd as thao_tac, roles::text as ai_dung_duoc
from pg_policies
where schemaname='public' and tablename like 'ps\_%'
order by tablename, policyname;
