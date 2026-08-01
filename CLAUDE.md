# PoolStaff — Trợ lý vận hành quán bi-a (đa vai, đa người dùng)

App tĩnh một-file: toàn bộ UI + logic + CSS trong `index.html` (~308KB, ~4.575 dòng — **RẤT LỚN**), React 18 + Babel Standalone + Supabase 2 + QRCode + Tabler icons qua CDN, KHÔNG build step. Khác các app khác trong hệ sinh thái: đây là app **B2B đa người dùng thật** (nhiều vai + app khách), xử lý **dữ liệu khách hàng thật** (tên, SĐT, đơn, booking).

## 🔴 BẢO MẬT — đọc trước khi cho quán dùng thật
- **RLS đang MỞ TOÀN BỘ.** `supabase-schema.sql` đặt `for all using (true) with check (true)` cho **cả 16 bảng `ps_*`**. Anon key + URL Supabase đều công khai trong `index.html` → **bất kỳ ai cũng đọc/ghi/xoá được toàn bộ** đơn hàng, khách hàng, SĐT, booking, doanh số. "Khoá quán" hiện chỉ chặn ở **tầng app** (JS), KHÔNG ràng buộc ở DB nên vô hiệu với người gọi thẳng API.
- Cảnh báo "demo · đừng nhập data khách thật" trong README **đang đúng** — giữ nguyên cho tới khi siết RLS.
- **Hướng vá đề xuất** (cần Supabase thật + test, chưa làm sẵn): dùng "khoá quán" làm mật khẩu một tài khoản Supabase Auth dùng chung cho nhân viên → RLS bảng nội bộ (`ps_customers`, `ps_sessions`, `ps_kv`, `ps_growth`, `ps_maint`, `ps_lockers`, `ps_cues`, `ps_broadcasts`) yêu cầu `auth.role() = 'authenticated'`; các bảng khách tự thao tác (`ps_orders` insert, `ps_feedback`, `ps_signups`, `ps_bookings`, `ps_alerts`) cho anon `insert` nhưng KHÔNG cho `select/update/delete`. Test trên bản sao trước khi áp production.
- **Dùng chung một project Supabase** với các app khác (`ltmlueqkajqmduoqghdf`) — chỉ ảnh hưởng bảng `ps_*`, nhưng là lý do phải siết RLS đồng đều.
- Trước khi public/đưa vào dùng: chạy skill `supabase-security-audit`.

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
