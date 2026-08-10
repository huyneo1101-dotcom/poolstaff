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
Repo hiện CHƯA cài `.claude/skills`. Cài: `/plugin marketplace add huyneo1101-dotcom/Claude_skills` → `/plugin install vibe-pwa-kit@huyneo-skills`. Ưu tiên ở đây: `supabase-security-audit`, `bigfile-nav`, `pwa-healthcheck`, `scaffold-vibe-pwa`, `deploy-static`.
