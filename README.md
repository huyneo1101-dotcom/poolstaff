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
| **Khách hàng** | Đặt món | Đặt món, đặt bàn, **Highlight** (xin cắt clip & xem video), **hạng & quà theo giờ chơi**, thông báo, góp ý |

Đăng nhập giả lập (chọn tên). Khách đăng nhập bằng **SĐT**, máy tự nhớ.

## Chạy

- **Cục bộ:** mở thẳng `index.html` (nhấp đúp) — không cần build.
- **Online:** GitHub Pages (xem link ở phần About của repo).

## Đồng bộ nhiều máy (Supabase)

Chạy 1 lần `supabase-schema.sql` trong **Supabase → SQL Editor**. Sau đó:

- **Order realtime** — order từ máy nhân viên/khách hiện ngay ở quầy
- Đồng bộ: order · góp ý · khách & điểm/giờ chơi · menu · bàn · khuyến mãi · hạng khách · thông báo · highlight
- Nội bộ (chấm công, đào tạo, lương, kho, giải đấu) vẫn lưu cục bộ từng máy

Chưa chạy SQL / mất mạng → app vẫn chạy bình thường bằng `localStorage`. Icon ☁️ ở góc trên báo trạng thái.

## Hạng khách theo giờ chơi

Mỗi lần **chốt bill có gắn tên khách** (mục *Bàn*), khách được cộng **giờ chơi** + điểm (mặc định 10đ/giờ).
Đủ mốc giờ là **lên hạng**: chiết khấu tiền bàn cao hơn và **tặng quà 1 lần** (voucher / nước / đồ ăn).

| Hạng | Từ | Giảm tiền bàn | Quà khi lên hạng |
|------|-----|---------------|------------------|
| 🎱 Khách mới | 0h | — | — |
| 🥉 Đồng | 10h | 5% | 1 trà đá |
| 🥈 Bạc | 30h | 10% | 1 nước suối + 1 hướng dương |
| 🥇 Vàng | 60h | 15% | 1 phần đồ ăn nhẹ |
| 💎 Kim cương | 120h | 20% | Voucher 200.000đ |

- Chiết khấu **tự trừ vào bill** ngay khi chọn khách trong màn chốt bill.
- **Khách → Hạng**: quản lý sửa mốc giờ, % giảm, quà, quyền lợi; xem bảng khách chơi nhiều nhất.
- **Khách → hồ sơ khách**: nhân viên bấm *Đã trao* khi đưa quà cho khách.
- App khách, tab **Hạng**: hạng hiện tại, thanh tiến trình "còn bao nhiêu giờ nữa lên hạng", quà của mình.
- Khách cũ chưa có giờ chơi thì quy đổi tạm từ điểm đã tích (10đ = 1 giờ), không mất hạng.

## Highlight — cắt clip pha bóng đẹp

Khách vào tab **Highlight** chọn bàn + mốc thời gian chính xác (giờ:phút:giây, có nút "vừa xong / 1 phút trước")
và số giây lấy trước–sau → quán biết đúng đoạn cần trích trên camera.

**Quản lý → Highlight**: xem yêu cầu (bàn · ngày · đoạn cần cắt · mô tả), dán **link video** gửi lại khách,
hoặc báo "không cắt được" kèm lý do. Cũng gửi thẳng video cho khách được mà không cần khách xin.

Video nằm luôn trong mục **Video của tôi** của khách. Link YouTube hoặc file `.mp4` phát ngay trong app;
link khác (Drive, Facebook…) hiện nút mở tab mới — nhớ đặt quyền xem công khai.

> Cần chạy lại `supabase-schema.sql` (thêm bảng `ps_highlights`) thì highlight mới đồng bộ giữa các máy.
> Chưa chạy → phần còn lại vẫn đồng bộ bình thường, riêng highlight lưu cục bộ.

## QR đặt món

**Quản lý → QR bàn**: sinh QR cho từng bàn (`?table=N`). In dán lên bàn — khách quét là vào thẳng
trang đặt món với số bàn chọn sẵn. Cần deploy online + đã chạy SQL thì khách mới gửi order về quầy được.

## Tech

Một file `index.html` tự chứa: React 18 + Babel standalone + Supabase JS + QRCode, đều qua CDN. Không có build step.
