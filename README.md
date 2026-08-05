# 🎱 PoolStaff — Trợ lý quán bi-a

Web app hỗ trợ vận hành quán bi-a: nhân viên báo món về quầy, đầu việc theo ca, đào tạo, chấm công,
tích điểm khách, khuyến mãi, giải đấu — và app riêng cho **khách hàng** tự đặt món & góp ý.

## Bảo mật — chạy 2 file SQL theo đúng thứ tự

1. `supabase-schema.sql` — tạo bảng (chỉ tạo bảng, **không** cấp quyền)
2. `supabase-auth-rls.sql` — bật đăng nhập + khoá dữ liệu

Sau khi chạy: nhân viên phải **đăng nhập bằng khoá quán** mới đọc/ghi được; khách chỉ
**gửi** đơn/góp ý/đặt bàn, không đọc được danh sách khách, không xoá được gì.

- Tài khoản quán: tạo 1 lần ở **Supabase → Authentication → Users** —
  email `quan@poolstaff.local`, password = **khoá quán**, tick *Auto Confirm User*.
- Khoá quán để ở `KHOA-QUAN.txt` trên máy quán (không lên GitHub). Mỗi máy nhân viên nhập 1 lần.
- Nhân viên nghỉ việc / mất máy → đổi password trên Supabase rồi báo khoá mới cho các máy còn lại.

> ⚠️ Chưa chạy `supabase-auth-rls.sql` thì **ai có link cũng đọc/xoá được dữ liệu khách** —
> đừng nhập tên/SĐT/ảnh khách thật cho tới khi chạy xong.

## Vai trò

| Vai | Màn mặc định | Chức năng chính |
|-----|--------------|-----------------|
| **Quản lý** | Doanh thu | 6 mục gom theo việc quản lý cái gì — xem bảng dưới |
| **Nhân viên phục vụ** | Báo món | Báo món, đầu việc, gậy & tủ, đào tạo, chấm công |
| **Nhân viên quầy** | Quầy | Order các bàn, gọi món ngoài, gậy & tủ, kiểm kho |
| **Tổ chức giải** | Giải đấu | Lịch giải, đăng ký, kết quả, khách, chấm công |
| **Khách hàng** | Đặt món | Đặt món, đặt bàn, **Highlight** (xin cắt clip & xem video), **hạng & quà theo giờ chơi**, thông báo, góp ý |

Đăng nhập giả lập (chọn tên). Khách đăng nhập bằng **SĐT**, máy tự nhớ.

## Menu của Quản lý

Gom theo **quản lý cái gì**, mỗi mục chỉ nằm ở đúng một chỗ, sâu tối đa 1 lớp tab:

| Mục | Tab con |
|-----|---------|
| **Bàn** | Sơ đồ bàn — mở / chốt bill (badge: số bàn đang chơi) |
| **Doanh thu** | Sổ sách · Tăng doanh số · Khuyến mãi · Giải đấu |
| **Khách** | Danh sách (lọc VIP) · Hạng & quà · Góp ý · Gửi tin · Highlight |
| **Nhân sự** | Cả đội · Phân ca · Lỗi & lương · Nhân viên · Đào tạo · Ca của tôi |
| **Vận hành** | Đầu việc · Tủ gửi gậy · Gậy quán · Kho · Bảo trì |
| **Cài đặt** | Thực đơn · Bàn & giá · QR bàn |

Badge đỏ: Khách = góp ý mới + yêu cầu cắt clip chờ; Vận hành = tủ quá hạn, bảo trì tới hạn.

## Chạy

- **Cục bộ:** mở thẳng `index.html` (nhấp đúp) — không cần build.
- **Online:** GitHub Pages (xem link ở phần About của repo).

## Đồng bộ nhiều máy (Supabase)

Chạy 1 lần `supabase-schema.sql` trong **Supabase → SQL Editor**. Sau đó:

- **Order realtime** — order từ máy nhân viên/khách hiện ngay ở quầy
- Đồng bộ: order · góp ý · khách & điểm/giờ chơi · menu · bàn · khuyến mãi · hạng khách · thông báo · highlight · tủ gậy & gậy quán
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

## Gậy & tủ

Màn **Gậy & tủ** (quản lý · nhân viên quầy · nhân viên phục vụ), 2 mục:

- **Tủ gửi gậy** — sơ đồ ô tủ như sơ đồ bàn. Bấm ô trống để cho khách quen thuê: chọn khách, ghi
  gậy khách gửi, ngày bắt đầu / hết hạn, phí theo tháng. Ô đang thuê bấm để **gia hạn 1 tháng**
  hoặc **trả tủ**. Viền xanh = đang thuê · vàng = còn ≤7 ngày · đỏ = quá hạn; danh sách
  *cần nhắc khách đóng phí* nổi lên đầu, số tủ quá hạn hiện thành badge đỏ trên thanh menu.
- **Gậy của quán** — giá cơ cho khách mượn: mã, loại, tình trạng (tốt / cần bảo dưỡng / hỏng —
  bấm để đổi), cho bàn nào mượn và nút *đã trả*. Cơ hỏng không cho mượn được.

Khách xem **tủ của mình** (số tủ, gậy đã gửi, hạn) ngay trong tab **Hạng** của app khách.
Chỉ quản lý mới thêm/xoá ô tủ và gậy.

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
