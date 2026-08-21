# ⛔ ĐỌC TRƯỚC KHI SỬA APP — `index.html` LÀ BẢN DỰNG, KHÔNG PHẢI NGUỒN

Từ 10/08/2026 app này không còn bắt điện thoại người dùng tự dịch mã mỗi lần mở.
Việc dịch chuyển sang Mac lúc dựng bản, nên cấu trúc đổi:

| File | Vai trò |
|---|---|
| `nguon/app.jsx` | **mã app — ĐÂY là chỗ sửa** |
| `nguon/khung.html` | phần HTML bao quanh, chỗ chèn mã đánh dấu `<!--@@APP@@-->` |
| `index.html` | **bản dựng, sinh tự động — CẤM sửa tay** |

Sửa xong `nguon/app.jsx` thì dựng lại, nếu không thì bản chạy vẫn là mã cũ:

```bash
python3 /Users/Huy/Claude/HeThong/dungapp/dung.py /Users/Huy/Claude/App/PoolStaff
```

**Vì sao phải có dòng cảnh báo này:** sửa thẳng vào `index.html` vẫn chạy được ngay,
không lỗi nào phát ra — nên không có gì báo cho biết là đã sửa nhầm chỗ. Lần dựng kế
tiếp mới nuốt mất bản sửa ấy. Công cụ có chốt: thấy `index.html` lệch với dấu vân tay
của lần dựng trước thì DỪNG và bắt gộp tay, chứ không ghi đè.

---

# PoolStaff — Trợ lý vận hành quán bi-a (đa vai, đa người dùng)

App tĩnh một-file: toàn bộ UI + logic + CSS trong `index.html` (~308KB, ~4.575 dòng — **RẤT LỚN**), React 18 + Babel Standalone + Supabase 2 + QRCode + Tabler icons qua CDN, KHÔNG build step. Khác các app khác trong hệ sinh thái: đây là app **B2B đa người dùng thật** (nhiều vai + app khách), xử lý **dữ liệu khách hàng thật** (tên, SĐT, đơn, booking).

## 🔴 BẢO MẬT — đọc trước khi sửa SQL
- **Đã siết (2026-08-05):** quyền truy cập nằm ở **`supabase-auth-rls.sql`**, KHÔNG còn trong `supabase-schema.sql`.
  - Nhân viên: `Cloud.signIn()` đăng nhập Supabase Auth `quan@poolstaff.local`, **mật khẩu = khoá quán** (`localStorage.ps_club_key`, gốc ở `KHOA-QUAN.txt`, gitignored) → policy `authenticated` cho toàn quyền.
  - Khách (anon): chỉ `INSERT` vào `ps_orders/feedback/bookings/signups/alerts/highlights`; chỉ `SELECT` `ps_kv/ps_tours/ps_broadcasts`. **Không** đọc `ps_customers`, không xoá gì. Hồ sơ khách lấy qua RPC `ps_cust_login(phone,name)` / `ps_cust_data(cust_id)` (SECURITY DEFINER, chỉ trả phần của chính khách).
- **⚠️ BẪY ĐÃ DÍNH 1 LẦN:** `supabase-schema.sql` trước đây tạo `for all using(true) with check(true)` cho mọi bảng → chạy lại là **mở toang lại toàn bộ**, ghi đè policy chặt. Đã bỏ phần cấp quyền khỏi file đó; nay nó chỉ tạo bảng + bật RLS. **Thứ tự bắt buộc: schema.sql → auth-rls.sql.** Đừng bao giờ thêm policy `using(true)` cho `anon` vào schema.
- Sau mỗi lần đổi SQL, kiểm chứng bằng cách **đóng vai người lạ** (client anon, không đăng nhập): phải bị chặn đọc `ps_customers`/`ps_sessions` và chặn `delete`.
- **Dùng chung project Supabase** với app khác (`ltmlueqkajqmduoqghdf`) — chỉ đụng bảng `ps_*`.
- Trước khi cho quán khác dùng: chạy skill `supabase-security-audit`.

## Quy tắc làm việc với file này
- **KHÔNG đọc cả `index.html` (~308KB, ~4.575 dòng)** — grep định vị rồi Read cửa sổ nhỏ (skill `bigfile-nav`).
- Babel transpile trong trình duyệt: lỗi cú pháp = trắng màn hình, không báo terminal. Kiểm Console sau khi sửa (skill `smoke-test`).
- **CDN đang pin LỎNG (chỉ major)**: `react@18`, `react-dom@18`, `@supabase/supabase-js@2`, `qrcode@1`, `@babel/standalone@7` — CDN nhả bản mới trong major có thể gây trắng màn hình bất ngờ. Nên **pin đúng version** như các app anh em (skill `pwa-healthcheck`).

## Dữ liệu
- **Cloud (Supabase, nguồn chính)**: 16 bảng `ps_*` dạng `id text / data jsonb / updated_at`, cộng `ps_kv` (`k / v jsonb`) cho cấu hình. Realtime bật cho cả 16 bảng (đồng bộ nhiều máy). Bảng: `ps_orders` `ps_feedback` `ps_customers` `ps_kv` `ps_broadcasts` `ps_alerts` `ps_tours` `ps_signups` `ps_results` `ps_bookings` `ps_sessions` `ps_maint` `ps_growth` `ps_highlights` `ps_lockers` `ps_cues`.
- **localStorage (tiền tố `ps.`)**: cache cục bộ + cấu hình máy (vd `ps.dark`). URL + anon key Supabase người dùng nhập vào app (lưu qua `ps_kv`/localStorage).

## Vai trò (`ROLES`, ~dòng 421)
`manager` 🧑‍💼 Quản lý · `organizer` 🏆 Tổ chức giải · `counter` 🧾 Nhân viên quầy · `staff` 🎱 Nhân viên phục vụ. Ngoài ra có **app khách** (đặt món QR, đặt bàn, phản hồi, đăng ký giải, xin highlight). `createClient` khởi tạo Supabase ~dòng 346–349.

## PWA / Deploy
- **CHƯA phải PWA**: không có `sw.js`, không đăng ký service worker → **không offline, không cài về máy** (rủi ro cho quán khi mất mạng). README nói deploy GitHub Pages. Cân nhắc thêm `manifest.json` + `sw.js` network-first (skill `scaffold-vibe-pwa` / `web-push`) để máy quầy chạy offline.
- **Chưa có CI/CD** (`.github/workflows` / `netlify.toml`) → deploy thủ công. Xem skill `deploy-static`.

## Skills dùng chung
Repo hiện CHƯA cài `.claude/skills`. Cài: `/plugin marketplace add huyneo1101-dotcom/Claude_skills` → `/plugin install vibe-pwa-kit@huyneo-skills`.
⚠ Repo `Claude_skills` đã chuyển RIÊNG TƯ 12/08/2026 — lệnh trên chỉ chạy được trên máy đã đăng nhập `gh`. Máy lạ sẽ trượt ở bước clone. Ưu tiên ở đây: `supabase-security-audit`, `bigfile-nav`, `pwa-healthcheck`, `scaffold-vibe-pwa`, `deploy-static`.

## Hai bảng cố ý cho cả internet đọc — đừng siết mù (chốt 20/08/2026)
`ps_kv` và `ps_tours` mang policy `for select to anon using (true)` (mục 4a của
`supabase-auth-rls.sql`) vì **app khách chạy không đăng nhập**: quét mã QR ở bàn là đọc ngay
thực đơn, sơ đồ bàn, khuyến mãi và lịch giải. Siết hai bảng này là app khách trắng màn hình.

Đo nội dung thật 20/08/2026 bằng khoá công khai: `ps_kv` đúng 04 khoá `promos` · `tables` ·
`menu` · `tiers` (bậc thẻ chỉ khai mốc giờ, % giảm, quà — không tên khách nào); `ps_tours`
chỉ có thể lệ giải (ngày, thể thức, phí, giải thưởng). Không dòng nào mang tên, số điện thoại
hay doanh số. Người đăng ký giải nằm ở `ps_signups`, vẫn kín.

Vì thế canary `HeThong/canh-ro-ri-supabase.py` đã chuyển hai bảng sang `BANG_MO` kèm lý do,
và thêm `CAM_MO` canh chiều nới — nhét `ps_customers` hay bảng tiền nào vào danh sách mở thì
`--tu-kiem` báo đỏ ngay (ca g · h · i, đã chứng minh trên 02 bản hỏng).

⚠ `ps_broadcasts` cũng có policy anon read nhưng **đang rỗng nên chưa đo được nội dung** —
cố ý GIỮ trong danh sách phải kín. Khi bảng có dữ liệu, canary sẽ kêu; lúc đó soi nội dung
rồi mới quyết, đừng khai mở sẵn.


## 💰 CHỐT SỔ CUỐI CA — vế thứ hai của sổ sách (dựng 21/08/2026)

Sổ sách vốn tính **một chiều**: cộng bill đã chốt rồi in ra một con số. Con số ấy trả lời
*quán đáng lẽ thu bao nhiêu*, **không** trả lời *két có đúng chừng ấy không*. Chênh lệch
giữa hai vế chính là chỗ tiền thật của quán rơi ra — bill quên chốt, khách chuyển khoản mà
vẫn tính vào tiền mặt, nhân viên lấy tiền két đi mua đá rồi quên ghi. Không có vế thứ hai
thì mọi lối rơi ấy đều **câm**: sổ vẫn đẹp, số vẫn cộng đúng, chỉ két là thiếu.

Chỗ đứng: **Doanh thu → Chốt ca**. Phép tính nằm ở `tinhChotCa()` cạnh `sumRev`.

```
tiền mặt đáng lẽ có = tiền lẻ đầu ca + doanh số trong ca − khách chuyển khoản − tiền lấy két đi mua đồ
lệch = đếm được − tiền mặt đáng lẽ có
```

⛔ **Bốn luật, đừng "dọn cho gọn" mất:**
1. **CHƯA ĐẾM KÉT THÌ KHÔNG KẾT LUẬN.** Ô đếm để trống trả `lech: null`, không trả 0. Coi
   "chưa đếm" là "đếm được 0đ" thì mỗi ca mở ra đã báo thiếu đúng bằng doanh số, và một
   cảnh báo luôn đỏ là cảnh báo hết ai đọc. ⚠ Nhưng **gõ số 0 là ĐÃ đếm** và két rỗng thật
   — phải kết luận ngay (ca 13 canh chiều này).
2. **TIỀN ĐẦU CA VÀ KHOẢN CHI VÀO THẲNG PHÉP TÍNH**, không để người chốt trừ nhẩm — trừ
   nhẩm là nguồn lệch riêng của nó, và lúc ấy con số cuối không kiểm lại được.
3. **NGƯỠNG BỎ QUA `NGUONG_LECH` = 10.000₫** (dòng khai giá trị đang có hiệu lực). Nới quá
   tay là mất vài trăm nghìn mỗi ca mà app vẫn hiện chữ "khớp" — ca 18 chặn trần 20.000₫.
4. **LỆCH TỪ NGƯỠNG TRỞ LÊN THÌ BẮT GHI LÝ DO** mới cho chốt: ba tháng sau nhìn lại chỉ
   thấy một con số âm mà không ai nhớ vì sao.

**Bảng `ps_chotca`** — khuôn `id text / data jsonb / updated_at` như 15 bảng `ps_*` còn lại,
nằm trong `CLOUD_OPTIONAL` nên quán chưa chạy lại SQL vẫn dùng app bình thường (dữ liệu ở
localStorage). ⛔ **Bảng này mang tiền thật theo từng ca — KHÔNG thêm policy nào cho `anon`.**
Nghiệm thu 21/08/2026 bằng lời gọi thật với khoá công khai, trên bảng ĐANG CÓ 01 dòng: đọc
trả `[]` · ghi trả **401** · xoá không mất dòng nào. Ca 24 của bộ test canh chiều này bằng
cách soi thẳng `supabase-auth-rls.sql`.

```bash
node /Users/Huy/Claude/App/PoolStaff/_test/kiem-chot-ca.js --tu-kiem
```

**25 ca · 11 bản hỏng**, đã nạp `BO_TEST` của `khoe.py`.

⚠️ **`soTien()` phải bỏ dấu chấm phân cách nghìn**: người Việt gõ `1.500.000`, mà
`Number('1.500.000')` ra `NaN` rồi thành 0 — ô nào gõ đủ dấu chấm là bảng báo thiếu đúng
bằng số ấy. Lỗi này có thật trong bản đầu, bắt được lúc dựng bộ ca.
