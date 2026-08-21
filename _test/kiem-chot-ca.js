#!/usr/bin/env node
/* Bộ ca canh PHẦN CHỐT SỔ CUỐI CA của PoolStaff — đối chiếu tiền mặt trong két.
 *
 * VÌ SAO PHẢI CÓ: trước 21/08/2026 sổ sách của app tính MỘT CHIỀU — cộng các bill đã chốt
 * rồi in ra một con số. Con số ấy trả lời *quán đáng lẽ thu bao nhiêu*, không trả lời *két
 * có đúng chừng ấy không*. Chênh lệch giữa hai vế chính là chỗ tiền thật của quán rơi ra:
 * bill quên chốt, khách chuyển khoản mà vẫn tính vào tiền mặt, nhân viên lấy tiền két đi
 * mua đá rồi quên ghi. Không có vế thứ hai thì mọi lối rơi ấy đều CÂM — sổ vẫn đẹp, số vẫn
 * cộng đúng, chỉ két là thiếu, và không dòng nào phát ra lỗi.
 *
 * Bốn lối hỏng của chính phép đối chiếu, tất cả đều im lặng:
 *   (1) coi "chưa đếm két" là "đếm được 0đ" ⇒ mỗi ca mở ra đã báo thiếu đúng bằng doanh số,
 *       cảnh báo luôn đỏ là cảnh báo hết ai đọc;
 *   (2) bỏ tiền lẻ đầu ca hoặc khoản lấy đi mua đồ khỏi phép tính ⇒ ca nào cũng lệch, người
 *       chốt trừ nhẩm, và con số cuối không còn kiểm lại được;
 *   (3) lấy nhầm khoảng thời gian ⇒ cộng cả bill của ca trước vào ca này;
 *   (4) ngưỡng bỏ qua nới quá tay ⇒ mất vài trăm nghìn mỗi ca vẫn hiện chữ "khớp".
 *
 *   node kiem-chot-ca.js            chạy bộ ca
 *   node kiem-chot-ca.js --tu-kiem  dựng bản hỏng rồi đòi bộ ca bắt được
 *
 * Mã thoát: 0 đạt · 1 có ca trượt · 2 chưa đo được.
 */
const fs = require('fs');
const path = require('path');

const NGUON = path.join(path.dirname(__dirname), 'nguon', 'app.jsx');

/* Bóc khối chốt ca từ mã THẬT rồi chạy — không chép công thức sang đây. Chép là bản đo
 * tách khỏi bản chạy ngay lần vá sau, và ca vẫn xanh trong khi app đã sai. */
const DAU = '/* ===== CHỐT SỔ CUỐI CA';
/* ⚠ Mốc cuối là chỗ khai `Ledger`, KHÔNG phải chỗ khai màn chốt ca: giữa hai chỗ ấy có cả
 * thân `Ledger` với JSX, mà JSX thì `new Function` không dịch được — bóc quá tay là bộ ca
 * chết ngay ở bước nạp và mọi ca đọc ra như nhau. */
const CUOI = 'function Ledger({sessions';

function bocKhoi(ma) {
    const a = ma.indexOf(DAU);
    if (a < 0) throw new Error('không thấy mốc đầu "' + DAU + '"');
    const b = ma.indexOf(CUOI, a);
    if (b < 0) throw new Error('không thấy mốc cuối "' + CUOI + '"');
    /* `sumRev` và `fmtVnd` nằm ngoài khối — tiêm vào chứ không bóc theo, để khối đo đúng
       bằng khối đang sửa. */
    return ma.slice(a, b);
}

function nap(ma) {
    const duoi = '\n;return {tinhChotCa, mucLech, soTien, NGUONG_LECH};';
    const sumRev = (list) => list.reduce((a, x) => ({
        table: a.table + (x.tableAmt || 0), item: a.item + (x.itemAmt || 0),
        disc: a.disc + (x.disc || 0), total: a.total + (x.total || 0),
    }), {table: 0, item: 0, disc: 0, total: 0});
    const fmtVnd = n => Math.round(n || 0).toLocaleString('vi-VN') + '₫';
    return new Function('sumRev', 'fmtVnd', ma + duoi)(sumRev, fmtVnd);
}

const bill = (endTs, tableAmt, itemAmt, disc) => ({
    endTs, tableAmt, itemAmt, disc: disc || 0,
    total: tableAmt + itemAmt - (disc || 0),
});

/* Ca tối 16:00 → 24:00 ngày 21/08/2026, mốc thời gian ghi cứng để ca không trôi theo
   ngày chạy — ca chập chờn dạy người đọc bỏ qua màu đỏ. */
const T16 = new Date(2026, 7, 21, 16, 0, 0).getTime();
const T24 = new Date(2026, 7, 22, 0, 0, 0).getTime();
const TRUOC = T16 - 3600000;          // một bill của ca chiều, trước giờ ca này
const SAU = T24 + 3600000;            // một bill của ca sau

const CA = [
    ['01', 'cộng đúng các bill trong khoảng ca', m => {
        const r = m.tinhChotCa({sessions: [bill(T16 + 1000, 100000, 50000), bill(T24 - 1000, 60000, 0)],
            tuTs: T16, denTs: T24, demDuoc: ''});
        return r.soLuot === 2 && r.doanhSo === 210000 && r.tienBan === 160000 && r.tienDo === 50000;
    }],
    /* Cộng cả bill ca trước là ca này thừa tiền trên giấy và người chốt bị quy thiếu két. */
    ['02', 'KHÔNG cộng bill của ca trước và ca sau', m => {
        const r = m.tinhChotCa({sessions: [bill(TRUOC, 999000, 0), bill(T16 + 1000, 100000, 0), bill(SAU, 888000, 0)],
            tuTs: T16, denTs: T24, demDuoc: ''});
        return r.soLuot === 1 && r.doanhSo === 100000;
    }],
    ['03', 'bill chưa chốt (còn đang chơi) không tính vào doanh số ca', m => {
        const r = m.tinhChotCa({sessions: [{endTs: null, total: 500000}, bill(T16 + 1000, 100000, 0)],
            tuTs: T16, denTs: T24, demDuoc: ''});
        return r.soLuot === 1 && r.doanhSo === 100000;
    }],
    /* Đúng mốc đầu và mốc cuối phải tính vào — bỏ mép là mỗi ngày rơi vài bill mà không ai
       thấy, vì con số vẫn trông hợp lý. */
    ['04', 'bill rơi đúng mốc mở ca và mốc đóng ca vẫn được tính', m => {
        const r = m.tinhChotCa({sessions: [bill(T16, 50000, 0), bill(T24, 70000, 0)],
            tuTs: T16, denTs: T24, demDuoc: ''});
        return r.soLuot === 2 && r.doanhSo === 120000;
    }],

    /* ── Phép đối chiếu ──────────────────────────────────────────────────── */
    ['05', 'két đúng bằng số đáng lẽ có thì lệch bằng 0', m => {
        const r = m.tinhChotCa({sessions: [bill(T16 + 1000, 200000, 0)],
            tuTs: T16, denTs: T24, dauCa: 500000, demDuoc: 700000});
        return r.tienMatPhaiCo === 700000 && r.lech === 0;
    }],
    ['06', 'tiền lẻ đầu ca vào phép tính, không bắt người chốt trừ nhẩm', m => {
        const r = m.tinhChotCa({sessions: [bill(T16 + 1000, 200000, 0)],
            tuTs: T16, denTs: T24, dauCa: 500000, demDuoc: 200000});
        return r.lech === -500000;
    }],
    /* Khách chuyển khoản mà vẫn tính vào tiền mặt là lối lệch hay gặp nhất ở quán. */
    ['07', 'khoản khách chuyển khoản bị trừ khỏi tiền mặt đáng lẽ có', m => {
        const r = m.tinhChotCa({sessions: [bill(T16 + 1000, 300000, 0)],
            tuTs: T16, denTs: T24, chuyenKhoan: 300000, demDuoc: 0});
        return r.tienMatPhaiCo === 0 && r.lech === 0;
    }],
    ['08', 'tiền lấy từ két đi mua đồ bị trừ khỏi tiền mặt đáng lẽ có', m => {
        const r = m.tinhChotCa({sessions: [bill(T16 + 1000, 300000, 0)],
            tuTs: T16, denTs: T24, chiTrongCa: 100000, demDuoc: 200000});
        return r.tienMatPhaiCo === 200000 && r.lech === 0;
    }],
    ['09', 'thiếu tiền thì lệch âm, thừa tiền thì lệch dương', m => {
        const a = m.tinhChotCa({sessions: [bill(T16 + 1000, 300000, 0)], tuTs: T16, denTs: T24, demDuoc: 250000});
        const b = m.tinhChotCa({sessions: [bill(T16 + 1000, 300000, 0)], tuTs: T16, denTs: T24, demDuoc: 350000});
        return a.lech === -50000 && b.lech === 50000;
    }],
    /* Giảm giá theo hạng khách đã trừ vào `total` của bill, cộng lại lần nữa là ca nào cũng
       báo thiếu đúng bằng số đã giảm. */
    ['10', 'giảm giá theo hạng khách không bị cộng lại vào tiền mặt phải có', m => {
        const r = m.tinhChotCa({sessions: [bill(T16 + 1000, 300000, 0, 50000)],
            tuTs: T16, denTs: T24, demDuoc: 250000});
        return r.doanhSo === 250000 && r.lech === 0;
    }],

    /* ── Chưa đếm két ────────────────────────────────────────────────────── */
    ['11', 'chưa đếm két thì lệch là null, KHÔNG phải 0 hay số âm', m => {
        const r = m.tinhChotCa({sessions: [bill(T16 + 1000, 300000, 0)], tuTs: T16, denTs: T24, demDuoc: ''});
        return r.lech === null && r.demDuoc === null;
    }],
    ['12', 'ô đếm bỏ trắng, để null, hay gõ mỗi khoảng trắng đều là CHƯA đếm', m =>
        [undefined, null, '', '   '].every(v =>
            m.tinhChotCa({sessions: [], tuTs: T16, denTs: T24, demDuoc: v}).lech === null)],
    /* ĐỐI CHỨNG chiều ngược: gõ số 0 là đã đếm và két rỗng thật, phải ra kết luận chứ không
       được im — két rỗng cuối ca là chuyện phải truy ngay. */
    ['13', 'gõ số 0 là ĐÃ đếm và két rỗng thật, phải kết luận (chiều NỚI)', m => {
        const r = m.tinhChotCa({sessions: [bill(T16 + 1000, 300000, 0)], tuTs: T16, denTs: T24, demDuoc: '0'});
        return r.demDuoc === 0 && r.lech === -300000;
    }],
    ['14', 'chưa đếm thì mucLech nói rõ là chưa đối chiếu được, không nói "khớp"', m =>
        m.mucLech(null).k === 'chua'],

    /* ── Ngưỡng bỏ qua ───────────────────────────────────────────────────── */
    ['15', 'lệch dưới ngưỡng là tiền lẻ, xếp khớp', m =>
        m.mucLech(5000).k === 'khop' && m.mucLech(-5000).k === 'khop'],
    ['16', 'đúng ngưỡng đã là lệch, không còn xếp khớp', m =>
        m.mucLech(m.NGUONG_LECH).k === 'thua' && m.mucLech(-m.NGUONG_LECH).k === 'thieu'],
    ['17', 'thiếu và thừa là hai kết luận khác nhau, không gộp thành "lệch"', m =>
        m.mucLech(-50000).k === 'thieu' && m.mucLech(50000).k === 'thua'],
    /* Ngưỡng nới quá tay là mất vài trăm nghìn mỗi ca mà app vẫn hiện chữ "khớp" — đúng
       kiểu hỏng mà cả phần này sinh ra để chống. */
    ['18', 'ngưỡng bỏ qua không được vượt 20.000đ (chiều NỚI)', m =>
        m.NGUONG_LECH > 0 && m.NGUONG_LECH <= 20000],

    /* ── Đọc số người gõ ─────────────────────────────────────────────────── */
    ['19', 'người gõ có chấm phân cách nghìn vẫn ra đúng số', m =>
        m.soTien('1.500.000') === 1500000 && m.soTien('700000') === 700000],
    ['20', 'chữ lẫn vào ô số không làm cả phép tính thành NaN', m =>
        m.soTien('500k') === 500 && m.soTien('abc') === 0 && m.soTien(null) === 0],
    /* NaN lọt vào là mọi con số phía sau thành NaN, màn hình hiện "NaN₫" và người chốt
       không biết nên tin cái nào. */
    ['21', 'ô số gõ rác thì cả bảng vẫn ra số, không ra NaN', m => {
        const r = m.tinhChotCa({sessions: [bill(T16 + 1000, 300000, 0)],
            tuTs: T16, denTs: T24, dauCa: 'abc', chuyenKhoan: '?', chiTrongCa: '', demDuoc: '300000'});
        return isFinite(r.tienMatPhaiCo) && r.lech === 0;
    }],
    ['22', 'chưa có bill nào trong ca thì doanh số bằng 0, không nổ', m => {
        const r = m.tinhChotCa({sessions: [], tuTs: T16, denTs: T24, dauCa: 500000, demDuoc: 500000});
        return r.soLuot === 0 && r.doanhSo === 0 && r.lech === 0;
    }],
    ['23', 'danh sách bill rỗng hoặc thiếu vẫn chạy', m =>
        m.tinhChotCa({sessions: null, tuTs: T16, denTs: T24, demDuoc: ''}).soLuot === 0],
];

/* ── Ca đọc thẳng mã nguồn ──────────────────────────────────────────────── */
function caDocNguon(ma) {
    let hong = 0;
    /* Bảng `ps_chotca` mang tiền thật của quán theo từng ca. Lọt vào nhóm cho `anon` đọc là
       ai có link cũng xem được doanh số từng ca — và không dấu hiệu nào lộ ra. */
    const rls = fs.readFileSync(path.join(path.dirname(__dirname), 'supabase-auth-rls.sql'), 'utf8');
    const hoLo = /ps_chotca[^\n]*to anon/.test(rls);
    console.log('  ' + (hoLo ? '✗' : '✓') + ' [24] ps_chotca KHÔNG nằm trong nhóm cho khách đọc');
    if (hoLo) hong++;
    /* Bảng mới mà quán chưa chạy lại SQL thì phải nằm trong CLOUD_OPTIONAL, không thì cả
       phần đồng bộ đứng lại vì một bảng chưa có. */
    const tuyChon = /const CLOUD_OPTIONAL=\{[^}]*chotca/.test(ma);
    console.log('  ' + (tuyChon ? '✓' : '✗') + ' [25] ps_chotca khai là bảng tuỳ chọn (quán chưa chạy SQL vẫn dùng được app)');
    if (!tuyChon) hong++;
    return hong;
}

/* ── Chạy ───────────────────────────────────────────────────────────────── */
function chay(ma, im) {
    let m;
    try { m = nap(ma); }
    catch (e) {
        if (!im) console.log('  ✗ không nạp nổi mã: ' + e.message);
        return CA.map(c => c[0]);
    }
    const do_ = [];
    for (const [so, ten, ham] of CA) {
        let dat = false, loi = '';
        try { dat = ham(m); } catch (e) { dat = false; loi = ' — ném lỗi: ' + e.message; }
        if (!im) console.log('  ' + (dat ? '✓' : '✗') + ' [' + so + '] ' + ten + (dat ? '' : loi));
        if (!dat) do_.push(so);
    }
    return do_;
}

const BAN_HONG = [
    /* Ca 14 CỐ Ý không khai: nó nạp thẳng `null` vào `mucLech`, không đi qua `tinhChotCa`
       nên phép thay này không chạm tới. */
    ['coi "chưa đếm" là đếm được 0đ — mỗi ca mở ra đã báo thiếu', ['11', '12'],
        ma => ma.replace("  const daDem=!(demDuoc===''||demDuoc==null||String(demDuoc).trim()==='');",
            '  const daDem=true;')],

    ['gõ số 0 bị coi là chưa đếm — két rỗng thật thì im lặng (chiều NỚI)', ['13'],
        ma => ma.replace("  const daDem=!(demDuoc===''||demDuoc==null||String(demDuoc).trim()==='');",
            '  const daDem=!!soTien(demDuoc);')],

    ['bỏ tiền lẻ đầu ca khỏi phép tính', ['06'],
        ma => ma.replace('  const tienMatPhaiCo=dau+r.total-ck-chi;', '  const tienMatPhaiCo=r.total-ck-chi;')],

    ['bỏ khoản lấy két đi mua đồ khỏi phép tính', ['08'],
        ma => ma.replace('  const tienMatPhaiCo=dau+r.total-ck-chi;', '  const tienMatPhaiCo=dau+r.total-ck;')],

    ['cộng luôn tiền khách chuyển khoản vào tiền mặt phải có', ['07'],
        ma => ma.replace('  const tienMatPhaiCo=dau+r.total-ck-chi;', '  const tienMatPhaiCo=dau+r.total-chi;')],

    ['bỏ chặn hai đầu khoảng ca — cộng cả bill của ca trước', ['02'],
        ma => ma.replace('const trongCa=(sessions||[]).filter(x=>x.endTs&&x.endTs>=tu&&x.endTs<=den);',
            'const trongCa=(sessions||[]).filter(x=>x.endTs);')],

    ['bỏ mép: bill rơi đúng mốc mở và mốc đóng ca bị rơi mất', ['04'],
        ma => ma.replace('const trongCa=(sessions||[]).filter(x=>x.endTs&&x.endTs>=tu&&x.endTs<=den);',
            'const trongCa=(sessions||[]).filter(x=>x.endTs&&x.endTs>tu&&x.endTs<den);')],

    /* Ca 01 CỐ Ý không khai: cả hai bill của ca ấy đều đã chốt nên nới điều kiện không đổi
       kết quả — khai thừa thì tự kiểm trượt vì lý do sai và che mất bản hỏng thật. */
    ['tính cả bill chưa chốt (bàn còn đang chơi)', ['03'],
        ma => ma.replace('const trongCa=(sessions||[]).filter(x=>x.endTs&&x.endTs>=tu&&x.endTs<=den);',
            'const trongCa=(sessions||[]).filter(x=>x.endTs==null||(x.endTs>=tu&&x.endTs<=den));')],

    /* Ca 16 đo mốc "đúng ngưỡng đã là lệch" theo chính hằng số ấy, nên nới hằng số không
       làm nó đỏ. Ca 18 mới là ca canh chiều NỚI. */
    ['nới ngưỡng bỏ qua lên 500.000đ — mất nửa triệu mỗi ca vẫn hiện "khớp"', ['18'],
        ma => ma.replace('const NGUONG_LECH=10000;', 'const NGUONG_LECH=500000;')],

    ['gộp thiếu và thừa thành một kết luận chung', ['17'],
        ma => ma.replace("  return lech>0? {k:'thua',t:'Két THỪA '+fmtVnd(lech)} : {k:'thieu',t:'Két THIẾU '+fmtVnd(-lech)};",
            "  return {k:'thua',t:'Két lệch '+fmtVnd(Math.abs(lech))};")],

    ['soTien không lọc ký tự lạ — một ô gõ rác làm cả bảng thành NaN', ['19', '20', '21'],
        ma => ma.replace(/const soTien=v=>\{[^\n]*\};/, 'const soTien=v=>Number(v);')],

];

function tuKiem(ma) {
    let hong = 0;
    const doThat = chay(ma, true);
    if (doThat.length) {
        console.log('  ✗ bộ ca ĐÃ ĐỎ sẵn trên bản đúng: ' + doThat.join(', ') + ' — sửa bộ ca trước đã');
        return 1;
    }
    for (const [ten, canDo, thay] of BAN_HONG) {
        const hongMa = thay(ma);
        if (hongMa === ma) {
            console.log('  ✗ ' + ten + ' — phép thay KHÔNG khớp chỗ nào, bản hỏng rỗng');
            hong++; continue;
        }
        const do_ = chay(hongMa, true);
        if (do_.length === CA.length) {
            console.log('  ✗ ' + ten + ' — làm đỏ TOÀN BỘ ca, tức hỏng cú pháp chứ không phải gỡ lớp vá');
            hong++; continue;
        }
        const thieu = canDo.filter(c => !do_.includes(c));
        if (thieu.length) {
            console.log('  ✗ ' + ten + ' — KHÔNG làm đỏ ca ' + thieu.join(', ')
                + ' (đỏ: ' + (do_.join(', ') || 'không ca nào') + ')');
            hong++;
        } else console.log('  ✓ ' + ten + ' — bắt được, ca đỏ [' + do_.join(', ') + ']');
    }
    return hong;
}

let nguon;
try { nguon = fs.readFileSync(NGUON, 'utf8'); }
catch (e) { console.log('CHƯA ĐO ĐƯỢC — không đọc được ' + NGUON); process.exit(2); }
let ma;
try { ma = bocKhoi(nguon); }
catch (e) { console.log('CHƯA ĐO ĐƯỢC — ' + e.message); process.exit(2); }

if (process.argv.includes('--tu-kiem')) {
    console.log('Chạy bộ ca trên bản ĐÚNG trước:');
    const do_ = chay(ma, false);
    const doNguon = caDocNguon(nguon);
    console.log('\nDựng bản hỏng, mỗi bản phải làm đỏ đúng ca đã khai:');
    const hong = tuKiem(ma);
    console.log(hong || do_.length || doNguon ? '\n✗ Tự kiểm TRƯỢT.' : '\n✓ Tự kiểm đạt.');
    process.exit(hong || do_.length || doNguon ? 1 : 0);
}
console.log('Cổng chốt sổ cuối ca — PoolStaff:');
process.exit(chay(ma, false).length + caDocNguon(nguon) ? 1 : 0);
