# 🎱 PoolStaff — Trợ lý quán bi-a

Web app hỗ trợ vận hành quán bi-a: nhân viên báo món về quầy, đầu việc theo ca, đào tạo, chấm công,
tích điểm khách, khuyến mãi, giải đấu — và app riêng cho **khách hàng** tự đặt món & góp ý.

> ⚠️ **Bản demo.** Đang dùng RLS mở + khoá publishable công khai → **không nhập dữ liệu khách thật**
> (tên/SĐT/ảnh). Muốn dùng thật cần siết bảo mật (Supabase Auth + RLS theo người dùng).

## Vai trò

| Vai | Màn mặc định | Chức năng chính |
|-----|--------------|-----------------|
| **Quản lý** | Báo món | Toàn quyền + hub *Quản lý*: khuyến mãi, giải đấu, gửi tin, QR bàn, lỗi & lương, bàn, nhân viên, thực đơn |
| **Nhân viên phục vụ** | Báo món | Báo món, đầu việc, đào tạo, chấm công, khách |
| **Nhân viên quầy** | Quầy | Order các bàn, gọi món ngoài, kiểm kho |
| **Khách hàng** | Đặt món | Đặt món, điểm tích luỹ, thông báo, góp ý |

Đăng nhập giả lập (chọn tên). Khách đăng nhập bằng **SĐT**, máy tự nhớ.

## Chạy

- **Cục bộ:** mở thẳng `index.html` (nhấp đúp) — không cần build.
- **Online:** GitHub Pages (xem link ở phần About của repo).

## Đồng bộ nhiều máy (Supabase)

Chạy 1 lần `supabase-schema.sql` trong **Supabase → SQL Editor**. Sau đó:

- **Order realtime** — order từ máy nhân viên/khách hiện ngay ở quầy
- Đồng bộ: order · góp ý · khách & điểm · menu · bàn · khuyến mãi · thông báo
- Nội bộ (chấm công, đào tạo, lương, kho, giải đấu) vẫn lưu cục bộ từng máy

Chưa chạy SQL / mất mạng → app vẫn chạy bình thường bằng `localStorage`. Icon ☁️ ở góc trên báo trạng thái.

## QR đặt món

**Quản lý → QR bàn**: sinh QR cho từng bàn (`?table=N`). In dán lên bàn — khách quét là vào thẳng
trang đặt món với số bàn chọn sẵn. Cần deploy online + đã chạy SQL thì khách mới gửi order về quầy được.

## Tech

Một file `index.html` tự chứa: React 18 + Babel standalone + Supabase JS + QRCode, đều qua CDN. Không có build step.
