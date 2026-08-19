#!/usr/bin/env node
/* Bộ ca canh PHẦN CHẤM CÔNG của PoolStaff — giờ làm và bảng lương tháng.
 *
 * VÌ SAO PHẢI CÓ: bảng lương lấy thẳng số phút giữa lúc bấm vào ca và bấm ra ca, rồi nhân
 * đơn giá. Sai ở đây ra thẳng tiền trả cho nhân viên, mà KHÔNG có dấu hiệu nào: bảng vẫn in
 * ra một con số trông hợp lý. Ba lỗi đo được ngày 20/08/2026 trước khi có bộ này:
 *
 *   (1) RA CA SAU NỬA ĐÊM MẤT TRẮNG CẢ CA. Ca tối khai 16:00–24:00, quán bi-a đóng cửa muộn
 *       nên bấm ra ca lúc 00:20 là chuyện thường. `clockOut` ghi vào `attend[today()]`, mà
 *       lúc ấy `today()` đã sang ngày mới ⇒ ngày cũ có `in` không `out`, ngày mới có `out`
 *       không `in`, và phép cộng đòi đủ cả hai nên BỎ QUA cả hai. Mất 8 tiếng công một ca.
 *   (2) KHOẢNG ÂM ĐƯỢC CỘNG VÀO. `out < in` (bấm nhầm, đồng hồ máy lệch, sửa tay số liệu)
 *       cho ra số phút âm và nó TRỪ vào tổng công của chính người đó.
 *   (3) QUÊN BẤM RA CA rồi bấm vào hôm sau ⇒ một ca dài 20+ tiếng vào thẳng bảng lương.
 *
 * Phép tính còn bị CHÉP 05 CHỖ (`MyShift`, `MyHistory`, `TeamAttend`, `AttendView` lương
 * tháng) nên vá một chỗ là bốn chỗ kia vẫn sai — bộ này đo hàm dùng chung `phutCa`/`ngayRaCa`
 * và có ca canh chính việc "không được chép lại phép tính".
 *
 *   node kiem-cham-cong.js            chạy bộ ca
 *   node kiem-cham-cong.js --tu-kiem  dựng bản hỏng rồi đòi bộ ca bắt được
 *
 * Mã thoát: 0 đạt · 1 có ca trượt · 2 chưa đo được.
 */
const fs = require('fs');
const path = require('path');

const NGUON = path.join(path.dirname(__dirname), 'nguon', 'app.jsx');
const F = process.env.KIEM_NGUON || NGUON;

/* Bóc hai hàm thuần từ mã THẬT rồi chạy — không chép công thức sang đây. Chép là bản đo
 * tách khỏi bản chạy ngay lần vá sau, và ca vẫn xanh trong khi app đã sai. */
function nap(duong) {
    let s;
    try {
        s = fs.readFileSync(duong || F, 'utf8');
    } catch (e) {
        console.log('CHƯA ĐO ĐƯỢC — không đọc được ' + (duong || F));
        process.exit(2);
    }
    const lay = (ten) => {
        const i = s.indexOf('function ' + ten + '(');
        if (i < 0) return null;
        // cắt tới dấu } ở cột 0 — quy ước của file này: hàm cấp cao nhất không thụt lề
        const j = s.indexOf('\n}\n', i);
        return j < 0 ? null : s.slice(i, j + 3);
    };
    const ma = ['phutCa', 'ngayRaCa'].map(lay);
    if (ma.some(x => !x)) {
        return {thieu: ['phutCa', 'ngayRaCa'].filter((_, k) => !ma[k])};
    }
    /* Bóc kèm thứ hai hàm ấy dựa vào — cũng lấy từ mã THẬT, không chép:
     *   `TRAN_CA_PHUT` là ngưỡng bộ ca đang đo (bản hỏng nới/siết nó phải làm ca đỏ);
     *   `pad` là hàm `ngayRaCa` gọi để dựng chuỗi ngày.
     * Thiếu chúng thì bộ ca chết vì ReferenceError chứ không phải vì lỗi của app — đọc ra
     * y hệt lúc bộ ca thật sự bắt được lỗi, nên phải kêu riêng. */
    const phu = [];
    for (const ten of ['TRAN_CA_PHUT', 'pad']) {
        const m = s.match(new RegExp('^(?:var|const|let)\\s+' + ten + '\\s*=.*$', 'm'));
        if (!m) return {thieu: ['hằng/hàm phụ ' + ten]};
        phu.push(m[0]);
    }
    const f = new Function(phu.join('\n') + '\n' + ma.join('\n')
        + '\nreturn {phutCa, ngayRaCa};');
    return f();
}

// ── Dựng mốc thời gian thật ────────────────────────────────────────────────────────────
const ms = (ngay, gio, phut) => new Date(ngay + 'T' + String(gio).padStart(2, '0') + ':'
    + String(phut).padStart(2, '0') + ':00').getTime();

let truot = [];

function ca(ten, that, doi) {
    const dat = JSON.stringify(that) === JSON.stringify(doi);
    console.log((dat ? '  ✓ ' : '  ✗ TRƯỢT ') + ten
        + (dat ? '' : ` — ra ${JSON.stringify(that)}, đòi ${JSON.stringify(doi)}`));
    if (!dat) truot.push(ten);
}

function boCa(m) {
    truot = [];
    if (m.thieu) {
        console.log('  ✗ TRƯỢT · mã THIẾU hàm: ' + m.thieu.join(', '));
        return ['thiếu hàm ' + m.thieu.join(', ')];
    }
    const {phutCa, ngayRaCa} = m;
    console.log('BỘ CA CHẤM CÔNG — giờ làm ra thẳng tiền lương:\n');

    // ── phutCa · ca bình thường ────────────────────────────────────────────────────
    ca('ĐỐI CHỨNG · ca sáng 08:00–16:00 ra đúng 480 phút',
       phutCa({in: ms('2026-08-10', 8, 0), out: ms('2026-08-10', 16, 0)}), 480);
    ca('ĐỐI CHỨNG · ca lẻ phút vẫn tính đủ',
       phutCa({in: ms('2026-08-10', 8, 5), out: ms('2026-08-10', 16, 20)}), 495);
    ca('ĐỐI CHỨNG · thiếu giờ ra thì chưa tính công',
       phutCa({in: ms('2026-08-10', 8, 0)}), 0);
    ca('ĐỐI CHỨNG · chưa vào ca thì bằng 0', phutCa({}), 0);
    ca('ĐỐI CHỨNG · bản ghi rỗng không làm vỡ phép tính', phutCa(null), 0);

    // ── phutCa · lỗi (2) khoảng âm ─────────────────────────────────────────────────
    // Số âm TRỪ vào tổng công của chính người đó, và bảng lương vẫn in ra một con số.
    ca('PHẢI CHẶN · giờ ra trước giờ vào thì trả 0, không trả số âm',
       phutCa({in: ms('2026-08-10', 16, 0), out: ms('2026-08-10', 8, 0)}), 0);

    // ── phutCa · lỗi (3) ca dài bất thường ─────────────────────────────────────────
    // Quên bấm ra ca rồi bấm hôm sau. Trần 16 giờ: ca dài nhất của quán là 08:00–24:00.
    ca('PHẢI CHẶN · ca 20 tiếng (quên bấm ra ca) bị cắt về trần 16 giờ',
       phutCa({in: ms('2026-08-10', 8, 0), out: ms('2026-08-11', 4, 0)}), 960);
    ca('ĐỐI CHỨNG · ca 16 tiếng chẵn vẫn được tính đủ, không bị cắt oan',
       phutCa({in: ms('2026-08-10', 8, 0), out: ms('2026-08-11', 0, 0)}), 960);
    ca('ĐỐI CHỨNG · ca tối 16:00–00:30 qua nửa đêm tính đủ 510 phút',
       phutCa({in: ms('2026-08-10', 16, 0), out: ms('2026-08-11', 0, 30)}), 510);

    // ── ngayRaCa · lỗi (1) ra ca sau nửa đêm ───────────────────────────────────────
    // Trả về NGÀY phải ghi giờ ra. Bấm lúc 00:20 ngày 11 mà ca mở từ ngày 10 ⇒ ghi vào 10.
    const att = {
        '2026-08-10': {u1: {in: ms('2026-08-10', 16, 0)}},          // đang mở, chưa ra ca
        '2026-08-09': {u1: {in: ms('2026-08-09', 8, 0), out: ms('2026-08-09', 16, 0)}},
    };
    ca('PHẢI CHẶN · ra ca lúc 00:20 ghi vào NGÀY VÀO CA, không phải ngày mới',
       ngayRaCa(att, 'u1', '2026-08-11'), '2026-08-10');
    ca('ĐỐI CHỨNG · ra ca trong ngày thì vẫn ghi ngày hôm nay',
       ngayRaCa({'2026-08-10': {u1: {in: ms('2026-08-10', 8, 0)}}}, 'u1', '2026-08-10'),
       '2026-08-10');
    // Ca hôm qua phải ĐÃ ĐÓNG (có cả `in` lẫn `out`) thì mới đo được điều kiện `!a.out`.
    // Dựng hôm qua RỖNG là bản hỏng bỏ điều kiện ấy vẫn không lùi được, ca xanh trên cả hai.
    ca('ĐỐI CHỨNG · hôm qua đã đóng ca thì KHÔNG lùi về hôm qua',
       ngayRaCa({'2026-08-10': {u1: {in: ms('2026-08-10', 16, 0),
                                     out: ms('2026-08-10', 23, 0)}}}, 'u1', '2026-08-11'),
       '2026-08-11');
    ca('ĐỐI CHỨNG · chưa vào ca bao giờ thì ghi ngày hôm nay',
       ngayRaCa({}, 'u9', '2026-08-11'), '2026-08-11');
    // Chỉ lùi ĐÚNG MỘT ngày: ca mở từ 3 hôm trước là quên bấm hẳn, lùi về đó thì một lần
    // bấm nhầm đẻ ra ca 72 tiếng — thà để nó thành ca hôm nay rồi người ta sửa tay.
    ca('PHẢI CHẶN · ca bỏ quên từ 3 hôm trước KHÔNG được nhận',
       ngayRaCa({'2026-08-08': {u1: {in: ms('2026-08-08', 16, 0)}}}, 'u1', '2026-08-11'),
       '2026-08-11');
    // Người khác đang mở ca hôm qua không được kéo ca của mình lùi theo.
    ca('ĐỐI CHỨNG · ca đang mở của NGƯỜI KHÁC không kéo mình lùi ngày',
       ngayRaCa(att, 'u2', '2026-08-11'), '2026-08-11');

    return truot;
}

// ── Bản hỏng ───────────────────────────────────────────────────────────────────────────
const BAN_HONG = [
    ['bỏ chặn khoảng âm',
     'if (!(p > 0)) return 0;', 'if (false) return 0;',
     ['PHẢI CHẶN · giờ ra trước giờ vào thì trả 0, không trả số âm']],
    ['bỏ trần 16 giờ',
     'return Math.min(p, TRAN_CA_PHUT);', 'return p;',
     ['PHẢI CHẶN · ca 20 tiếng (quên bấm ra ca) bị cắt về trần 16 giờ']],
    ['nới trần lên 24 giờ',
     'var TRAN_CA_PHUT = 16 * 60;', 'var TRAN_CA_PHUT = 24 * 60;',
     ['PHẢI CHẶN · ca 20 tiếng (quên bấm ra ca) bị cắt về trần 16 giờ']],
    ['siết trần xuống 8 giờ (kêu oan ca tối)',
     'var TRAN_CA_PHUT = 16 * 60;', 'var TRAN_CA_PHUT = 8 * 60;',
     ['ĐỐI CHỨNG · ca 16 tiếng chẵn vẫn được tính đủ, không bị cắt oan',
      'ĐỐI CHỨNG · ca tối 16:00–00:30 qua nửa đêm tính đủ 510 phút']],
    ['ngayRaCa luôn trả ngày hôm nay (đúng lỗi gốc)',
     'if (a && a.in && !a.out) return hom_qua;', 'if (false) return hom_qua;',
     ['PHẢI CHẶN · ra ca lúc 00:20 ghi vào NGÀY VÀO CA, không phải ngày mới']],
    ['ngayRaCa lùi cả khi ca hôm qua ĐÃ đóng',
     'if (a && a.in && !a.out) return hom_qua;', 'if (a && a.in) return hom_qua;',
     ['ĐỐI CHỨNG · hôm qua đã đóng ca thì KHÔNG lùi về hôm qua']],
];

function tuKiem() {
    const goc = fs.readFileSync(F, 'utf8');

    console.log('BẢN ĐÚNG:\n');
    if (boCa(nap()).length) {
        console.log('\n✗ BỘ CA TRƯỢT TRÊN BẢN ĐÚNG — sửa bộ ca trước khi đo bản hỏng');
        return 1;
    }

    /* Ca soi TĨNH: chuỗi neo hết khớp là bản hỏng mất răng TRONG IM LẶNG, mà bảng vẫn in ra
     * một dòng lẫn giữa các dòng đạt. Đọc bản THẬT trên đĩa, không đọc `__filename`. */
    const tit = BAN_HONG.filter(([, cu]) => goc.split(cu).length - 1 !== 1).map(([t]) => t);
    console.log('\n  ' + (tit.length ? '✗ TRƯỢT' : '✓') + ' neo của bản hỏng khớp đúng 1 chỗ'
        + (tit.length ? ' — hỏng neo: ' + tit.join(' · ') : ''));
    if (tit.length) return 1;

    /* Phép tính KHÔNG được chép lại ở nơi khác. Vá một chỗ mà bốn chỗ kia vẫn giữ công thức
     * cũ thì bảng lương đúng còn màn của nhân viên vẫn sai — không dòng lỗi nào phát ra. */
    /* Bỏ THÂN của `phutCa` ra trước khi đếm: bản gốc của công thức nằm chính trong đó, đếm
     * cả nó thì ca đỏ vĩnh viễn ngay trên bản đúng — cổng chết, luồng bình thường không bao
     * giờ qua nổi. */
    const iP = goc.indexOf('function phutCa(');
    const ngoai = iP < 0 ? goc
        : goc.slice(0, iP) + goc.slice(goc.indexOf('\n}\n', iP) + 3);
    const chep = (ngoai.match(/Math\.round\(\((?:a|myAtt)\.out\s*-\s*(?:a|myAtt)\.in\)\s*\/\s*60000\)/g) || []);
    console.log('  ' + (chep.length ? '✗ TRƯỢT' : '✓')
        + ' phép tính phút không bị chép lại ngoài `phutCa`'
        + (chep.length ? ` — còn ${chep.length} chỗ chép` : ''));
    if (chep.length) return 1;

    console.log('\nBẢN HỎNG — mỗi bản gỡ một lớp vá, ca tương ứng PHẢI đỏ:\n');
    let hong = 0;
    const tam = path.join(__dirname, `_thu-hong-${process.pid}-app.jsx`);
    try {
        for (const [ten, cu, moi, doiDo] of BAN_HONG) {
            fs.writeFileSync(tam, goc.replace(cu, moi));
            console.log('  ── ' + ten);
            const do_ = new Set(boCa(nap(tam)));
            const thieu = doiDo.filter(c => !do_.has(c));
            if (thieu.length) {
                hong++;
                console.log('     ✗ KHÔNG BẮT ĐƯỢC: ' + thieu.join(' · '));
            } else {
                console.log('     ✓ bắt được: ' + doiDo.join(' · '));
            }
            console.log();
        }
    } finally {
        try { fs.unlinkSync(tam); } catch (e) { /* đã xoá rồi thì thôi */ }
    }

    console.log(`${hong ? 'TRƯỢT' : 'ĐẠT'} — ${BAN_HONG.length - hong}/${BAN_HONG.length} `
        + 'bản hỏng đều bị bắt');
    return hong ? 1 : 0;
}

if (process.argv.includes('--tu-kiem')) {
    process.exit(tuKiem());
} else {
    const t = boCa(nap());
    console.log(`\n${t.length ? 'TRƯỢT' : 'ĐẠT'} — ${t.length} ca trượt`);
    process.exit(t.length ? 1 : 0);
}
