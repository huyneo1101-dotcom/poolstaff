
const {useState,useEffect,useMemo,useRef} = React;

/* ================= storage ================= */
const mem={};
const store={
  get(k,d){ try{const v=localStorage.getItem(k);return v==null?d:JSON.parse(v);}catch(e){return k in mem?mem[k]:d;} },
  set(k,v){ try{localStorage.setItem(k,JSON.stringify(v));}catch(e){mem[k]=v;} }
};
// Hook lưu tự động: dùng state + useEffect ghi localStorage
function usePersist(key,initial){
  const [v,setV]=useState(()=>store.get(key,typeof initial==='function'?initial():initial));
  useEffect(()=>{store.set(key,v);},[key,v]);
  return [v,setV];
}

/* ================= Cloud (Supabase) =================
   Đồng bộ liên máy: order (realtime), feedback, khách + menu/bàn/khuyến mãi (ps_kv).
   Nội bộ (chấm công/đào tạo/lương/kho) vẫn cục bộ từng máy.
   Mỗi dòng lưu cả object ở cột jsonb → không cần map cột.
   Chưa chạy SQL / mất mạng → app vẫn chạy bình thường bằng localStorage.
*/
const SB_URL='https://ltmlueqkajqmduoqghdf.supabase.co';
const SB_KEY='sb_publishable_74Lm6cc0CkoOOzy3A4IRrQ_BX0jHQcg';
const CLOUD_ARRAYS={orders:'ps_orders',feedback:'ps_feedback',customers:'ps_customers',broadcasts:'ps_broadcasts',alerts:'ps_alerts',
  tours:'ps_tours',signups:'ps_signups',results:'ps_results',bookings:'ps_bookings',
  sessions:'ps_sessions',maint:'ps_maint',growth:'ps_growth',highlights:'ps_highlights',
  lockers:'ps_lockers',cues:'ps_cues',chotca:'ps_chotca'};
// Bảng mới thêm sau: quán chưa chạy lại supabase-schema.sql thì bỏ qua, phần còn lại vẫn đồng bộ
const CLOUD_OPTIONAL={highlights:1,lockers:1,cues:1,chotca:1};
// Khoá quán: dữ liệu khách (tên, số điện thoại, lịch sử) chỉ mở cho máy biết khoá.
// Khoá nằm ở KHOA-QUAN.txt trên máy chủ quán, KHÔNG nằm trong file này và không lên GitHub.
// Nhập một lần trên mỗi máy, trình duyệt nhớ. Không có khoá → app vẫn chạy bằng dữ liệu máy này.
const CLUB_KEY_STORE='ps_club_key';
const Cloud={
  sb:null,enabled:false,status:'off',onStatus:null,
  clubKey(){ try{return localStorage.getItem(CLUB_KEY_STORE)||'';}catch(e){return '';} },
  hasKey(){ return !!this.clubKey(); },
  saveKey(k){
    try{localStorage.setItem(CLUB_KEY_STORE,(k||'').trim());}catch(e){}
    this.sb=null;this.enabled=false; // dựng lại kết nối với khoá mới
  },
  // Tài khoản dùng chung của quán: khoá quán chính là mật khẩu (tạo ở Supabase → Authentication)
  staffEmail:'quan@poolstaff.local',
  init(){
    if(this.sb)return true;
    try{
      if(!window.supabase||!window.supabase.createClient)return false;
      const k=this.clubKey();
      if(!k)return false;
      this.sb=window.supabase.createClient(SB_URL,SB_KEY,{global:{headers:{'x-club-key':k}}});
      this.enabled=true;return true;
    }catch(e){this.enabled=false;return false;}
  },
  // Máy nhân viên: đăng nhập bằng khoá quán để RLS mở quyền đọc/ghi dữ liệu nội bộ
  async signIn(){
    if(!this.sb)return false;
    try{
      const {data}=await this.sb.auth.getSession();
      if(data&&data.session)return true;
      const {error}=await this.sb.auth.signInWithPassword({email:this.staffEmail,password:this.clubKey()});
      if(error){ this.authError=error.message; return false; }
      return true;
    }catch(e){ this.authError=String(e&&e.message||e); return false; }
  },
  // Máy khách: không đăng nhập, chỉ gọi 2 hàm riêng (không đọc được bảng khách)
  guest(){
    if(this._g)return this._g;
    try{ this._g=window.supabase.createClient(SB_URL,SB_KEY); }catch(e){ this._g=null; }
    return this._g;
  },
  async custLogin(phone,name){
    const sb=this.sb||this.guest(); if(!sb)return null;
    const {data,error}=await sb.rpc('ps_cust_login',{p_phone:phone,p_name:name||null});
    if(error)throw error; return data;
  },
  async custData(custId){
    const sb=this.sb||this.guest(); if(!sb)return null;
    const {data,error}=await sb.rpc('ps_cust_data',{p_cust_id:custId});
    if(error)throw error; return data;
  },
  setStatus(s){this.status=s;if(this.onStatus)this.onStatus(s);},
  async bootstrap(){
    const out={kv:{}};
    for(const key in CLOUD_ARRAYS){
      const {data,error}=await this.sb.from(CLOUD_ARRAYS[key]).select('data');
      if(error){ if(CLOUD_OPTIONAL[key]){out[key]=null;continue;} throw error; }
      out[key]=(data||[]).map(r=>r.data).filter(Boolean);
    }
    const {data:kv,error:e2}=await this.sb.from('ps_kv').select('k,v');
    if(e2)throw e2;
    (kv||[]).forEach(r=>{out.kv[r.k]=r.v;});
    return out;
  },
  // Ghi hỏng (RLS chặn / mất mạng) → báo lên icon ☁️ thay vì im lặng nuốt lỗi
  noteWriteError(e){
    const m=(e&&(e.message||e.msg))||'';
    this.writeError=/row-level security|permission|denied|JWT/i.test(m)
      ? 'Cloud từ chối ghi. Máy này chưa đăng nhập bằng khoá quán, hoặc chưa chạy supabase-auth-rls.sql.'
      : ('Không lưu được lên cloud: '+(m||'lỗi không rõ'));
    this.setStatus('error');
  },
  async upsertRow(table,obj){
    try{ const {error}=await this.sb.from(table).upsert({id:obj.id,data:obj,updated_at:new Date().toISOString()});
      if(error)this.noteWriteError(error); }catch(e){ this.noteWriteError(e); }
  },
  async deleteRow(table,id){
    try{ await this.sb.from(table).delete().eq('id',id); }catch(e){}
  },
  async setKv(k,v){
    if(!this.enabled)return;
    try{ await this.sb.from('ps_kv').upsert({k,v,updated_at:new Date().toISOString()}); }catch(e){}
  },
  // Đẩy thay đổi của 1 mảng (thêm/sửa/xoá theo id) lên cloud
  syncArray(table,prev,next){
    if(!this.enabled||prev===next)return;
    const pm={};(prev||[]).forEach(x=>{if(x&&x.id)pm[x.id]=x;});
    const nm={};(next||[]).forEach(x=>{if(x&&x.id)nm[x.id]=x;});
    (next||[]).forEach(x=>{ if(!x||!x.id)return; const p=pm[x.id];
      if(!p||JSON.stringify(p)!==JSON.stringify(x)) this.upsertRow(table,x); });
    (prev||[]).forEach(x=>{ if(x&&x.id&&!nm[x.id]) this.deleteRow(table,x.id); });
  },
  subscribe(table,handler){
    return this.sb.channel('rt_'+table)
      .on('postgres_changes',{event:'*',schema:'public',table},handler).subscribe();
  },
};
// Áp thay đổi realtime vào state (dùng setter GỐC để không đẩy ngược lên cloud)
// norm: hàm chuẩn hoá bản ghi cũ trên cloud (vd khách chưa có giờ chơi)
function applyRealtime(rawSet,payload,norm){
  if(payload.eventType==='DELETE'){
    const id=payload.old&&payload.old.id; if(id)rawSet(v=>v.filter(x=>x.id!==id)); return;
  }
  let obj=payload.new&&payload.new.data; if(!obj||!obj.id)return;
  if(norm)obj=norm(obj);
  rawSet(v=>{const i=v.findIndex(x=>x.id===obj.id);if(i<0)return [obj,...v];
    if(JSON.stringify(v[i])===JSON.stringify(obj))return v; const nv=v.slice();nv[i]=obj;return nv;});
}

/* ================= utils ================= */
const uid=()=>Math.random().toString(36).slice(2,9);
const pad=n=>String(n).padStart(2,'0');
const today=()=>{const d=new Date();return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());};
const nowHM=()=>{const d=new Date();return pad(d.getHours())+':'+pad(d.getMinutes());};
const fmtDateVN=s=>{const[y,m,d]=s.split('-');return `${d}/${m}/${y}`;};
const dayName=s=>{const d=new Date(s+'T00:00');return ['CN','T2','T3','T4','T5','T6','T7'][d.getDay()];};
const minToHM=m=>{if(m==null)return '—';const h=Math.floor(m/60);return (h?h+'h':'')+pad(m%60)+'p';};

/* ================= chấm công — MỘT bản gốc cho cả app ================= */
/* Trần một ca. Ca dài nhất của quán là 08:00–24:00, nên 16 giờ vừa đủ cho ca tối kéo qua
   nửa đêm mà vẫn chặn được ca "quên bấm ra ca" 20+ tiếng. Ba lỗi bên dưới đều ra thẳng tiền
   lương và không lỗi nào phát ra — bảng vẫn in một con số trông hợp lý. */
var TRAN_CA_PHUT = 16 * 60;

/* Số phút công của MỘT bản ghi chấm công. Mọi nơi phải gọi hàm này, cấm chép lại phép tính:
   trước 20/08/2026 công thức nằm rải 05 chỗ (màn ca của tôi, lịch sử của tôi, bảng cả đội,
   bảng lương tháng) nên vá một chỗ là bốn chỗ kia vẫn sai.
   ⛔ Khoảng ÂM trả 0 chứ không trả số âm: `out < in` (bấm nhầm, đồng hồ máy lệch, sửa tay số
   liệu) từng TRỪ thẳng vào tổng công của chính người đó. */
function phutCa(a) {
  if (!a || !a.in || !a.out) return 0;
  var p = Math.round((a.out - a.in) / 60000);
  if (!(p > 0)) return 0;
  return Math.min(p, TRAN_CA_PHUT);
}

/* Ngày phải ghi giờ RA CA. Ca tối khai 16:00–24:00 mà quán bi-a đóng cửa muộn, nên bấm ra ca
   lúc 00:20 là chuyện thường — ghi vào ngày mới thì ngày cũ có `in` không `out`, ngày mới có
   `out` không `in`, và phép cộng đòi đủ cả hai nên BỎ QUA cả hai: mất trắng 8 tiếng công.
   Chỉ lùi ĐÚNG MỘT ngày và chỉ khi ca hôm qua còn đang mở. Lùi xa hơn thì một lần quên bấm
   đẻ ra ca 72 tiếng; thà để nó thành ca hôm nay rồi người ta sửa tay. */
function ngayRaCa(attend, sid, hom_nay) {
  var t = new Date(hom_nay + 'T00:00');
  t.setDate(t.getDate() - 1);
  var hom_qua = t.getFullYear() + '-' + pad(t.getMonth() + 1) + '-' + pad(t.getDate());
  var nay = ((attend || {})[hom_nay] || {})[sid];
  if (nay && nay.in) return hom_nay;          // đã vào ca hôm nay thì đóng đúng hôm nay
  var a = ((attend || {})[hom_qua] || {})[sid];
  if (a && a.in && !a.out) return hom_qua;
  return hom_nay;
}
const AV_COLORS=['#0f766e','#2563eb','#db2777','#d97706','#7c3aed','#0891b2','#16a34a','#e11d48'];
const avColor=id=>AV_COLORS[(id.charCodeAt(0)+id.length)%AV_COLORS.length];
const initials=n=>n.split(' ').slice(-2).map(w=>w[0]).join('').toUpperCase();

/* ================= seed ================= */
const SEED_STAFF=[
  {id:'u_an',  name:'Nguyễn Văn An', role:'manager', rate:30000},
  {id:'u_binh',name:'Trần Thị Bình', role:'counter', rate:25000},
  {id:'u_cuong',name:'Lê Cường',     role:'staff',   rate:22000},
  {id:'u_dung',name:'Phạm Dũng',     role:'staff',   rate:22000},
];
const ROLES={manager:{label:'Quản lý',icon:'🧑‍💼'},organizer:{label:'Tổ chức giải',icon:'🏆'},counter:{label:'Nhân viên quầy',icon:'🧾'},staff:{label:'Nhân viên phục vụ',icon:'🎱'}};
const ROLE_KEYS=['manager','organizer','counter','staff'];
const roleLabel=r=>(ROLES[r]||ROLES.staff).label;
const SEED_TABLES=(()=>{
  const a=[];
  for(let i=1;i<=16;i++)a.push({id:'t'+i,no:i,type:'Tiêu chuẩn',price:60000});
  for(let i=17;i<=20;i++)a.push({id:'t'+i,no:i,type:'VIP',price:80000});
  return a;
})();
const SEED_ENDTASKS=[
  {id:uid(),text:'Tắt đèn bàn, ghi giờ kết thúc & tính tiền giờ'},
  {id:uid(),text:'Đếm & thu lại bi, cơ, tam giác — kiểm tra thiếu/hỏng'},
  {id:uid(),text:'Nhặt vỏ lon/cốc, lau băng bàn & bàn phụ'},
  {id:uid(),text:'Chải lại mặt nỉ 1 chiều, phủi phấn lơ rơi'},
  {id:uid(),text:'Xếp cơ lên giá, để bi vào khay đúng bộ'},
  {id:uid(),text:'Chốt đồ uống của bàn & thu tiền đủ'},
  {id:uid(),text:'Cộng điểm tích luỹ cho khách quen'},
];
const FB_GOOD=['Nhân viên thân thiện','Bàn/nỉ đẹp','Phục vụ nhanh','Đồ ăn ngon','Nhạc hay','Giá hợp lý','Sạch sẽ, thoáng'];
const FB_BAD=['Đồ ăn ra chậm','Đồ ăn chưa ngon','Nhạc chưa hay','Bàn thiếu lết','Bàn/bi chưa sạch','Phục vụ chậm','Thái độ chưa tốt','Ồn / đông','Giá hơi cao','Khác'];
// Yêu cầu khách gọi tại bàn. to = ai nhận được. ttl = tự xoá sau (ms) vì coi như đã xong.
const ALERT_KINDS={
  end:    {label:'Khách báo đã chơi xong',    icon:'🏁',chip:'r',hint:'Ra tắt bàn & chốt tiền giờ',      to:['staff','counter']},
  remind: {label:'Khách nhắc đồ chưa mang ra',icon:'⏰',chip:'a',hint:'Kiểm tra & mang đồ ra cho khách',  to:['staff','counter']},
  rack:   {label:'Khách xin xếp bi',          icon:'🎱',chip:'b',hint:'Ra xếp bi cho khách',             to:['staff'], ttl:60000},
};
// Hết hạn (vd xếp bi sau 1 phút coi như đã xong) → tự biến mất
const alertExpired=a=>{const k=ALERT_KINDS[a.kind];return !!(k&&k.ttl&&a.status==='open'&&Date.now()-a.ts>k.ttl);};
const alertFor=(a,role)=>{const k=ALERT_KINDS[a.kind];return !k||!k.to||k.to.indexOf(role)>=0;};
const FB_RATING={good:{label:'Hài lòng',icon:'😃',chip:'gr'},ok:{label:'Bình thường',icon:'😐',chip:'a'},bad:{label:'Chưa hài lòng',icon:'😞',chip:'r'}};
// Món có giá (QL sửa ở Quản lý → Khác → Thực đơn)
const SEED_MENU=[
  {grp:'Nước', items:[{name:'Trà đá',price:3000},{name:'Trà chanh',price:15000},{name:'Nước suối',price:10000},{name:'Sting',price:15000},{name:'Red Bull',price:20000},{name:'Coca',price:15000},{name:'Pepsi',price:15000},{name:'Cà phê đen',price:20000},{name:'Cà phê sữa',price:25000},{name:'Bia Hà Nội',price:20000},{name:'Bia Tiger',price:25000},{name:'Nước cam',price:25000}]},
  {grp:'Đồ ăn',items:[{name:'Mì tôm úp',price:20000},{name:'Mì xào bò',price:40000},{name:'Hướng dương',price:15000},{name:'Bò khô',price:30000},{name:'Xúc xích rán',price:25000},{name:'Đậu phộng',price:15000},{name:'Bim bim',price:10000}]},
  {grp:'Thuốc lá',items:[{name:'Thăng Long',price:25000},{name:'Vinataba',price:28000},{name:'555',price:35000}]},
  {grp:'Khác',items:[{name:'Lơ (phấn)',price:10000},{name:'Khăn lạnh',price:5000},{name:'Găng bi-a',price:30000}]},
];
const priceOfItem=(menu,name)=>{for(const g of (menu||[])){const f=(g.items||[]).find(i=>i&&i.name===name);if(f)return Number(f.price)||0;}return 0;};
// Menu cũ: items là mảng chuỗi → chuẩn hoá {name,price}, lấy giá seed theo tên (đừng để về 0)
const menuIsOld=m=>(m||[]).some(g=>(g.items||[]).some(i=>typeof i==='string'));
const normMenu=m=>(m||[]).map(g=>({...g,items:(g.items||[]).map(it=>typeof it==='string'?{name:it,price:priceOfItem(SEED_MENU,it)}:it)}));
// đầu việc theo ca — mẫu
const SEED_SHIFT_TASKS={
  morning:[
    {id:uid(),text:'Mở cửa, bật đèn & điều hoà toàn quán'},
    {id:uid(),text:'Hút bụi & lau mặt bàn, phủ lơ các bàn'},
    {id:uid(),text:'Kiểm tra & sắp cơ, bi, tam giác đủ bộ'},
    {id:uid(),text:'Lau quầy, kê bàn ghế ngay ngắn'},
    {id:uid(),text:'Kiểm kho nước – ghi món sắp hết'},
    {id:uid(),text:'Nhận tiền quỹ đầu ca từ quản lý'},
  ],
  evening:[
    {id:uid(),text:'Kiểm tra đèn bàn, thay bi rơi/thiếu'},
    {id:uid(),text:'Bổ sung nước vào tủ mát cho ca tối'},
    {id:uid(),text:'Lau nhà khu vực sảnh & WC'},
    {id:uid(),text:'Đổ rác, thay túi rác các bàn'},
    {id:uid(),text:'Cuối ca: phủ bạt bàn, tắt đèn từng khu'},
    {id:uid(),text:'Chốt quỹ, bàn giao ca & khoá cửa'},
  ],
};
const SEED_TRAINING=[
  {id:uid(),title:'Chào & đón khách',icon:'🙌',lessons:[
    {t:'Quy trình đón khách',c:'• Khi khách vào: mỉm cười, chào "Anh/chị chơi mấy người ạ?"\n• Hỏi khách chơi thể thức nào (8 bi / 9 bi / 10 bi).\n• Dẫn khách tới bàn trống gần nhất, bật đèn bàn.\n• Đưa cơ, lau bàn nhanh nếu cần, hỏi khách uống gì.'},
    {t:'Thái độ phục vụ',c:'Luôn niềm nở, không ngồi bấm điện thoại khi có khách. Gọi khách quen bằng tên nếu nhớ. Không tranh cãi tay đôi — có vấn đề thì báo quản lý.'},
  ],quiz:[
    {q:'Việc ĐẦU TIÊN khi khách vào quán?',opts:['Tính tiền bàn cũ','Mỉm cười chào & hỏi số người','Đi lau nhà'],a:1},
  ]},
  {id:uid(),title:'Mở / tắt bàn & tính giờ',icon:'🕹️',lessons:[
    {t:'Mở bàn & xếp bi',c:'• Bật công tắc đèn đúng số bàn khách ngồi.\n• Ghi lại giờ bắt đầu (bảng quầy hoặc app tính giờ).\n• Xếp bi theo thể thức: 8 bi — đủ 15 bi + tam giác; 9 bi — bi 1–9 xếp hình thoi; 10 bi — bi 1–10 xếp tam giác.'},
    {t:'Tắt bàn & tính giờ',c:'• Khi khách xong: tắt đèn, ghi giờ kết thúc.\n• Tính tiền = số giờ × giá bàn (bảng giá ở quầy).\n• Khung giờ vàng (sau 18h) tính giá cao điểm.'},
  ],quiz:[
    {q:'Chơi 9 bi thì xếp bi thế nào?',opts:['Xếp tam giác đủ 15 bi','Bi 1–9 xếp hình thoi','Chỉ dùng 3 bi'],a:1},
    {q:'Giá cao điểm áp dụng khi nào?',opts:['Cả ngày','Trước 12h trưa','Khung giờ vàng sau 18h'],a:2},
  ]},
  {id:uid(),title:'Order & phục vụ đồ',icon:'🧋',lessons:[
    {t:'Nhận order',c:'• Ghi rõ BÀN SỐ MẤY + món + số lượng.\n• Nhập order vào app (tab Báo món) để quầy chuẩn bị.\n• Nhắc lại đơn cho khách xác nhận trước khi gửi.'},
    {t:'Phục vụ',c:'• Bê đồ đúng bàn, đặt gọn ở mép bàn phụ, tránh mặt bàn bi.\n• Không đặt cốc nước lên nỉ bàn.\n• Dọn vỏ lon/cốc bẩn thường xuyên.'},
  ],quiz:[
    {q:'Khi ghi order bắt buộc phải có?',opts:['Tên khách','Số bàn + món + số lượng','Biển số xe'],a:1},
    {q:'Được đặt cốc nước ở đâu?',opts:['Trên nỉ mặt bàn bi','Bàn phụ / mép bàn','Trên băng bàn'],a:1},
  ]},
  {id:uid(),title:'Vệ sinh & bảo quản bàn',icon:'🧹',lessons:[
    {t:'Chăm mặt nỉ',c:'• Chải nỉ 1 chiều bằng bàn chải chuyên dụng.\n• Không để nước/tàn thuốc rơi lên nỉ.\n• Phủ bạt bàn khi hết giờ để tránh bụi & nắng.'},
    {t:'Cơ & bi',c:'• Lau bi bằng khăn mềm, kiểm tra bi nứt.\n• Chuốt đầu cơ, gắn lơ đều.\n• Cơ cong/gãy đầu báo quản lý thay.'},
  ],quiz:[
    {q:'Chải nỉ bàn thế nào cho đúng?',opts:['Chải qua lại nhiều chiều','Chải 1 chiều bằng bàn chải chuyên dụng','Dùng chổi quét nhà'],a:1},
  ]},
  {id:uid(),title:'Khi khách chơi xong',icon:'✅',lessons:[
    {t:'Ngay khi khách rời bàn',c:'• Tắt đèn bàn, ghi giờ kết thúc & tính tiền giờ.\n• Đếm & thu lại bi, cơ, tam giác — kiểm tra thiếu/hỏng.\n• Nhặt vỏ lon, cốc, tàn thuốc; lau mặt băng bàn.\n• Chải lại mặt nỉ 1 chiều, phủi phấn lơ rơi.'},
    {t:'Chuẩn bị cho khách sau',c:'• Xếp lại cơ lên giá, để bi vào khay đúng bộ.\n• Kê ghế ngay ngắn, lau bàn phụ.\n• Nếu vắng khách: phủ bạt bàn để tránh bụi.\n• Báo quầy nếu bàn có bi hỏng/đèn lỗi để xử lý.'},
    {t:'Chốt đồ uống & mời quay lại',c:'• Chốt các món đã order của bàn, nhắc khách thanh toán đủ.\n• Cộng điểm tích luỹ cho khách quen (tab Khách).\n• Cảm ơn & mời khách quay lại, giới thiệu khuyến mãi đang chạy.'},
  ],quiz:[
    {q:'Ngay khi khách rời bàn KHÔNG nên bỏ qua việc nào?',opts:['Đếm lại bi & cơ, kiểm tra hỏng','Đăng Facebook','Bật nhạc to'],a:0},
    {q:'Trước khi rời bàn cho khách sau nên?',opts:['Để nguyên bàn bừa bộn','Chải nỉ, xếp cơ bi, lau bàn phụ','Tắt hết đèn quán'],a:1},
  ]},
  {id:uid(),title:'Xử lý tình huống',icon:'⚠️',lessons:[
    {t:'Khách say / gây ồn',c:'• Giữ bình tĩnh, nói nhẹ nhàng, không khích bác.\n• Mời nước, hạ nhiệt, cần thiết báo quản lý.\n• Không tự ý xô xát.'},
    {t:'Tranh chấp bàn / mất đồ',c:'• Bàn đã đặt trước: ưu tiên khách đặt, xin lỗi khách sau.\n• Khách báo mất đồ: hỏi kỹ vị trí, xem camera, báo quản lý ngay.'},
  ],quiz:[
    {q:'Khách say gây ồn, nên?',opts:['Cãi tay đôi cho khách sợ','Bình tĩnh hạ nhiệt & báo quản lý','Mặc kệ'],a:1},
  ]},
  {id:uid(),title:'Kết ca & bàn giao',icon:'🔑',lessons:[
    {t:'Cuối ca',c:'• Hoàn thành checklist đầu việc cuối ca.\n• Chốt quỹ tiền mặt, đối chiếu với bảng ghi.\n• Ghi lại sự cố trong ca (nếu có) cho ca sau.'},
    {t:'Bàn giao',c:'• Bàn giao quỹ + tình trạng bàn/kho cho ca sau hoặc quản lý.\n• Ca tối: phủ bạt, tắt điện từng khu, khoá cửa, bật báo động.'},
  ],quiz:[
    {q:'Cuối ca tối trước khi về phải?',opts:['Để nguyên đèn cho sáng','Phủ bạt, tắt điện, khoá cửa','Mở hết cửa cho thoáng'],a:1},
  ]},
  {id:uid(),title:'Hướng tăng doanh số (Quản lý)',icon:'📈',role:'manager',lessons:[
    {t:'Tăng doanh thu tiền bàn',c:'• Khung giờ vàng: giá cao điểm tối & cuối tuần, ưu đãi giờ thấp điểm (sáng, đầu tuần) để lấp bàn trống.\n• Combo "giờ + đồ uống" trọn gói theo nhóm.\n• Thẻ giờ trả trước (nạp 500k tặng 50k) để giữ khách & thu tiền sớm.\n• Đặt bàn trước qua điện thoại/Zalo cho khung giờ đông.'},
    {t:'Tăng doanh thu đồ uống & dịch vụ',c:'• Nhân viên chủ động mời nước khi mở bàn (upsell).\n• Combo nước + đồ ăn nhẹ giá tốt; bán thêm thuốc, lơ, găng.\n• Menu rõ ràng, ảnh đẹp; món "best-seller" để dễ chốt.\n• Gọi món ăn ngoài giúp khách ngồi lâu hơn = thêm giờ bàn.'},
    {t:'Giữ chân & marketing',c:'• Tích điểm đổi giờ/đồ uống; chăm sóc khách VIP (nhớ tên, nhớ mặt).\n• Tổ chức giải đấu định kỳ: thu lệ phí + tiền bàn + tạo cộng đồng.\n• Nhắn tin khuyến mãi/giải đấu cho khách quen.\n• Livestream/đăng highlight trận hay lên mạng xã hội.'},
    {t:'Quản trị chi phí',c:'• Theo dõi tồn kho (kiểm kho) tránh thất thoát & hết hàng.\n• Xếp ca theo lưu lượng khách để không thừa/thiếu người.\n• Bảo trì bàn/nỉ định kỳ để giảm chi phí thay thế lớn.\n• Đối chiếu quỹ cuối ca chặt chẽ.'},
  ],quiz:[]}, // chương tham khảo cho quản lý — không cần kiểm tra
];
const SEED_CUSTOMERS=[
  {id:uid(),name:'Anh Hùng',phone:'0912345678',points:120,hours:12,visits:14,vip:false,games:['8 bi'],photo:'',note:'Hay chơi tối, thích trà chanh',rewards:[],history:[{delta:20,reason:'Chơi 2h + đồ uống',ts:Date.now()-86400000*2}]},
  {id:uid(),name:'Chị Lan',phone:'0987654321',points:45,hours:4.5,visits:6,vip:false,games:['9 bi'],photo:'',note:'',rewards:[],history:[{delta:10,reason:'Chơi 1h',ts:Date.now()-86400000}]},
  {id:uid(),name:'Anh Tuấn',phone:'0909090909',points:230,hours:63,visits:31,vip:true,games:['9 bi','10 bi'],photo:'',note:'Khách VIP, hay dẫn nhóm 4 người, uống bia Tiger',rewards:[],history:[{delta:30,reason:'Nhóm 4 người',ts:Date.now()-3600000*5}]},
];
/* ===== Hạng khách theo tổng GIỜ CHƠI tích luỹ =====
   Chốt bill có gắn khách → cộng giờ + điểm. Đủ mốc giờ → lên hạng:
   chiết khấu tiền bàn cao hơn + tặng quà (voucher / nước / đồ ăn) 1 lần khi lên hạng.
   Quản lý sửa được mốc giờ, % giảm, quà ở: Khách → Hạng. Cấu hình đồng bộ qua ps_kv key 'tiers'. */
const SEED_TIERS={
  ptsPerHour:10,
  levels:[
    {id:'tv_new',  name:'Khách mới', icon:'🎱', hours:0,   discount:0,  gift:'',                       perks:''},
    {id:'tv_dong', name:'Đồng',      icon:'🥉', hours:10,  discount:5,  gift:'1 trà đá miễn phí',      perks:'nhận tin ưu đãi sớm'},
    {id:'tv_bac',  name:'Bạc',       icon:'🥈', hours:30,  discount:10, gift:'1 nước suối + 1 hướng dương', perks:'ưu tiên nhận đặt bàn'},
    {id:'tv_vang', name:'Vàng',      icon:'🥇', hours:60,  discount:15, gift:'1 phần đồ ăn nhẹ',       perks:'giữ bàn trước 30 phút'},
    {id:'tv_kc',   name:'Kim cương', icon:'💎', hours:120, discount:20, gift:'Voucher 200.000đ',       perks:'ưu tiên bàn VIP cuối tuần'},
  ],
};
// Khách cũ (localStorage/cloud) chưa có giờ chơi → suy ra từ điểm đã tích để không mất hạng
const normCust=c=>(c&&c.hours!=null)?(c.rewards?c:{...c,rewards:[]})
  :{...c,hours:Math.round(((c&&c.points)||0)/(SEED_TIERS.ptsPerHour||10)*10)/10,rewards:(c&&c.rewards)||[]};
const tierLevels=cfg=>[...(((cfg||{}).levels)||[])].sort((a,b)=>(Number(a.hours)||0)-(Number(b.hours)||0));
const tierOf=(cfg,hours)=>{const L=tierLevels(cfg);let cur=L[0]||null;L.forEach(l=>{if((Number(hours)||0)>=(Number(l.hours)||0))cur=l;});return cur;};
const nextTier=(cfg,hours)=>tierLevels(cfg).find(l=>(Number(l.hours)||0)>(Number(hours)||0))||null;
const tierPct=(cfg,hours)=>{const t=tierOf(cfg,hours);return t?Number(t.discount)||0:0;};
const fmtHours=h=>{const n=Number(h)||0;return (Math.round(n*10)/10).toString().replace('.',',')+'h';};
const unusedRewards=c=>((c&&c.rewards)||[]).filter(r=>!r.used);
function TierChip({t,big}){
  if(!t)return null;
  return <span className="chip a" style={big?{fontSize:13,padding:'5px 11px'}:null}>{t.icon} {t.name}</span>;
}

/* ===== Gậy & tủ =====
   Tủ gửi gậy: khách quen thuê ô tủ theo tháng để gửi cơ tại quán.
   Gậy quán: cơ của quán cho khách mượn theo bàn, theo dõi tình trạng. */
const SEED_LOCKERS=(()=>{
  const a=[];
  for(let i=1;i<=12;i++)a.push({id:'lk'+i,no:i,size:i<=8?'Thường':'To',fee:i<=8?50000:80000,
    custId:'',custName:'',phone:'',cue:'',startDate:'',dueDate:'',note:''});
  return a;
})();
const SEED_CUES=[
  {id:'cu1',code:'G-01',name:'Cơ chơi 12.5mm',type:'Cơ chơi',cond:'good',outTable:'',outTs:0,note:''},
  {id:'cu2',code:'G-02',name:'Cơ chơi 12.5mm',type:'Cơ chơi',cond:'good',outTable:'',outTs:0,note:''},
  {id:'cu3',code:'G-03',name:'Cơ chơi 13mm',type:'Cơ chơi',cond:'good',outTable:'',outTs:0,note:''},
  {id:'cu4',code:'G-04',name:'Cơ phá bi',type:'Cơ phá',cond:'good',outTable:'',outTs:0,note:''},
  {id:'cu5',code:'G-05',name:'Cơ lỗ 11mm',type:'Cơ lỗ',cond:'fix',outTable:'',outTs:0,note:'Đầu cơ mòn, cần chuốt lại'},
  {id:'cu6',code:'G-06',name:'Cơ tập cho khách mới',type:'Cơ chơi',cond:'good',outTable:'',outTs:0,note:''},
];
const CUE_TYPES=['Cơ chơi','Cơ phá','Cơ lỗ','Khác'];
const CUE_COND={good:{label:'Tốt',chip:'gr'},fix:{label:'Cần bảo dưỡng',chip:'a'},broken:{label:'Hỏng',chip:'r'}};
const lockerBusy=l=>!!(l&&l.custId);
// Trạng thái hạn thuê tủ: quá hạn (đỏ) · sắp hết ≤7 ngày (vàng) · còn hạn
const dueChip=(d)=>{
  if(!d)return null;
  const n=daysLeft(d);
  if(n<0)return {label:'quá hạn '+(-n)+' ngày',chip:'r',late:true};
  if(n<=7)return {label:'còn '+n+' ngày',chip:'a',soon:true};
  return {label:'đến '+fmtDateVN(d),chip:''};
};
const lockerOfCust=(lockers,custId)=>(lockers||[]).find(l=>l.custId===custId)||null;
const SHIFT_TIME={morning:{label:'Sáng',start:'08:00',end:'16:00',icon:'☀️'},evening:{label:'Tối',start:'16:00',end:'24:00',icon:'🌙'}};
const GAME_MODES=['8 bi','9 bi','10 bi'];
// Ưu đãi đẩy doanh số khung giờ vắng 8h–15h
const PROMO_DAYTIME={id:'promo_daytime',title:'Ưu đãi khung giờ 8h–15h',
  desc:'Giảm 30% tiền bàn + tặng trà đá cả bàn khi chơi khung 8h–15h. Chơi từ 2 giờ tặng thêm 1 giờ.',
  percent:30,hourStart:'08:00',hourEnd:'15:00',start:'',end:'',active:true};
const SEED_PROMOS=[
  PROMO_DAYTIME,
  {id:uid(),title:'Combo nhóm 4 người',desc:'Nhóm từ 4 khách: tặng 1 bình trà + 4 nước suối.',percent:0,hourStart:'',hourEnd:'',start:'',end:'',active:true},
  {id:uid(),title:'Sinh nhật tháng',desc:'Khách có sinh nhật trong tháng được tặng 1 giờ chơi miễn phí (xuất trình CCCD).',percent:0,hourStart:'',hourEnd:'',start:'',end:'',active:false},
];
const fmtVnd=n=>{const v=Math.round(n||0);return v.toLocaleString('vi-VN')+'₫';};
// Đang trong khung giờ áp dụng? (hỗ trợ khung qua đêm, vd 22:00–02:00)
const promoInHours=p=>{
  if(!p.hourStart||!p.hourEnd)return true;
  const n=nowHM();
  return p.hourStart<=p.hourEnd ? (n>=p.hourStart&&n<=p.hourEnd) : (n>=p.hourStart||n<=p.hourEnd);
};
// Đã bật + đúng ngày (chưa xét khung giờ)
const promoScheduled=p=>{ if(!p.active)return false; const t=today(); if(p.start&&t<p.start)return false; if(p.end&&t>p.end)return false; return true; };
// Đang chạy ngay lúc này (xét cả khung giờ)
const promoActive=p=>promoScheduled(p)&&promoInHours(p);
const monthOf=s=>(s||'').slice(0,7); // 'YYYY-MM'
const thisMonth=()=>today().slice(0,7);
const SEED_PENALTY=[
  {id:uid(),name:'Đi làm trễ',amount:20000},
  {id:uid(),name:'Nghỉ không báo trước',amount:100000},
  {id:uid(),name:'Quên phủ bạt / tắt đèn cuối ca',amount:30000},
  {id:uid(),name:'Làm vỡ/hỏng đồ (bi, cơ, ly)',amount:50000},
  {id:uid(),name:'Sai order / thái độ với khách',amount:30000},
  {id:uid(),name:'Lệch quỹ cuối ca',amount:50000},
];
// Bảo trì lặp theo chu kỳ (everyDays). Làm xong → tự đặt hạn lần sau.
const addDays=(d,n)=>{const x=new Date(d+'T00:00');x.setDate(x.getDate()+n);return x.getFullYear()+'-'+pad(x.getMonth()+1)+'-'+pad(x.getDate());};
const daysLeft=(due)=>Math.round((new Date(due+'T00:00')-new Date(today()+'T00:00'))/86400000);
const SEED_MAINT=[
  {id:uid(),name:'Thay nỉ bàn',note:'Thay nỉ toàn bộ bàn (hoặc bàn xuống cấp trước)',everyDays:180,due:addDays(today(),45),lastDone:''},
  {id:uid(),name:'Bảo dưỡng gậy (cơ)',note:'Chuốt đầu cơ, thay lơ đầu, kiểm tra cơ cong/nứt',everyDays:30,due:addDays(today(),7),lastDone:''},
  {id:uid(),name:'Chải & hút bụi mặt nỉ',note:'Chải 1 chiều toàn bộ bàn',everyDays:7,due:addDays(today(),2),lastDone:''},
  {id:uid(),name:'Lau & kiểm tra bi',note:'Lau bi, loại bi nứt/mờ',everyDays:14,due:addDays(today(),5),lastDone:''},
  {id:uid(),name:'Kiểm tra đèn bàn',note:'Thay bóng hỏng, chỉnh độ cao đèn',everyDays:60,due:addDays(today(),20),lastDone:''},
  {id:uid(),name:'Cân chỉnh mặt bàn (thăng bằng)',note:'Kiểm tra bàn có bị nghiêng/lún',everyDays:365,due:addDays(today(),120),lastDone:''},
];
// To-do tăng doanh số (chuyển từ chương đào tạo cũ) — có subtask tick được
const SEED_GROWTH=[
  {id:uid(),title:'Tăng doanh thu tiền bàn',done:false,subs:[
    {id:uid(),text:'Áp giá cao điểm tối & cuối tuần',done:false},
    {id:uid(),text:'Ưu đãi giờ thấp điểm (sáng/đầu tuần) để lấp bàn trống',done:false},
    {id:uid(),text:'Combo "giờ + đồ uống" trọn gói theo nhóm',done:false},
    {id:uid(),text:'Thẻ giờ trả trước (nạp 500k tặng 50k)',done:false},
    {id:uid(),text:'Nhận đặt bàn trước cho khung giờ đông',done:false},
  ]},
  {id:uid(),title:'Tăng doanh thu đồ uống & dịch vụ',done:false,subs:[
    {id:uid(),text:'Nhân viên chủ động mời nước khi mở bàn (upsell)',done:false},
    {id:uid(),text:'Combo nước + đồ ăn nhẹ giá tốt',done:false},
    {id:uid(),text:'Menu rõ ràng, đánh dấu món best-seller',done:false},
    {id:uid(),text:'Đẩy mạnh gọi món ăn ngoài (khách ngồi lâu hơn)',done:false},
  ]},
  {id:uid(),title:'Giữ chân khách & marketing',done:false,subs:[
    {id:uid(),text:'Tích điểm đổi giờ/đồ uống',done:false},
    {id:uid(),text:'Chăm sóc khách VIP (nhớ tên, nhớ mặt)',done:false},
    {id:uid(),text:'Tổ chức giải đấu định kỳ',done:false},
    {id:uid(),text:'Nhắn tin khuyến mãi/giải đấu cho khách quen',done:false},
    {id:uid(),text:'Đăng highlight trận hay lên mạng xã hội',done:false},
  ]},
  {id:uid(),title:'Quản trị chi phí',done:false,subs:[
    {id:uid(),text:'Theo dõi tồn kho, tránh thất thoát & hết hàng',done:false},
    {id:uid(),text:'Xếp ca theo lưu lượng khách',done:false},
    {id:uid(),text:'Bảo trì bàn/nỉ định kỳ',done:false},
    {id:uid(),text:'Đối chiếu quỹ cuối ca chặt chẽ',done:false},
  ]},
];
const SEED_OUTFOOD=[
  {id:uid(),name:'Cơm rang / cơm bình dân',phone:'0987000111'},
  {id:uid(),name:'Bún / phở gánh',phone:'0987000222'},
  {id:uid(),name:'Gà rán – ăn vặt',phone:'0987000333'},
  {id:uid(),name:'Trà sữa',phone:'0987000444'},
];

/* ================= small components ================= */
function Avatar({staff,size=36}){
  if(!staff)return null;
  return <div className="avatar" style={{width:size,height:size,fontSize:size*0.4,background:avColor(staff.id)}}>{initials(staff.name)}</div>;
}
function Modal({title,onClose,children,foot}){
  return (
    <div className="ov" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <div className="modal-h"><b>{title}</b><button className="x" onClick={onClose}><i className="ti ti-x"/></button></div>
        <div className="modal-b">{children}</div>
        {foot&&<div style={{padding:'0 18px 18px'}}>{foot}</div>}
      </div>
    </div>
  );
}
// Thanh tab con dùng chung: [{id,label,icon,badge}]
function Seg({tabs,cur,onPick}){
  return (
    <div className="seg">
      {tabs.filter(Boolean).map(t=>(
        <button key={t.id} className={cur===t.id?'on':''} onClick={()=>onPick(t.id)}>
          <i className={'ti '+t.icon}/>{t.label}{t.badge>0&&` (${t.badge})`}
        </button>
      ))}
    </div>
  );
}
function Empty({icon,text}){return <div className="empty"><i className={'ti '+icon}/><p>{text}</p></div>;}
function Toast({msg}){return msg?<div className="toast"><i className="ti ti-circle-check"/>{msg}</div>:null;}
const CLOUD_UI={
  off:{icon:'ti-cloud-off',color:'var(--muted2)',title:'Chạy cục bộ (chưa nối cloud)'},
  syncing:{icon:'ti-cloud-upload',color:'var(--amber)',title:'Đang đồng bộ…'},
  synced:{icon:'ti-cloud-check',color:'var(--grn)',title:'Đã đồng bộ — nhiều máy dùng chung'},
  error:{icon:'ti-cloud-x',color:'var(--red)',title:'Chưa nối được cloud — đang chạy cục bộ (chạy supabase-schema.sql?)'},
};
function CloudDot({status}){
  const c=CLOUD_UI[status]||CLOUD_UI.off;
  // Lỗi thì bấm vào để xem vì sao (sai khoá quán / chưa chạy SQL / RLS chặn ghi)
  const why=()=>{
    if(status!=='error')return;
    const a=Cloud.authError,w=Cloud.writeError;
    alert('⚠️ Chưa đồng bộ được lên cloud\n\n'+
      (a?('• Đăng nhập quán thất bại: '+a+'\n  → Kiểm tra lại KHOÁ QUÁN, và tài khoản quan@poolstaff.local đã tạo trong Supabase chưa.\n'):'')+
      (w?('• Ghi dữ liệu bị từ chối: '+w+'\n'):'')+
      (!a&&!w?'• Chưa chạy supabase-schema.sql, hoặc mất mạng.\n':'')+
      '\nApp vẫn chạy bình thường bằng dữ liệu trên máy này.');
  };
  return <span className="iconbtn" title={c.title} onClick={why} style={{cursor:status==='error'?'pointer':'default'}}>
    <i className={'ti '+c.icon} style={{color:c.color}}/></span>;
}

/* ================= App ================= */
/* Thanh nhập khoá quán: chỉ hiện khi máy này chưa có khoá.
   Không có khoá thì app vẫn chạy bằng dữ liệu của máy, chỉ là không đồng bộ với máy khác. */
function ClubKeyBar({cloud}){
  const [k,setK]=useState('');
  const [an,setAn]=useState(cloud!=='nokey');
  useEffect(()=>{setAn(cloud!=='nokey');},[cloud]);
  if(an)return null;
  const luu=()=>{ if(!k.trim())return; Cloud.saveKey(k); location.reload(); };
  return (
    <div style={{position:'fixed',left:0,right:0,bottom:0,zIndex:9999,background:'var(--card,#fff)',
      borderTop:'3px solid var(--red,#e5484d)',padding:'12px 16px',boxShadow:'0 -6px 24px rgba(0,0,0,.18)'}}>
      <div style={{maxWidth:640,margin:'0 auto'}}>
        <b style={{fontSize:14}}>🔑 Máy này chưa có khoá quán</b>
        <p className="hint" style={{margin:'4px 0 8px'}}>
          Chưa nhập khoá thì máy chạy riêng, không thấy order và khách của máy khác.
          Khoá nằm ở file <code>KHOA-QUAN.txt</code> trên máy chủ quán.
        </p>
        <div style={{display:'flex',gap:8}}>
          <input className="inp" style={{flex:1}} type="password" placeholder="Dán khoá quán vào đây"
            value={k} onChange={e=>setK(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')luu();}}/>
          <button className="btn pri" onClick={luu}>Lưu</button>
          <button className="btn" onClick={()=>setAn(true)}>Để sau</button>
        </div>
      </div>
    </div>
  );
}

function App(){
  const [staff,setStaff]=usePersist('ps.staff',SEED_STAFF);
  const [tables,setTables]=usePersist('ps.tables',SEED_TABLES);
  const [menu,setMenu]=usePersist('ps.menu',SEED_MENU);
  const [orders,setOrders]=usePersist('ps.orders',[]);
  const [shiftTasks,setShiftTasks]=usePersist('ps.shiftTasks',SEED_SHIFT_TASKS);
  const [taskLog,setTaskLog]=usePersist('ps.taskLog',{});
  const [training,setTraining]=usePersist('ps.training',SEED_TRAINING);
  const [trainProg,setTrainProg]=usePersist('ps.trainProg',{});
  const [schedule,setSchedule]=usePersist('ps.schedule',{});
  const [attend,setAttend]=usePersist('ps.attend',{});
  const [customers,setCustomers]=usePersist('ps.customers',SEED_CUSTOMERS);
  const [promos,setPromos]=usePersist('ps.promos',SEED_PROMOS);
  const [tiers,setTiers]=usePersist('ps.tiers',SEED_TIERS);
  const [tours,setTours]=usePersist('ps.tours',[]);
  const [feedback,setFeedback]=usePersist('ps.feedback',[]);
  const [penaltyRules,setPenaltyRules]=usePersist('ps.penaltyRules',SEED_PENALTY);
  const [violations,setViolations]=usePersist('ps.violations',[]);
  const [outfood,setOutfood]=usePersist('ps.outfood',SEED_OUTFOOD);
  const [inventory,setInventory]=usePersist('ps.inventory',[]);
  const [endTasks,setEndTasks]=usePersist('ps.endTasks',SEED_ENDTASKS);
  const [broadcasts,setBroadcasts]=usePersist('ps.broadcasts',[]);
  const [alerts,setAlerts]=usePersist('ps.alerts',[]);
  const [signups,setSignups]=usePersist('ps.signups',[]);
  const [results,setResults]=usePersist('ps.results',[]);
  const [bookings,setBookings]=usePersist('ps.bookings',[]);
  const [sessions,setSessions]=usePersist('ps.sessions',[]);
  const [highlights,setHighlights]=usePersist('ps.highlights',[]);
  const [lockers,setLockers]=usePersist('ps.lockers',SEED_LOCKERS);
  const [cues,setCues]=usePersist('ps.cues',SEED_CUES);
  const [chotca,setChotca]=usePersist('ps.chotca',[]);
  const [maint,setMaint]=usePersist('ps.maint',SEED_MAINT);
  const [growth,setGrowth]=usePersist('ps.growth',SEED_GROWTH);
  const [fbSeen,setFbSeen]=usePersist('ps.fbSeen',0);
  const [meId,setMeId]=usePersist('ps.me',null);
  const [dark,setDark]=useState(()=>store.get('ps.dark',false)===true||localStorage.getItem('ps.dark')==='1');
  const [view,setView]=useState('order');
  const [toast,setToast]=useState(null);
  const [cloud,setCloud]=useState('off'); // off | syncing | synced | error

  useEffect(()=>{document.body.classList.toggle('dark',dark);store.set('ps.dark',dark);},[dark]);
  // Cập nhật dữ liệu mẫu khi cấu trúc đổi (prototype): giữ dữ liệu vận hành & chỉnh sửa của người dùng
  useEffect(()=>{
    const V=9;
    const cur=store.get('ps.seedVer',1);
    if(cur<V){
      if(cur<2){ // bỏ Phăng
        if(/[Pp]h[ăa]ng/.test(JSON.stringify(store.get('ps.training',[])))) setTraining(SEED_TRAINING);
      }
      // v3: bổ sung chương đào tạo mới (không ghi đè bản đã sửa), thêm field mới cho khách & nhân viên
      setTraining(prev=>{const titles=prev.map(c=>c.title);const add=SEED_TRAINING.filter(c=>!titles.includes(c.title));return add.length?[...prev,...add]:prev;});
      setCustomers(prev=>prev.map(c=>({vip:false,games:[],photo:'',note:'',...c})));
      setStaff(prev=>prev.map(s=>({rate:22000,...s,role:ROLE_KEYS.includes(s.role)?s.role:'staff'})));
      // v4: bàn có loại + giá, nâng lên 20 bàn (làm mới nếu bàn cũ chưa có giá)
      if(cur<4){ if(store.get('ps.tables',[]).some(t=>t.price==null)) setTables(SEED_TABLES); }
      // v5: khuyến mãi có khung giờ — thêm ưu đãi 8h–15h, bỏ seed "Giờ vàng buổi trưa" cũ (đã bị thay)
      if(cur<5) setPromos(prev=>{
        const rest=prev.filter(p=>p.title!=='Giờ vàng buổi trưa');
        return rest.some(p=>p.id===PROMO_DAYTIME.id)?rest:[PROMO_DAYTIME,...rest];
      });
      // v6: bỏ phần kiểm tra nhanh ở chương "Hướng tăng doanh số" (chỉ để tham khảo)
      if(cur<6) setTraining(prev=>prev.map(c=>c.title==='Hướng tăng doanh số (Quản lý)'?{...c,quiz:[]}:c));
      // v7: thêm tài khoản Tổ chức giải mẫu (nếu chưa có ai giữ vai này)
      if(cur<7) setStaff(prev=>prev.some(s=>s.role==='organizer')?prev:[...prev,{id:'u_'+uid(),name:'Đỗ Minh Giải',role:'organizer',rate:25000}]);
      // v8: món có giá — chuyển items từ chuỗi sang {name,price}; lấy giá seed nếu trùng tên
      if(cur<8) setMenu(prev=>{
        const seedPrice=(n)=>priceOfItem(SEED_MENU,n);
        return (prev||[]).map(g=>({...g,items:(g.items||[]).map(it=>typeof it==='string'?{name:it,price:seedPrice(it)}:it)}));
      });
      // v9: hạng khách theo giờ chơi — khách cũ suy ra giờ từ điểm đã tích (10đ/giờ)
      if(cur<9) setCustomers(prev=>prev.map(normCust));
      store.set('ps.seedVer',V);
    }
  },[]);
  // Setter có đồng bộ cloud: cập nhật state rồi đẩy thay đổi lên Supabase (no-op nếu cloud tắt)
  const cloudArr=(rawSet,table)=>(updater)=>rawSet(prev=>{
    const next=typeof updater==='function'?updater(prev):updater;
    Cloud.syncArray(table,prev,next); return next;
  });
  const cloudKv=(rawSet,key)=>(updater)=>rawSet(prev=>{
    const next=typeof updater==='function'?updater(prev):updater;
    Cloud.setKv(key,next); return next;
  });
  const setOrdersC=cloudArr(setOrders,'ps_orders');
  const setFeedbackC=cloudArr(setFeedback,'ps_feedback');
  const setCustomersC=cloudArr(setCustomers,'ps_customers');
  const setBroadcastsC=cloudArr(setBroadcasts,'ps_broadcasts');
  const setAlertsC=cloudArr(setAlerts,'ps_alerts');
  const setToursC=cloudArr(setTours,'ps_tours');
  const setSignupsC=cloudArr(setSignups,'ps_signups');
  const setResultsC=cloudArr(setResults,'ps_results');
  const setBookingsC=cloudArr(setBookings,'ps_bookings');
  const setSessionsC=cloudArr(setSessions,'ps_sessions');
  const setHighlightsC=cloudArr(setHighlights,'ps_highlights');
  const setLockersC=cloudArr(setLockers,'ps_lockers');
  const setCuesC=cloudArr(setCues,'ps_cues');
  const setChotcaC=cloudArr(setChotca,'ps_chotca');
  const setMaintC=cloudArr(setMaint,'ps_maint');
  const setGrowthC=cloudArr(setGrowth,'ps_growth');
  const setMenuC=cloudKv(setMenu,'menu');
  const setTablesC=cloudKv(setTables,'tables');
  const setPromosC=cloudKv(setPromos,'promos');
  const setTiersC=cloudKv(setTiers,'tiers');

  // Giữ giá trị mới nhất cho bước seed cloud (tránh dùng giá trị cũ lúc mount)
  const latest=useRef({});
  latest.current={menu,tables,promos,tiers,customers,tours,maint,growth,lockers,cues};

  // Kết nối cloud: tải dữ liệu chung + lắng nghe realtime. Lỗi/chưa chạy SQL → chạy cục bộ.
  useEffect(()=>{
    if(!Cloud.init()){setCloud(Cloud.hasKey()?'off':'nokey');return;}
    Cloud.onStatus=setCloud;
    let subs=[],alive=true,poll=null;
    (async()=>{
      Cloud.setStatus('syncing');
      try{
        await Cloud.signIn(); // đăng nhập tài khoản quán (khoá quán = mật khẩu) để RLS mở quyền
        const d=await Cloud.bootstrap();
        if(!alive)return;
        const L=latest.current;
        setOrders(d.orders||[]);
        setFeedback(d.feedback||[]);
        setBroadcasts(d.broadcasts||[]);
        setAlerts(d.alerts||[]);
        setSignups(d.signups||[]);
        setResults(d.results||[]);
        setBookings(d.bookings||[]);
        setSessions(d.sessions||[]);
        if(d.highlights)setHighlights(d.highlights); // null = chưa có bảng ps_highlights → giữ dữ liệu cục bộ
        if(d.lockers){ if(d.lockers.length)setLockers(d.lockers); else (L.lockers||[]).forEach(x=>Cloud.upsertRow('ps_lockers',x)); }
        if(d.cues){ if(d.cues.length)setCues(d.cues); else (L.cues||[]).forEach(x=>Cloud.upsertRow('ps_cues',x)); }
        if(d.chotca)setChotca(d.chotca); // null = quán chưa chạy SQL tạo ps_chotca → giữ bản cục bộ
        if(d.maint&&d.maint.length)setMaint(d.maint); else (L.maint||[]).forEach(x=>Cloud.upsertRow('ps_maint',x));
        if(d.growth&&d.growth.length)setGrowth(d.growth); else (L.growth||[]).forEach(x=>Cloud.upsertRow('ps_growth',x));
        if(d.customers&&d.customers.length)setCustomers(d.customers.map(normCust));
        else (L.customers||[]).forEach(c=>Cloud.upsertRow('ps_customers',c));
        if(d.tours&&d.tours.length)setTours(d.tours);
        else (L.tours||[]).forEach(t=>Cloud.upsertRow('ps_tours',t));
        if(d.kv.menu){
          // Menu trên cloud có thể còn định dạng cũ (chuỗi, chưa giá) → nâng cấp rồi đẩy lại lên cloud
          const fixed=normMenu(d.kv.menu);
          setMenu(fixed);
          if(menuIsOld(d.kv.menu))Cloud.setKv('menu',fixed);
        } else Cloud.setKv('menu',L.menu);
        if(d.kv.tables)setTables(d.kv.tables); else Cloud.setKv('tables',L.tables);
        if(d.kv.promos)setPromos(d.kv.promos); else Cloud.setKv('promos',L.promos);
        if(d.kv.tiers)setTiers(d.kv.tiers); else Cloud.setKv('tiers',L.tiers);
        Cloud.setStatus('synced');
        subs.push(Cloud.subscribe('ps_orders',p=>applyRealtime(setOrders,p)));
        subs.push(Cloud.subscribe('ps_feedback',p=>applyRealtime(setFeedback,p)));
        subs.push(Cloud.subscribe('ps_customers',p=>applyRealtime(setCustomers,p,normCust)));
        subs.push(Cloud.subscribe('ps_broadcasts',p=>applyRealtime(setBroadcasts,p)));
        subs.push(Cloud.subscribe('ps_alerts',p=>applyRealtime(setAlerts,p)));
        subs.push(Cloud.subscribe('ps_tours',p=>applyRealtime(setTours,p)));
        subs.push(Cloud.subscribe('ps_signups',p=>applyRealtime(setSignups,p)));
        subs.push(Cloud.subscribe('ps_results',p=>applyRealtime(setResults,p)));
        subs.push(Cloud.subscribe('ps_bookings',p=>applyRealtime(setBookings,p)));
        subs.push(Cloud.subscribe('ps_sessions',p=>applyRealtime(setSessions,p)));
        if(d.highlights)subs.push(Cloud.subscribe('ps_highlights',p=>applyRealtime(setHighlights,p)));
        if(d.lockers)subs.push(Cloud.subscribe('ps_lockers',p=>applyRealtime(setLockers,p)));
        if(d.cues)subs.push(Cloud.subscribe('ps_cues',p=>applyRealtime(setCues,p)));
        if(d.chotca)subs.push(Cloud.subscribe('ps_chotca',p=>applyRealtime(setChotca,p)));
        subs.push(Cloud.subscribe('ps_maint',p=>applyRealtime(setMaint,p)));
        subs.push(Cloud.subscribe('ps_growth',p=>applyRealtime(setGrowth,p)));
        subs.push(Cloud.sb.channel('rt_ps_kv').on('postgres_changes',{event:'*',schema:'public',table:'ps_kv'},p=>{
          const row=p.new; if(!row||!row.k)return;
          if(row.k==='menu')setMenu(normMenu(row.v)); else if(row.k==='tables')setTables(row.v);
          else if(row.k==='promos')setPromos(row.v); else if(row.k==='tiers')setTiers(row.v);
        }).subscribe());
        // Từ khi bật khoá quán, kênh realtime không mang được khoá nên bị đóng.
        // Đồng bộ định kỳ thay thế: cứ 20 giây tải lại phần dùng chung giữa các máy.
        poll=setInterval(async()=>{
          if(document.hidden)return;
          try{
            const n=await Cloud.bootstrap();
            if(!alive)return;
            if(n.orders)setOrders(n.orders);
            if(n.feedback)setFeedback(n.feedback);
            if(n.broadcasts)setBroadcasts(n.broadcasts);
            if(n.alerts)setAlerts(n.alerts);
            if(n.signups)setSignups(n.signups);
            if(n.results)setResults(n.results);
            if(n.bookings)setBookings(n.bookings);
            if(n.sessions)setSessions(n.sessions);
            if(n.customers)setCustomers(n.customers.map(normCust));
            if(n.tours)setTours(n.tours);
            if(n.maint)setMaint(n.maint);
            if(n.growth)setGrowth(n.growth);
            if(n.highlights)setHighlights(n.highlights);
            if(n.lockers)setLockers(n.lockers);
            if(n.cues)setCues(n.cues);
            if(n.kv.menu)setMenu(normMenu(n.kv.menu));
            if(n.kv.tables)setTables(n.kv.tables);
            if(n.kv.promos)setPromos(n.kv.promos);
            if(n.kv.tiers)setTiers(n.kv.tiers);
          }catch(e){}
        },20000);
      }catch(e){ Cloud.enabled=false; Cloud.setStatus('error'); }
    })();
    return ()=>{alive=false;if(poll)clearInterval(poll);subs.forEach(s=>{try{Cloud.sb.removeChannel(s);}catch(e){}});};
  },[]);

  const flash=(m)=>{setToast(m);setTimeout(()=>setToast(null),2200);};

  const isCust=meId&&typeof meId==='string'&&meId.indexOf('c:')===0;
  const custMe=useMemo(()=>isCust?customers.find(c=>c.id===meId.slice(2)):null,[isCust,customers,meId]);
  const me=useMemo(()=>staff.find(s=>s.id===meId),[staff,meId]);
  const isManager=me&&me.role==='manager';
  const isCounter=me&&me.role==='counter';
  const pendingCount=orders.filter(o=>o.status==='pending').length;
  const myRole=isCounter?'counter':'staff';
  const openAlerts=alerts.filter(a=>a.status==='open'&&!alertExpired(a)&&alertFor(a,myRole)).length;
  const newBookings=bookings.filter(b=>b.status==='pending').length; // đặt bàn chờ duyệt
  const openTables=sessions.filter(x=>!x.endTs).length; // bàn đang chơi
  const newFb=feedback.filter(f=>f.ts>(fbSeen||0)).length; // góp ý mới cho quản lý
  const newHl=highlights.filter(h=>h.status==='pending').length; // yêu cầu cắt clip chờ xử lý
  const lockerAlerts=lockers.filter(l=>lockerBusy(l)&&l.dueDate&&daysLeft(l.dueDate)<0).length; // tủ quá hạn thuê

  // Quản lý: gom theo "quản lý cái gì" — bàn (thời gian thực) · tiền · khách · người · đồ&việc · danh mục
  const NAV_BY_ROLE={
    manager:['desk','biz','cust','hr','ops','setup'],
    staff:['desk','order','cue','tasks','train','attend'],
    counter:['counter','desk','cue','inventory','cust','attend'],
    organizer:['tours','cust','attend'], // tổ chức giải không cần đào tạo nhân viên
  };
  const DEFAULT_VIEW={manager:'biz',counter:'counter',staff:'desk',organizer:'tours'};
  // Về màn mặc định đúng vai khi đăng nhập
  useEffect(()=>{
    if(!meId)return; const m=staff.find(s=>s.id===meId); if(!m)return;
    setView(DEFAULT_VIEW[m.role]||'order'); // đăng nhập/mở lại → về đúng màn mặc định của vai
  },[meId]);
  // Tự xoá yêu cầu hết hạn (vd xếp bi quá 1 phút → coi như xong)
  useEffect(()=>{
    const t=setInterval(()=>setAlertsC(v=>{
      const keep=v.filter(a=>!alertExpired(a));
      return keep.length===v.length?v:keep;
    }),15000);
    return ()=>clearInterval(t);
  },[]);

  if(isCust){
    if(!custMe){ // hồ sơ khách bị xoá → đăng xuất
      return <Login staff={staff} onPick={setMeId} customers={customers} setCustomers={setCustomersC} onCust={setMeId} cloud={cloud}/>;
    }
    return <CustomerApp cust={custMe} tables={tables} menu={menu} orders={orders} setOrders={setOrdersC}
      promos={promos} tiers={tiers} lockers={lockers} customers={customers} setCustomers={setCustomersC} feedback={feedback} setFeedback={setFeedbackC}
      alerts={alerts} setAlerts={setAlertsC} tours={tours} signups={signups} setSignups={setSignupsC}
      bookings={bookings} setBookings={setBookingsC}
      highlights={highlights} setHighlights={setHighlightsC}
      broadcasts={broadcasts} cloud={cloud} dark={dark} setDark={setDark} onLogout={()=>setMeId(null)} flash={flash}/>;
  }
  if(!me) return <Login staff={staff} onPick={setMeId} customers={customers} setCustomers={setCustomersC} onCust={setMeId} cloud={cloud}/>;

  const shared={me,isManager,isCounter,staff,setStaff,tables,setTables:setTablesC,menu,setMenu:setMenuC,
    orders,setOrders:setOrdersC,shiftTasks,setShiftTasks,
    taskLog,setTaskLog,training,setTraining,trainProg,setTrainProg,schedule,setSchedule,attend,setAttend,
    customers,setCustomers:setCustomersC,promos,setPromos:setPromosC,tiers,setTiers:setTiersC,tours,setTours:setToursC,
    signups,setSignups:setSignupsC,results,setResults:setResultsC,bookings,setBookings:setBookingsC,
    sessions,setSessions:setSessionsC,maint,setMaint:setMaintC,growth,setGrowth:setGrowthC,
    highlights,setHighlights:setHighlightsC,lockers,setLockers:setLockersC,cues,setCues:setCuesC,
    chotca,setChotca:setChotcaC,
    feedback,setFeedback:setFeedbackC,penaltyRules,setPenaltyRules,
    violations,setViolations,outfood,setOutfood,inventory,setInventory,endTasks,setEndTasks,
    broadcasts,setBroadcasts:setBroadcastsC,alerts,setAlerts:setAlertsC,fbSeen,setFbSeen,cloud,flash};

  const NAV_DEF={
    order:{label:'Báo món',icon:'ti-glass-full',badge:pendingCount+openAlerts+newBookings},
    counter:{label:'Quầy',icon:'ti-cash-register',badge:pendingCount+openAlerts+newBookings},
    inventory:{label:'Kiểm kho',icon:'ti-box-seam'},
    cue:{label:'Gậy & tủ',icon:'ti-cricket',badge:lockerAlerts},
    tasks:{label:'Đầu việc',icon:'ti-checklist'},
    train:{label:'Đào tạo',icon:'ti-school'},
    attend:{label:'Chấm công',icon:'ti-clock-hour-4'},
    cust:{label:'Khách',icon:'ti-users',badge:isManager?newFb+newHl:0},
    tours:{label:'Giải đấu',icon:'ti-trophy'},
    desk:{label:'Bàn',icon:'ti-layout-grid',badge:openTables},
    biz:{label:'Doanh thu',icon:'ti-chart-line'},
    hr:{label:'Nhân sự',icon:'ti-id-badge-2'},
    ops:{label:'Vận hành',icon:'ti-checklist',badge:lockerAlerts},
    setup:{label:'Cài đặt',icon:'ti-settings'},
  };
  const navItems=(NAV_BY_ROLE[me.role]||NAV_BY_ROLE.staff).map(id=>({id,...NAV_DEF[id]}));
  const TITLES={order:['Báo món','Gửi order từ bàn về quầy'],counter:['Quầy phục vụ','Order · yêu cầu · đặt bàn'],
    inventory:['Kiểm kho','Đếm & theo dõi tồn hàng'],cue:['Gậy & tủ','Tủ gửi gậy của khách · cơ của quán'],tasks:['Đầu việc theo ca','Checklist việc quán sáng / tối'],
    train:['Đào tạo nhân viên','Học cách quán vận hành'],attend:['Chấm công','Lịch ca · giờ làm · lỗi phạt'],
    cust:['Khách hàng','Danh sách · hạng & quà · góp ý'],
    tours:['Tổ chức giải','Lịch giải · đăng ký · kết quả'],desk:['Bàn','Mở / tắt bàn & chốt bill'],
    biz:['Doanh thu','Sổ sách · tăng doanh số · KM · giải đấu'],
    hr:['Nhân sự','Ca làm · lương · nhân viên · đào tạo'],
    ops:['Vận hành quán','Đầu việc · gậy & tủ · kho · bảo trì'],
    setup:['Cài đặt quán','Thực đơn · bàn & giá · QR bàn']};
  const t=TITLES[view]||['',''];

  return (
    <div className="app">
      <ClubKeyBar cloud={cloud}/>
      {/* Sidebar desktop */}
      <aside className="side">
        <div className="brand"><div className="lic">🎱</div><div><b>PoolStaff</b><br/><small>Trợ lý quán bi-a</small></div></div>
        <nav className="nav">
          {navItems.map(n=>(
            <button key={n.id} className={view===n.id?'on':''} onClick={()=>setView(n.id)}>
              <i className={'ti '+n.icon}/>{n.label}{n.badge>0&&<span className="badge">{n.badge}</span>}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <div className="meline"><Avatar staff={me} size={34}/><div><div className="nm">{me.name}</div><div className="rl">{roleLabel(me.role)}</div></div></div>
          <button className="tgl" onClick={()=>setDark(!dark)}><i className={'ti '+(dark?'ti-sun':'ti-moon')}/>{dark?'Chế độ sáng':'Chế độ tối'}</button>
          <button className="tgl" onClick={()=>{if(confirm('Đăng xuất / đổi người dùng?'))setMeId(null);}}><i className="ti ti-logout"/>Đổi người dùng</button>
        </div>
      </aside>

      {/* Main */}
      <main className="main">
        <header className="topbar">
          <div><h1>{t[0]}</h1><div className="sub">{t[1]}</div></div>
          <div className="spacer"/>
          <CloudDot status={cloud}/>
          {!isManager&&<button className="iconbtn" onClick={()=>setView(isCounter?'counter':'order')} title="Order chờ & yêu cầu">
            <i className="ti ti-bell"/>{(pendingCount+openAlerts)>0&&<span className="dot">{pendingCount+openAlerts}</span>}
          </button>}
          <button className="iconbtn chi-hep" onClick={()=>setDark(!dark)} title={dark?'Chế độ sáng':'Chế độ tối'}>
            <i className={'ti '+(dark?'ti-sun':'ti-moon')}/>
          </button>
          <button className="iconbtn chi-hep" onClick={()=>{if(confirm('Đăng xuất / đổi người dùng?'))setMeId(null);}} title="Đăng xuất / đổi người dùng">
            <i className="ti ti-logout"/>
          </button>
        </header>
        <div className="content">
          {view==='order'&&<OrderView s={shared}/>}
          {view==='counter'&&<CounterView s={shared}/>}
          {view==='inventory'&&<InventoryView s={shared}/>}
          {view==='cue'&&<CueView s={shared}/>}
          {view==='tasks'&&<TasksView s={shared}/>}
          {view==='train'&&<TrainView s={shared}/>}
          {view==='attend'&&<AttendView s={shared}/>}
          {view==='cust'&&<CustView s={shared}/>}
          {view==='biz'&&isManager&&<BizView s={shared}/>}
          {view==='hr'&&isManager&&<HRView s={shared}/>}
          {view==='ops'&&isManager&&<OpsView s={shared}/>}
          {view==='setup'&&isManager&&<SetupView s={shared}/>}
          {view==='tours'&&<OrganizerView s={shared}/>}
          {view==='desk'&&<TablesView s={shared}/>}
        </div>
      </main>

      {/* Bottom nav mobile */}
      <nav className="bnav">
        {navItems.map(n=>(
          <button key={n.id} className={view===n.id?'on':''} onClick={()=>setView(n.id)}>
            <i className={'ti '+n.icon}/>{n.label}{n.badge>0&&<span className="bd">{n.badge}</span>}
          </button>
        ))}
      </nav>
      <Toast msg={toast}/>
    </div>
  );
}

/* ================= Login ================= */
function Login({staff,onPick,customers,setCustomers,onCust}){
  const [mode,setMode]=useState('pick'); // pick | cust
  const [phone,setPhone]=useState('');
  const [name,setName]=useState('');
  const [busy,setBusy]=useState(false);
  const custLogin=async()=>{
    const ph=phone.trim();
    if(ph.length<8){alert('Nhập số điện thoại hợp lệ');return;}
    const same=x=>(x||'').replace(/\s/g,'')===ph.replace(/\s/g,'');
    setBusy(true);
    try{
      // Ưu tiên hỏi cloud (máy khách không đọc được bảng khách, phải qua hàm riêng)
      const rec=await Cloud.custLogin(ph,name.trim());
      if(rec&&rec.id){
        setCustomers(v=>v.some(c=>c.id===rec.id)?v.map(c=>c.id===rec.id?{...c,...rec}:c):[rec,...v]);
        onCust('c:'+rec.id);return;
      }
    }catch(e){ /* chưa chạy SQL mới / mất mạng → dùng dữ liệu máy này */ }
    finally{ setBusy(false); }
    const found=customers.find(c=>same(c.phone));
    if(found){onCust('c:'+found.id);return;}
    const nm=name.trim()||('Khách '+ph.slice(-3));
    const nc={id:uid(),name:nm,phone:ph,points:0,hours:0,visits:0,vip:false,games:[],photo:'',note:'',rewards:[],history:[]};
    setCustomers(v=>[nc,...v]);
    onCust('c:'+nc.id);
  };
  return (
    <div className="loginwrap">
      <div className="loginbox">
        <div className="logohero">
          <div className="big">🎱</div>
          <h1>PoolStaff</h1>
          <p>{mode==='cust'?'Đăng nhập khách hàng':'Chọn tên bạn để bắt đầu ca làm'}</p>
        </div>
        {mode==='pick'?(
          <div>
            <div className="stafflist">
              {staff.map(s=>(
                <button key={s.id} className="staffpick" onClick={()=>onPick(s.id)}>
                  <Avatar staff={s} size={44}/>
                  <div style={{flex:1}}><div className="nm">{s.name}</div><div className="rl">{(ROLES[s.role]||ROLES.staff).icon} {roleLabel(s.role)}</div></div>
                  <i className="ti ti-chevron-right" style={{color:'var(--muted2)',fontSize:20}}/>
                </button>
              ))}
            </div>
            <button className="btn ghost block" style={{marginTop:14}} onClick={()=>setMode('cust')}><i className="ti ti-user-heart"/>Tôi là khách hàng</button>
          </div>
        ):(
          <div className="card">
            <p className="hint" style={{marginBottom:12}}>Nhập số điện thoại để vào đặt món & xem điểm. Máy sẽ tự nhớ cho lần sau.</p>
            <label className="fld"><span>Số điện thoại *</span><input className="inp" autoFocus value={phone} onChange={e=>setPhone(e.target.value)} placeholder="09xx xxx xxx" inputMode="tel" onKeyDown={e=>e.key==='Enter'&&custLogin()}/></label>
            <label className="fld"><span>Tên (nếu là khách mới)</span><input className="inp" value={name} onChange={e=>setName(e.target.value)} placeholder="Tên của bạn"/></label>
            <button className="btn block wide" onClick={custLogin} disabled={busy}><i className={'ti '+(busy?'ti-loader-2':'ti-login')}/>{busy?'Đang vào…':'Vào quán'}</button>
            <button className="btn ghost block" style={{marginTop:8}} onClick={()=>setMode('pick')}><i className="ti ti-arrow-left"/>Tôi là nhân viên</button>
          </div>
        )}
        <p className="hint" style={{textAlign:'center',marginTop:18}}>Bản demo — dữ liệu lưu trên máy này.</p>
      </div>
    </div>
  );
}

/* ================= 1. Order ================= */
function OrderView({s}){
  const {tables,menu,setMenu,orders,setOrders,me,promos,endTasks,alerts,setAlerts,bookings,setBookings,flash}=s;
  const [tab,setTab]=useState('new'); // new | queue | alerts | book
  const [endOpen,setEndOpen]=useState(false);
  const openAlerts=alerts.filter(a=>a.status==='open'&&!alertExpired(a)&&alertFor(a,'staff')).length;
  const pendBook=bookings.filter(b=>b.status==='pending').length;
  const [sel,setSel]=useState(null); // table id
  const [cart,setCart]=useState({}); // name -> qty
  const [note,setNote]=useState('');
  const [addGrp,setAddGrp]=useState(null); // group index adding item to
  const [newItem,setNewItem]=useState('');
  const [showPromo,setShowPromo]=useState(false);
  const livePromos=(promos||[]).filter(promoActive);
  const [editMenu,setEditMenu]=useState(false);
  const [newPrice,setNewPrice]=useState('');
  const addMenuItem=(gi)=>{const val=newItem.trim();if(!val)return;
    setMenu(v=>v.map((g,i)=>i===gi?{...g,items:g.items.some(x=>x.name===val)?g.items:[...g.items,{name:val,price:Number(newPrice)||0}]}:g));
    setNewItem('');setNewPrice('');setAddGrp(null);flash('Đã thêm "'+val+'" vào thực đơn');};
  const delMenuItem=(gi,name)=>{setMenu(v=>v.map((g,i)=>i===gi?{...g,items:g.items.filter(x=>x.name!==name)}:g));};

  const pendingByTable={};
  orders.filter(o=>o.status==='pending').forEach(o=>{pendingByTable[o.table]=(pendingByTable[o.table]||0)+1;});
  const cartCount=Object.values(cart).reduce((a,b)=>a+b,0);
  const cartTotal=Object.entries(cart).reduce((a,[n,q])=>a+q*priceOfItem(menu,n),0);
  const add=(n)=>setCart(c=>({...c,[n]:(c[n]||0)+1}));
  const dec=(n)=>setCart(c=>{const q=(c[n]||0)-1;const nc={...c};if(q<=0)delete nc[n];else nc[n]=q;return nc;});

  const send=()=>{
    if(!sel){flash('Chọn bàn trước đã');return;}
    if(cartCount===0){flash('Chưa chọn món nào');return;}
    const tbl=tables.find(t=>t.id===sel);
    const items=Object.entries(cart).map(([name,qty])=>({name,qty,price:priceOfItem(menu,name)}));
    const o={id:uid(),table:tbl.no,items,note:note.trim(),by:me.id,byName:me.name,status:'pending',ts:Date.now()};
    setOrders(v=>[o,...v]);
    setCart({});setNote('');setSel(null);
    flash('Đã gửi order bàn '+tbl.no+' về quầy 🔔');
    setTab('queue');
  };
  const serve=(id)=>setOrders(v=>v.map(o=>o.id===id?{...o,status:'done',doneTs:Date.now()}:o));
  const cancel=(id)=>{if(confirm('Huỷ order này?'))setOrders(v=>v.filter(o=>o.id!==id));};
  const pending=orders.filter(o=>o.status==='pending');
  const done=orders.filter(o=>o.status==='done').slice(0,12);

  return (
    <div>
      {livePromos.length>0&&(
        <div className="card" style={{marginBottom:14,padding:0,overflow:'hidden'}}>
          <button style={{display:'flex',alignItems:'center',gap:9,padding:'12px 15px',width:'100%',textAlign:'left'}} onClick={()=>setShowPromo(v=>!v)}>
            <span style={{fontSize:20}}>🎁</span>
            <b style={{flex:1,fontFamily:'"Baloo 2"',fontSize:14}}>{livePromos.length} khuyến mãi đang chạy</b>
            <i className={'ti '+(showPromo?'ti-chevron-up':'ti-chevron-down')} style={{color:'var(--muted)',fontSize:20}}/>
          </button>
          {showPromo&&<div style={{padding:'0 15px 12px'}}>
            {livePromos.map(p=>(
              <div key={p.id} style={{padding:'8px 0',borderTop:'1px solid var(--border)'}}>
                <div style={{display:'flex',gap:8,alignItems:'center'}}><b style={{fontSize:13.5}}>{p.title}</b>{p.percent>0&&<span className="chip a">-{p.percent}%</span>}</div>
                <div className="hint" style={{marginTop:2}}>{p.desc}</div>
              </div>
            ))}
          </div>}
        </div>
      )}
      <div className="seg">
        <button className={tab==='new'?'on':''} onClick={()=>setTab('new')}><i className="ti ti-plus"/>Tạo order</button>
        <button className={tab==='queue'?'on':''} onClick={()=>setTab('queue')}><i className="ti ti-clipboard-list"/>Quầy chờ {pending.length>0&&`(${pending.length})`}</button>
        <button className={tab==='alerts'?'on':''} onClick={()=>setTab('alerts')}><i className="ti ti-bell-ringing"/>Yêu cầu {openAlerts>0&&`(${openAlerts})`}</button>
        <button className={tab==='book'?'on':''} onClick={()=>setTab('book')}><i className="ti ti-calendar-event"/>Đặt bàn {pendBook>0&&`(${pendBook})`}</button>
      </div>

      {tab==='new'&&(
        <div>
          <button className="btn ghost block" style={{marginBottom:14}} onClick={()=>setEndOpen(true)}><i className="ti ti-broom"/>Khách chơi xong — dọn bàn</button>
          <div className="panel">
            <div className="panel-h"><i className="ti ti-layout-grid lead"/><b>Chọn bàn</b>{sel&&<span className="chip g">Bàn {tables.find(t=>t.id===sel).no}</span>}</div>
            <div className="panel-b">
              <div className="tablegrid">
                {tables.map(t=>(
                  <button key={t.id} className={'tbl'+(sel===t.id?' on':'')} onClick={()=>setSel(t.id)}>
                    {pendingByTable[t.no]&&<span className="pend">{pendingByTable[t.no]}</span>}
                    <span className="ty">Bàn</span><span className="no">{t.no}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="panel">
            <div className="panel-h"><i className="ti ti-glass-full lead"/><b>Chọn món</b>{cartCount>0&&<span className="chip a">{cartCount} món</span>}
              <button className={'btn sm '+(editMenu?'':'ghost')} onClick={()=>setEditMenu(v=>!v)}><i className={'ti '+(editMenu?'ti-check':'ti-pencil')}/>{editMenu?'Xong':'Sửa'}</button></div>
            <div className="panel-b">
              {editMenu&&<p className="hint" style={{marginBottom:8}}>Bấm ✕ để xóa món. Sửa giá ở Quản lý → Khác → Thực đơn.</p>}
              {menu.map((g,gi)=>(
                <div className="menugrp" key={g.grp}>
                  <div className="gh">{g.grp}</div>
                  <div className="mitems">
                    {g.items.map(it=>(
                      editMenu?(
                        <span key={it.name} className="mitem" style={{cursor:'default'}}>{it.name}<i className="ti ti-x" style={{fontSize:16,color:'var(--red)',cursor:'pointer'}} onClick={()=>delMenuItem(gi,it.name)}/></span>
                      ):(
                        <button key={it.name} className="mitem" onClick={()=>add(it.name)}>
                          {cart[it.name]>0&&<span className="q">{cart[it.name]}</span>}{it.name}
                          <em style={{fontStyle:'normal',fontSize:11,color:'var(--muted)',fontWeight:600}}>{fmtVnd(it.price)}</em>
                        </button>
                      )
                    ))}
                    {addGrp===gi?(
                      <span className="mitem" style={{padding:'4px 6px'}}>
                        <input className="inp" autoFocus value={newItem} onChange={e=>setNewItem(e.target.value)}
                          onKeyDown={e=>{if(e.key==='Enter')addMenuItem(gi);if(e.key==='Escape'){setAddGrp(null);setNewItem('');}}}
                          placeholder={'Món mới…'} style={{padding:'6px 9px',width:100,height:30}}/>
                        <input className="inp" type="number" value={newPrice} onChange={e=>setNewPrice(e.target.value)}
                          onKeyDown={e=>{if(e.key==='Enter')addMenuItem(gi);}} placeholder="Giá" style={{padding:'6px 9px',width:70,height:30}}/>
                        <i className="ti ti-check" style={{fontSize:18,color:'var(--grn)',cursor:'pointer'}} onClick={()=>addMenuItem(gi)}/>
                        <i className="ti ti-x" style={{fontSize:17,color:'var(--red)',cursor:'pointer'}} onClick={()=>{setAddGrp(null);setNewItem('');setNewPrice('');}}/>
                      </span>
                    ):(
                      <button className="mitem" style={{borderStyle:'dashed',color:'var(--muted)'}} onClick={()=>{setAddGrp(gi);setNewItem('');}}>
                        <i className="ti ti-plus" style={{fontSize:16}}/>Thêm món
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {cartCount>0&&(
            <div className="panel">
              <div className="panel-h"><i className="ti ti-shopping-cart lead"/><b>Đơn đang tạo</b></div>
              <div className="panel-b">
                {Object.entries(cart).map(([n,q])=>(
                  <div className="row" key={n}>
                    <div style={{flex:1,minWidth:0}}><div style={{fontWeight:600}}>{n}</div>
                      <div className="hint">{fmtVnd(priceOfItem(menu,n))} × {q} = <b>{fmtVnd(q*priceOfItem(menu,n))}</b></div></div>
                    <div className="stepper">
                      <button onClick={()=>dec(n)}>−</button><b>{q}</b><button onClick={()=>add(n)}>+</button>
                    </div>
                  </div>
                ))}
                <div className="row" style={{borderTop:'2px solid var(--border)'}}>
                  <span style={{flex:1,fontWeight:700}}>Tổng tiền đồ</span>
                  <b style={{fontFamily:'"Baloo 2"',fontSize:18,color:'var(--g)'}}>{fmtVnd(cartTotal)}</b>
                </div>
                <label className="fld" style={{marginTop:12}}><span>Ghi chú (không đá, ít đường…)</span>
                  <input className="inp" value={note} onChange={e=>setNote(e.target.value)} placeholder="Tuỳ chọn"/></label>
              </div>
            </div>
          )}

          <div className="cartbar">
            <button className="btn wide block" onClick={send} disabled={!sel||cartCount===0}>
              <i className="ti ti-send"/>Gửi về quầy{sel?` · Bàn ${tables.find(t=>t.id===sel).no}`:''}{cartCount>0?` · ${cartCount} món · ${fmtVnd(cartTotal)}`:''}
            </button>
          </div>
        </div>
      )}

      {tab==='queue'&&(
        <div>
          {pending.length===0&&done.length===0&&<Empty icon="ti-clipboard-off" text="Chưa có order nào. Tạo order ở tab bên."/>}
          {pending.length>0&&<div style={{fontSize:13,fontWeight:700,color:'var(--amber)',margin:'2px 2px 10px'}}><i className="ti ti-flame"/> Đang chờ ({pending.length})</div>}
          {pending.map(o=><OrderCard key={o.id} o={o} onServe={serve} onCancel={cancel}/>)}
          {done.length>0&&<div style={{fontSize:13,fontWeight:700,color:'var(--muted)',margin:'16px 2px 10px'}}>Đã phục vụ</div>}
          {done.map(o=><OrderCard key={o.id} o={o} done/>)}
        </div>
      )}
      {tab==='alerts'&&<AlertsPanel alerts={alerts} setAlerts={setAlerts} me={me} role="staff" flash={flash}/>}
      {tab==='book'&&<BookingsPanel bookings={bookings} setBookings={setBookings} me={me} flash={flash}/>}
      {endOpen&&<EndTableModal tables={tables} endTasks={endTasks} onClose={()=>setEndOpen(false)} flash={flash}/>}
    </div>
  );
}
function EndTableModal({tables,endTasks,onClose,flash}){
  const [sel,setSel]=useState(null);
  const [done,setDone]=useState({});
  const tbl=tables.find(t=>t.id===sel);
  const toggle=(id)=>setDone(v=>({...v,[id]:!v[id]}));
  const doneCount=endTasks.filter(t=>done[t.id]).length;
  const allDone=endTasks.length>0&&doneCount===endTasks.length;
  const finish=()=>{flash('Đã dọn xong bàn '+tbl.no+' ✓');onClose();};
  return (
    <Modal title="Khách chơi xong — dọn bàn" onClose={onClose}
      foot={sel&&<button className="btn block wide" onClick={finish} disabled={!allDone}><i className="ti ti-check"/>{allDone?`Hoàn tất bàn ${tbl.no}`:`Còn ${endTasks.length-doneCount} việc`}</button>}>
      {!sel?(
        <div>
          <p className="hint" style={{marginBottom:10}}>Chọn bàn khách vừa chơi xong:</p>
          <div className="tablegrid">
            {tables.map(t=>(
              <button key={t.id} className="tbl" onClick={()=>setSel(t.id)}><span className="ty">Bàn</span><span className="no">{t.no}</span></button>
            ))}
          </div>
        </div>
      ):(
        <div>
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:12}}>
            <span className="chip g" style={{fontSize:13,padding:'5px 12px'}}>Bàn {tbl.no} · {tbl.type}</span>
            <div className="spacer" style={{flex:1}}/>
            <button className="btn ghost sm" onClick={()=>{setSel(null);setDone({});}}><i className="ti ti-arrow-left"/>Đổi bàn</button>
          </div>
          <div className={'prog'+(allDone?' full':'')} style={{marginBottom:12}}><i style={{width:(endTasks.length?doneCount/endTasks.length*100:0)+'%'}}/></div>
          {endTasks.map(t=>(
            <div className="row" key={t.id}>
              <div className={'chk'+(done[t.id]?' done':'')} onClick={()=>toggle(t.id)}>{done[t.id]&&<i className="ti ti-check"/>}</div>
              <div style={{flex:1,fontWeight:600,textDecoration:done[t.id]?'line-through':'none',color:done[t.id]?'var(--muted)':'var(--ink)'}}>{t.text}</div>
            </div>
          ))}
          {endTasks.length===0&&<Empty icon="ti-clipboard-off" text="Chưa có việc dọn bàn. QL thêm ở mục Quản lý → Bàn."/>}
        </div>
      )}
    </Modal>
  );
}
/* Yêu cầu tại bàn — khách gọi NV / NV báo quầy tắt tiền giờ */
function AlertsPanel({alerts,setAlerts,me,role,flash}){
  const [,tick]=useState(0);
  useEffect(()=>{const t=setInterval(()=>tick(x=>x+1),10000);return ()=>clearInterval(t);},[]); // làm mới "N phút" & ẩn cái hết hạn
  const mine=alerts.filter(a=>alertFor(a,role));
  const open=mine.filter(a=>a.status==='open'&&!alertExpired(a)).sort((a,b)=>b.ts-a.ts);
  const done=mine.filter(a=>a.status==='done').sort((a,b)=>b.ts-a.ts).slice(0,8);
  const resolve=(id)=>setAlerts(v=>v.map(a=>a.id===id?{...a,status:'done',doneTs:Date.now(),doneBy:me.name}:a));
  const card=(a,isDone)=>{
    const k=ALERT_KINDS[a.kind]||{label:a.kind,icon:'🔔',chip:'',hint:''};
    const ago=Math.max(0,Math.round((Date.now()-a.ts)/60000));
    return (
      <div className={'ocard'+(isDone?' done':'')} key={a.id} style={!isDone?{borderLeftColor:'var(--red)'}:null}>
        <div className="oh">
          <span style={{fontSize:20}}>{k.icon}</span>
          <span className="otbl">Bàn {a.table}</span>
          <div className="spacer" style={{flex:1}}/>
          {!isDone&&<span className="chip a"><i className="ti ti-clock"/>{ago===0?'vừa xong':ago+' phút'}</span>}
          {isDone&&<span className="chip gr"><i className="ti ti-check"/>đã xử lý</span>}
        </div>
        <div style={{fontWeight:600,fontSize:13.5,marginBottom:2}}>{k.label}</div>
        <div className="hint" style={{marginBottom:9}}>{k.hint} · báo bởi {a.byName}{a.source==='customer'?' (khách)':''}</div>
        {!isDone&&<button className="btn sm block" onClick={()=>resolve(a.id)}><i className="ti ti-check"/>Đã xử lý</button>}
        {isDone&&a.doneBy&&<div className="hint">xong bởi {a.doneBy}</div>}
      </div>
    );
  };
  return (
    <div>
      {open.length===0&&done.length===0&&<Empty icon="ti-bell-off" text="Chưa có yêu cầu nào từ bàn"/>}
      {open.length>0&&<div style={{fontSize:13,fontWeight:700,color:'var(--red)',margin:'2px 2px 10px'}}><i className="ti ti-bell-ringing"/> Cần xử lý ({open.length})</div>}
      {open.map(a=>card(a,false))}
      {done.length>0&&<div style={{fontSize:13,fontWeight:700,color:'var(--muted)',margin:'16px 2px 10px'}}>Đã xử lý</div>}
      {done.map(a=>card(a,true))}
    </div>
  );
}
/* ===== Phiên bàn: mở → tắt → chốt bill (nguồn doanh số) ===== */
const dayKey=(ts)=>{const d=new Date(ts);return d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());};
// Tiền đồ của bàn trong khoảng thời gian phiên
const sessionItems=(orders,tableNo,startTs,endTs)=>orders.filter(o=>o.table===tableNo&&o.ts>=startTs&&o.ts<=(endTs||Date.now()));
const itemsTotal=(list)=>list.reduce((a,o)=>a+(o.items||[]).reduce((x,i)=>x+(Number(i.price)||0)*(Number(i.qty)||0),0),0);
// Tính tiền 1 phiên (làm tròn phút lên, tính theo giờ lẻ). discPct = % giảm tiền bàn theo hạng khách.
function billOf(se,orders,nowTs,discPct){
  const end=se.endTs||nowTs||Date.now();
  const mins=Math.max(1,Math.round((end-se.startTs)/60000));
  const hours=mins/60;
  const tableAmt=Math.round(hours*(Number(se.price)||0));
  const os=sessionItems(orders,se.tableNo,se.startTs,se.endTs);
  const itemAmt=itemsTotal(os);
  const pct=Number(discPct)||0;
  const disc=Math.round(tableAmt*pct/100);
  return {mins,hours,tableAmt,itemAmt,discPct:pct,disc,total:tableAmt+itemAmt-disc,orders:os};
}
function TablesView({s}){
  const {tables,sessions,setSessions,orders,me,customers,setCustomers,tiers,flash}=s;
  const [,tick]=useState(0);
  useEffect(()=>{const t=setInterval(()=>tick(x=>x+1),30000);return ()=>clearInterval(t);},[]);
  const [bill,setBill]=useState(null); // session đang chốt
  const openOf=(no)=>sessions.find(x=>x.tableNo===no&&!x.endTs);
  const openTable=(t)=>{
    if(openOf(t.no)){flash('Bàn '+t.no+' đang mở rồi');return;}
    setSessions(v=>[{id:uid(),tableNo:t.no,tableType:t.type,price:Number(t.price)||0,startTs:Date.now(),endTs:null,by:me.id,byName:me.name},...v]);
    flash('Đã mở bàn '+t.no+' — bắt đầu tính giờ ⏱️');
  };
  const closeTable=(se)=>setBill(se);
  const confirmBill=(se,custId)=>{
    const cu=customers.find(c=>c.id===custId);
    const b=billOf(se,orders,null,cu?tierPct(tiers,cu.hours):0);
    setSessions(v=>v.map(x=>x.id===se.id?{...x,endTs:Date.now(),mins:b.mins,tableAmt:b.tableAmt,itemAmt:b.itemAmt,
      discPct:b.discPct,disc:b.disc,total:b.total,
      custId:custId||null,custName:cu?cu.name:'',closedBy:me.name}:x));
    setBill(null);
    flash('Đã chốt bàn '+se.tableNo+' · '+fmtVnd(b.total)+' ✓');
    if(cu)award(cu,b.mins,se.tableNo);
  };
  // Cộng giờ chơi + điểm cho khách quen; đủ mốc giờ thì lên hạng & tặng quà 1 lần
  const award=(cu,mins,tableNo)=>{
    const addH=Math.round((mins/60)*10)/10;
    const pts=Math.round(addH*(Number(tiers.ptsPerHour)||0));
    const before=tierOf(tiers,cu.hours||0);
    const newH=Math.round(((cu.hours||0)+addH)*10)/10;
    const after=tierOf(tiers,newH);
    const up=after&&(!before||after.id!==before.id);
    const gift=up&&after.gift?[{id:uid(),label:after.gift,tier:after.name,ts:Date.now(),used:false}]:[];
    setCustomers(v=>v.map(x=>x.id!==cu.id?x:{...x,
      hours:newH,points:Math.max(0,(x.points||0)+pts),visits:(x.visits||0)+1,
      rewards:[...gift,...(x.rewards||[])],
      history:[{delta:pts,reason:'Chơi '+minToHM(mins)+' · bàn '+tableNo,by:me.name,ts:Date.now()},
        ...(up?[{delta:0,reason:'🎉 Lên hạng '+after.name+(after.gift?' — tặng '+after.gift:''),by:me.name,ts:Date.now()+1}]:[]),
        ...(x.history||[])]}));
    setTimeout(()=>flash(up
      ?'🎉 '+cu.name+' lên hạng '+after.name+(after.gift?' — tặng '+after.gift:'')
      :'+'+pts+' điểm · '+cu.name+' đã chơi '+fmtHours(newH)),1400);
  };
  const openCount=sessions.filter(x=>!x.endTs).length;
  const todayRev=sessions.filter(x=>x.endTs&&dayKey(x.endTs)===today()).reduce((a,x)=>a+(x.total||0),0);
  return (
    <div>
      <div className="grid-stat">
        <div className="stat"><div className="ic g"><i className="ti ti-player-play"/></div><div className="n">{openCount}/{tables.length}</div><div className="l">Bàn đang chơi</div></div>
        <div className="stat"><div className="ic gr"><i className="ti ti-cash"/></div><div className="n" style={{fontSize:20}}>{fmtVnd(todayRev)}</div><div className="l">Doanh số hôm nay</div></div>
      </div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-layout-grid lead"/><b>Sơ đồ bàn</b><span className="hint">bấm để mở / chốt</span></div>
        <div className="panel-b">
          <div className="tablegrid">
            {tables.slice().sort((a,b)=>a.no-b.no).map(t=>{
              const se=openOf(t.no);
              const b=se?billOf(se,orders):null;
              return (
                <button key={t.id} className={'tbl'+(se?' on':'')} onClick={()=>se?closeTable(se):openTable(t)}
                  style={se?{borderColor:'var(--grn)',background:'var(--grn-lt)'}:null}>
                  <span className="ty">{t.type}</span><span className="no">{t.no}</span>
                  {se
                    ? <span style={{fontSize:10,fontWeight:700,color:'var(--grn)'}}>{minToHM(b.mins)}</span>
                    : <span style={{fontSize:9.5,color:'var(--muted2)'}}>trống</span>}
                </button>
              );
            })}
          </div>
          <p className="hint" style={{marginTop:10}}>Bàn xanh = đang chơi (kèm giờ đã chơi). Bấm vào bàn xanh để chốt bill.</p>
        </div>
      </div>
      {bill&&<BillModal se={bill} orders={orders} customers={customers} tiers={tiers} onClose={()=>setBill(null)} onConfirm={confirmBill}/>}
    </div>
  );
}
function BillModal({se,orders,customers,tiers,onClose,onConfirm}){
  const [custId,setCustId]=useState(se.custId||'');
  const cu=customers.find(c=>c.id===custId);
  const tier=cu?tierOf(tiers,cu.hours):null;
  const b=billOf(se,orders,null,cu?tierPct(tiers,cu.hours):0);
  const addH=Math.round((b.mins/60)*10)/10;
  const gainPts=Math.round(addH*(Number(tiers.ptsPerHour)||0));
  const nx=cu?nextTier(tiers,(cu.hours||0)+addH):null;
  const lines={};
  b.orders.forEach(o=>(o.items||[]).forEach(i=>{
    const k=i.name;lines[k]=lines[k]||{name:i.name,price:Number(i.price)||0,qty:0};lines[k].qty+=Number(i.qty)||0;}));
  return (
    <Modal title={'Chốt bill bàn '+se.tableNo} onClose={onClose}
      foot={<button className="btn block wide" onClick={()=>onConfirm(se,custId)}><i className="ti ti-check"/>Chốt bill · {fmtVnd(b.total)}</button>}>
      <div className="card" style={{background:'var(--bg)',marginBottom:12}}>
        <div className="row" style={{padding:'6px 2px'}}><span style={{flex:1}} className="hint">Mở bàn lúc</span><b>{new Date(se.startTs).toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'})}</b></div>
        <div className="row" style={{padding:'6px 2px'}}><span style={{flex:1}} className="hint">Thời gian chơi</span><b>{minToHM(b.mins)}</b></div>
        <div className="row" style={{padding:'6px 2px'}}><span style={{flex:1}} className="hint">Tiền bàn ({b.hours.toFixed(2)}h × {fmtVnd(se.price)})</span><b>{fmtVnd(b.tableAmt)}</b></div>
      </div>
      <div style={{fontWeight:700,fontSize:13.5,marginBottom:8}}>🧋 Đồ đã gọi</div>
      {Object.keys(lines).length===0&&<p className="hint">Bàn này chưa gọi đồ.</p>}
      {Object.values(lines).map(l=>(
        <div className="row" key={l.name} style={{padding:'7px 2px'}}>
          <div style={{flex:1,minWidth:0}}><div style={{fontWeight:600,fontSize:13}}>{l.name}</div><div className="hint">{fmtVnd(l.price)} × {l.qty}</div></div>
          <b>{fmtVnd(l.price*l.qty)}</b>
        </div>
      ))}
      <div className="row" style={{padding:'7px 2px',borderTop:'1px solid var(--border)'}}><span style={{flex:1}} className="hint">Tổng tiền đồ</span><b>{fmtVnd(b.itemAmt)}</b></div>
      {b.disc>0&&<div className="row" style={{padding:'7px 2px'}}>
        <span style={{flex:1}} className="hint">Giảm hạng {tier?tier.icon+' '+tier.name:''} (−{b.discPct}% tiền bàn)</span>
        <b style={{color:'var(--grn)'}}>−{fmtVnd(b.disc)}</b></div>}
      <div className="row" style={{padding:'10px 2px',borderTop:'2px solid var(--border)'}}>
        <span style={{flex:1,fontWeight:700,fontSize:15}}>TỔNG CỘNG</span>
        <b style={{fontFamily:'"Baloo 2"',fontSize:22,color:'var(--g)'}}>{fmtVnd(b.total)}</b>
      </div>
      <label className="fld" style={{marginTop:10}}><span>Gắn khách quen (để tích giờ, điểm & giảm giá theo hạng)</span>
        <select className="inp" value={custId} onChange={e=>setCustId(e.target.value)}>
          <option value="">— Khách vãng lai —</option>
          {customers.map(c=><option key={c.id} value={c.id}>{c.name}{c.phone?' · '+c.phone:''}</option>)}
        </select></label>
      {cu&&<div className="card" style={{background:'var(--bg)'}}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
          <TierChip t={tier}/><span className="hint">đã chơi {fmtHours(cu.hours)}</span>
        </div>
        <div className="hint">Chốt bill này: <b style={{color:'var(--grn)'}}>+{fmtHours(addH)}</b> và <b style={{color:'var(--grn)'}}>+{gainPts} điểm</b>
          {nx?<> · còn {fmtHours(Math.max(0,(Number(nx.hours)||0)-((cu.hours||0)+addH)))} nữa lên {nx.icon} {nx.name}</>:<> · đã đạt hạng cao nhất</>}</div>
      </div>}
    </Modal>
  );
}

/* Khách đặt bàn trước — quán duyệt */
const BK_ST={pending:{label:'Chờ duyệt',chip:'a'},confirmed:{label:'Đã xác nhận',chip:'gr'},rejected:{label:'Đã từ chối',chip:'r'}};
function BookingsPanel({bookings,setBookings,me,flash}){
  const pending=bookings.filter(b=>b.status==='pending').sort((a,b)=>a.ts-b.ts);
  const rest=bookings.filter(b=>b.status!=='pending').sort((a,b)=>b.ts-a.ts).slice(0,10);
  const decide=(id,status)=>{
    let reason='';
    if(status==='rejected'){ reason=prompt('Lý do từ chối (khách sẽ thấy):','Khung giờ đó đã kín bàn')||''; }
    setBookings(v=>v.map(b=>b.id===id?{...b,status,decidedTs:Date.now(),decidedBy:me.name,reason}:b));
    flash(status==='confirmed'?'Đã xác nhận đặt bàn ✓':'Đã từ chối đặt bàn');
  };
  const card=(b)=>{
    const st=BK_ST[b.status]||BK_ST.pending;
    return (
      <div className={'ocard'+(b.status!=='pending'?' done':'')} key={b.id}
        style={b.status==='pending'?{borderLeftColor:'var(--blue)'}:null}>
        <div className="oh">
          <span style={{fontSize:20}}>📅</span>
          <span className="otbl">{fmtDateVN(b.date)} · {b.time}</span>
          <div className="spacer" style={{flex:1}}/>
          <span className={'chip '+st.chip}>{st.label}</span>
        </div>
        <div style={{fontWeight:600,fontSize:13.5,marginBottom:2}}>{b.custName} · {b.phone||'—'}</div>
        <div className="hint" style={{marginBottom:9}}>{b.tableType} · {b.hours} giờ · {b.people} người{b.note?' · '+b.note:''}</div>
        {b.status==='pending'?(
          <div className="rowbtns">
            <button className="btn sm" style={{flex:1}} onClick={()=>decide(b.id,'confirmed')}><i className="ti ti-check"/>Xác nhận</button>
            <button className="btn ghost sm" style={{flex:1}} onClick={()=>decide(b.id,'rejected')}><i className="ti ti-x"/>Từ chối</button>
          </div>
        ):(
          <div className="hint">{b.decidedBy?'bởi '+b.decidedBy:''}{b.reason?' · '+b.reason:''}</div>
        )}
      </div>
    );
  };
  return (
    <div>
      {pending.length===0&&rest.length===0&&<Empty icon="ti-calendar-off" text="Chưa có khách đặt bàn"/>}
      {pending.length>0&&<div style={{fontSize:13,fontWeight:700,color:'var(--blue)',margin:'2px 2px 10px'}}><i className="ti ti-calendar-plus"/> Chờ duyệt ({pending.length})</div>}
      {pending.map(card)}
      {rest.length>0&&<div style={{fontSize:13,fontWeight:700,color:'var(--muted)',margin:'16px 2px 10px'}}>Đã xử lý</div>}
      {rest.map(card)}
    </div>
  );
}
function OrderCard({o,onServe,onCancel,done}){
  const ago=Math.max(0,Math.round((Date.now()-o.ts)/60000));
  return (
    <div className={'ocard'+(done?' done':'')}>
      <div className="oh">
        <span className="otbl">Bàn {o.table}</span>
        {o.source==='customer'&&<span className="chip b"><i className="ti ti-user-heart"/>khách tự đặt</span>}
        <div className="spacer" style={{flex:1}}/>
        {!done&&<span className="chip a"><i className="ti ti-clock"/>{ago===0?'vừa xong':ago+' phút'}</span>}
        {done&&<span className="chip gr"><i className="ti ti-check"/>xong</span>}
      </div>
      <div className="oitems">
        {o.items.map((it,i)=><span className="oitag" key={i}><b>{it.qty}×</b> {it.name}</span>)}
      </div>
      {o.note&&<div className="oitag" style={{display:'inline-block',marginBottom:9}}><em>Ghi chú: {o.note}</em></div>}
      <div style={{display:'flex',alignItems:'center',gap:8}}>
        <span className="hint">bởi {o.byName}</span>
        <div className="spacer" style={{flex:1}}/>
        {!done&&<><button className="btn ghost sm" onClick={()=>onCancel(o.id)}><i className="ti ti-trash"/></button>
        <button className="btn sm" onClick={()=>onServe(o.id)}><i className="ti ti-check"/>Đã phục vụ</button></>}
      </div>
    </div>
  );
}

/* ================= 2. Tasks by shift ================= */
function TasksView({s}){
  const {shiftTasks,taskLog,setTaskLog,staff,me,setShiftTasks,flash}=s;
  const [shift,setShift]=useState(()=>new Date().getHours()<16?'morning':'evening');
  const [mineOnly,setMineOnly]=useState(false);
  const d=today();
  const log=taskLog[d]||{};
  const all=shiftTasks[shift]||[];
  const list=mineOnly?all.filter(t=>t.assignee===me.id):all;
  const toggle=(tid)=>{
    setTaskLog(v=>{
      const day={...(v[d]||{})};
      if(day[tid])delete day[tid];
      else day[tid]={by:me.id,byName:me.name,ts:Date.now()};
      return {...v,[d]:day};
    });
  };
  const doneCount=list.filter(t=>log[t.id]).length;
  const pct=list.length?Math.round(doneCount/list.length*100):0;
  const shortName=id=>{const u=staff.find(x=>x.id===id);return u?u.name.split(' ').slice(-1)[0]:'';};

  const [adding,setAdding]=useState(false);const [txt,setTxt]=useState('');const [newAssignee,setNewAssignee]=useState('');
  const addTask=()=>{if(!txt.trim())return;setShiftTasks(v=>({...v,[shift]:[...v[shift],{id:uid(),text:txt.trim(),assignee:newAssignee||null}]}));setTxt('');setNewAssignee('');setAdding(false);flash('Đã thêm việc');};
  const delTask=(tid)=>{if(confirm('Xoá đầu việc này?'))setShiftTasks(v=>({...v,[shift]:v[shift].filter(t=>t.id!==tid)}));};
  const setAssignee=(tid,uid2)=>setShiftTasks(v=>({...v,[shift]:v[shift].map(t=>t.id===tid?{...t,assignee:uid2||null}:t)}));

  return (
    <div>
      <div className="seg">
        {Object.entries(SHIFT_TIME).map(([k,v])=>(
          <button key={k} className={shift===k?'on':''} onClick={()=>setShift(k)}>{v.icon} Ca {v.label} · {v.start.slice(0,2)}–{v.end.slice(0,2)}h</button>
        ))}
      </div>

      <div className="card" style={{marginBottom:16}}>
        <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:10}}>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontFamily:'"Baloo 2"',fontSize:16}}>Tiến độ ca {SHIFT_TIME[shift].label}{mineOnly?' (việc của tôi)':''}</div>
            <div className="hint">Ngày {fmtDateVN(d)} · {doneCount}/{list.length} việc xong</div>
          </div>
          <div style={{fontFamily:'"Baloo 2"',fontSize:26,fontWeight:800,color:pct===100?'var(--grn)':'var(--g)'}}>{pct}%</div>
        </div>
        <div className={'prog'+(pct===100?' full':'')}><i style={{width:pct+'%'}}/></div>
      </div>

      <div className="panel">
        <div className="panel-h"><i className="ti ti-checklist lead"/><b>Đầu việc ca {SHIFT_TIME[shift].label}</b>
          <button className={'btn sm '+(mineOnly?'':'ghost')} onClick={()=>setMineOnly(v=>!v)}><i className="ti ti-user"/>Việc của tôi</button>
          <button className="btn ghost sm" onClick={()=>setAdding(a=>!a)}><i className="ti ti-plus"/>Thêm</button></div>
        <div className="panel-b" style={{paddingTop:4}}>
          {adding&&(
            <div style={{margin:'8px 0',display:'flex',gap:8,flexWrap:'wrap'}}>
              <input className="inp" style={{flex:1,minWidth:150}} autoFocus value={txt} onChange={e=>setTxt(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addTask()} placeholder="Nội dung đầu việc…"/>
              <select className="inp" style={{width:'auto'}} value={newAssignee} onChange={e=>setNewAssignee(e.target.value)}>
                <option value="">👥 Chung</option>
                {staff.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}
              </select>
              <button className="btn" onClick={addTask}>Lưu</button>
            </div>
          )}
          {list.length===0&&<Empty icon="ti-clipboard-off" text={mineOnly?'Không có việc nào giao cho bạn':'Chưa có đầu việc nào cho ca này'}/>}
          {list.map(t=>{
            const dn=log[t.id];
            return (
              <div className="row" key={t.id}>
                <div className={'chk'+(dn?' done':'')} onClick={()=>toggle(t.id)}>{dn&&<i className="ti ti-check"/>}</div>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:600,textDecoration:dn?'line-through':'none',color:dn?'var(--muted)':'var(--ink)'}}>{t.text}</div>
                  <div style={{display:'flex',alignItems:'center',gap:6,marginTop:3,flexWrap:'wrap'}}>
                    <select value={t.assignee||''} onChange={e=>setAssignee(t.id,e.target.value)}
                      style={{fontSize:11.5,fontWeight:600,padding:'2px 6px',borderRadius:7,border:'1px solid var(--border)',background:t.assignee?'var(--g-lt)':'var(--bg)',color:t.assignee?'var(--g-dk)':'var(--muted)'}}>
                      <option value="">👥 Chung</option>
                      {staff.map(u=><option key={u.id} value={u.id}>{shortName(u.id)}</option>)}
                    </select>
                    {dn&&<span className="hint"><i className="ti ti-user-check"/> {dn.byName} · {new Date(dn.ts).toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'})}</span>}
                  </div>
                </div>
                <button className="iconbtn" style={{padding:6,background:'none',border:0}} onClick={()=>delTask(t.id)}><i className="ti ti-trash" style={{fontSize:17}}/></button>
              </div>
            );
          })}
        </div>
      </div>
      <p className="hint" style={{textAlign:'center'}}>Ai cũng gán được việc cho người khác. Checklist reset mỗi ngày; ai tick được ghi tên & giờ.</p>
    </div>
  );
}

/* ================= 3. Training ================= */
function TrainView({s}){
  const {training,setTraining,trainProg,setTrainProg,me,isManager,staff,flash}=s;
  const [open,setOpen]=useState(null);
  const [view,setView]=useState('learn'); // learn | team (manager)
  const [editChap,setEditChap]=useState(null); // chapter obj, or 'new'
  const delChap=(id)=>{if(confirm('Xoá cả chương này?'))setTraining(v=>v.filter(c=>c.id!==id));};
  const saveChap=(chap)=>{
    setTraining(v=>{const exists=v.some(c=>c.id===chap.id);return exists?v.map(c=>c.id===chap.id?chap:c):[...v,chap];});
    setEditChap(null);flash('Đã lưu chương đào tạo');
  };
  const myProg=trainProg[me.id]||{done:{},quiz:{}};
  const chapDone=(ch)=>{
    // hoàn thành khi: đọc hết lesson + (nếu có quiz) đúng hết
    const lessonsOk=ch.lessons.every((_,i)=>myProg.done[ch.id+'_'+i]);
    const quizOk=!ch.quiz||ch.quiz.length===0||(myProg.quiz[ch.id]&&myProg.quiz[ch.id].pass);
    return lessonsOk&&quizOk;
  };
  const visible=training.filter(ch=>ch.role!=='manager'||isManager);
  const totalDone=visible.filter(chapDone).length;
  const pct=visible.length?Math.round(totalDone/visible.length*100):0;

  const markLesson=(chId,i)=>setTrainProg(v=>{
    const mp={...(v[me.id]||{done:{},quiz:{}})};mp.done={...mp.done,[chId+'_'+i]:true};return {...v,[me.id]:mp};
  });
  const setQuiz=(chId,pass,score)=>setTrainProg(v=>{
    const mp={...(v[me.id]||{done:{},quiz:{}})};mp.quiz={...mp.quiz,[chId]:{pass,score,ts:Date.now()}};return {...v,[me.id]:mp};
  });

  if(view==='team'&&isManager) return <TrainTeam s={s} training={training} onBack={()=>setView('learn')}/>;

  return (
    <div>
      <div className="card" style={{marginBottom:16}}>
        <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:10}}>
          <div style={{flex:1}}>
            <div style={{fontWeight:700,fontFamily:'"Baloo 2"',fontSize:16}}>Tiến độ đào tạo của bạn</div>
            <div className="hint">{totalDone}/{visible.length} chương hoàn thành</div>
          </div>
          <div style={{fontFamily:'"Baloo 2"',fontSize:26,fontWeight:800,color:pct===100?'var(--grn)':'var(--g)'}}>{pct}%</div>
        </div>
        <div className={'prog'+(pct===100?' full':'')}><i style={{width:pct+'%'}}/></div>
        {isManager&&<button className="btn ghost sm" style={{marginTop:12}} onClick={()=>setView('team')}><i className="ti ti-users"/>Xem tiến độ cả đội</button>}
      </div>

      {visible.map((ch,ci)=>{
        const ok=chapDone(ch);
        const lessonsDone=ch.lessons.filter((_,i)=>myProg.done[ch.id+'_'+i]).length;
        return (
          <div className="chap" key={ch.id}>
            <div className={'chap-h'+(ok?' ok':'')} onClick={()=>setOpen(open===ch.id?null:ch.id)}>
              <div className="num">{ok?<i className="ti ti-check"/>:ci+1}</div>
              <div className="ct"><b>{ch.icon} {ch.title} {ch.role==='manager'&&<span className="chip b" style={{fontSize:10}}>QL</span>}</b><small>{lessonsDone}/{ch.lessons.length} bài{ch.quiz&&ch.quiz.length?` · ${ch.quiz.length} câu hỏi`:''}</small></div>
              {isManager&&<button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={e=>{e.stopPropagation();setEditChap(ch);}}><i className="ti ti-pencil" style={{fontSize:17}}/></button>}
              <i className={'ti '+(open===ch.id?'ti-chevron-up':'ti-chevron-down')} style={{color:'var(--muted)',fontSize:20}}/>
            </div>
            {open===ch.id&&(
              <div className="chap-b">
                {ch.lessons.map((l,i)=>{
                  const read=myProg.done[ch.id+'_'+i];
                  return (
                    <div className="lesson" key={i}>
                      <div style={{display:'flex',alignItems:'center',gap:8}}>
                        <b style={{flex:1}}>{l.t}</b>
                        {read?<span className="chip gr"><i className="ti ti-check"/>đã đọc</span>
                          :<button className="btn ghost sm" onClick={()=>markLesson(ch.id,i)}>Đánh dấu đã đọc</button>}
                      </div>
                      <p>{l.c}</p>
                    </div>
                  );
                })}
                {ch.quiz&&ch.quiz.length>0&&<Quiz ch={ch} result={myProg.quiz[ch.id]} onDone={(pass,score)=>setQuiz(ch.id,pass,score)}/>}
              </div>
            )}
          </div>
        );
      })}
      {isManager&&<button className="btn ghost block" style={{marginTop:6}} onClick={()=>setEditChap('new')}><i className="ti ti-plus"/>Thêm chương đào tạo</button>}
      {editChap&&<ChapterEditor chap={editChap==='new'?null:editChap} onSave={saveChap} onDelete={delChap} onClose={()=>setEditChap(null)}/>}
    </div>
  );
}
function ChapterEditor({chap,onSave,onDelete,onClose}){
  const [c,setC]=useState(()=>chap?JSON.parse(JSON.stringify(chap)):{id:uid(),title:'',icon:'📘',lessons:[{t:'',c:''}],quiz:[]});
  const setLesson=(i,k,val)=>setC(x=>({...x,lessons:x.lessons.map((l,j)=>j===i?{...l,[k]:val}:l)}));
  const addLesson=()=>setC(x=>({...x,lessons:[...x.lessons,{t:'',c:''}]}));
  const delLesson=(i)=>setC(x=>({...x,lessons:x.lessons.filter((_,j)=>j!==i)}));
  const setQ=(i,patch)=>setC(x=>({...x,quiz:x.quiz.map((q,j)=>j===i?{...q,...patch}:q)}));
  const addQ=()=>setC(x=>({...x,quiz:[...x.quiz,{q:'',opts:['',''],a:0}]}));
  const delQ=(i)=>setC(x=>({...x,quiz:x.quiz.filter((_,j)=>j!==i)}));
  const setOpt=(qi,oi,val)=>setC(x=>({...x,quiz:x.quiz.map((q,j)=>j===qi?{...q,opts:q.opts.map((o,k)=>k===oi?val:o)}:q)}));
  const addOpt=(qi)=>setC(x=>({...x,quiz:x.quiz.map((q,j)=>j===qi&&q.opts.length<4?{...q,opts:[...q.opts,'']}:q)}));
  const delOpt=(qi,oi)=>setC(x=>({...x,quiz:x.quiz.map((q,j)=>{if(j!==qi||q.opts.length<=2)return q;const opts=q.opts.filter((_,k)=>k!==oi);return {...q,opts,a:q.a>=opts.length?0:q.a};})}));
  const save=()=>{
    if(!c.title.trim()){alert('Nhập tên chương');return;}
    const clean={...c,title:c.title.trim(),icon:c.icon.trim()||'📘',
      lessons:c.lessons.filter(l=>l.t.trim()||l.c.trim()),
      quiz:c.quiz.filter(q=>q.q.trim()&&q.opts.filter(o=>o.trim()).length>=2).map(q=>({...q,opts:q.opts.filter(o=>o.trim())}))};
    if(clean.lessons.length===0){alert('Cần ít nhất 1 bài học');return;}
    onSave(clean);
  };
  return (
    <Modal title={chap?'Sửa chương đào tạo':'Thêm chương đào tạo'} onClose={onClose}
      foot={<div className="rowbtns"><button className="btn block" onClick={save}><i className="ti ti-device-floppy"/>Lưu chương</button>{chap&&<button className="btn ghost" onClick={()=>{onDelete(chap.id);onClose();}}><i className="ti ti-trash" style={{color:'var(--red)'}}/></button>}</div>}>
      <div style={{display:'flex',gap:9}}>
        <label className="fld" style={{width:70}}><span>Icon</span><input className="inp" value={c.icon} onChange={e=>setC(x=>({...x,icon:e.target.value}))} style={{textAlign:'center'}}/></label>
        <label className="fld" style={{flex:1}}><span>Tên chương *</span><input className="inp" value={c.title} onChange={e=>setC(x=>({...x,title:e.target.value}))} placeholder="VD: Cách chuốt lơ & bảo quản cơ"/></label>
      </div>
      <label className="fld"><span>Đối tượng học</span>
        <div className="rowbtns">
          <button className={'btn sm '+(c.role!=='manager'?'':'ghost')} onClick={()=>setC(x=>({...x,role:null}))}>Mọi nhân viên</button>
          <button className={'btn sm '+(c.role==='manager'?'':'ghost')} onClick={()=>setC(x=>({...x,role:'manager'}))}>Chỉ quản lý</button>
        </div>
      </label>

      <div style={{fontWeight:700,fontSize:13.5,margin:'6px 0 8px'}}>📖 Bài học</div>
      {c.lessons.map((l,i)=>(
        <div key={i} className="card" style={{background:'var(--bg)',marginBottom:10,padding:12}}>
          <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:8}}>
            <input className="inp" value={l.t} onChange={e=>setLesson(i,'t',e.target.value)} placeholder={'Tiêu đề bài '+(i+1)}/>
            {c.lessons.length>1&&<button className="iconbtn" style={{padding:8,border:0,background:'none'}} onClick={()=>delLesson(i)}><i className="ti ti-trash" style={{fontSize:17,color:'var(--red)'}}/></button>}
          </div>
          <textarea className="inp" value={l.c} onChange={e=>setLesson(i,'c',e.target.value)} placeholder="Nội dung hướng dẫn… (xuống dòng để tách ý)"/>
        </div>
      ))}
      <button className="btn ghost sm" onClick={addLesson}><i className="ti ti-plus"/>Thêm bài</button>

      <div style={{fontWeight:700,fontSize:13.5,margin:'16px 0 8px'}}>❓ Câu hỏi kiểm tra <span className="hint">(chọn đáp án đúng bằng nút tròn)</span></div>
      {c.quiz.map((q,qi)=>(
        <div key={qi} className="card" style={{background:'var(--bg)',marginBottom:10,padding:12}}>
          <div style={{display:'flex',gap:8,alignItems:'center',marginBottom:8}}>
            <input className="inp" value={q.q} onChange={e=>setQ(qi,{q:e.target.value})} placeholder={'Câu hỏi '+(qi+1)}/>
            <button className="iconbtn" style={{padding:8,border:0,background:'none'}} onClick={()=>delQ(qi)}><i className="ti ti-trash" style={{fontSize:17,color:'var(--red)'}}/></button>
          </div>
          {q.opts.map((o,oi)=>(
            <div key={oi} style={{display:'flex',gap:8,alignItems:'center',marginBottom:6}}>
              <button onClick={()=>setQ(qi,{a:oi})} title="Đáp án đúng" style={{width:22,height:22,borderRadius:'50%',border:'2px solid '+(q.a===oi?'var(--grn)':'var(--muted2)'),background:q.a===oi?'var(--grn)':'transparent',flexShrink:0,display:'flex',alignItems:'center',justifyContent:'center'}}>{q.a===oi&&<i className="ti ti-check" style={{color:'#fff',fontSize:14}}/>}</button>
              <input className="inp" value={o} onChange={e=>setOpt(qi,oi,e.target.value)} placeholder={'Lựa chọn '+(oi+1)} style={{padding:'8px 11px'}}/>
              {q.opts.length>2&&<button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>delOpt(qi,oi)}><i className="ti ti-x" style={{fontSize:16,color:'var(--muted)'}}/></button>}
            </div>
          ))}
          {q.opts.length<4&&<button className="btn ghost sm" onClick={()=>addOpt(qi)}><i className="ti ti-plus"/>Thêm lựa chọn</button>}
        </div>
      ))}
      <button className="btn ghost sm" onClick={addQ}><i className="ti ti-plus"/>Thêm câu hỏi</button>
      <p className="hint" style={{marginTop:12}}>Để trống phần câu hỏi nếu chương không cần kiểm tra.</p>
    </Modal>
  );
}
function Quiz({ch,result,onDone}){
  const [ans,setAns]=useState({});
  const [submitted,setSubmitted]=useState(false);
  const allAnswered=ch.quiz.every((_,i)=>ans[i]!=null);
  const submit=()=>{
    let score=0;ch.quiz.forEach((q,i)=>{if(ans[i]===q.a)score++;});
    const pass=score===ch.quiz.length;
    setSubmitted(true);onDone(pass,score);
  };
  if(result&&result.pass&&!submitted){
    return (
      <div style={{marginTop:12}}>
        <div className="sep"/>
        <span className="chip gr"><i className="ti ti-award"/> Đã qua bài kiểm tra ({result.score}/{ch.quiz.length})</span>
      </div>
    );
  }
  return (
    <div style={{marginTop:6}}>
      <div className="sep"/>
      <div style={{fontWeight:700,fontSize:13.5,marginBottom:8}}><i className="ti ti-help-circle" style={{color:'var(--g)'}}/> Kiểm tra nhanh</div>
      {ch.quiz.map((q,i)=>(
        <div className="quizq" key={i}>
          <b>{i+1}. {q.q}</b>
          {q.opts.map((o,oi)=>{
            let cls='qopt';
            if(submitted){if(oi===q.a)cls+=' right';else if(ans[i]===oi)cls+=' wrong';}
            else if(ans[i]===oi)cls+=' sel';
            return <button key={oi} className={cls} disabled={submitted} onClick={()=>setAns(a=>({...a,[i]:oi}))}>{o}</button>;
          })}
        </div>
      ))}
      {!submitted?
        <button className="btn block" style={{marginTop:10}} disabled={!allAnswered} onClick={submit}>Nộp bài</button>
        :(()=>{const score=ch.quiz.reduce((a,q,i)=>a+(ans[i]===q.a?1:0),0);const pass=score===ch.quiz.length;
          return <div style={{marginTop:10,textAlign:'center'}}>
            <div className={'chip '+(pass?'gr':'r')} style={{fontSize:13,padding:'6px 12px'}}>{pass?<><i className="ti ti-circle-check"/> Đúng hết! Đã qua</>:<><i className="ti ti-x"/> {score}/{ch.quiz.length} đúng — thử lại</>}</div>
            {!pass&&<button className="btn ghost sm block" style={{marginTop:8}} onClick={()=>{setSubmitted(false);setAns({});}}>Làm lại</button>}
          </div>;})()}
    </div>
  );
}
function TrainTeam({s,training,onBack}){
  const {staff,trainProg}=s;
  const chapDoneFor=(uid,ch)=>{
    const mp=trainProg[uid]||{done:{},quiz:{}};
    const lessonsOk=ch.lessons.every((_,i)=>mp.done[ch.id+'_'+i]);
    const quizOk=!ch.quiz||ch.quiz.length===0||(mp.quiz[ch.id]&&mp.quiz[ch.id].pass);
    return lessonsOk&&quizOk;
  };
  return (
    <div>
      <button className="btn ghost sm" onClick={onBack} style={{marginBottom:12}}><i className="ti ti-arrow-left"/>Quay lại</button>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-users lead"/><b>Tiến độ đào tạo cả đội</b></div>
        <div className="panel-b" style={{paddingTop:6}}>
          {staff.map(u=>{
            const done=training.filter(ch=>chapDoneFor(u.id,ch)).length;
            const pct=training.length?Math.round(done/training.length*100):0;
            return (
              <div className="row" key={u.id}>
                <Avatar staff={u} size={34}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:600}}>{u.name} <span className="hint">· {u.role==='manager'?'QL':'NV'}</span></div>
                  <div className={'prog'+(pct===100?' full':'')} style={{marginTop:6}}><i style={{width:pct+'%'}}/></div>
                </div>
                <div style={{fontFamily:'"Baloo 2"',fontWeight:700,color:pct===100?'var(--grn)':'var(--g)',minWidth:42,textAlign:'right'}}>{done}/{training.length}</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ================= 4. Attendance ================= */
/* Ca làm của chính mình: đồng hồ vào/ra ca + lịch sử */
function MyShift({s}){
  const {attend,setAttend,schedule,me,flash}=s;
  const [clock,setClock]=useState(nowHM());
  useEffect(()=>{const t=setInterval(()=>setClock(nowHM()),1000*10);return ()=>clearInterval(t);},[]);
  const d=today();
  const myAtt=(attend[d]||{})[me.id]||{};
  const mySched=(schedule[d]||{})[me.id];

  const clockIn=()=>{setAttend(v=>{const day={...(v[d]||{})};day[me.id]={...(day[me.id]||{}),in:Date.now()};return {...v,[d]:day};});flash('Đã vào ca lúc '+nowHM());};
  /* Ghi vào NGÀY VÀO CA, không phải ngày đang hiện: ca tối kéo qua nửa đêm thì `today()`
     đã sang ngày mới và cả ca bị mất công (xem `ngayRaCa`). */
  const clockOut=()=>{setAttend(v=>{const dr=ngayRaCa(v,me.id,d);const day={...(v[dr]||{})};day[me.id]={...(day[me.id]||{}),out:Date.now()};return {...v,[dr]:day};});flash('Đã ra ca lúc '+nowHM());};

  const workedMin=myAtt.in&&myAtt.out?phutCa(myAtt):(myAtt.in?phutCa({in:myAtt.in,out:Date.now()}):null);
  const lateMin=(()=>{if(!myAtt.in||!mySched||mySched==='off')return null;const st=SHIFT_TIME[mySched];if(!st)return null;
    const [sh,sm]=st.start.split(':').map(Number);const inD=new Date(myAtt.in);const startMs=new Date(inD).setHours(sh,sm,0,0);
    return Math.round((myAtt.in-startMs)/60000);})();
  return (
        <div>
          <div className="card" style={{marginBottom:16}}>
            <div className="bigclock"><div className="t">{clock}</div><div className="d">{dayName(d)}, {fmtDateVN(d)}</div></div>
            <div style={{textAlign:'center',margin:'10px 0'}}>
              {mySched&&mySched!=='off'?<span className="chip g" style={{fontSize:13,padding:'5px 12px'}}>{SHIFT_TIME[mySched].icon} Lịch ca {SHIFT_TIME[mySched].label} · {SHIFT_TIME[mySched].start}–{SHIFT_TIME[mySched].end}</span>
                :mySched==='off'?<span className="chip">Hôm nay nghỉ</span>
                :<span className="chip">Chưa phân ca hôm nay</span>}
            </div>
            <div className="attgrid">
              <div className="attbox"><div className="lb">Vào ca</div><div className="vv" style={{color:myAtt.in?'var(--grn)':'var(--muted2)'}}>{myAtt.in?new Date(myAtt.in).toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'}):'—'}</div>
                {lateMin!=null&&myAtt.in&&<div className="hint" style={{marginTop:2}}>{lateMin>5?<span style={{color:'var(--red)'}}>trễ {lateMin}p</span>:lateMin< -5?<span style={{color:'var(--blue)'}}>sớm {-lateMin}p</span>:<span style={{color:'var(--grn)'}}>đúng giờ</span>}</div>}
              </div>
              <div className="attbox"><div className="lb">Ra ca</div><div className="vv" style={{color:myAtt.out?'var(--red)':'var(--muted2)'}}>{myAtt.out?new Date(myAtt.out).toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'}):'—'}</div></div>
            </div>
            {workedMin!=null&&<div style={{textAlign:'center',marginTop:10}} className="hint">Đã làm: <b style={{color:'var(--ink)'}}>{minToHM(workedMin)}</b></div>}
            <div style={{marginTop:14}}>
              {!myAtt.in&&<button className="btn wide block" onClick={clockIn}><i className="ti ti-login"/>Vào ca</button>}
              {myAtt.in&&!myAtt.out&&<button className="btn wide block red" onClick={clockOut}><i className="ti ti-logout"/>Ra ca</button>}
              {myAtt.in&&myAtt.out&&<div style={{textAlign:'center'}} className="chip gr">✓ Đã hoàn thành ca hôm nay</div>}
            </div>
          </div>
          <MyHistory attend={attend} schedule={schedule} me={me}/>
        </div>
  );
}

function AttendView({s}){
  const {attend,setAttend,schedule,setSchedule,staff,me,isManager,isCounter,violations,setViolations,penaltyRules,flash}=s;
  const [tab,setTab]=useState('me'); // me | mine | team | schedule | log
  const canLog=isManager||isCounter;

  return (
    <div>
      <div className="seg">
        <button className={tab==='me'?'on':''} onClick={()=>setTab('me')}><i className="ti ti-user"/>Ca của tôi</button>
        <button className={tab==='mine'?'on':''} onClick={()=>setTab('mine')}><i className="ti ti-alert-triangle"/>Lỗi của tôi</button>
        {isManager&&<button className={tab==='team'?'on':''} onClick={()=>setTab('team')}><i className="ti ti-users"/>Cả đội</button>}
        {isManager&&<button className={tab==='schedule'?'on':''} onClick={()=>setTab('schedule')}><i className="ti ti-calendar"/>Phân ca</button>}
        {canLog&&<button className={tab==='log'?'on':''} onClick={()=>setTab('log')}><i className="ti ti-flag"/>Ghi lỗi</button>}
      </div>

      {tab==='me'&&<MyShift s={s}/>}

      {tab==='mine'&&<MyViolations violations={violations} me={me}/>}
      {tab==='team'&&isManager&&<TeamAttend attend={attend} schedule={schedule} staff={staff}/>}
      {tab==='schedule'&&isManager&&<ScheduleEditor schedule={schedule} setSchedule={setSchedule} staff={staff} attend={attend} flash={flash}/>}
      {tab==='log'&&canLog&&<LogViolation violations={violations} setViolations={setViolations} penaltyRules={penaltyRules} staff={staff} me={me} flash={flash}/>}
    </div>
  );
}
function MyHistory({attend,schedule,me}){
  const days=Object.keys(attend).filter(d=>(attend[d]||{})[me.id]).sort().reverse().slice(0,10);
  if(days.length===0)return <Empty icon="ti-calendar-off" text="Chưa có lịch sử chấm công"/>;
  let totalMin=0;
  days.forEach(d=>{totalMin+=phutCa(attend[d][me.id]);});
  return (
    <div className="panel">
      <div className="panel-h"><i className="ti ti-history lead"/><b>Lịch sử gần đây</b><span className="chip g">Tổng {minToHM(totalMin)}</span></div>
      <div className="tbl-scroll">
        <table className="data">
          <thead><tr><th>Ngày</th><th>Ca</th><th>Vào</th><th>Ra</th><th>Giờ làm</th></tr></thead>
          <tbody>
            {days.map(d=>{const a=attend[d][me.id];const sc=(schedule[d]||{})[me.id];const wm=a.in&&a.out?phutCa(a):null;
              return <tr key={d}><td>{dayName(d)} {fmtDateVN(d).slice(0,5)}</td>
                <td>{sc&&sc!=='off'?SHIFT_TIME[sc].label:'—'}</td>
                <td>{a.in?new Date(a.in).toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'}):'—'}</td>
                <td>{a.out?new Date(a.out).toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'}):'—'}</td>
                <td><b>{minToHM(wm)}</b></td></tr>;
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function TeamAttend({attend,schedule,staff}){
  const [d,setD]=useState(today());
  const day=attend[d]||{};const sched=schedule[d]||{};
  return (
    <div className="panel">
      <div className="panel-h"><i className="ti ti-users lead"/><b>Chấm công cả đội</b>
        <input type="date" className="inp" style={{width:'auto',padding:'7px 10px'}} value={d} onChange={e=>setD(e.target.value)}/></div>
      <div className="tbl-scroll">
        <table className="data">
          <thead><tr><th>Nhân viên</th><th>Ca xếp</th><th>Vào</th><th>Ra</th><th>Giờ làm</th></tr></thead>
          <tbody>
            {staff.map(u=>{const a=day[u.id]||{};const sc=sched[u.id];const wm=a.in&&a.out?phutCa(a):null;
              let late=null;if(a.in&&sc&&sc!=='off'){const st=SHIFT_TIME[sc];const[sh,sm]=st.start.split(':').map(Number);const startMs=new Date(a.in).setHours(sh,sm,0,0);late=Math.round((a.in-startMs)/60000);}
              return <tr key={u.id}>
                <td style={{display:'flex',alignItems:'center',gap:8}}><Avatar staff={u} size={28}/>{u.name.split(' ').slice(-1)[0]}</td>
                <td>{sc?(sc==='off'?<span className="chip">Nghỉ</span>:<span className="chip g">{SHIFT_TIME[sc].label}</span>):'—'}</td>
                <td>{a.in?<span>{new Date(a.in).toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'})}{late>5&&<span style={{color:'var(--red)',fontSize:11}}> (trễ {late}p)</span>}</span>:'—'}</td>
                <td>{a.out?new Date(a.out).toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'}):'—'}</td>
                <td><b>{minToHM(wm)}</b></td></tr>;
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
function ScheduleEditor({schedule,setSchedule,staff,attend,flash}){
  const [d,setD]=useState(today());
  const sched=schedule[d]||{};
  const setShift=(uid,sh)=>setSchedule(v=>{const day={...(v[d]||{})};if(day[uid]===sh)delete day[uid];else day[uid]=sh;return {...v,[d]:day};});
  return (
    <div className="panel">
      <div className="panel-h"><i className="ti ti-calendar-event lead"/><b>Phân ca</b>
        <input type="date" className="inp" style={{width:'auto',padding:'7px 10px'}} value={d} onChange={e=>setD(e.target.value)}/></div>
      <div className="panel-b">
        <p className="hint" style={{marginBottom:10}}>Chọn ca cho từng nhân viên ngày {dayName(d)}, {fmtDateVN(d)}. Bấm lại để bỏ chọn.</p>
        {staff.map(u=>(
          <div className="row" key={u.id}>
            <Avatar staff={u} size={32}/>
            <div style={{flex:1,fontWeight:600,minWidth:0}}>{u.name}</div>
            <div className="rowbtns">
              <button className={'btn sm '+(sched[u.id]==='morning'?'':'ghost')} onClick={()=>setShift(u.id,'morning')}>☀️ Sáng</button>
              <button className={'btn sm '+(sched[u.id]==='evening'?'':'ghost')} onClick={()=>setShift(u.id,'evening')}>🌙 Tối</button>
              <button className={'btn sm '+(sched[u.id]==='off'?'red':'ghost')} onClick={()=>setShift(u.id,'off')}>Nghỉ</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
function MyViolations({violations,me}){
  const mine=violations.filter(v=>v.staffId===me.id).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  const mineMonth=mine.filter(v=>monthOf(v.date)===thisMonth());
  const totalMonth=mineMonth.reduce((a,v)=>a+(v.amount||0),0);
  return (
    <div>
      <div className="card" style={{marginBottom:14,textAlign:'center'}}>
        <div className="hint">Tổng phạt tháng này ({thisMonth().split('-').reverse().join('/')})</div>
        <div style={{fontFamily:'"Baloo 2"',fontSize:30,fontWeight:800,color:totalMonth>0?'var(--red)':'var(--grn)'}}>{fmtVnd(totalMonth)}</div>
        <div className="hint">{mineMonth.length} lỗi trong tháng</div>
      </div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-alert-triangle lead"/><b>Lỗi của tôi</b></div>
        <div className="panel-b" style={{paddingTop:6}}>
          {mine.length===0&&<Empty icon="ti-mood-happy" text="Chưa có lỗi nào. Giữ phong độ nhé!"/>}
          {mine.map(v=>(
            <div className="row" key={v.id}>
              <div style={{flex:1,minWidth:0}}><div style={{fontWeight:600,fontSize:13.5}}>{v.name}</div>
                <div className="hint">{v.date?fmtDateVN(v.date):''}{v.note?' · '+v.note:''} · ghi bởi {v.byName}</div></div>
              <div style={{fontWeight:700,fontFamily:'"Baloo 2"',color:'var(--red)'}}>−{fmtVnd(v.amount)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
function LogViolation({violations,setViolations,penaltyRules,staff,me,flash}){
  const [staffId,setStaffId]=useState('');
  const [ruleId,setRuleId]=useState('');
  const [note,setNote]=useState('');
  const [date,setDate]=useState(today());
  const rule=penaltyRules.find(r=>r.id===ruleId);
  const add=()=>{
    if(!staffId){flash('Chọn nhân viên');return;}
    if(!rule){flash('Chọn loại lỗi');return;}
    setViolations(v=>[{id:uid(),staffId,ruleId,name:rule.name,amount:rule.amount,note:note.trim(),date,by:me.id,byName:me.name,ts:Date.now()},...v]);
    setNote('');flash('Đã ghi lỗi cho '+(staff.find(s=>s.id===staffId)||{}).name);
  };
  const recent=[...violations].sort((a,b)=>b.ts-a.ts).slice(0,15);
  const nameOf=id=>(staff.find(s=>s.id===id)||{}).name||'?';
  return (
    <div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-flag lead"/><b>Ghi lỗi nhân viên</b></div>
        <div className="panel-b">
          <div style={{display:'flex',gap:9,flexWrap:'wrap'}}>
            <label className="fld" style={{flex:1,minWidth:150}}><span>Nhân viên</span>
              <select className="inp" value={staffId} onChange={e=>setStaffId(e.target.value)}><option value="">— Chọn —</option>{staff.map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
            <label className="fld" style={{width:130}}><span>Ngày</span><input className="inp" type="date" value={date} onChange={e=>setDate(e.target.value)}/></label>
          </div>
          <label className="fld"><span>Loại lỗi (mức phạt theo bảng)</span>
            <select className="inp" value={ruleId} onChange={e=>setRuleId(e.target.value)}><option value="">— Chọn lỗi —</option>{penaltyRules.map(r=><option key={r.id} value={r.id}>{r.name} · {fmtVnd(r.amount)}</option>)}</select></label>
          {rule&&<div className="chip r" style={{marginBottom:10}}>Phạt: {fmtVnd(rule.amount)}</div>}
          <label className="fld"><span>Ghi chú (tuỳ chọn)</span><input className="inp" value={note} onChange={e=>setNote(e.target.value)} placeholder="VD: trễ 25 phút ca sáng"/></label>
          <button className="btn block" onClick={add}><i className="ti ti-plus"/>Ghi lỗi</button>
        </div>
      </div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-history lead"/><b>Lỗi ghi gần đây</b></div>
        <div className="panel-b" style={{paddingTop:6}}>
          {recent.length===0&&<Empty icon="ti-clipboard-check" text="Chưa ghi lỗi nào"/>}
          {recent.map(v=>(
            <div className="row" key={v.id}>
              <div style={{flex:1,minWidth:0}}><div style={{fontWeight:600,fontSize:13.5}}>{nameOf(v.staffId)} — {v.name}</div>
                <div className="hint">{v.date?fmtDateVN(v.date):''}{v.note?' · '+v.note:''}</div></div>
              <div style={{fontWeight:700,fontFamily:'"Baloo 2"',color:'var(--red)'}}>−{fmtVnd(v.amount)}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ================= 5. Customers ================= */
function compressImage(file,cb){
  const r=new FileReader();
  r.onload=e=>{const img=new Image();img.onload=()=>{
    const max=360;let w=img.width,h=img.height;
    if(w>h&&w>max){h=Math.round(h*max/w);w=max;}else if(h>=w&&h>max){w=Math.round(w*max/h);h=max;}
    const cv=document.createElement('canvas');cv.width=w;cv.height=h;
    cv.getContext('2d').drawImage(img,0,0,w,h);
    try{cb(cv.toDataURL('image/jpeg',0.7));}catch(err){cb('');}
  };img.src=e.target.result;};
  r.readAsDataURL(file);
}
function CustPic({c,size=40}){
  if(c.photo) return <img src={c.photo} alt={c.name} style={{width:size,height:size,borderRadius:'50%',objectFit:'cover',flexShrink:0}}/>;
  return <div className="avatar" style={{background:avColor(c.id),width:size,height:size,fontSize:size*0.38}}>{initials(c.name)}</div>;
}
function CustView({s}){
  const {customers,setCustomers,me,isManager,tiers,setTiers,feedback,setFeedback,fbSeen,setFbSeen,flash}=s;
  const [sec,setSec]=useState('list');
  const newFb=feedback.filter(f=>f.ts>(fbSeen||0)).length;
  // Mở tab Feedback = quản lý đã xem → tắt badge
  useEffect(()=>{ if(sec==='fb'&&newFb>0) setFbSeen(Date.now()); },[sec,feedback]);
  const [q,setQ]=useState('');
  const [vipOnly,setVipOnly]=useState(false);
  const [adding,setAdding]=useState(false);
  const [detail,setDetail]=useState(null);
  const [nf,setNf]=useState({name:'',phone:''});
  const newHl=(s.highlights||[]).filter(h=>h.status==='pending').length;

  const filtered=customers.filter(c=>{const t=(c.name+' '+(c.phone||'')).toLowerCase();return t.includes(q.toLowerCase());}).sort((a,b)=>b.points-a.points);
  const list=vipOnly?filtered.filter(c=>c.vip):filtered;
  const addCust=()=>{if(!nf.name.trim()){flash('Nhập tên khách');return;}
    setCustomers(v=>[{id:uid(),name:nf.name.trim(),phone:nf.phone.trim(),points:0,hours:0,visits:0,vip:false,games:[],photo:'',note:'',rewards:[],history:[]},...v]);
    setNf({name:'',phone:''});setAdding(false);flash('Đã thêm khách');};

  return (
    <div>
      <Seg cur={sec} onPick={setSec} tabs={[
        {id:'list',label:'Danh sách',icon:'ti-users'},
        {id:'tier',label:'Hạng & quà',icon:'ti-stairs-up'},
        {id:'fb',label:'Góp ý',icon:'ti-message-2',badge:newFb},
        isManager&&{id:'bc',label:'Gửi tin',icon:'ti-speakerphone'},
        isManager&&{id:'hl',label:'Highlight',icon:'ti-video',badge:newHl},
      ]}/>

      {sec==='fb'&&<FeedbackSection feedback={feedback} setFeedback={setFeedback} customers={customers} me={me} isManager={isManager} flash={flash}/>}
      {sec==='tier'&&<TierMgr tiers={tiers} setTiers={setTiers} customers={customers} isManager={isManager} onOpenCust={setDetail} flash={flash}/>}
      {sec==='bc'&&isManager&&<BroadcastMgr broadcasts={s.broadcasts} setBroadcasts={s.setBroadcasts} promos={s.promos} tours={s.tours} customers={customers} cloud={s.cloud} flash={flash}/>}
      {sec==='hl'&&isManager&&<HighlightMgr highlights={s.highlights} setHighlights={s.setHighlights} customers={customers} me={me} flash={flash}/>}
      {sec==='list'&&(
      <div>
        <div style={{display:'flex',gap:9,marginBottom:14}}>
          <div className="inp" style={{display:'flex',alignItems:'center',gap:8,flex:1,padding:'0 12px'}}>
            <i className="ti ti-search" style={{color:'var(--muted2)',fontSize:18}}/>
            <input style={{border:0,outline:0,background:'none',flex:1,color:'var(--ink)',height:42}} placeholder="Tìm tên / SĐT khách" value={q} onChange={e=>setQ(e.target.value)}/>
          </div>
          <button className={'btn '+(vipOnly?'':'ghost')} onClick={()=>setVipOnly(v=>!v)} title="Chỉ khách VIP"><i className="ti ti-crown"/></button>
          <button className="btn" onClick={()=>setAdding(true)}><i className="ti ti-user-plus"/></button>
        </div>

        <div className="grid-stat">
          <div className="stat"><div className="ic g"><i className="ti ti-users"/></div><div className="n">{customers.length}</div><div className="l">Khách quen</div></div>
          <div className="stat"><div className="ic a"><i className="ti ti-crown"/></div><div className="n">{customers.filter(c=>c.vip).length}</div><div className="l">Khách VIP</div></div>
        </div>

        <div className="panel">
          <div className="panel-h"><i className="ti ti-award lead"/><b>{vipOnly?'Khách VIP':'Danh sách khách (theo điểm)'}</b></div>
          <div className="panel-b" style={{paddingTop:4}}>
            {list.length===0&&<Empty icon="ti-user-off" text={vipOnly?'Chưa có khách VIP':'Không có khách phù hợp'}/>}
            {list.map(c=>{const t=tierOf(tiers,c.hours);return (
              <div className="custrow" key={c.id} onClick={()=>setDetail(c.id)} style={{cursor:'pointer'}}>
                <CustPic c={c} size={42}/>
                <div className="ci"><b>{c.name} {c.vip&&<i className="ti ti-crown" style={{color:'var(--amber)',fontSize:15}}/>}</b>
                  <small>{t?t.icon+' '+t.name+' · ':''}{fmtHours(c.hours)} chơi · {c.visits} lượt{unusedRewards(c).length?' · 🎁 '+unusedRewards(c).length:''}</small></div>
                <div style={{textAlign:'right'}}><div className="pts">{c.points}</div><div className="hint">điểm</div></div>
              </div>
            );})}
          </div>
        </div>
      </div>
      )}

      {adding&&(
        <Modal title="Thêm khách mới" onClose={()=>setAdding(false)}
          foot={<button className="btn block" onClick={addCust}>Thêm khách</button>}>
          <label className="fld"><span>Tên khách *</span><input className="inp" autoFocus value={nf.name} onChange={e=>setNf({...nf,name:e.target.value})} placeholder="Anh Hùng"/></label>
          <label className="fld"><span>Số điện thoại</span><input className="inp" value={nf.phone} onChange={e=>setNf({...nf,phone:e.target.value})} placeholder="09xx…" inputMode="tel"/></label>
        </Modal>
      )}
      {detail&&<CustDetail cid={detail} customers={customers} tiers={tiers} onClose={()=>setDetail(null)} setCustomers={setCustomers} me={me} flash={flash}/>}
    </div>
  );
}
function CustDetail({cid,customers,tiers,onClose,setCustomers,me,flash}){
  const c=customers.find(x=>x.id===cid);
  const [amt,setAmt]=useState(10);
  const [reason,setReason]=useState('');
  const fileRef=useRef();
  if(!c)return null;
  const patch=(obj)=>setCustomers(v=>v.map(x=>x.id===c.id?{...x,...obj}:x));
  const apply=(sign)=>{
    const delta=sign*Math.abs(amt||0);
    if(delta===0)return;
    setCustomers(v=>v.map(x=>x.id===c.id?{
      ...x,points:Math.max(0,x.points+delta),
      visits:sign>0?x.visits+1:x.visits,
      history:[{delta,reason:reason.trim()||(sign>0?'Cộng điểm':'Đổi/trừ điểm'),by:me.name,ts:Date.now()},...x.history]
    }:x));
    flash((delta>0?'+':'')+delta+' điểm cho '+c.name);
    setReason('');
  };
  const toggleGame=(g)=>{const cur=c.games||[];patch({games:cur.includes(g)?cur.filter(x=>x!==g):[...cur,g]});};
  // Trao quà lên hạng cho khách (nhân viên bấm khi đã đưa nước/đồ ăn/voucher)
  const useReward=(r)=>{
    if(!confirm('Đã trao "'+r.label+'" cho khách?'))return;
    patch({rewards:(c.rewards||[]).map(x=>x.id===r.id?{...x,used:true,usedTs:Date.now(),usedBy:me.name}:x)});
    flash('Đã trao quà cho '+c.name+' 🎁');
  };
  const tier=tierOf(tiers,c.hours), nx=nextTier(tiers,c.hours);
  const pctToNext=nx?Math.min(100,Math.round(((c.hours||0)-(Number(tier?tier.hours:0)||0))/Math.max(1,(Number(nx.hours)||0)-(Number(tier?tier.hours:0)||0))*100)):100;
  const onPhoto=(e)=>{const f=e.target.files&&e.target.files[0];if(!f)return;compressImage(f,d=>{patch({photo:d});flash('Đã lưu ảnh khách');});};
  return (
    <Modal title={c.name} onClose={onClose}>
      <div style={{display:'flex',alignItems:'center',gap:12,marginBottom:14}}>
        <div style={{position:'relative',cursor:'pointer'}} onClick={()=>fileRef.current&&fileRef.current.click()}>
          <CustPic c={c} size={56}/>
          <span style={{position:'absolute',right:-2,bottom:-2,background:'var(--g)',color:'#fff',width:22,height:22,borderRadius:'50%',display:'flex',alignItems:'center',justifyContent:'center',border:'2px solid var(--card)'}}><i className="ti ti-camera" style={{fontSize:12}}/></span>
        </div>
        <input ref={fileRef} type="file" accept="image/*" style={{display:'none'}} onChange={onPhoto}/>
        <div style={{flex:1}}><div style={{fontWeight:700,fontSize:15}}>{c.name}</div><div className="hint">{c.phone||'chưa có SĐT'} · {c.visits} lượt đến</div></div>
        <button onClick={()=>patch({vip:!c.vip})} title="Khách VIP" style={{textAlign:'center',padding:'4px 8px',borderRadius:10,background:c.vip?'var(--amber-lt)':'var(--bg)'}}>
          <i className="ti ti-crown" style={{fontSize:22,color:c.vip?'var(--amber)':'var(--muted2)'}}/><div className="hint" style={{color:c.vip?'var(--amber)':'var(--muted)'}}>{c.vip?'VIP':'Gắn VIP'}</div>
        </button>
      </div>

      <label className="fld"><span>Bộ môn hay chơi</span>
        <div className="rowbtns">{GAME_MODES.map(g=>(
          <button key={g} className={'btn sm '+((c.games||[]).includes(g)?'':'ghost')} onClick={()=>toggleGame(g)}>{g}</button>
        ))}</div>
      </label>
      <label className="fld"><span>Ghi chú (thói quen, đồ hay uống…)</span>
        <textarea className="inp" value={c.note||''} onChange={e=>patch({note:e.target.value})} placeholder="VD: hay chơi tối, thích bia Tiger, dẫn nhóm 4 người…"/></label>

      <div className="card" style={{background:'var(--bg)',marginBottom:14}}>
        <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
          <TierChip t={tier} big/>
          <div className="spacer" style={{flex:1}}/>
          <div style={{textAlign:'right'}}><b style={{fontFamily:'"Baloo 2"',fontSize:18,color:'var(--g)'}}>{fmtHours(c.hours)}</b>
            <div className="hint">tổng giờ chơi</div></div>
        </div>
        <div className="prog" style={{marginBottom:6}}><i style={{width:pctToNext+'%'}}/></div>
        <div className="hint">{nx
          ?<>Còn <b>{fmtHours(Math.max(0,(Number(nx.hours)||0)-(c.hours||0)))}</b> nữa lên {nx.icon} {nx.name} — giảm {nx.discount||0}% tiền bàn{nx.gift?' + tặng '+nx.gift:''}</>
          :<>Đã đạt hạng cao nhất — giảm {tier?tier.discount||0:0}% tiền bàn</>}</div>
      </div>

      <div style={{fontWeight:700,fontSize:13.5,marginBottom:8}}>🎁 Quà lên hạng {unusedRewards(c).length>0&&<span className="chip a" style={{marginLeft:6}}>{unusedRewards(c).length} chưa trao</span>}</div>
      {(!c.rewards||c.rewards.length===0)&&<p className="hint" style={{marginBottom:14}}>Chưa có quà nào. Khách lên hạng mới là quà tự sinh ra ở đây.</p>}
      {(c.rewards||[]).slice(0,10).map(r=>(
        <div className="row" key={r.id} style={{padding:'9px 2px'}}>
          <span style={{fontSize:18}}>{r.used?'✅':'🎁'}</span>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontWeight:600,fontSize:13,textDecoration:r.used?'line-through':'none'}}>{r.label}</div>
            <div className="hint">hạng {r.tier} · {new Date(r.ts).toLocaleDateString('vi')}{r.used&&r.usedBy?' · đã trao bởi '+r.usedBy:''}</div>
          </div>
          {!r.used&&<button className="btn sm" onClick={()=>useReward(r)}><i className="ti ti-gift"/>Đã trao</button>}
        </div>
      ))}

      <div className="card" style={{background:'var(--bg)',margin:'14px 0'}}>
        <div style={{fontWeight:700,marginBottom:10}}>Ghi điểm lần đến này <span className="pts" style={{float:'right'}}>{c.points}đ</span></div>
        <div className="stepper" style={{marginBottom:10}}>
          <button onClick={()=>setAmt(a=>Math.max(0,a-5))}>−</button>
          <b style={{minWidth:50}}>{amt}</b>
          <button onClick={()=>setAmt(a=>a+5)}>+</button>
          <span className="hint" style={{marginLeft:6}}>điểm (gợi ý ~10đ/giờ chơi)</span>
        </div>
        <input className="inp" placeholder="Lý do (vd: chơi 2h + nước)" value={reason} onChange={e=>setReason(e.target.value)} style={{marginBottom:10}}/>
        <div className="rowbtns">
          <button className="btn" style={{flex:1}} onClick={()=>apply(1)}><i className="ti ti-plus"/>Cộng điểm</button>
          <button className="btn ghost" style={{flex:1}} onClick={()=>apply(-1)}><i className="ti ti-minus"/>Trừ / đổi thưởng</button>
        </div>
      </div>

      <div style={{fontWeight:700,fontSize:13.5,marginBottom:8}}>Lịch sử điểm</div>
      {(!c.history||c.history.length===0)&&<p className="hint">Chưa có giao dịch điểm.</p>}
      {(c.history||[]).slice(0,20).map((h,i)=>(
        <div className="row" key={i} style={{padding:'9px 2px'}}>
          <div style={{flex:1,minWidth:0}}><div style={{fontWeight:600,fontSize:13}}>{h.reason}</div><div className="hint">{new Date(h.ts).toLocaleString('vi',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}{h.by?' · '+h.by:''}</div></div>
          <div style={{fontWeight:700,fontFamily:'"Baloo 2"',color:h.delta>0?'var(--grn)':'var(--red)'}}>{h.delta>0?'+':''}{h.delta}</div>
        </div>
      ))}
    </Modal>
  );
}
/* ===== Hạng khách: xem bậc thang & (quản lý) sửa mốc giờ / % giảm / quà ===== */
function TierMgr({tiers,setTiers,customers,isManager,onOpenCust,flash}){
  const [edit,setEdit]=useState(null); // level đang sửa
  const L=tierLevels(tiers);
  const countOf=(lv)=>customers.filter(c=>{const t=tierOf(tiers,c.hours);return t&&t.id===lv.id;}).length;
  const totalGifts=customers.reduce((a,c)=>a+unusedRewards(c).length,0);
  const setPph=(v)=>setTiers(t=>({...t,ptsPerHour:Math.max(0,Number(v)||0)}));
  const saveLevel=(lv)=>{
    if(!lv.name.trim()){flash('Nhập tên hạng');return;}
    setTiers(t=>({...t,levels:(t.levels||[]).map(x=>x.id===lv.id?{...lv,name:lv.name.trim(),
      hours:Math.max(0,Number(lv.hours)||0),discount:Math.max(0,Math.min(100,Number(lv.discount)||0))}:x)}));
    setEdit(null);flash('Đã lưu hạng '+lv.name);
  };
  const addLevel=()=>{
    const last=L[L.length-1];
    setTiers(t=>({...t,levels:[...(t.levels||[]),{id:'tv_'+uid(),name:'Hạng mới',icon:'⭐',
      hours:(Number(last?last.hours:0)||0)+30,discount:0,gift:'',perks:''}]}));
  };
  const delLevel=(lv)=>{
    if(L.length<=1){flash('Phải còn ít nhất 1 hạng');return;}
    if(!confirm('Xoá hạng "'+lv.name+'"? Khách đang ở hạng này sẽ rơi về hạng thấp hơn.'))return;
    setTiers(t=>({...t,levels:(t.levels||[]).filter(x=>x.id!==lv.id)}));
  };
  const top=[...customers].sort((a,b)=>(b.hours||0)-(a.hours||0)).slice(0,5);
  return (
    <div>
      <div className="grid-stat">
        <div className="stat"><div className="ic g"><i className="ti ti-clock-hour-4"/></div>
          <div className="n">{fmtHours(customers.reduce((a,c)=>a+(c.hours||0),0))}</div><div className="l">Tổng giờ khách quen</div></div>
        <div className="stat"><div className="ic a"><i className="ti ti-gift"/></div>
          <div className="n">{totalGifts}</div><div className="l">Quà chưa trao</div></div>
      </div>

      <div className="panel">
        <div className="panel-h"><i className="ti ti-stairs-up lead"/><b>Bậc thang hạng khách</b>
          {isManager&&<button className="btn ghost sm" onClick={addLevel}><i className="ti ti-plus"/>Thêm hạng</button>}
        </div>
        <div className="panel-b" style={{paddingTop:6}}>
          <p className="hint" style={{marginBottom:10}}>Khách tích <b>giờ chơi</b> mỗi lần chốt bill có gắn tên. Đủ mốc giờ là lên hạng,
            được giảm tiền bàn nhiều hơn và nhận quà 1 lần.</p>
          {L.map(lv=>(
            <div className="row" key={lv.id}>
              <span style={{fontSize:22}}>{lv.icon||'⭐'}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:700}}>{lv.name} <span className="hint">· từ {fmtHours(lv.hours)} chơi</span></div>
                <div className="hint">Giảm {Number(lv.discount)||0}% tiền bàn{lv.gift?' · 🎁 '+lv.gift:''}{lv.perks?' · '+lv.perks:''}</div>
              </div>
              <span className="chip g">{countOf(lv)} khách</span>
              {isManager&&<button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>setEdit({...lv})}><i className="ti ti-edit" style={{fontSize:17}}/></button>}
            </div>
          ))}
          {isManager&&<label className="fld" style={{marginTop:12,marginBottom:0}}><span>Điểm tích được mỗi giờ chơi</span>
            <input className="inp" type="number" min="0" value={tiers.ptsPerHour||0} onChange={e=>setPph(e.target.value)}/></label>}
        </div>
      </div>

      <div className="panel">
        <div className="panel-h"><i className="ti ti-trophy lead"/><b>Khách chơi nhiều nhất</b></div>
        <div className="panel-b" style={{paddingTop:6}}>
          {top.length===0&&<Empty icon="ti-user-off" text="Chưa có khách quen nào"/>}
          {top.map((c,i)=>{const t=tierOf(tiers,c.hours);const nx=nextTier(tiers,c.hours);
            const base=Number(t?t.hours:0)||0;
            const pct=nx?Math.min(100,Math.round(((c.hours||0)-base)/Math.max(1,(Number(nx.hours)||0)-base)*100)):100;
            return (
              <div className="row" key={c.id} onClick={()=>onOpenCust&&onOpenCust(c.id)} style={{cursor:'pointer',alignItems:'flex-start'}}>
                <span style={{fontSize:16,fontWeight:800,color:'var(--muted2)',width:18}}>{i+1}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',alignItems:'center',gap:7}}>
                    <b style={{fontSize:13.5}}>{c.name}</b><TierChip t={t}/>
                    <div className="spacer" style={{flex:1}}/><span className="hint">{fmtHours(c.hours)}</span>
                  </div>
                  <div className="prog" style={{margin:'6px 0 3px'}}><i style={{width:pct+'%'}}/></div>
                  <div className="hint">{nx?'còn '+fmtHours(Math.max(0,(Number(nx.hours)||0)-(c.hours||0)))+' nữa lên '+nx.icon+' '+nx.name:'hạng cao nhất'}</div>
                </div>
              </div>
            );})}
        </div>
      </div>

      {edit&&<Modal title={'Sửa hạng '+edit.name} onClose={()=>setEdit(null)}
        foot={<div className="rowbtns">
          <button className="btn ghost" onClick={()=>{setEdit(null);delLevel(edit);}}><i className="ti ti-trash"/></button>
          <button className="btn" style={{flex:1}} onClick={()=>saveLevel(edit)}><i className="ti ti-check"/>Lưu hạng</button>
        </div>}>
        <div style={{display:'flex',gap:9}}>
          <label className="fld" style={{width:76}}><span>Biểu tượng</span>
            <input className="inp" value={edit.icon||''} onChange={e=>setEdit({...edit,icon:e.target.value})} placeholder="🥉"/></label>
          <label className="fld" style={{flex:1}}><span>Tên hạng</span>
            <input className="inp" value={edit.name} onChange={e=>setEdit({...edit,name:e.target.value})}/></label>
        </div>
        <div style={{display:'flex',gap:9}}>
          <label className="fld" style={{flex:1}}><span>Đạt hạng từ (giờ chơi)</span>
            <input className="inp" type="number" min="0" value={edit.hours} onChange={e=>setEdit({...edit,hours:e.target.value})}/></label>
          <label className="fld" style={{flex:1}}><span>Giảm tiền bàn (%)</span>
            <input className="inp" type="number" min="0" max="100" value={edit.discount} onChange={e=>setEdit({...edit,discount:e.target.value})}/></label>
        </div>
        <label className="fld"><span>Quà tặng khi lên hạng</span>
          <input className="inp" value={edit.gift||''} onChange={e=>setEdit({...edit,gift:e.target.value})} placeholder="VD: Voucher 200.000đ / 1 nước suối / 1 phần đồ ăn"/></label>
        <label className="fld"><span>Quyền lợi (khách nhìn thấy)</span>
          <input className="inp" value={edit.perks||''} onChange={e=>setEdit({...edit,perks:e.target.value})} placeholder="VD: ưu tiên giữ bàn cuối tuần"/></label>
        <p className="hint">Quà chỉ tặng <b>1 lần</b> lúc khách vừa đạt hạng. Chiết khấu thì áp mỗi lần chốt bill.</p>
      </Modal>}
    </div>
  );
}
function FeedbackSection({feedback,setFeedback,customers,me,isManager,flash}){
  const del=(id)=>{if(confirm('Xoá feedback này?'))setFeedback(v=>v.filter(x=>x.id!==id));};
  const sorted=[...feedback].sort((a,b)=>b.ts-a.ts);
  const good=feedback.filter(f=>f.rating==='good').length;
  const bad=feedback.filter(f=>f.rating==='bad').length;
  return (
    <div>
      <div className="grid-stat">
        <div className="stat"><div className="ic gr"><i className="ti ti-mood-happy"/></div><div className="n">{good}</div><div className="l">Hài lòng</div></div>
        <div className="stat"><div className="ic r"><i className="ti ti-mood-sad"/></div><div className="n">{bad}</div><div className="l">Chưa hài lòng</div></div>
      </div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-inbox lead"/><b>Góp ý từ khách ({feedback.length})</b></div>
        <div className="panel-b" style={{paddingTop:6}}>
          {sorted.length===0&&<Empty icon="ti-message-off" text="Chưa có góp ý nào. Khách hàng tự gửi từ app của họ."/>}
          {sorted.map(f=>{
            const r=FB_RATING[f.rating]; // shape mới
            return (
              <div className="row" key={f.id} style={{alignItems:'flex-start'}}>
                <span style={{fontSize:20}}>{r?r.icon:'💬'}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:'flex',gap:6,alignItems:'center',flexWrap:'wrap',marginBottom:3}}>
                    {r&&<span className={'chip '+r.chip}>{r.label}</span>}
                    {f.custName&&<span className="chip"><i className="ti ti-user"/>{f.custName}</span>}
                    {(f.tags||[]).map(t=><span key={t} className="chip">{t}</span>)}
                  </div>
                  {(f.comment||f.content)&&<div style={{fontSize:13.5,fontWeight:500}}>{f.comment||f.content}</div>}
                  <div className="hint" style={{marginTop:2}}>{new Date(f.ts).toLocaleString('vi',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</div>
                </div>
                {isManager&&<button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>del(f.id)}><i className="ti ti-trash" style={{fontSize:16}}/></button>}
              </div>
            );
          })}
        </div>
      </div>
      <p className="hint" style={{textAlign:'center'}}>Góp ý do khách hàng tự gửi từ app khách (đăng nhập bằng SĐT).</p>
    </div>
  );
}

/* ================= Settings (manager) ================= */
/* ================= Các màn của QUẢN LÝ =================
   Gom theo việc quản lý cái gì: tiền (Kinh doanh) · đồ & việc trong quán (Vận hành)
   · người (Nhân sự) · danh mục ít đổi (Cài đặt). Khách nằm ở màn Khách.
   Mỗi mục chỉ có 1 chỗ duy nhất, sâu tối đa 1 lớp tab. */
function BizView({s}){
  const [tab,setTab]=useState('book');
  return (
    <div>
      <Seg cur={tab} onPick={setTab} tabs={[
        {id:'book',label:'Sổ sách',icon:'ti-book'},
        {id:'chotca',label:'Chốt ca',icon:'ti-cash-register'},
        {id:'grow',label:'Tăng doanh số',icon:'ti-chart-line'},
        {id:'promo',label:'Khuyến mãi',icon:'ti-gift'},
        {id:'tour',label:'Giải đấu',icon:'ti-trophy'},
      ]}/>
      {tab==='book'&&<Ledger sessions={s.sessions} tours={s.tours} signups={s.signups}/>}
      {tab==='chotca'&&<ChotCa sessions={s.sessions} chotca={s.chotca} setChotca={s.setChotca} me={s.me} flash={s.flash}/>}
      {tab==='grow'&&<GrowthView sessions={s.sessions} customers={s.customers} growth={s.growth} setGrowth={s.setGrowth} flash={s.flash}/>}
      {tab==='promo'&&<PromoMgr promos={s.promos} setPromos={s.setPromos} flash={s.flash}/>}
      {tab==='tour'&&<TourMgr tours={s.tours} setTours={s.setTours} signups={s.signups} flash={s.flash}/>}
    </div>
  );
}
function OpsView({s}){
  const [tab,setTab]=useState('tasks');
  const late=(s.lockers||[]).filter(l=>lockerBusy(l)&&l.dueDate&&daysLeft(l.dueDate)<0).length;
  const dueMaint=(s.maint||[]).filter(m=>m.due&&daysLeft(m.due)<=0).length;
  return (
    <div>
      <Seg cur={tab} onPick={setTab} tabs={[
        {id:'tasks',label:'Đầu việc',icon:'ti-checklist'},
        {id:'locker',label:'Tủ gửi gậy',icon:'ti-lock',badge:late},
        {id:'cue',label:'Gậy quán',icon:'ti-cricket'},
        {id:'stock',label:'Kho',icon:'ti-box-seam'},
        {id:'maint',label:'Bảo trì',icon:'ti-tools',badge:dueMaint},
      ]}/>
      {tab==='tasks'&&<TasksView s={s}/>}
      {tab==='locker'&&<LockerBoard s={s}/>}
      {tab==='cue'&&<CueStock cues={s.cues} setCues={s.setCues} tables={s.tables} me={s.me} isManager={s.isManager} flash={s.flash}/>}
      {tab==='stock'&&<InventoryView s={s}/>}
      {tab==='maint'&&<MaintView maint={s.maint} setMaint={s.setMaint} flash={s.flash}/>}
    </div>
  );
}
function HRView({s}){
  const [tab,setTab]=useState('team');
  return (
    <div>
      <Seg cur={tab} onPick={setTab} tabs={[
        {id:'team',label:'Cả đội',icon:'ti-users'},
        {id:'sched',label:'Phân ca',icon:'ti-calendar'},
        {id:'pay',label:'Lỗi & lương',icon:'ti-cash'},
        {id:'staff',label:'Nhân viên',icon:'ti-id-badge-2'},
        {id:'train',label:'Đào tạo',icon:'ti-school'},
        {id:'me',label:'Ca của tôi',icon:'ti-user'},
      ]}/>
      {tab==='team'&&<TeamAttend attend={s.attend} schedule={s.schedule} staff={s.staff}/>}
      {tab==='sched'&&<ScheduleEditor schedule={s.schedule} setSchedule={s.setSchedule} staff={s.staff} attend={s.attend} flash={s.flash}/>}
      {tab==='pay'&&<div>
        <LogViolation violations={s.violations} setViolations={s.setViolations} penaltyRules={s.penaltyRules} staff={s.staff} me={s.me} flash={s.flash}/>
        <PenaltyPayroll penaltyRules={s.penaltyRules} setPenaltyRules={s.setPenaltyRules} violations={s.violations} attend={s.attend} staff={s.staff} flash={s.flash}/>
      </div>}
      {tab==='staff'&&<StaffMgr staff={s.staff} setStaff={s.setStaff} flash={s.flash}/>}
      {tab==='train'&&<TrainView s={s}/>}
      {tab==='me'&&<div><MyShift s={s}/><MyViolations violations={s.violations} me={s.me}/></div>}
    </div>
  );
}
function SetupView({s}){
  const [tab,setTab]=useState('menu');
  return (
    <div>
      <Seg cur={tab} onPick={setTab} tabs={[
        {id:'menu',label:'Thực đơn',icon:'ti-list'},
        {id:'tables',label:'Bàn & giá',icon:'ti-layout-grid'},
        {id:'qr',label:'QR bàn',icon:'ti-qrcode'},
      ]}/>
      <p className="hint" style={{marginBottom:10}}>Danh mục nền của quán — ít phải đổi, sửa ở đây là cả app theo.</p>
      {tab==='menu'&&<MenuMgr menu={s.menu} setMenu={s.setMenu} flash={s.flash}/>}
      {tab==='tables'&&<BanMgr tables={s.tables} setTables={s.setTables} endTasks={s.endTasks} setEndTasks={s.setEndTasks} flash={s.flash}/>}
      {tab==='qr'&&<QRMgr tables={s.tables} cloud={s.cloud}/>}
    </div>
  );
}
/* ===== Sổ sách: doanh số ngày & tháng ===== */
const revOfDay=(sessions,d)=>sessions.filter(x=>x.endTs&&dayKey(x.endTs)===d);
const revOfMonth=(sessions,ym)=>sessions.filter(x=>x.endTs&&monthOf(dayKey(x.endTs))===ym);
const sumRev=(list)=>list.reduce((a,x)=>({table:a.table+(x.tableAmt||0),item:a.item+(x.itemAmt||0),
  disc:a.disc+(x.disc||0),total:a.total+(x.total||0)}),{table:0,item:0,disc:0,total:0});
const prevMonth=(ym)=>{const [y,m]=ym.split('-').map(Number);const d=new Date(y,m-2,1);return d.getFullYear()+'-'+pad(d.getMonth()+1);};

/* ===== CHỐT SỔ CUỐI CA — đối chiếu tiền mặt trong két với doanh số đã tính =====

   Vì sao phải có: sổ sách của app tính MỘT CHIỀU — cộng các bill đã chốt rồi in ra một
   con số. Con số ấy trả lời "quán đáng lẽ thu bao nhiêu", không trả lời "két có đúng
   chừng ấy không". Chênh lệch giữa hai vế là chỗ tiền thật của quán rơi ra: bill quên
   chốt, khách chuyển khoản mà vẫn tính vào tiền mặt, nhân viên lấy tiền két đi mua đá
   rồi quên ghi. Không vế thứ hai thì mọi lối rơi ấy đều câm — sổ vẫn đẹp, số vẫn cộng
   đúng, chỉ két là thiếu.

   ⛔ CHƯA ĐẾM KÉT THÌ KHÔNG KẾT LUẬN LỆCH. `demDuoc` để trống trả `lech: null` chứ không
   trả 0 hay số âm: coi "chưa đếm" là "đếm được 0đ" thì mỗi ca mở ra đã thấy báo thiếu
   đúng bằng doanh số, và một cảnh báo luôn đỏ là cảnh báo hết ai đọc.

   ⛔ TIỀN ĐẦU CA VÀ KHOẢN CHI PHẢI VÀO PHÉP TÍNH, không để người chốt tự trừ nhẩm —
   trừ nhẩm là nguồn lệch riêng của nó, và lúc ấy con số cuối không còn kiểm lại được. */
/* Đọc số người gõ. ⚠ Dấu chấm và dấu phẩy ở đây là PHÂN CÁCH NGHÌN, không phải dấu thập
   phân: người Việt gõ "1.500.000", mà `Number('1.500.000')` ra NaN. Giữ chúng lại là mỗi ô
   gõ đủ dấu chấm đọc thành 0 và bảng chốt ca báo thiếu đúng bằng số ấy. Tiền quán tính
   theo nghìn nên không có phần lẻ để mất. */
const soTien=v=>{const n=Number(String(v==null?'':v).replace(/[^0-9-]/g,''));return isFinite(n)?n:0;};
function tinhChotCa({sessions,tuTs,denTs,dauCa,chuyenKhoan,chiTrongCa,demDuoc}){
  const tu=Number(tuTs)||0, den=Number(denTs)||0;
  const trongCa=(sessions||[]).filter(x=>x.endTs&&x.endTs>=tu&&x.endTs<=den);
  const r=sumRev(trongCa);
  const dau=soTien(dauCa), ck=soTien(chuyenKhoan), chi=soTien(chiTrongCa);
  const tienMatPhaiCo=dau+r.total-ck-chi;
  /* Chuỗi rỗng, khoảng trắng, null đều là CHƯA ĐẾM. Số 0 là đã đếm và két rỗng thật. */
  const daDem=!(demDuoc===''||demDuoc==null||String(demDuoc).trim()==='');
  const dem=daDem?soTien(demDuoc):null;
  return {
    soLuot:trongCa.length, tienBan:r.table, tienDo:r.item, giam:r.disc, doanhSo:r.total,
    dauCa:dau, chuyenKhoan:ck, chiTrongCa:chi, tienMatPhaiCo, demDuoc:dem,
    lech: daDem? dem-tienMatPhaiCo : null,
  };
}
/* Ngưỡng bỏ qua: lệch dưới mức này là tiền lẻ trả lại, không phải chuyện phải truy.
   Đây là dòng khai giá trị ĐANG CÓ HIỆU LỰC. */
const NGUONG_LECH=10000;
function mucLech(lech){
  if(lech==null) return {k:'chua',t:'Chưa đếm két nên chưa đối chiếu được'};
  if(Math.abs(lech)<NGUONG_LECH) return {k:'khop',t:'Khớp (lệch dưới '+fmtVnd(NGUONG_LECH)+')'};
  return lech>0? {k:'thua',t:'Két THỪA '+fmtVnd(lech)} : {k:'thieu',t:'Két THIẾU '+fmtVnd(-lech)};
}

function Ledger({sessions,tours,signups}){
  const [ym,setYm]=useState(thisMonth());
  const td=sumRev(revOfDay(sessions,today()));
  const tdCount=revOfDay(sessions,today()).length;
  const mo=revOfMonth(sessions,ym);
  const mSum=sumRev(mo);
  const days={};
  mo.forEach(x=>{const k=dayKey(x.endTs);days[k]=days[k]||[];days[k].push(x);});
  const dayList=Object.keys(days).sort().reverse();
  const feeRev=(signups||[]).filter(s=>s.paid).reduce((a,s)=>{const t=(tours||[]).find(x=>x.id===s.tourId);return a+(t?Number(t.entryFee)||0:0);},0);
  return (
    <div>
      <div className="card" style={{marginBottom:14,textAlign:'center'}}>
        <div className="hint">Doanh số hôm nay · {dayName(today())} {fmtDateVN(today())}</div>
        <div style={{fontFamily:'"Baloo 2"',fontSize:34,fontWeight:800,color:'var(--g)'}}>{fmtVnd(td.total)}</div>
        <div className="hint">{tdCount} lượt bàn · tiền bàn {fmtVnd(td.table)} · đồ {fmtVnd(td.item)}</div>
      </div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-book lead"/><b>Tổng tháng</b>
          <input type="month" className="inp" style={{width:'auto',padding:'7px 10px'}} value={ym} onChange={e=>setYm(e.target.value)}/></div>
        <div className="panel-b">
          <div className="grid-stat" style={{marginBottom:10}}>
            <div className="stat"><div className="ic gr"><i className="ti ti-cash"/></div><div className="n" style={{fontSize:19}}>{fmtVnd(mSum.total)}</div><div className="l">Tổng doanh số</div></div>
            <div className="stat"><div className="ic g"><i className="ti ti-clock"/></div><div className="n" style={{fontSize:19}}>{fmtVnd(mSum.table)}</div><div className="l">Tiền bàn</div></div>
            <div className="stat"><div className="ic a"><i className="ti ti-glass-full"/></div><div className="n" style={{fontSize:19}}>{fmtVnd(mSum.item)}</div><div className="l">Tiền đồ</div></div>
            <div className="stat"><div className="ic b"><i className="ti ti-users"/></div><div className="n">{mo.length}</div><div className="l">Lượt bàn</div></div>
          </div>
          {mo.length>0&&<div className="hint">Trung bình {fmtVnd(mSum.total/mo.length)}/lượt · đồ chiếm {Math.round(mSum.item/(mSum.total||1)*100)}% doanh số</div>}
          {mSum.disc>0&&<div className="hint" style={{marginTop:4}}>Đã giảm cho khách theo hạng: <b style={{color:'var(--grn)'}}>−{fmtVnd(mSum.disc)}</b> (đã trừ vào tổng doanh số)</div>}
          {feeRev>0&&<div className="hint" style={{marginTop:4}}>Ngoài ra: lệ phí giải đã thu <b>{fmtVnd(feeRev)}</b> (chưa tính vào bảng trên)</div>}
        </div>
      </div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-calendar lead"/><b>Chi tiết theo ngày</b></div>
        <div className="tbl-scroll">
          <table className="data">
            <thead><tr><th>Ngày</th><th>Lượt</th><th>Tiền bàn</th><th>Tiền đồ</th><th>Tổng</th></tr></thead>
            <tbody>
              {dayList.length===0&&<tr><td colSpan="5" style={{textAlign:'center',color:'var(--muted2)',padding:20}}>Chưa có bill nào chốt trong tháng này</td></tr>}
              {dayList.map(d=>{const s=sumRev(days[d]);return (
                <tr key={d}><td>{dayName(d)} {fmtDateVN(d).slice(0,5)}</td><td>{days[d].length}</td>
                  <td>{fmtVnd(s.table)}</td><td>{fmtVnd(s.item)}</td>
                  <td><b style={{color:'var(--g)',fontFamily:'"Baloo 2"'}}>{fmtVnd(s.total)}</b></td></tr>
              );})}
            </tbody>
          </table>
        </div>
      </div>
      <p className="hint" style={{textAlign:'center'}}>Doanh số tự tính từ bill đã chốt ở mục <b>Bàn</b> (tiền giờ + đồ đã gọi).</p>
    </div>
  );
}

/* Màn chốt ca: nhập bốn con số, app tự đối chiếu với doanh số của đúng khoảng ca đó. */
function ChotCa({sessions,chotca,setChotca,me,flash}){
  const gioTruoc=(h)=>{const d=new Date();d.setHours(d.getHours()-h,0,0,0);return d;};
  const dtLocal=(d)=>d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate())+'T'+pad(d.getHours())+':'+pad(d.getMinutes());
  const [tu,setTu]=useState(()=>dtLocal(gioTruoc(8)));
  const [den,setDen]=useState(()=>dtLocal(new Date()));
  const [dauCa,setDauCa]=useState('');
  const [ck,setCk]=useState('');
  const [chi,setChi]=useState('');
  const [dem,setDem]=useState('');
  const [ghi,setGhi]=useState('');
  const r=tinhChotCa({sessions,tuTs:new Date(tu).getTime(),denTs:new Date(den).getTime(),
    dauCa,chuyenKhoan:ck,chiTrongCa:chi,demDuoc:dem});
  const m=mucLech(r.lech);
  const mau=m.k==='khop'?'var(--grn)':m.k==='chua'?'var(--muted2)':'var(--r)';
  const luu=()=>{
    if(r.lech==null){flash('Đếm tiền trong két rồi nhập vào đã');return;}
    /* Lệch lớn mà không ghi lý do thì bản chốt sổ không dùng được về sau: ba tháng nữa
       nhìn lại chỉ thấy một con số âm mà không ai nhớ vì sao. */
    if(Math.abs(r.lech)>=NGUONG_LECH&&!ghi.trim()){flash('Lệch '+fmtVnd(Math.abs(r.lech))+' — ghi lại lý do đã');return;}
    setChotca(v=>[{id:'cc_'+uid(),tuTs:new Date(tu).getTime(),denTs:new Date(den).getTime(),
      boi:(me&&me.name)||'',luc:Date.now(),ghi:ghi.trim(),
      soLuot:r.soLuot,doanhSo:r.doanhSo,dauCa:r.dauCa,chuyenKhoan:r.chuyenKhoan,
      chiTrongCa:r.chiTrongCa,tienMatPhaiCo:r.tienMatPhaiCo,demDuoc:r.demDuoc,lech:r.lech},...(v||[])]);
    setDem('');setGhi('');setChi('');setCk('');setDauCa('');
    flash('Đã chốt ca');
  };
  const ds=(chotca||[]).slice(0,20);
  return (
    <div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-cash-register lead"/><b>Chốt ca này</b></div>
        <div className="panel-b">
          <div className="grid2" style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
            <label className="fld"><span>Ca bắt đầu</span>
              <input className="inp" type="datetime-local" value={tu} onChange={e=>setTu(e.target.value)}/></label>
            <label className="fld"><span>Ca kết thúc</span>
              <input className="inp" type="datetime-local" value={den} onChange={e=>setDen(e.target.value)}/></label>
            <label className="fld"><span>Tiền lẻ để sẵn đầu ca</span>
              <input className="inp" inputMode="numeric" value={dauCa} onChange={e=>setDauCa(e.target.value)} placeholder="0"/></label>
            <label className="fld"><span>Khách trả chuyển khoản</span>
              <input className="inp" inputMode="numeric" value={ck} onChange={e=>setCk(e.target.value)} placeholder="0"/></label>
            <label className="fld"><span>Lấy tiền két đi mua đồ</span>
              <input className="inp" inputMode="numeric" value={chi} onChange={e=>setChi(e.target.value)} placeholder="0"/></label>
            <label className="fld"><span>Đếm được trong két</span>
              <input className="inp" inputMode="numeric" value={dem} onChange={e=>setDem(e.target.value)} placeholder="đếm rồi nhập"/></label>
          </div>
          <div className="tbl-scroll" style={{marginTop:12}}>
            <table className="data">
              <tbody>
                <tr><td>Bill đã chốt trong ca</td><td style={{textAlign:'right'}}>{r.soLuot} lượt</td></tr>
                <tr><td>Doanh số (bàn {fmtVnd(r.tienBan)} · đồ {fmtVnd(r.tienDo)})</td>
                  <td style={{textAlign:'right'}}><b>{fmtVnd(r.doanhSo)}</b></td></tr>
                <tr><td>Tiền mặt đáng lẽ có trong két</td>
                  <td style={{textAlign:'right'}}><b>{fmtVnd(r.tienMatPhaiCo)}</b></td></tr>
                <tr><td>Đếm được</td><td style={{textAlign:'right'}}>{r.demDuoc==null?'—':fmtVnd(r.demDuoc)}</td></tr>
              </tbody>
            </table>
          </div>
          <div className="card" style={{marginTop:10,textAlign:'center',borderLeft:'4px solid '+mau}}>
            <div style={{fontFamily:'"Baloo 2"',fontSize:24,fontWeight:800,color:mau}}>{m.t}</div>
            <div className="hint">Đáng lẽ có = tiền lẻ đầu ca + doanh số − chuyển khoản − tiền lấy đi mua đồ</div>
          </div>
          <label className="fld" style={{marginTop:10}}><span>Ghi chú (bắt buộc khi lệch từ {fmtVnd(NGUONG_LECH)})</span>
            <input className="inp" value={ghi} onChange={e=>setGhi(e.target.value)} placeholder="vd: bàn 7 quên chốt bill, khách nợ 50k"/></label>
          <button className="btn pri block" style={{marginTop:10}} onClick={luu}><i className="ti ti-lock-check"/>Chốt ca</button>
        </div>
      </div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-history lead"/><b>Các ca đã chốt</b></div>
        <div className="tbl-scroll">
          <table className="data">
            <thead><tr><th>Ca</th><th>Doanh số</th><th>Đếm được</th><th>Lệch</th><th>Người chốt</th></tr></thead>
            <tbody>
              {ds.length===0&&<tr><td colSpan="5" style={{textAlign:'center',color:'var(--muted2)',padding:20}}>Chưa chốt ca nào</td></tr>}
              {ds.map(c=>{const mm=mucLech(c.lech);return (
                <tr key={c.id}>
                  <td>{fmtDateVN(dayKey(c.denTs)).slice(0,5)} {pad(new Date(c.tuTs).getHours())}h–{pad(new Date(c.denTs).getHours())}h</td>
                  <td>{fmtVnd(c.doanhSo)}</td><td>{fmtVnd(c.demDuoc)}</td>
                  <td style={{color:mm.k==='khop'?'var(--grn)':'var(--r)',fontWeight:700}}>
                    {mm.k==='khop'?'khớp':(c.lech>0?'+':'')+fmtVnd(c.lech)}</td>
                  <td>{c.boi||'—'}{c.ghi?<div className="hint">{c.ghi}</div>:null}</td>
                </tr>
              );})}
            </tbody>
          </table>
        </div>
      </div>
      <p className="hint" style={{textAlign:'center'}}>Doanh số lấy từ bill đã chốt ở mục <b>Bàn</b> trong đúng khoảng ca.
        Lệch thường đến từ bill quên chốt, khách chuyển khoản mà chưa khai, hoặc tiền lấy đi mua đồ chưa ghi.</p>
    </div>
  );
}

/* ===== Tăng doanh số: phân tích + to-do ===== */
function GrowthView({sessions,customers,growth,setGrowth,flash}){
  const [tab,setTab]=useState('an'); // an | todo
  const ym=thisMonth(),pm=prevMonth(ym);
  const cur=sumRev(revOfMonth(sessions,ym)),prev=sumRev(revOfMonth(sessions,pm));
  const curN=revOfMonth(sessions,ym).length,prevN=revOfMonth(sessions,pm).length;
  const pct=(a,b)=>b>0?Math.round((a-b)/b*100):(a>0?100:0);
  const Delta=({now,before,money})=>{
    const p=pct(now,before);const up=p>=0;
    return <span className={'chip '+(up?'gr':'r')}>{up?'▲':'▼'} {Math.abs(p)}%</span>;
  };
  // Phân tích khách từ phiên đã chốt
  const seen={};
  sessions.filter(x=>x.endTs&&x.custId).forEach(x=>{
    const o=seen[x.custId]=seen[x.custId]||{first:x.endTs,last:x.endTs,n:0,cur:0,prev:0,spend:0};
    o.first=Math.min(o.first,x.endTs);o.last=Math.max(o.last,x.endTs);o.n++;o.spend+=x.total||0;
    const m=monthOf(dayKey(x.endTs)); if(m===ym)o.cur++; else if(m===pm)o.prev++;
  });
  const withInfo=customers.map(c=>({c,i:seen[c.id]})).filter(x=>x.i);
  const fading=withInfo.filter(x=>x.i.prev>0&&x.i.cur<x.i.prev).sort((a,b)=>(b.i.prev-b.i.cur)-(a.i.prev-a.i.cur));
  const gone=withInfo.filter(x=>Date.now()-x.i.last>21*86400000).sort((a,b)=>a.i.last-b.i.last);
  const fresh=withInfo.filter(x=>Date.now()-x.i.first<30*86400000).sort((a,b)=>b.i.first-a.i.first);
  const daysAgo=(ts)=>Math.round((Date.now()-ts)/86400000);

  const toggleSub=(gid,sid)=>setGrowth(v=>v.map(g=>g.id!==gid?g:{...g,subs:g.subs.map(s=>s.id===sid?{...s,done:!s.done}:s)}));
  const [nt,setNt]=useState('');
  const addTask=()=>{if(!nt.trim())return;setGrowth(v=>[...v,{id:uid(),title:nt.trim(),done:false,subs:[]}]);setNt('');};
  const delTask=(gid)=>{if(confirm('Xoá mục này?'))setGrowth(v=>v.filter(g=>g.id!==gid));};
  const [ns,setNs]=useState({});
  const addSub=(gid)=>{const t=(ns[gid]||'').trim();if(!t)return;setGrowth(v=>v.map(g=>g.id===gid?{...g,subs:[...g.subs,{id:uid(),text:t,done:false}]}:g));setNs(x=>({...x,[gid]:''}));};
  const delSub=(gid,sid)=>setGrowth(v=>v.map(g=>g.id===gid?{...g,subs:g.subs.filter(s=>s.id!==sid)}:g));

  return (
    <div>
      <div className="seg">
        <button className={tab==='an'?'on':''} onClick={()=>setTab('an')}><i className="ti ti-chart-line"/>Phân tích</button>
        <button className={tab==='todo'?'on':''} onClick={()=>setTab('todo')}><i className="ti ti-checklist"/>Việc cần làm</button>
      </div>

      {tab==='an'&&(
        <div>
          <div className="panel">
            <div className="panel-h"><i className="ti ti-chart-line lead"/><b>Tháng này so tháng trước</b></div>
            <div className="tbl-scroll">
              <table className="data">
                <thead><tr><th>Chỉ số</th><th>Tháng trước</th><th>Tháng này</th><th>Thay đổi</th></tr></thead>
                <tbody>
                  <tr><td style={{fontWeight:600}}>Doanh số</td><td>{fmtVnd(prev.total)}</td><td><b>{fmtVnd(cur.total)}</b></td><td><Delta now={cur.total} before={prev.total}/></td></tr>
                  <tr><td style={{fontWeight:600}}>Tiền bàn</td><td>{fmtVnd(prev.table)}</td><td><b>{fmtVnd(cur.table)}</b></td><td><Delta now={cur.table} before={prev.table}/></td></tr>
                  <tr><td style={{fontWeight:600}}>Tiền đồ</td><td>{fmtVnd(prev.item)}</td><td><b>{fmtVnd(cur.item)}</b></td><td><Delta now={cur.item} before={prev.item}/></td></tr>
                  <tr><td style={{fontWeight:600}}>Lượt bàn</td><td>{prevN}</td><td><b>{curN}</b></td><td><Delta now={curN} before={prevN}/></td></tr>
                  <tr><td style={{fontWeight:600}}>TB / lượt</td><td>{fmtVnd(prevN?prev.total/prevN:0)}</td><td><b>{fmtVnd(curN?cur.total/curN:0)}</b></td><td><Delta now={curN?cur.total/curN:0} before={prevN?prev.total/prevN:0}/></td></tr>
                </tbody>
              </table>
            </div>
            {curN===0&&prevN===0&&<p className="hint" style={{padding:'10px 16px'}}>Chưa có bill nào — chốt bill ở mục <b>Bàn</b> để có số liệu.</p>}
          </div>

          <div className="panel">
            <div className="panel-h"><i className="ti ti-trending-down lead" style={{color:'var(--red)'}}/><b>Khách đang chơi ít đi</b><span className="chip r">{fading.length}</span></div>
            <div className="panel-b" style={{paddingTop:6}}>
              {fading.length===0&&<p className="hint">Chưa phát hiện khách nào giảm tần suất.</p>}
              {fading.slice(0,8).map(({c,i})=>(
                <div className="custrow" key={c.id}>
                  <CustPic c={c} size={38}/>
                  <div className="ci"><b>{c.name} {c.vip&&<i className="ti ti-crown" style={{color:'var(--amber)',fontSize:14}}/>}</b>
                    <small>{c.phone||'—'} · tháng trước {i.prev} lượt → tháng này {i.cur} lượt</small></div>
                  <span className="chip r">−{i.prev-i.cur}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-h"><i className="ti ti-clock-x lead" style={{color:'var(--amber)'}}/><b>Lâu chưa quay lại (&gt;21 ngày)</b><span className="chip a">{gone.length}</span></div>
            <div className="panel-b" style={{paddingTop:6}}>
              {gone.length===0&&<p className="hint">Không có khách nào vắng lâu. Tốt!</p>}
              {gone.slice(0,8).map(({c,i})=>(
                <div className="custrow" key={c.id}>
                  <CustPic c={c} size={38}/>
                  <div className="ci"><b>{c.name}</b><small>{c.phone||'—'} · đã chi {fmtVnd(i.spend)} · {i.n} lượt</small></div>
                  <span className="chip a">{daysAgo(i.last)} ngày</span>
                </div>
              ))}
              {gone.length>0&&<p className="hint" style={{marginTop:8}}>💡 Gửi tin khuyến mãi cho nhóm này ở mục <b>Gửi tin</b>.</p>}
            </div>
          </div>

          <div className="panel">
            <div className="panel-h"><i className="ti ti-sparkles lead" style={{color:'var(--grn)'}}/><b>Khách mới cần quan tâm (30 ngày)</b><span className="chip gr">{fresh.length}</span></div>
            <div className="panel-b" style={{paddingTop:6}}>
              {fresh.length===0&&<p className="hint">Chưa có khách mới trong 30 ngày.</p>}
              {fresh.slice(0,8).map(({c,i})=>(
                <div className="custrow" key={c.id}>
                  <CustPic c={c} size={38}/>
                  <div className="ci"><b>{c.name}</b><small>{c.phone||'—'} · {i.n} lượt · đã chi {fmtVnd(i.spend)}</small></div>
                  <span className="chip gr">{daysAgo(i.first)} ngày trước</span>
                </div>
              ))}
              {fresh.length>0&&<p className="hint" style={{marginTop:8}}>💡 Nhớ mặt & tên, mời tích điểm để giữ chân.</p>}
            </div>
          </div>
          <p className="hint" style={{textAlign:'center'}}>Phân tích dựa trên bill đã chốt có gắn khách quen.</p>
        </div>
      )}

      {tab==='todo'&&(
        <div>
          {growth.map(g=>{
            const dn=g.subs.filter(s=>s.done).length,tot=g.subs.length;
            const pctv=tot?Math.round(dn/tot*100):0;
            return (
              <div className="panel" key={g.id}>
                <div className="panel-h"><i className="ti ti-target lead"/><b>{g.title}</b>
                  <span className={'chip '+(pctv===100?'gr':'')}>{dn}/{tot}</span>
                  <button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>delTask(g.id)}><i className="ti ti-trash" style={{fontSize:16}}/></button></div>
                <div className="panel-b" style={{paddingTop:8}}>
                  <div className={'prog'+(pctv===100?' full':'')} style={{marginBottom:10}}><i style={{width:pctv+'%'}}/></div>
                  {g.subs.map(s=>(
                    <div className="row" key={s.id}>
                      <div className={'chk'+(s.done?' done':'')} onClick={()=>toggleSub(g.id,s.id)}>{s.done&&<i className="ti ti-check"/>}</div>
                      <div style={{flex:1,fontWeight:500,textDecoration:s.done?'line-through':'none',color:s.done?'var(--muted)':'var(--ink)'}}>{s.text}</div>
                      <button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>delSub(g.id,s.id)}><i className="ti ti-x" style={{fontSize:15}}/></button>
                    </div>
                  ))}
                  <div style={{display:'flex',gap:8,marginTop:10}}>
                    <input className="inp" value={ns[g.id]||''} onChange={e=>setNs(x=>({...x,[g.id]:e.target.value}))} onKeyDown={e=>e.key==='Enter'&&addSub(g.id)} placeholder="Thêm việc nhỏ…"/>
                    <button className="btn" onClick={()=>addSub(g.id)}><i className="ti ti-plus"/></button>
                  </div>
                </div>
              </div>
            );
          })}
          <div className="panel"><div className="panel-b">
            <div style={{display:'flex',gap:8}}>
              <input className="inp" value={nt} onChange={e=>setNt(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addTask()} placeholder="Thêm nhóm việc mới…"/>
              <button className="btn" onClick={addTask}><i className="ti ti-plus"/>Thêm</button>
            </div>
          </div></div>
        </div>
      )}
    </div>
  );
}

/* ===== Lịch bảo trì (lặp theo chu kỳ) ===== */
function MaintView({maint,setMaint,flash}){
  const [nf,setNf]=useState({name:'',everyDays:30,note:''});
  const list=[...maint].sort((a,b)=>(a.due||'').localeCompare(b.due||''));
  const done=(m)=>{const nd=addDays(today(),Number(m.everyDays)||30);
    setMaint(v=>v.map(x=>x.id===m.id?{...x,lastDone:today(),due:nd}:x));flash('Đã làm xong · hạn kế tiếp '+fmtDateVN(nd));};
  const del=(id)=>{if(confirm('Xoá việc bảo trì này?'))setMaint(v=>v.filter(x=>x.id!==id));};
  const patch=(id,o)=>setMaint(v=>v.map(x=>x.id===id?{...x,...o}:x));
  const add=()=>{if(!nf.name.trim()){flash('Nhập tên việc');return;}
    setMaint(v=>[...v,{id:uid(),name:nf.name.trim(),note:nf.note.trim(),everyDays:Number(nf.everyDays)||30,due:addDays(today(),Number(nf.everyDays)||30),lastDone:''}]);
    setNf({name:'',everyDays:30,note:''});flash('Đã thêm việc bảo trì');};
  const overdue=list.filter(m=>daysLeft(m.due)<0).length;
  const soon=list.filter(m=>{const d=daysLeft(m.due);return d>=0&&d<=7;}).length;
  return (
    <div>
      <div className="grid-stat">
        <div className="stat"><div className="ic r"><i className="ti ti-alert-triangle"/></div><div className="n">{overdue}</div><div className="l">Quá hạn</div></div>
        <div className="stat"><div className="ic a"><i className="ti ti-clock"/></div><div className="n">{soon}</div><div className="l">Tới hạn ≤7 ngày</div></div>
      </div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-tools lead"/><b>Lịch bảo trì / bảo dưỡng</b></div>
        <div className="panel-b" style={{paddingTop:6}}>
          {list.length===0&&<Empty icon="ti-tools-off" text="Chưa có việc bảo trì nào"/>}
          {list.map(m=>{
            const d=daysLeft(m.due);
            const st=d<0?{t:'Quá hạn '+(-d)+' ngày',c:'r'}:d===0?{t:'Hôm nay',c:'a'}:d<=7?{t:'Còn '+d+' ngày',c:'a'}:{t:'Còn '+d+' ngày',c:''};
            return (
              <div className="row" key={m.id} style={{alignItems:'flex-start',flexWrap:'wrap'}}>
                <span style={{fontSize:20}}>{d<0?'🔴':d<=7?'🟡':'🟢'}</span>
                <div style={{flex:1,minWidth:140}}>
                  <div style={{fontWeight:600}}>{m.name}</div>
                  {m.note&&<div className="hint">{m.note}</div>}
                  <div className="hint">Hạn {fmtDateVN(m.due)} · mỗi {m.everyDays} ngày{m.lastDone?' · lần cuối '+fmtDateVN(m.lastDone):' · chưa làm lần nào'}</div>
                </div>
                <span className={'chip '+st.c}>{st.t}</span>
                <label style={{display:'flex',alignItems:'center',gap:4}}>
                  <input className="inp" type="number" min="1" style={{width:64,padding:'5px 7px'}} value={m.everyDays} onChange={e=>patch(m.id,{everyDays:Number(e.target.value)||1})}/><span className="hint">ngày</span></label>
                <button className="btn sm" onClick={()=>done(m)}><i className="ti ti-check"/>Đã làm</button>
                <button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>del(m.id)}><i className="ti ti-trash" style={{fontSize:16}}/></button>
              </div>
            );
          })}
          <div className="sep"/>
          <div style={{display:'flex',gap:8,alignItems:'flex-end',flexWrap:'wrap'}}>
            <label className="fld" style={{flex:1,minWidth:130,marginBottom:0}}><span>Thêm việc bảo trì</span>
              <input className="inp" value={nf.name} onChange={e=>setNf({...nf,name:e.target.value})} placeholder="VD: Thay băng bàn"/></label>
            <label className="fld" style={{flex:1,minWidth:120,marginBottom:0}}><span>Ghi chú</span>
              <input className="inp" value={nf.note} onChange={e=>setNf({...nf,note:e.target.value})} placeholder="Tuỳ chọn"/></label>
            <label style={{display:'flex',alignItems:'center',gap:4}}><input className="inp" type="number" min="1" style={{width:70}} value={nf.everyDays} onChange={e=>setNf({...nf,everyDays:e.target.value})}/><span className="hint">ngày/lần</span></label>
            <button className="btn" onClick={add}><i className="ti ti-plus"/>Thêm</button>
          </div>
          <p className="hint" style={{marginTop:10}}>Bấm “Đã làm” → app tự đặt hạn lần sau theo chu kỳ. Cần mua/thay đồ → xem mục <b>Kiểm kho</b>.</p>
        </div>
      </div>
    </div>
  );
}
function BanMgr({tables,setTables,endTasks,setEndTasks,flash}){
  const [nf,setNf]=useState({type:'Tiêu chuẩn',price:60000});
  const nextNo=tables.reduce((m,t)=>Math.max(m,t.no),0)+1;
  const add=()=>{setTables(v=>[...v,{id:'t'+uid(),no:nextNo,type:nf.type.trim()||'Tiêu chuẩn',price:Number(nf.price)||0}]);flash('Đã thêm bàn '+nextNo);};
  const del=(id)=>{if(confirm('Xoá bàn này?'))setTables(v=>v.filter(t=>t.id!==id));};
  const patch=(id,obj)=>setTables(v=>v.map(t=>t.id===id?{...t,...obj}:t));
  const [etTxt,setEtTxt]=useState('');
  const addEt=()=>{if(!etTxt.trim())return;setEndTasks(v=>[...v,{id:uid(),text:etTxt.trim()}]);setEtTxt('');};
  const delEt=(id)=>setEndTasks(v=>v.filter(t=>t.id!==id));
  return (
    <div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-layout-grid lead"/><b>Danh sách bàn ({tables.length})</b></div>
        <div className="tbl-scroll">
          <table className="data">
            <thead><tr><th>Bàn</th><th>Loại</th><th>Giá / giờ</th><th></th></tr></thead>
            <tbody>
              {tables.slice().sort((a,b)=>a.no-b.no).map(t=>(
                <tr key={t.id}>
                  <td style={{fontWeight:700,fontFamily:'"Baloo 2"'}}>{t.no}</td>
                  <td><input className="inp" style={{width:120,padding:'6px 8px'}} value={t.type||''} onChange={e=>patch(t.id,{type:e.target.value})}/></td>
                  <td><input className="inp" type="number" style={{width:100,padding:'6px 8px'}} value={t.price||0} onChange={e=>patch(t.id,{price:Number(e.target.value)||0})}/></td>
                  <td><button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>del(t.id)}><i className="ti ti-trash" style={{fontSize:16}}/></button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="panel-b" style={{borderTop:'1px solid var(--border)'}}>
          <div style={{display:'flex',gap:8,alignItems:'flex-end',flexWrap:'wrap'}}>
            <label className="fld" style={{flex:1,minWidth:120,marginBottom:0}}><span>Loại bàn mới</span><input className="inp" value={nf.type} onChange={e=>setNf({...nf,type:e.target.value})} placeholder="VD: VIP / Pool Mỹ"/></label>
            <label style={{display:'flex',alignItems:'center',gap:4}}><input className="inp" type="number" style={{width:100}} value={nf.price} onChange={e=>setNf({...nf,price:e.target.value})}/><span className="hint">₫/h</span></label>
            <button className="btn" onClick={add}><i className="ti ti-plus"/>Thêm bàn {nextNo}</button>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h"><i className="ti ti-broom lead"/><b>Việc cần làm khi khách chơi xong</b></div>
        <div className="panel-b" style={{paddingTop:6}}>
          {endTasks.map(t=>(
            <div className="row" key={t.id}><div style={{flex:1,minWidth:0,fontWeight:500}}>{t.text}</div>
              <button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>delEt(t.id)}><i className="ti ti-trash" style={{fontSize:16}}/></button></div>
          ))}
          <div style={{display:'flex',gap:8,marginTop:10}}>
            <input className="inp" value={etTxt} onChange={e=>setEtTxt(e.target.value)} onKeyDown={e=>e.key==='Enter'&&addEt()} placeholder="Thêm việc dọn bàn…"/>
            <button className="btn" onClick={addEt}><i className="ti ti-plus"/></button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Khuyến mãi ---- */
function PromoMgr({promos,setPromos,flash}){
  const [edit,setEdit]=useState(null); // promo obj or 'new'
  const save=(p)=>{setPromos(v=>{const ex=v.some(x=>x.id===p.id);return ex?v.map(x=>x.id===p.id?p:x):[p,...v];});setEdit(null);flash('Đã lưu khuyến mãi');};
  const del=(id)=>{if(confirm('Xoá khuyến mãi này?'))setPromos(v=>v.filter(x=>x.id!==id));};
  const toggle=(id)=>setPromos(v=>v.map(x=>x.id===id?{...x,active:!x.active}:x));
  return (
    <div>
      <button className="btn block" style={{marginBottom:14}} onClick={()=>setEdit('new')}><i className="ti ti-plus"/>Tạo chương trình khuyến mãi</button>
      {promos.length===0&&<Empty icon="ti-gift" text="Chưa có khuyến mãi nào"/>}
      {promos.map(p=>{
        const live=promoActive(p);
        const sched=promoScheduled(p);
        const status=live?'Đang chạy':(!p.active?'Tắt':(sched?'Ngoài khung giờ':'Ngoài lịch'));
        return (
          <div className="card" key={p.id} style={{marginBottom:11}}>
            <div style={{display:'flex',alignItems:'flex-start',gap:8,marginBottom:6}}>
              <b style={{flex:1,fontSize:14.5,fontFamily:'"Baloo 2"'}}>{p.title}</b>
              {p.percent>0&&<span className="chip a">-{p.percent}%</span>}
              <span className={'chip '+(live?'gr':'')}>{status}</span>
            </div>
            <div className="hint" style={{marginBottom:8}}>{p.desc}</div>
            {p.hourStart&&p.hourEnd&&<div className="hint" style={{marginBottom:8}}><i className="ti ti-clock"/> Khung giờ {p.hourStart}–{p.hourEnd} mỗi ngày</div>}
            {(p.start||p.end)&&<div className="hint" style={{marginBottom:8}}><i className="ti ti-calendar"/> {p.start?fmtDateVN(p.start):'…'} → {p.end?fmtDateVN(p.end):'…'}</div>}
            <div className="rowbtns">
              <button className={'btn sm '+(p.active?'':'ghost')} onClick={()=>toggle(p.id)}><i className={'ti '+(p.active?'ti-toggle-right':'ti-toggle-left')}/>{p.active?'Đang bật':'Đang tắt'}</button>
              <button className="btn ghost sm" onClick={()=>setEdit(p)}><i className="ti ti-pencil"/>Sửa</button>
              <button className="btn ghost sm" onClick={()=>del(p.id)}><i className="ti ti-trash"/></button>
            </div>
          </div>
        );
      })}
      {edit&&<PromoForm promo={edit==='new'?null:edit} onSave={save} onClose={()=>setEdit(null)}/>}
    </div>
  );
}
function PromoForm({promo,onSave,onClose}){
  const [p,setP]=useState(()=>promo?{hourStart:'',hourEnd:'',...promo}:{id:uid(),title:'',desc:'',percent:0,hourStart:'',hourEnd:'',start:'',end:'',active:true});
  const save=()=>{if(!p.title.trim()){alert('Nhập tên khuyến mãi');return;}onSave({...p,title:p.title.trim(),desc:p.desc.trim(),percent:Number(p.percent)||0});};
  return (
    <Modal title={promo?'Sửa khuyến mãi':'Khuyến mãi mới'} onClose={onClose} foot={<button className="btn block" onClick={save}>Lưu khuyến mãi</button>}>
      <label className="fld"><span>Tên chương trình *</span><input className="inp" autoFocus value={p.title} onChange={e=>setP({...p,title:e.target.value})} placeholder="VD: Ưu đãi khung giờ 8h–15h"/></label>
      <label className="fld"><span>Mô tả / điều kiện</span><textarea className="inp" value={p.desc} onChange={e=>setP({...p,desc:e.target.value})} placeholder="Giảm 30% tiền bàn + tặng trà đá…"/></label>
      <label className="fld"><span>Giảm giá (%) — để 0 nếu là quà tặng/combo</span><input className="inp" type="number" min="0" max="100" value={p.percent} onChange={e=>setP({...p,percent:e.target.value})}/></label>
      <div style={{display:'flex',gap:9}}>
        <label className="fld" style={{flex:1}}><span>Khung giờ · từ</span><input className="inp" type="time" value={p.hourStart} onChange={e=>setP({...p,hourStart:e.target.value})}/></label>
        <label className="fld" style={{flex:1}}><span>Khung giờ · đến</span><input className="inp" type="time" value={p.hourEnd} onChange={e=>setP({...p,hourEnd:e.target.value})}/></label>
      </div>
      <div style={{display:'flex',gap:9}}>
        <label className="fld" style={{flex:1}}><span>Từ ngày</span><input className="inp" type="date" value={p.start} onChange={e=>setP({...p,start:e.target.value})}/></label>
        <label className="fld" style={{flex:1}}><span>Đến ngày</span><input className="inp" type="date" value={p.end} onChange={e=>setP({...p,end:e.target.value})}/></label>
      </div>
      <p className="hint">Bỏ trống khung giờ = áp dụng cả ngày. Bỏ trống ngày = vô thời hạn khi đang bật. KM chỉ hiện với khách khi đang trong khung giờ.</p>
    </Modal>
  );
}

/* ================= Tổ chức giải ================= */
// Bảng xếp hạng từ kết quả trận: thắng 2đ, thua 0đ; xếp theo điểm → hiệu số ván
function tourStandings(tourId,signups,results){
  const rows={};
  signups.filter(s=>s.tourId===tourId).forEach(s=>{rows[s.custId]={id:s.custId,name:s.custName,w:0,l:0,rf:0,ra:0};});
  results.filter(r=>r.tourId===tourId).forEach(r=>{
    const A=rows[r.aId],B=rows[r.bId]; if(!A||!B)return;
    A.rf+=r.scoreA;A.ra+=r.scoreB;B.rf+=r.scoreB;B.ra+=r.scoreA;
    if(r.scoreA>r.scoreB){A.w++;B.l++;} else if(r.scoreB>r.scoreA){B.w++;A.l++;}
  });
  return Object.values(rows).map(x=>({...x,pts:x.w*2,diff:x.rf-x.ra}))
    .sort((a,b)=>b.pts-a.pts||b.diff-a.diff||b.rf-a.rf);
}
function OrganizerView({s}){
  const {tours,setTours,signups,setSignups,results,setResults,me,flash}=s;
  const [openId,setOpenId]=useState(null);
  const t=tours.find(x=>x.id===openId);
  if(t) return <TourDetail t={t} setTours={setTours} signups={signups} setSignups={setSignups}
    results={results} setResults={setResults} me={me} flash={flash} onBack={()=>setOpenId(null)}/>;
  return <TourMgr tours={tours} setTours={setTours} signups={signups} flash={flash} onOpen={setOpenId}/>;
}
function TourDetail({t,setTours,signups,setSignups,results,setResults,me,flash,onBack}){
  const [tab,setTab]=useState('signup'); // signup | result | info
  const [edit,setEdit]=useState(false);
  const regs=signups.filter(x=>x.tourId===t.id).sort((a,b)=>a.ts-b.ts);
  const slots=Number(t.players)||0;
  const patchReg=(id,obj)=>setSignups(v=>v.map(x=>x.id===id?{...x,...obj}:x));
  const delReg=(id)=>{if(confirm('Xoá đăng ký này?'))setSignups(v=>v.filter(x=>x.id!==id));};
  const c=tourCalc(t);
  return (
    <div>
      <button className="btn ghost sm" onClick={onBack} style={{marginBottom:12}}><i className="ti ti-arrow-left"/>Danh sách giải</button>
      <div className="card" style={{marginBottom:14}}>
        <div style={{display:'flex',alignItems:'flex-start',gap:8}}>
          <b style={{flex:1,fontSize:16,fontFamily:'"Baloo 2"'}}>{t.name}</b>
          <button className="btn ghost sm" onClick={()=>setEdit(true)}><i className="ti ti-pencil"/>Sửa</button>
        </div>
        <div className="hint" style={{marginTop:4}}><i className="ti ti-calendar"/> {t.date?fmtDateVN(t.date):'—'}{t.time?' · '+t.time:''} · {t.mode||'8 bi'} · {TOUR_FORMATS[t.format]||''}</div>
        <div className="hint"><i className="ti ti-users"/> {regs.length}/{slots} đã đăng ký · lệ phí {fmtVnd(t.entryFee)} · thưởng {fmtVnd(t.prizePool)}</div>
      </div>
      <div className="seg">
        <button className={tab==='signup'?'on':''} onClick={()=>setTab('signup')}><i className="ti ti-user-check"/>Đăng ký ({regs.length})</button>
        <button className={tab==='result'?'on':''} onClick={()=>setTab('result')}><i className="ti ti-list-numbers"/>Kết quả & BXH</button>
        <button className={tab==='info'?'on':''} onClick={()=>setTab('info')}><i className="ti ti-report-money"/>Lợi nhuận</button>
      </div>

      {tab==='signup'&&(
        <div className="panel">
          <div className="panel-h"><i className="ti ti-user-check lead"/><b>Khách đã đăng ký</b>
            <span className={'chip '+(regs.length>=slots?'r':'g')}>{regs.length}/{slots} slot</span></div>
          <div className="panel-b" style={{paddingTop:6}}>
            {regs.length===0&&<Empty icon="ti-user-off" text="Chưa có khách nào đăng ký. Khách đăng ký từ app của họ (tab Giải đấu)."/>}
            {regs.map((r,i)=>(
              <div className="row" key={r.id}>
                <span style={{fontFamily:'"Baloo 2"',fontWeight:700,color:'var(--muted)',minWidth:18}}>{i+1}</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:600}}>{r.custName}</div>
                  <div className="hint">{r.phone||'—'} · đăng ký {new Date(r.ts).toLocaleString('vi',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</div>
                </div>
                <button className={'btn sm '+(r.paid?'':'ghost')} onClick={()=>patchReg(r.id,{paid:!r.paid})} title="Đã thu lệ phí">
                  <i className="ti ti-cash"/>{r.paid?'Đã thu':'Chưa thu'}</button>
                <button className={'btn sm '+(r.checkedIn?'':'ghost')} onClick={()=>patchReg(r.id,{checkedIn:!r.checkedIn})} title="Điểm danh">
                  <i className={'ti '+(r.checkedIn?'ti-user-check':'ti-user')}/>{r.checkedIn?'Có mặt':'Điểm danh'}</button>
                <button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>delReg(r.id)}><i className="ti ti-trash" style={{fontSize:16}}/></button>
              </div>
            ))}
            {regs.length>0&&(
              <div className="hint" style={{marginTop:10}}>
                Đã thu lệ phí: <b>{regs.filter(r=>r.paid).length}/{regs.length}</b> = {fmtVnd(regs.filter(r=>r.paid).length*(Number(t.entryFee)||0))} ·
                Có mặt: <b>{regs.filter(r=>r.checkedIn).length}</b>
              </div>
            )}
          </div>
        </div>
      )}

      {tab==='result'&&<TourResults t={t} regs={regs} results={results} setResults={setResults} me={me} flash={flash}/>}
      {tab==='info'&&(
        <div className="card">
          <div className="row" style={{padding:'6px 2px'}}><span style={{flex:1}} className="hint">Số trận{c.groupMatches?` (bảng ${c.groupMatches} + loại ${c.koMatches})`:''}</span><b>{c.total} trận</b></div>
          <div className="row" style={{padding:'6px 2px'}}><span style={{flex:1}} className="hint">Thu lệ phí (dự kiến {slots} người)</span><b>{fmtVnd(c.revEntry)}</b></div>
          <div className="row" style={{padding:'6px 2px'}}><span style={{flex:1}} className="hint">Thu tiền bàn ({c.tableHours.toFixed(1)}h)</span><b>{fmtVnd(c.revTable)}</b></div>
          <div className="row" style={{padding:'6px 2px'}}><span style={{flex:1,fontWeight:600}}>Tổng thu</span><b style={{color:'var(--grn)'}}>{fmtVnd(c.revTotal)}</b></div>
          <div className="row" style={{padding:'6px 2px'}}><span style={{flex:1,fontWeight:600}}>Tổng chi</span><b style={{color:'var(--red)'}}>−{fmtVnd(c.costTotal)}</b></div>
          <div className="row" style={{padding:'9px 2px',borderTop:'2px solid var(--border)'}}><span style={{flex:1,fontWeight:700,fontSize:15}}>Lợi nhuận dự kiến</span><b style={{color:c.profit>=0?'var(--g)':'var(--red)',fontFamily:'"Baloo 2"',fontSize:19}}>{fmtVnd(c.profit)}</b></div>
          <div className="sep"/>
          <div className="row" style={{padding:'6px 2px'}}><span style={{flex:1}} className="hint">Lệ phí ĐÃ THU thực tế ({regs.filter(r=>r.paid).length} người)</span><b>{fmtVnd(regs.filter(r=>r.paid).length*(Number(t.entryFee)||0))}</b></div>
          <button className="btn ghost block" style={{marginTop:10}} onClick={()=>setEdit(true)}><i className="ti ti-pencil"/>Sửa thông số giải</button>
        </div>
      )}
      {edit&&<TourForm tour={t} onSave={(nt)=>{setTours(v=>v.map(x=>x.id===nt.id?nt:x));setEdit(false);flash('Đã lưu giải');}} onClose={()=>setEdit(false)}/>}
    </div>
  );
}
function TourResults({t,regs,results,setResults,me,flash}){
  const rs=results.filter(r=>r.tourId===t.id).sort((a,b)=>b.ts-a.ts);
  const [a,setA]=useState('');const [b,setB]=useState('');
  const [sa,setSa]=useState(0);const [sb,setSb]=useState(0);
  const nameOf=id=>(regs.find(r=>r.custId===id)||{}).custName||'?';
  const add=()=>{
    if(!a||!b){flash('Chọn 2 người chơi');return;}
    if(a===b){flash('Hai người chơi phải khác nhau');return;}
    if(Number(sa)===Number(sb)){flash('Tỉ số không được hoà');return;}
    setResults(v=>[{id:uid(),tourId:t.id,aId:a,aName:nameOf(a),bId:b,bName:nameOf(b),scoreA:Number(sa)||0,scoreB:Number(sb)||0,by:me.name,ts:Date.now()},...v]);
    setSa(0);setSb(0);flash('Đã ghi kết quả');
  };
  const del=(id)=>{if(confirm('Xoá kết quả này?'))setResults(v=>v.filter(x=>x.id!==id));};
  const table=tourStandings(t.id,regs,results);
  if(regs.length===0) return <Empty icon="ti-users" text="Chưa có ai đăng ký — chưa ghi được kết quả."/>;
  return (
    <div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-plus lead"/><b>Ghi kết quả trận</b><span className="chip">race to {t.raceTo}</span></div>
        <div className="panel-b">
          <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
            <select className="inp" style={{flex:1,minWidth:110}} value={a} onChange={e=>setA(e.target.value)}>
              <option value="">— Người chơi A —</option>{regs.map(r=><option key={r.id} value={r.custId}>{r.custName}</option>)}</select>
            <input className="inp" type="number" min="0" style={{width:56,textAlign:'center'}} value={sa} onChange={e=>setSa(e.target.value)}/>
            <b style={{color:'var(--muted)'}}>–</b>
            <input className="inp" type="number" min="0" style={{width:56,textAlign:'center'}} value={sb} onChange={e=>setSb(e.target.value)}/>
            <select className="inp" style={{flex:1,minWidth:110}} value={b} onChange={e=>setB(e.target.value)}>
              <option value="">— Người chơi B —</option>{regs.map(r=><option key={r.id} value={r.custId}>{r.custName}</option>)}</select>
          </div>
          <button className="btn block" style={{marginTop:10}} onClick={add}><i className="ti ti-check"/>Ghi kết quả</button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h"><i className="ti ti-trophy lead"/><b>Bảng xếp hạng</b><span className="hint">thắng 2đ</span></div>
        <div className="tbl-scroll">
          <table className="data">
            <thead><tr><th>#</th><th>Người chơi</th><th>T</th><th>B</th><th>Ván</th><th>Điểm</th></tr></thead>
            <tbody>
              {table.map((r,i)=>(
                <tr key={r.id}>
                  <td style={{fontFamily:'"Baloo 2"',fontWeight:700,color:i===0?'var(--amber)':'var(--muted)'}}>{i===0?'🏆':i+1}</td>
                  <td style={{fontWeight:600}}>{r.name}</td>
                  <td style={{color:'var(--grn)'}}>{r.w}</td><td style={{color:'var(--red)'}}>{r.l}</td>
                  <td className="hint">{r.rf}–{r.ra}</td>
                  <td><b style={{fontFamily:'"Baloo 2"',color:'var(--g)'}}>{r.pts}</b></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h"><i className="ti ti-history lead"/><b>Các trận đã ghi ({rs.length})</b></div>
        <div className="panel-b" style={{paddingTop:6}}>
          {rs.length===0&&<Empty icon="ti-ball-baseball" text="Chưa ghi trận nào"/>}
          {rs.map(r=>(
            <div className="row" key={r.id}>
              <div style={{flex:1,minWidth:0,fontWeight:600,fontSize:13.5}}>
                <span style={{color:r.scoreA>r.scoreB?'var(--grn)':'var(--muted)'}}>{r.aName}</span>
                {' '}<b style={{fontFamily:'"Baloo 2"'}}>{r.scoreA}–{r.scoreB}</b>{' '}
                <span style={{color:r.scoreB>r.scoreA?'var(--grn)':'var(--muted)'}}>{r.bName}</span>
              </div>
              <button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>del(r.id)}><i className="ti ti-trash" style={{fontSize:16}}/></button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---- Giải đấu ---- */
const TOUR_FORMATS={groups:'Chia bảng → loại trực tiếp',knockout:'Loại trực tiếp 2 mạng'};
function tourMatches(t){
  const N=Number(t.players)||0;
  if(t.format==='knockout'){ // loại trực tiếp 2 mạng (double elimination)
    const total=N>1?(2*N-2):0;
    const free=N>=4?4:(N>=2?1:0);
    return {total,groupMatches:0,koMatches:total,K:N,groups:0,free};
  }
  // chia bảng (vòng tròn) → loại trực tiếp (1 mạng)
  const per=Math.max(2,Number(t.perGroup)||4);
  const qual=Math.min(per-1,Math.max(1,Number(t.qualifiers)||2));
  const groups=Math.max(1,Math.round(N/per));
  const base=Math.floor(N/groups);let rem=N-base*groups;const sizes=[];
  for(let i=0;i<groups;i++)sizes.push(base+(i<rem?1:0));
  const groupMatches=sizes.reduce((a,sz)=>a+sz*(sz-1)/2,0);
  const K=groups*qual;
  const koMatches=K>1?(K-1):0;
  const total=groupMatches+koMatches;
  const free=K>=4?3:(K>=2?1:0);
  return {total,groupMatches,koMatches,K,groups,sizes,free};
}
function tourCalc(t){
  const m=tourMatches(t);
  const raceTo=Number(t.raceTo)||5;
  const minPerRack=Number(t.minPerRack)||6;
  const avgRacks=Math.max(1,Math.round(raceTo*1.6)); // race to R ≈ 1.6R ván/trận
  const minPerMatch=avgRacks*minPerRack;
  const chargedMatches=Math.max(0,m.total-m.free);
  const tableHours=chargedMatches*minPerMatch/60;
  const tableRate=Number(t.tableRate)||0;
  const revTable=tableHours*tableRate;
  const revEntry=(Number(t.players)||0)*(Number(t.entryFee)||0);
  const revTotal=revEntry+revTable;
  const costTotal=(Number(t.prizePool)||0)+(Number(t.otherCost)||0);
  return {...m,raceTo,minPerRack,avgRacks,minPerMatch,chargedMatches,tableHours,revEntry,revTable,revTotal,costTotal,profit:revTotal-costTotal};
}
function TourMgr({tours,setTours,signups,flash,onOpen}){
  const [edit,setEdit]=useState(null);
  const regCount=(id)=>(signups||[]).filter(s=>s.tourId===id).length;
  const save=(t)=>{setTours(v=>{const ex=v.some(x=>x.id===t.id);return ex?v.map(x=>x.id===t.id?t:x):[t,...v];});setEdit(null);flash('Đã lưu giải đấu');};
  const del=(id)=>{if(confirm('Xoá giải này?'))setTours(v=>v.filter(x=>x.id!==id));};
  const sorted=[...tours].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  return (
    <div>
      <button className="btn block" style={{marginBottom:14}} onClick={()=>setEdit('new')}><i className="ti ti-plus"/>Lên lịch giải đấu mới</button>
      {tours.length===0&&<Empty icon="ti-trophy" text="Chưa có giải nào. Tạo giải để tính chi phí & lợi nhuận."/>}
      {sorted.map(t=>{
        const c=tourCalc(t);
        const past=t.date&&t.date<today();
        return (
          <div className="card" key={t.id} style={{marginBottom:11}}>
            <div style={{display:'flex',alignItems:'flex-start',gap:8,marginBottom:6}}>
              <b style={{flex:1,fontSize:15,fontFamily:'"Baloo 2"'}}>{t.name}</b>
              <span className={'chip '+(past?'':'g')}>{past?'Đã tổ chức':'Sắp diễn ra'}</span>
            </div>
            <div className="hint" style={{marginBottom:6}}><i className="ti ti-calendar"/> {t.date?fmtDateVN(t.date):'—'}{t.time?' · '+t.time:''} · {t.mode||'8 bi'}</div>
            <div className="hint" style={{marginBottom:6}}><i className="ti ti-tournament"/> {TOUR_FORMATS[t.format]||'—'} · ~{c.total} trận · race to {c.raceTo}</div>
            <div className="hint" style={{marginBottom:10}}><i className="ti ti-user-check"/> <b style={{color:regCount(t.id)>=(t.players||0)?'var(--red)':'var(--g)'}}>{regCount(t.id)}/{t.players||0}</b> đã đăng ký</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8,textAlign:'center'}}>
              <div style={{background:'var(--grn-lt)',borderRadius:10,padding:'8px 4px'}}><div className="hint">Tổng thu</div><b style={{color:'var(--grn)',fontFamily:'"Baloo 2"',fontSize:14}}>{fmtVnd(c.revTotal)}</b></div>
              <div style={{background:'var(--red-lt)',borderRadius:10,padding:'8px 4px'}}><div className="hint">Tổng chi</div><b style={{color:'var(--red)',fontFamily:'"Baloo 2"',fontSize:14}}>{fmtVnd(c.costTotal)}</b></div>
              <div style={{background:c.profit>=0?'var(--g-lt)':'var(--red-lt)',borderRadius:10,padding:'8px 4px'}}><div className="hint">Lợi nhuận</div><b style={{color:c.profit>=0?'var(--g)':'var(--red)',fontFamily:'"Baloo 2"',fontSize:14}}>{fmtVnd(c.profit)}</b></div>
            </div>
            <div className="rowbtns" style={{marginTop:10}}>
              {onOpen&&<button className="btn sm" style={{flex:1}} onClick={()=>onOpen(t.id)}><i className="ti ti-arrow-right"/>Mở giải · đăng ký · kết quả</button>}
              <button className="btn ghost sm" onClick={()=>setEdit(t)}><i className="ti ti-pencil"/>Sửa</button>
              <button className="btn ghost sm" onClick={()=>del(t.id)}><i className="ti ti-trash"/></button>
            </div>
          </div>
        );
      })}
      {edit&&<TourForm tour={edit==='new'?null:edit} onSave={save} onClose={()=>setEdit(null)}/>}
    </div>
  );
}
function TourForm({tour,onSave,onClose}){
  const [t,setT]=useState(()=>tour?{...tour}:{id:uid(),name:'',date:today(),time:'19:00',mode:'9 bi',format:'groups',perGroup:4,qualifiers:2,players:16,raceTo:5,minPerRack:6,entryFee:100000,tableRate:60000,prizePool:1200000,otherCost:300000});
  const set=(k,v)=>setT(x=>({...x,[k]:v}));
  const c=tourCalc(t);
  const numFld=(k,label,suffix)=>(
    <label className="fld" style={{flex:1,minWidth:110}}><span>{label}</span>
      <div style={{position:'relative'}}>
        <input className="inp" type="number" min="0" value={t[k]} onChange={e=>set(k,e.target.value)} style={{paddingRight:suffix?42:13}}/>
        {suffix&&<span style={{position:'absolute',right:11,top:'50%',transform:'translateY(-50%)',fontSize:12,color:'var(--muted)'}}>{suffix}</span>}
      </div>
    </label>
  );
  const save=()=>{if(!t.name.trim()){alert('Nhập tên giải');return;}onSave({...t,name:t.name.trim()});};
  return (
    <Modal title={tour?'Chi tiết giải đấu':'Lên lịch giải đấu'} onClose={onClose} foot={<button className="btn block" onClick={save}><i className="ti ti-device-floppy"/>Lưu giải</button>}>
      <label className="fld"><span>Tên giải *</span><input className="inp" autoFocus value={t.name} onChange={e=>set('name',e.target.value)} placeholder="VD: Giải bi-a mở rộng CLB tháng 7"/></label>
      <div style={{display:'flex',gap:9,flexWrap:'wrap'}}>
        <label className="fld" style={{flex:1,minWidth:120}}><span>Ngày</span><input className="inp" type="date" value={t.date} onChange={e=>set('date',e.target.value)}/></label>
        <label className="fld" style={{width:100}}><span>Giờ</span><input className="inp" type="time" value={t.time} onChange={e=>set('time',e.target.value)}/></label>
        <label className="fld" style={{width:100}}><span>Bộ môn</span><select className="inp" value={t.mode} onChange={e=>set('mode',e.target.value)}>{GAME_MODES.map(m=><option key={m} value={m}>{m}</option>)}</select></label>
      </div>

      <label className="fld"><span>Thể thức</span>
        <div className="rowbtns">
          {Object.entries(TOUR_FORMATS).map(([k,v])=>(
            <button key={k} className={'btn sm '+(t.format===k?'':'ghost')} onClick={()=>set('format',k)} style={{flex:1}}>{v}</button>
          ))}
        </div>
      </label>
      {t.format==='groups'&&(
        <div style={{display:'flex',gap:9,flexWrap:'wrap'}}>
          <label className="fld" style={{flex:1,minWidth:120}}><span>Số người / bảng</span><select className="inp" value={t.perGroup} onChange={e=>set('perGroup',Number(e.target.value))}><option value={3}>3 người</option><option value={4}>4 người</option></select></label>
          <label className="fld" style={{flex:1,minWidth:120}}><span>Đi tiếp / bảng</span><select className="inp" value={t.qualifiers} onChange={e=>set('qualifiers',Number(e.target.value))}><option value={1}>Top 1</option><option value={2}>Top 2</option></select></label>
        </div>
      )}
      {t.format==='knockout'&&<p className="hint" style={{marginTop:-4,marginBottom:10}}>Mỗi người 2 mạng — thua 2 trận mới bị loại (double elimination).</p>}

      <div style={{display:'flex',gap:9,flexWrap:'wrap'}}>{numFld('players','Số người dự','người')}{numFld('raceTo','Race to','ván')}{numFld('minPerRack','Phút / ván','phút')}</div>

      <div style={{fontWeight:700,fontSize:13.5,margin:'8px 0 8px',color:'var(--grn)'}}>💰 Nguồn thu (lệ phí + tiền bàn)</div>
      <div style={{display:'flex',gap:9,flexWrap:'wrap'}}>{numFld('entryFee','Lệ phí / người','₫')}{numFld('tableRate','Giá bàn / giờ','₫')}</div>

      <div style={{fontWeight:700,fontSize:13.5,margin:'8px 0 8px',color:'var(--red)'}}>💸 Chi phí</div>
      <div style={{display:'flex',gap:9,flexWrap:'wrap'}}>{numFld('prizePool','Tiền thưởng','₫')}{numFld('otherCost','Chi khác (nước, banner…)','₫')}</div>

      <div className="card" style={{background:'var(--bg)',marginTop:8}}>
        <div className="row" style={{padding:'6px 2px'}}><span style={{flex:1}} className="hint">Số trận{c.groupMatches?` (bảng ${c.groupMatches} + loại ${c.koMatches})`:''}</span><b>{c.total} trận</b></div>
        <div className="row" style={{padding:'6px 2px'}}><span style={{flex:1}} className="hint">Miễn tiền bàn (bán kết + chung kết)</span><b>−{c.free} trận</b></div>
        <div className="row" style={{padding:'6px 2px'}}><span style={{flex:1}} className="hint">Trận tính tiền × {c.minPerMatch} phút (~{c.avgRacks} ván)</span><b>{c.chargedMatches} trận</b></div>
        <div className="row" style={{padding:'6px 2px'}}><span style={{flex:1}} className="hint">Tổng giờ bàn tính phí</span><b>{c.tableHours.toFixed(1)} giờ</b></div>
        <div className="sep" style={{margin:'6px 0'}}/>
        <div className="row" style={{padding:'6px 2px'}}><span style={{flex:1}} className="hint">Thu lệ phí ({t.players||0} × {fmtVnd(t.entryFee)})</span><b>{fmtVnd(c.revEntry)}</b></div>
        <div className="row" style={{padding:'6px 2px'}}><span style={{flex:1}} className="hint">Thu tiền bàn ({c.tableHours.toFixed(1)}h × {fmtVnd(t.tableRate)})</span><b>{fmtVnd(c.revTable)}</b></div>
        <div className="row" style={{padding:'6px 2px'}}><span style={{flex:1,fontWeight:600}}>Tổng thu</span><b style={{color:'var(--grn)'}}>{fmtVnd(c.revTotal)}</b></div>
        <div className="row" style={{padding:'6px 2px'}}><span style={{flex:1,fontWeight:600}}>Tổng chi</span><b style={{color:'var(--red)'}}>−{fmtVnd(c.costTotal)}</b></div>
        <div className="row" style={{padding:'9px 2px',borderTop:'2px solid var(--border)'}}><span style={{flex:1,fontWeight:700,fontSize:15}}>Lợi nhuận</span><b style={{color:c.profit>=0?'var(--g)':'var(--red)',fontFamily:'"Baloo 2"',fontSize:19}}>{fmtVnd(c.profit)}</b></div>
      </div>
    </Modal>
  );
}
function StaffMgr({staff,setStaff,flash}){
  const [nf,setNf]=useState({name:'',role:'staff',rate:22000});
  const add=()=>{if(!nf.name.trim()){flash('Nhập tên');return;}setStaff(v=>[...v,{id:'u_'+uid(),name:nf.name.trim(),role:nf.role,rate:Number(nf.rate)||0}]);setNf({name:'',role:'staff',rate:22000});flash('Đã thêm nhân viên');};
  const del=(id)=>{if(staff.length<=1){flash('Phải còn ít nhất 1 người');return;}if(confirm('Xoá nhân viên này?'))setStaff(v=>v.filter(u=>u.id!==id));};
  const setRole=(id,role)=>setStaff(v=>v.map(u=>u.id===id?{...u,role}:u));
  const setRate=(id,rate)=>setStaff(v=>v.map(u=>u.id===id?{...u,rate:Number(rate)||0}:u));
  return (
    <div className="panel">
      <div className="panel-h"><i className="ti ti-users lead"/><b>Quản lý nhân viên</b></div>
      <div className="panel-b">
        {staff.map(u=>(
          <div className="row" key={u.id} style={{flexWrap:'wrap'}}>
            <Avatar staff={u} size={34}/>
            <div style={{flex:1,minWidth:120}}><div style={{fontWeight:600}}>{u.name}</div>
              <div className="hint">{(ROLES[u.role]||ROLES.staff).icon} {roleLabel(u.role)}</div></div>
            <select className="inp" style={{width:'auto',padding:'6px 8px',fontSize:12}} value={u.role} onChange={e=>setRole(u.id,e.target.value)}>
              {ROLE_KEYS.map(k=><option key={k} value={k}>{ROLES[k].label}</option>)}
            </select>
            <label style={{display:'flex',alignItems:'center',gap:4}}><input className="inp" type="number" min="0" style={{width:92,padding:'6px 8px',fontSize:12}} value={u.rate||0} onChange={e=>setRate(u.id,e.target.value)}/><span className="hint">₫/h</span></label>
            <button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>del(u.id)}><i className="ti ti-trash" style={{fontSize:17}}/></button>
          </div>
        ))}
        <div className="sep"/>
        <div style={{display:'flex',gap:8,alignItems:'flex-end',flexWrap:'wrap'}}>
          <label className="fld" style={{flex:1,minWidth:130,marginBottom:0}}><span>Thêm nhân viên</span>
            <input className="inp" value={nf.name} onChange={e=>setNf({...nf,name:e.target.value})} placeholder="Họ tên" onKeyDown={e=>e.key==='Enter'&&add()}/></label>
          <select className="inp" style={{width:'auto'}} value={nf.role} onChange={e=>setNf({...nf,role:e.target.value})}>{ROLE_KEYS.map(k=><option key={k} value={k}>{ROLES[k].label}</option>)}</select>
          <label style={{display:'flex',alignItems:'center',gap:4}}><input className="inp" type="number" style={{width:92}} value={nf.rate} onChange={e=>setNf({...nf,rate:e.target.value})}/><span className="hint">₫/h</span></label>
          <button className="btn" onClick={add}><i className="ti ti-plus"/>Thêm</button>
        </div>
      </div>
    </div>
  );
}
function MenuMgr({menu,setMenu,flash}){
  const [txt,setTxt]=useState({});const [pr,setPr]=useState({});
  const addItem=(gi)=>{const val=(txt[gi]||'').trim();if(!val)return;
    setMenu(v=>v.map((g,i)=>i===gi?{...g,items:[...g.items,{name:val,price:Number(pr[gi])||0}]}:g));
    setTxt(t=>({...t,[gi]:''}));setPr(p=>({...p,[gi]:''}));};
  const delItem=(gi,name)=>setMenu(v=>v.map((g,i)=>i===gi?{...g,items:g.items.filter(x=>x.name!==name)}:g));
  const setPrice=(gi,name,price)=>setMenu(v=>v.map((g,i)=>i===gi?{...g,items:g.items.map(x=>x.name===name?{...x,price:Number(price)||0}:x)}:g));
  return (
    <div>
      <p className="hint" style={{marginBottom:10}}>Giá món dùng để tính tiền đồ khi chốt bill bàn.</p>
      {menu.map((g,gi)=>(
        <div className="panel" key={g.grp}>
          <div className="panel-h"><i className="ti ti-tag lead"/><b>{g.grp}</b><span className="chip">{g.items.length} món</span></div>
          <div className="panel-b">
            {g.items.map(it=>(
              <div className="row" key={it.name}>
                <div style={{flex:1,minWidth:0,fontWeight:600}}>{it.name}</div>
                <label style={{display:'flex',alignItems:'center',gap:4}}>
                  <input className="inp" type="number" style={{width:96,padding:'6px 8px'}} value={it.price||0} onChange={e=>setPrice(gi,it.name,e.target.value)}/><span className="hint">₫</span></label>
                <button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>delItem(gi,it.name)}><i className="ti ti-trash" style={{fontSize:16}}/></button>
              </div>
            ))}
            <div style={{display:'flex',gap:8,marginTop:10}}>
              <input className="inp" value={txt[gi]||''} onChange={e=>setTxt(t=>({...t,[gi]:e.target.value}))} onKeyDown={e=>e.key==='Enter'&&addItem(gi)} placeholder={'Thêm món vào '+g.grp}/>
              <input className="inp" type="number" style={{width:90}} value={pr[gi]||''} onChange={e=>setPr(p=>({...p,[gi]:e.target.value}))} onKeyDown={e=>e.key==='Enter'&&addItem(gi)} placeholder="Giá"/>
              <button className="btn" onClick={()=>addItem(gi)}><i className="ti ti-plus"/></button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ---- QR đặt món ---- */
function appBaseUrl(){ return location.origin+location.pathname; }
function QRImg({text,size=150}){
  const [src,setSrc]=useState('');
  useEffect(()=>{
    let ok=true;
    try{
      if(window.QRCode&&window.QRCode.toDataURL){
        window.QRCode.toDataURL(text,{width:size,margin:1},(err,url)=>{ if(!err&&ok)setSrc(url); });
      }
    }catch(e){}
    return ()=>{ok=false;};
  },[text,size]);
  if(!src) return <div style={{width:size,height:size,background:'var(--bg)',border:'1px solid var(--border)',borderRadius:8,display:'flex',alignItems:'center',justifyContent:'center'}} className="hint">QR…</div>;
  return <img src={src} alt="QR" style={{width:size,height:size,borderRadius:8,background:'#fff',display:'block'}}/>;
}
function QRMgr({tables,cloud}){
  const base=appBaseUrl();
  const [sel,setSel]=useState('all');
  const isLocal=/^(localhost|127\.|file)/.test(location.hostname||'file');
  return (
    <div>
      {isLocal&&<div className="card" style={{marginBottom:14,borderLeft:'4px solid var(--amber)'}}>
        <b style={{fontSize:14}}>⚠️ Đang chạy máy cục bộ</b>
        <p className="hint" style={{marginTop:4}}>QR đang trỏ tới <code>{base}</code> — điện thoại khách quét sẽ KHÔNG mở được. Cần deploy lên link public (GitHub Pages) rồi in QR từ đó.</p>
      </div>}
      {cloud!=='synced'&&<div className="card" style={{marginBottom:14,borderLeft:'4px solid var(--red)'}}>
        <b style={{fontSize:14}}>⚠️ Chưa nối cloud</b>
        <p className="hint" style={{marginTop:4}}>Khách quét QR ở máy khác sẽ không gửi được order về quầy cho tới khi chạy <code>supabase-schema.sql</code>.</p>
      </div>}
      <div className="panel">
        <div className="panel-h"><i className="ti ti-qrcode lead"/><b>QR đặt món</b>
          <select className="inp" style={{width:'auto'}} value={sel} onChange={e=>setSel(e.target.value)}>
            <option value="all">Tất cả bàn</option>
            {tables.map(t=><option key={t.id} value={t.no}>Bàn {t.no}</option>)}
          </select></div>
        <div className="panel-b">
          <p className="hint" style={{marginBottom:12}}>In QR dán lên từng bàn. Khách quét → mở trang đặt món, tự chọn sẵn số bàn.</p>
          <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(170px,1fr))',gap:14}}>
            {(sel==='all'?tables:tables.filter(t=>String(t.no)===String(sel))).map(t=>(
              <div key={t.id} style={{textAlign:'center',border:'1px solid var(--border)',borderRadius:12,padding:12,background:'var(--card)'}}>
                <QRImg text={base+'?table='+t.no} size={140}/>
                <div style={{fontFamily:'"Baloo 2"',fontWeight:800,fontSize:18,marginTop:8}}>Bàn {t.no}</div>
                <div className="hint">{t.type} · {fmtVnd(t.price)}/h</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- Gửi tin cho khách ---- */
const BC_KINDS={promo:{label:'Khuyến mãi',icon:'🎁',chip:'a'},tour:{label:'Giải đấu',icon:'🏆',chip:'b'}};
function BroadcastMgr({broadcasts,setBroadcasts,promos,tours,customers,cloud,flash}){
  const [kind,setKind]=useState('promo');
  const [title,setTitle]=useState('');
  const [body,setBody]=useState('');
  const send=()=>{
    if(!title.trim()){flash('Nhập tiêu đề tin');return;}
    setBroadcasts(v=>[{id:uid(),kind,title:title.trim(),body:body.trim(),ts:Date.now()},...v]);
    setTitle('');setBody('');flash('Đã gửi tin tới '+customers.length+' khách 📣');
  };
  const del=(id)=>{if(confirm('Xoá tin này?'))setBroadcasts(v=>v.filter(b=>b.id!==id));};
  const fillPromo=(p)=>{setKind('promo');setTitle(p.title);setBody(p.desc);};
  const fillTour=(t)=>{setKind('tour');setTitle(t.name);setBody(`Giải ${t.mode||''} ngày ${t.date?fmtDateVN(t.date):''}${t.time?' lúc '+t.time:''}. Lệ phí ${fmtVnd(t.entryFee)}/người. Đăng ký tại quầy!`);};
  const live=(promos||[]).filter(promoActive);
  const upcoming=(tours||[]).filter(t=>!t.date||t.date>=today());
  const sorted=[...broadcasts].sort((a,b)=>b.ts-a.ts);
  return (
    <div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-speakerphone lead"/><b>Soạn tin gửi khách</b>
          <span className={'chip '+(cloud==='synced'?'gr':'')}>{cloud==='synced'?'Gửi tới mọi máy':'Chỉ máy này'}</span></div>
        <div className="panel-b">
          <div className="rowbtns" style={{marginBottom:10}}>
            {Object.entries(BC_KINDS).map(([k,v])=>(
              <button key={k} className={'btn sm '+(kind===k?'':'ghost')} onClick={()=>setKind(k)}>{v.icon} {v.label}</button>
            ))}
          </div>
          {(live.length>0||upcoming.length>0)&&<div style={{marginBottom:10}}>
            <div className="hint" style={{marginBottom:6}}>Điền nhanh từ:</div>
            <div className="rowbtns">
              {live.map(p=><button key={p.id} className="btn ghost sm" onClick={()=>fillPromo(p)}>🎁 {p.title}</button>)}
              {upcoming.map(t=><button key={t.id} className="btn ghost sm" onClick={()=>fillTour(t)}>🏆 {t.name}</button>)}
            </div>
          </div>}
          <label className="fld"><span>Tiêu đề *</span><input className="inp" value={title} onChange={e=>setTitle(e.target.value)} placeholder="VD: Giờ vàng cuối tuần giảm 20%"/></label>
          <label className="fld"><span>Nội dung</span><textarea className="inp" value={body} onChange={e=>setBody(e.target.value)} placeholder="Chi tiết ưu đãi / thể lệ giải…"/></label>
          <button className="btn block" onClick={send}><i className="ti ti-send"/>Gửi tới {customers.length} khách</button>
          <p className="hint" style={{marginTop:8}}>Tin hiện trong app khách (mục Thông báo). {cloud!=='synced'&&'Cần nối cloud để khách ở máy khác nhận được.'}</p>
        </div>
      </div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-history lead"/><b>Tin đã gửi ({broadcasts.length})</b></div>
        <div className="panel-b" style={{paddingTop:6}}>
          {sorted.length===0&&<Empty icon="ti-speakerphone" text="Chưa gửi tin nào"/>}
          {sorted.map(b=>{const k=BC_KINDS[b.kind]||BC_KINDS.promo;return (
            <div className="row" key={b.id} style={{alignItems:'flex-start'}}>
              <span style={{fontSize:18}}>{k.icon}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:600,fontSize:13.5}}>{b.title}</div>
                {b.body&&<div className="hint">{b.body}</div>}
                <div className="hint" style={{marginTop:2}}>{new Date(b.ts).toLocaleString('vi',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</div>
              </div>
              <button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>del(b.id)}><i className="ti ti-trash" style={{fontSize:16}}/></button>
            </div>
          );})}
        </div>
      </div>
    </div>
  );
}

/* ---- Bảng phạt & lương ---- */
function PenaltyPayroll({penaltyRules,setPenaltyRules,violations,attend,staff,flash}){
  const [sub,setSub]=useState('pay'); // pay | rules
  const [ym,setYm]=useState(thisMonth());
  const [nf,setNf]=useState({name:'',amount:20000});
  const addRule=()=>{if(!nf.name.trim()){flash('Nhập tên lỗi');return;}setPenaltyRules(v=>[...v,{id:uid(),name:nf.name.trim(),amount:Number(nf.amount)||0}]);setNf({name:'',amount:20000});};
  const delRule=(id)=>{if(confirm('Xoá loại lỗi này?'))setPenaltyRules(v=>v.filter(r=>r.id!==id));};
  const setRuleAmt=(id,amount)=>setPenaltyRules(v=>v.map(r=>r.id===id?{...r,amount:Number(amount)||0}:r));
  const monthMin=(sid)=>{let m=0;Object.keys(attend).forEach(d=>{if(monthOf(d)===ym)m+=phutCa((attend[d]||{})[sid]);});return m;};
  const monthFines=(sid)=>violations.filter(v=>v.staffId===sid&&monthOf(v.date)===ym).reduce((a,v)=>a+(v.amount||0),0);
  return (
    <div>
      <div className="seg">
        <button className={sub==='pay'?'on':''} onClick={()=>setSub('pay')}><i className="ti ti-cash"/>Bảng lương tháng</button>
        <button className={sub==='rules'?'on':''} onClick={()=>setSub('rules')}><i className="ti ti-gavel"/>Bảng mức phạt</button>
      </div>

      {sub==='pay'&&(
        <div className="panel">
          <div className="panel-h"><i className="ti ti-cash lead"/><b>Lương tháng</b>
            <input type="month" className="inp" style={{width:'auto',padding:'7px 10px'}} value={ym} onChange={e=>setYm(e.target.value)}/></div>
          <div className="tbl-scroll">
            <table className="data">
              <thead><tr><th>Nhân viên</th><th>Giờ công</th><th>Đơn giá</th><th>Lương</th><th>Phạt</th><th>Thực lĩnh</th></tr></thead>
              <tbody>
                {staff.map(u=>{const min=monthMin(u.id);const hrs=min/60;const rate=u.rate||0;const pay=hrs*rate;const fine=monthFines(u.id);const net=pay-fine;
                  return <tr key={u.id}>
                    <td style={{fontWeight:600}}>{u.name.split(' ').slice(-1)[0]}</td>
                    <td>{minToHM(min)}</td>
                    <td>{fmtVnd(rate)}</td>
                    <td>{fmtVnd(pay)}</td>
                    <td style={{color:fine?'var(--red)':'var(--muted)'}}>{fine?'−'+fmtVnd(fine):'—'}</td>
                    <td><b style={{color:'var(--g)',fontFamily:'"Baloo 2"'}}>{fmtVnd(net)}</b></td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{padding:'10px 16px'}}>Lương = giờ công (từ chấm công) × đơn giá/giờ − tổng phạt trong tháng. Sửa đơn giá ở mục Nhân viên.</p>
        </div>
      )}

      {sub==='rules'&&(
        <div className="panel">
          <div className="panel-h"><i className="ti ti-gavel lead"/><b>Bảng mức phạt</b></div>
          <div className="panel-b">
            {penaltyRules.map(r=>(
              <div className="row" key={r.id}>
                <div style={{flex:1,fontWeight:600,minWidth:0}}>{r.name}</div>
                <label style={{display:'flex',alignItems:'center',gap:4}}><input className="inp" type="number" style={{width:110,padding:'6px 8px'}} value={r.amount} onChange={e=>setRuleAmt(r.id,e.target.value)}/><span className="hint">₫</span></label>
                <button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>delRule(r.id)}><i className="ti ti-trash" style={{fontSize:17}}/></button>
              </div>
            ))}
            <div className="sep"/>
            <div style={{display:'flex',gap:8,alignItems:'flex-end',flexWrap:'wrap'}}>
              <label className="fld" style={{flex:1,minWidth:150,marginBottom:0}}><span>Thêm loại lỗi</span><input className="inp" value={nf.name} onChange={e=>setNf({...nf,name:e.target.value})} placeholder="VD: Dùng điện thoại khi đông khách"/></label>
              <label style={{display:'flex',alignItems:'center',gap:4}}><input className="inp" type="number" style={{width:110}} value={nf.amount} onChange={e=>setNf({...nf,amount:e.target.value})}/><span className="hint">₫</span></label>
              <button className="btn" onClick={addRule}><i className="ti ti-plus"/>Thêm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ================= Nhân viên quầy ================= */
function CounterView({s}){
  const {orders,setOrders,outfood,setOutfood,alerts,setAlerts,bookings,setBookings,me,flash}=s;
  const openAlerts=alerts.filter(a=>a.status==='open'&&!alertExpired(a)&&alertFor(a,'counter'));
  const pendBook=bookings.filter(b=>b.status==='pending').length;
  // Có yêu cầu dành cho quầy → mở thẳng tab Yêu cầu để tắt tiền giờ kịp
  const [tab,setTab]=useState(()=>openAlerts.length>0?'alerts':'orders'); // orders | alerts | outfood
  const serve=(id)=>setOrders(v=>v.map(o=>o.id===id?{...o,status:'done',doneTs:Date.now()}:o));
  const cancel=(id)=>{if(confirm('Huỷ order này?'))setOrders(v=>v.filter(o=>o.id!==id));};
  const pending=orders.filter(o=>o.status==='pending');
  const done=orders.filter(o=>o.status==='done').slice(0,10);
  return (
    <div>
      <div className="seg">
        <button className={tab==='orders'?'on':''} onClick={()=>setTab('orders')}><i className="ti ti-clipboard-list"/>Order bàn {pending.length>0&&`(${pending.length})`}</button>
        <button className={tab==='alerts'?'on':''} onClick={()=>setTab('alerts')}><i className="ti ti-bell-ringing"/>Yêu cầu {openAlerts.length>0&&`(${openAlerts.length})`}</button>
        <button className={tab==='book'?'on':''} onClick={()=>setTab('book')}><i className="ti ti-calendar-event"/>Đặt bàn {pendBook>0&&`(${pendBook})`}</button>
        <button className={tab==='outfood'?'on':''} onClick={()=>setTab('outfood')}><i className="ti ti-tools-kitchen-2"/>Gọi món ngoài</button>
      </div>
      {tab==='alerts'&&<AlertsPanel alerts={alerts} setAlerts={setAlerts} me={me} role="counter" flash={flash}/>}
      {tab==='book'&&<BookingsPanel bookings={bookings} setBookings={setBookings} me={me} flash={flash}/>}
      {tab==='orders'&&(
        <div>
          {pending.length===0&&done.length===0&&<Empty icon="ti-clipboard-off" text="Chưa có order nào từ các bàn"/>}
          {pending.length>0&&<div style={{fontSize:13,fontWeight:700,color:'var(--amber)',margin:'2px 2px 10px'}}><i className="ti ti-flame"/> Đồ khách đang chờ ({pending.length})</div>}
          {pending.map(o=><OrderCard key={o.id} o={o} onServe={serve} onCancel={cancel}/>)}
          {done.length>0&&<div style={{fontSize:13,fontWeight:700,color:'var(--muted)',margin:'16px 2px 10px'}}>Đã phục vụ</div>}
          {done.map(o=><OrderCard key={o.id} o={o} done/>)}
        </div>
      )}
      {tab==='outfood'&&<OutfoodMgr outfood={outfood} setOutfood={setOutfood} flash={flash}/>}
    </div>
  );
}
function OutfoodMgr({outfood,setOutfood,flash}){
  const [nf,setNf]=useState({name:'',phone:''});
  const [editId,setEditId]=useState(null);
  const add=()=>{if(!nf.name.trim()){flash('Nhập tên món/quán');return;}
    if(editId){setOutfood(v=>v.map(o=>o.id===editId?{...o,name:nf.name.trim(),phone:nf.phone.trim()}:o));setEditId(null);}
    else setOutfood(v=>[...v,{id:uid(),name:nf.name.trim(),phone:nf.phone.trim()}]);
    setNf({name:'',phone:''});flash('Đã lưu');};
  const del=(id)=>{if(confirm('Xoá món ngoài này?'))setOutfood(v=>v.filter(o=>o.id!==id));};
  const edit=(o)=>{setNf({name:o.name,phone:o.phone});setEditId(o.id);};
  return (
    <div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-phone-call lead"/><b>Danh bạ gọi món ngoài</b></div>
        <div className="panel-b" style={{paddingTop:6}}>
          {outfood.length===0&&<Empty icon="ti-tools-kitchen-off" text="Chưa có món ngoài nào"/>}
          {outfood.map(o=>(
            <div className="row" key={o.id}>
              <div style={{flex:1,minWidth:0}}><div style={{fontWeight:600}}>{o.name}</div><div className="hint">{o.phone||'chưa có SĐT'}</div></div>
              {o.phone&&<a className="btn sm" href={'tel:'+o.phone}><i className="ti ti-phone"/>Gọi</a>}
              <button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>edit(o)}><i className="ti ti-pencil" style={{fontSize:16}}/></button>
              <button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>del(o.id)}><i className="ti ti-trash" style={{fontSize:16}}/></button>
            </div>
          ))}
          <div className="sep"/>
          <div style={{display:'flex',gap:8,alignItems:'flex-end',flexWrap:'wrap'}}>
            <label className="fld" style={{flex:1,minWidth:130,marginBottom:0}}><span>{editId?'Sửa món ngoài':'Thêm món ngoài'}</span><input className="inp" value={nf.name} onChange={e=>setNf({...nf,name:e.target.value})} placeholder="VD: Cơm rang / Trà sữa"/></label>
            <input className="inp" style={{width:130}} value={nf.phone} onChange={e=>setNf({...nf,phone:e.target.value})} placeholder="SĐT quán" inputMode="tel"/>
            <button className="btn" onClick={add}><i className={'ti '+(editId?'ti-check':'ti-plus')}/>{editId?'Lưu':'Thêm'}</button>
          </div>
        </div>
      </div>
      <p className="hint" style={{textAlign:'center'}}>Bấm “Gọi” để quay số quán món ngoài giúp khách.</p>
    </div>
  );
}
function InventoryView({s}){
  const {inventory,setInventory,me,flash}=s;
  const [nf,setNf]=useState({name:'',unit:'lon',qty:0,min:0});
  const add=()=>{if(!nf.name.trim()){flash('Nhập tên hàng');return;}setInventory(v=>[...v,{id:uid(),name:nf.name.trim(),unit:nf.unit.trim()||'cái',qty:Number(nf.qty)||0,min:Number(nf.min)||0}]);setNf({name:'',unit:'lon',qty:0,min:0});flash('Đã thêm hàng');};
  const del=(id)=>{if(confirm('Xoá mặt hàng này?'))setInventory(v=>v.filter(i=>i.id!==id));};
  const setQty=(id,qty)=>setInventory(v=>v.map(i=>i.id===id?{...i,qty:Math.max(0,Number(qty)||0)}:i));
  const step=(id,d)=>setInventory(v=>v.map(i=>i.id===id?{...i,qty:Math.max(0,(i.qty||0)+d)}:i));
  const low=inventory.filter(i=>i.min>0&&i.qty<=i.min);
  const needList=inventory.filter(i=>i.need);
  const toggleNeed=(id)=>setInventory(v=>v.map(i=>i.id===id?{...i,need:!i.need}:i));
  return (
    <div>
      <div className="grid-stat">
        <div className="stat"><div className="ic g"><i className="ti ti-box-seam"/></div><div className="n">{inventory.length}</div><div className="l">Mặt hàng</div></div>
        <div className="stat"><div className="ic r"><i className="ti ti-alert-triangle"/></div><div className="n">{low.length}</div><div className="l">Sắp hết</div></div>
        <div className="stat"><div className="ic a"><i className="ti ti-shopping-cart"/></div><div className="n">{needList.length}</div><div className="l">Cần mua / thay</div></div>
      </div>

      {needList.length>0&&(
        <div className="panel">
          <div className="panel-h"><i className="ti ti-shopping-cart lead" style={{color:'var(--amber)'}}/><b>Cần mua / thay thế</b><span className="chip a">{needList.length}</span></div>
          <div className="panel-b" style={{paddingTop:6}}>
            {needList.map(i=>(
              <div className="row" key={i.id}>
                <div style={{flex:1,minWidth:0}}><div style={{fontWeight:600}}>{i.name}</div>
                  <div className="hint">còn {i.qty} {i.unit}{i.min>0?` · tối thiểu ${i.min}`:''}</div></div>
                <button className="btn sm" onClick={()=>toggleNeed(i.id)}><i className="ti ti-check"/>Đã mua</button>
              </div>
            ))}
            <p className="hint" style={{marginTop:8}}>Danh sách này để báo quản lý mua bổ sung / thay mới.</p>
          </div>
        </div>
      )}
      <div className="panel">
        <div className="panel-h"><i className="ti ti-clipboard-check lead"/><b>Kiểm kho</b><span className="hint">bởi {me.name.split(' ').slice(-1)[0]}</span></div>
        <div className="panel-b" style={{paddingTop:6}}>
          {inventory.length===0&&<Empty icon="ti-box-off" text="Chưa có mặt hàng. Thêm bên dưới để bắt đầu đếm."/>}
          {inventory.map(i=>{const isLow=i.min>0&&i.qty<=i.min;return (
            <div className="row" key={i.id}>
              <div style={{flex:1,minWidth:0}}><div style={{fontWeight:600}}>{i.name} {isLow&&<span className="chip r">sắp hết</span>}</div>
                <div className="hint">đơn vị: {i.unit}{i.min>0?` · tối thiểu ${i.min}`:''}</div></div>
              <div className="stepper">
                <button onClick={()=>step(i.id,-1)}>−</button>
                <input className="inp" type="number" value={i.qty} onChange={e=>setQty(i.id,e.target.value)} style={{width:56,textAlign:'center',padding:'6px'}}/>
                <button onClick={()=>step(i.id,1)}>+</button>
              </div>
              <button className={'btn sm '+(i.need?'':'ghost')} onClick={()=>toggleNeed(i.id)} title="Báo cần mua/thay"><i className="ti ti-shopping-cart"/>{i.need?'Cần mua':'Báo mua'}</button>
              <button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>del(i.id)}><i className="ti ti-trash" style={{fontSize:16}}/></button>
            </div>
          );})}
          <div className="sep"/>
          <div style={{fontWeight:700,fontSize:13,marginBottom:8}}>Thêm mặt hàng</div>
          <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'flex-end'}}>
            <label className="fld" style={{flex:1,minWidth:120,marginBottom:0}}><span>Tên hàng</span><input className="inp" value={nf.name} onChange={e=>setNf({...nf,name:e.target.value})} placeholder="VD: Coca lon"/></label>
            <label className="fld" style={{width:80,marginBottom:0}}><span>Đơn vị</span><input className="inp" value={nf.unit} onChange={e=>setNf({...nf,unit:e.target.value})} placeholder="lon"/></label>
            <label className="fld" style={{width:74,marginBottom:0}}><span>Tồn</span><input className="inp" type="number" value={nf.qty} onChange={e=>setNf({...nf,qty:e.target.value})}/></label>
            <label className="fld" style={{width:74,marginBottom:0}}><span>Tối thiểu</span><input className="inp" type="number" value={nf.min} onChange={e=>setNf({...nf,min:e.target.value})}/></label>
            <button className="btn" onClick={add}><i className="ti ti-plus"/>Thêm</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ================= Gậy & tủ ================= */
function CueView({s}){ // nhân viên quầy / phục vụ: 2 mục trong 1 màn
  const [sec,setSec]=useState('locker');
  const late=(s.lockers||[]).filter(l=>lockerBusy(l)&&l.dueDate&&daysLeft(l.dueDate)<0).length;
  return (
    <div>
      <Seg cur={sec} onPick={setSec} tabs={[
        {id:'locker',label:'Tủ gửi gậy',icon:'ti-lock',badge:late},
        {id:'cue',label:'Gậy của quán',icon:'ti-cricket'},
      ]}/>
      {sec==='locker'&&<LockerBoard s={s}/>}
      {sec==='cue'&&<CueStock cues={s.cues} setCues={s.setCues} tables={s.tables} me={s.me} isManager={s.isManager} flash={s.flash}/>}
    </div>
  );
}
function LockerBoard({s}){
  const {lockers,setLockers,customers,me,isManager,flash}=s;
  const [edit,setEdit]=useState(null);   // ô tủ đang mở
  const list=[...lockers].sort((a,b)=>(Number(a.no)||0)-(Number(b.no)||0));
  const busy=list.filter(lockerBusy);
  const late=busy.filter(l=>l.dueDate&&daysLeft(l.dueDate)<0);
  const soon=busy.filter(l=>l.dueDate&&daysLeft(l.dueDate)>=0&&daysLeft(l.dueDate)<=7);
  const addLocker=()=>{
    const no=list.reduce((a,l)=>Math.max(a,Number(l.no)||0),0)+1;
    setLockers(v=>[...v,{id:uid(),no,size:'Thường',fee:50000,custId:'',custName:'',phone:'',cue:'',startDate:'',dueDate:'',note:''}]);
    flash('Đã thêm ô tủ số '+no);
  };
  return (
    <div>
      <div>
        <div className="grid-stat">
          <div className="stat"><div className="ic g"><i className="ti ti-lock-open"/></div><div className="n">{list.length-busy.length}/{list.length}</div><div className="l">Ô tủ còn trống</div></div>
          <div className="stat"><div className="ic a"><i className="ti ti-clock-exclamation"/></div><div className="n">{soon.length}</div><div className="l">Sắp hết hạn</div></div>
          <div className="stat"><div className="ic r"><i className="ti ti-alert-triangle"/></div><div className="n">{late.length}</div><div className="l">Quá hạn</div></div>
        </div>

        {(late.length>0||soon.length>0)&&(
          <div className="panel">
            <div className="panel-h"><i className="ti ti-bell-ringing lead" style={{color:'var(--amber)'}}/><b>Cần nhắc khách đóng phí</b></div>
            <div className="panel-b" style={{paddingTop:6}}>
              {[...late,...soon].map(l=>{const d=dueChip(l.dueDate);return (
                <div className="row" key={l.id} onClick={()=>setEdit(l)} style={{cursor:'pointer'}}>
                  <span style={{fontSize:20}}>🔐</span>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontWeight:600}}>Tủ {l.no} · {l.custName}</div>
                    <div className="hint">{l.phone||'—'}{l.cue?' · '+l.cue:''}</div>
                  </div>
                  <span className={'chip '+d.chip}>{d.label}</span>
                </div>
              );})}
            </div>
          </div>
        )}

        <div className="panel">
          <div className="panel-h"><i className="ti ti-lock lead"/><b>Sơ đồ tủ</b><span className="hint">bấm ô để gán / trả</span>
            {isManager&&<button className="btn ghost sm" onClick={addLocker}><i className="ti ti-plus"/>Thêm ô</button>}
          </div>
          <div className="panel-b">
            <div className="tablegrid">
              {list.map(l=>{
                const d=lockerBusy(l)?dueChip(l.dueDate):null;
                const color=!lockerBusy(l)?null:(d&&d.late?'var(--red)':(d&&d.soon?'var(--amber)':'var(--grn)'));
                return (
                  <button key={l.id} className={'tbl'+(lockerBusy(l)?' on':'')} onClick={()=>setEdit(l)}
                    style={color?{borderColor:color,background:'var(--bg)'}:null}>
                    <span className="ty">{l.size}</span><span className="no">{l.no}</span>
                    {lockerBusy(l)
                      ? <span style={{fontSize:9.5,fontWeight:700,color,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis',maxWidth:'100%'}}>{l.custName.split(' ').slice(-2).join(' ')}</span>
                      : <span style={{fontSize:9.5,color:'var(--muted2)'}}>trống</span>}
                  </button>
                );
              })}
            </div>
            <p className="hint" style={{marginTop:10}}>Viền xanh = đang thuê · vàng = sắp hết hạn · đỏ = quá hạn. Ô trống thì bấm để cho khách thuê.</p>
          </div>
        </div>
      </div>

      {edit&&<LockerModal lk={edit} lockers={lockers} setLockers={setLockers} customers={customers} isManager={isManager}
        onClose={()=>setEdit(null)} flash={flash}/>}
    </div>
  );
}
function LockerModal({lk,lockers,setLockers,customers,isManager,onClose,flash}){
  const cur=lockers.find(x=>x.id===lk.id)||lk;
  const [f,setF]=useState(()=>({custId:cur.custId||'',cue:cur.cue||'',size:cur.size||'Thường',
    fee:cur.fee||0,startDate:cur.startDate||today(),dueDate:cur.dueDate||addDays(today(),30),note:cur.note||''}));
  const patch=(obj)=>setLockers(v=>v.map(x=>x.id===cur.id?{...x,...obj}:x));
  const save=()=>{
    const c=customers.find(x=>x.id===f.custId);
    if(!c){flash('Chọn khách thuê tủ');return;}
    if(lockers.some(x=>x.id!==cur.id&&x.custId===c.id)){flash(c.name+' đang thuê ô tủ khác rồi');return;}
    patch({custId:c.id,custName:c.name,phone:c.phone||'',cue:f.cue.trim(),size:f.size,
      fee:Number(f.fee)||0,startDate:f.startDate,dueDate:f.dueDate,note:f.note.trim()});
    flash('Tủ '+cur.no+' → '+c.name+' ✓');onClose();
  };
  const renew=()=>{
    const base=cur.dueDate&&daysLeft(cur.dueDate)>0?cur.dueDate:today();
    const d=addDays(base,30);
    patch({dueDate:d});setF({...f,dueDate:d});flash('Đã gia hạn tới '+fmtDateVN(d));
  };
  const free=()=>{
    if(!confirm('Trả tủ '+cur.no+' (khách lấy gậy về)?'))return;
    patch({custId:'',custName:'',phone:'',cue:'',startDate:'',dueDate:'',note:''});
    flash('Tủ '+cur.no+' đã trống');onClose();
  };
  const del=()=>{
    if(lockerBusy(cur)){flash('Trả tủ trước khi xoá ô');return;}
    if(!confirm('Xoá hẳn ô tủ số '+cur.no+'?'))return;
    setLockers(v=>v.filter(x=>x.id!==cur.id));onClose();
  };
  const d=lockerBusy(cur)?dueChip(cur.dueDate):null;
  return (
    <Modal title={'Tủ số '+cur.no} onClose={onClose}
      foot={lockerBusy(cur)
        ? <div className="rowbtns">
            <button className="btn ghost" style={{flex:1}} onClick={free}><i className="ti ti-lock-open"/>Trả tủ</button>
            <button className="btn" style={{flex:1}} onClick={renew}><i className="ti ti-calendar-plus"/>Gia hạn 1 tháng</button>
          </div>
        : <button className="btn block wide" onClick={save}><i className="ti ti-check"/>Cho thuê ô tủ này</button>}>
      {lockerBusy(cur)&&(
        <div className="card" style={{background:'var(--bg)',marginBottom:14}}>
          <div style={{display:'flex',alignItems:'center',gap:8}}>
            <div style={{flex:1}}>
              <div style={{fontWeight:700,fontSize:15}}>{cur.custName}</div>
              <div className="hint">{cur.phone||'chưa có SĐT'} · thuê từ {cur.startDate?fmtDateVN(cur.startDate):'—'}</div>
            </div>
            {d&&<span className={'chip '+d.chip}>{d.label}</span>}
          </div>
          {cur.cue&&<div className="hint" style={{marginTop:7}}>🎱 Gậy gửi: {cur.cue}</div>}
          {cur.note&&<div className="hint" style={{marginTop:3}}>Ghi chú: {cur.note}</div>}
          <div className="hint" style={{marginTop:3}}>Phí thuê: {fmtVnd(cur.fee)}/tháng</div>
        </div>
      )}
      {!lockerBusy(cur)&&(
        <div>
          <label className="fld"><span>Khách thuê</span>
            <select className="inp" value={f.custId} onChange={e=>setF({...f,custId:e.target.value})}>
              <option value="">— Chọn khách quen —</option>
              {customers.map(c=><option key={c.id} value={c.id}>{c.name}{c.phone?' · '+c.phone:''}</option>)}
            </select>
          </label>
          <label className="fld"><span>Gậy khách gửi</span>
            <input className="inp" value={f.cue} onChange={e=>setF({...f,cue:e.target.value})} placeholder="VD: Mezz EC7 + bao da đen"/></label>
          <div style={{display:'flex',gap:9,flexWrap:'wrap'}}>
            <label className="fld" style={{flex:1,minWidth:120}}><span>Bắt đầu</span>
              <input className="inp" type="date" value={f.startDate} onChange={e=>setF({...f,startDate:e.target.value,dueDate:addDays(e.target.value,30)})}/></label>
            <label className="fld" style={{flex:1,minWidth:120}}><span>Hết hạn</span>
              <input className="inp" type="date" value={f.dueDate} onChange={e=>setF({...f,dueDate:e.target.value})}/></label>
          </div>
          <div style={{display:'flex',gap:9,flexWrap:'wrap'}}>
            <label className="fld" style={{width:120}}><span>Cỡ tủ</span>
              <select className="inp" value={f.size} onChange={e=>setF({...f,size:e.target.value})}>
                <option>Thường</option><option>To</option></select></label>
            <label className="fld" style={{flex:1,minWidth:120}}><span>Phí thuê (đ/tháng)</span>
              <input className="inp" type="number" min="0" step="10000" value={f.fee} onChange={e=>setF({...f,fee:e.target.value})}/></label>
          </div>
          <label className="fld"><span>Ghi chú</span>
            <input className="inp" value={f.note} onChange={e=>setF({...f,note:e.target.value})} placeholder="VD: đã thu tiền tháng đầu"/></label>
        </div>
      )}
      {isManager&&!lockerBusy(cur)&&<button className="btn ghost sm" onClick={del}><i className="ti ti-trash"/>Xoá ô tủ này</button>}
    </Modal>
  );
}
function CueStock({cues,setCues,tables,me,isManager,flash}){
  const [nf,setNf]=useState({code:'',name:'',type:CUE_TYPES[0]});
  const out=cues.filter(c=>c.outTable);
  const add=()=>{
    if(!nf.name.trim()){flash('Nhập tên gậy');return;}
    setCues(v=>[...v,{id:uid(),code:nf.code.trim()||('G-'+pad(v.length+1)),name:nf.name.trim(),type:nf.type,
      cond:'good',outTable:'',outTs:0,note:''}]);
    setNf({code:'',name:'',type:CUE_TYPES[0]});flash('Đã thêm gậy');
  };
  const del=(c)=>{if(confirm('Xoá gậy '+c.code+'?'))setCues(v=>v.filter(x=>x.id!==c.id));};
  const setCond=(c)=>{
    const next=c.cond==='good'?'fix':(c.cond==='fix'?'broken':'good');
    setCues(v=>v.map(x=>x.id===c.id?{...x,cond:next}:x));
  };
  const lend=(c)=>{
    const no=prompt('Cho bàn số mấy mượn gậy '+c.code+'?','');
    if(no===null)return;
    const t=tables.find(x=>String(x.no)===String(no).trim());
    if(!t){flash('Không có bàn số '+no);return;}
    setCues(v=>v.map(x=>x.id===c.id?{...x,outTable:t.no,outTs:Date.now(),outBy:me.name}:x));
    flash(c.code+' → bàn '+t.no);
  };
  const back=(c)=>{setCues(v=>v.map(x=>x.id===c.id?{...x,outTable:'',outTs:0}:x));flash(c.code+' đã về giá ✓');};
  return (
    <div>
      <div className="grid-stat">
        <div className="stat"><div className="ic g"><i className="ti ti-cricket"/></div><div className="n">{cues.length}</div><div className="l">Gậy của quán</div></div>
        <div className="stat"><div className="ic b"><i className="ti ti-arrow-right-circle"/></div><div className="n">{out.length}</div><div className="l">Đang cho mượn</div></div>
        <div className="stat"><div className="ic r"><i className="ti ti-tool"/></div><div className="n">{cues.filter(c=>c.cond!=='good').length}</div><div className="l">Cần sửa / hỏng</div></div>
      </div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-cricket lead"/><b>Giá gậy</b><span className="hint">bấm tình trạng để đổi</span></div>
        <div className="panel-b" style={{paddingTop:6}}>
          {cues.length===0&&<Empty icon="ti-cricket" text="Chưa có gậy nào của quán"/>}
          {cues.map(c=>{const cd=CUE_COND[c.cond]||CUE_COND.good;return (
            <div className="row" key={c.id}>
              <span style={{fontSize:20}}>🎱</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:600}}>{c.code} · {c.name}</div>
                <div className="hint">{c.type}{c.outTable?' · đang ở bàn '+c.outTable:''}{c.note?' · '+c.note:''}</div>
              </div>
              <button className={'chip '+cd.chip} onClick={()=>setCond(c)} title="Đổi tình trạng">{cd.label}</button>
              {c.outTable
                ? <button className="btn sm" onClick={()=>back(c)}><i className="ti ti-arrow-back-up"/>Đã trả</button>
                : <button className="btn ghost sm" onClick={()=>lend(c)} disabled={c.cond==='broken'}><i className="ti ti-arrow-right"/>Cho mượn</button>}
              {isManager&&<button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>del(c)}><i className="ti ti-trash" style={{fontSize:16}}/></button>}
            </div>
          );})}
          {isManager&&<>
            <div className="sep"/>
            <div style={{fontWeight:700,fontSize:13,marginBottom:8}}>Thêm gậy</div>
            <div style={{display:'flex',gap:8,flexWrap:'wrap',alignItems:'flex-end'}}>
              <label className="fld" style={{width:90,marginBottom:0}}><span>Mã</span>
                <input className="inp" value={nf.code} onChange={e=>setNf({...nf,code:e.target.value})} placeholder="G-07"/></label>
              <label className="fld" style={{flex:1,minWidth:130,marginBottom:0}}><span>Tên gậy</span>
                <input className="inp" value={nf.name} onChange={e=>setNf({...nf,name:e.target.value})} placeholder="VD: Cơ chơi 12.5mm"/></label>
              <label className="fld" style={{width:110,marginBottom:0}}><span>Loại</span>
                <select className="inp" value={nf.type} onChange={e=>setNf({...nf,type:e.target.value})}>
                  {CUE_TYPES.map(t=><option key={t}>{t}</option>)}</select></label>
              <button className="btn" onClick={add}><i className="ti ti-plus"/>Thêm</button>
            </div>
          </>}
        </div>
      </div>
    </div>
  );
}

/* ================= App cho KHÁCH HÀNG ================= */
function CustomerApp({cust,tables,menu,orders,setOrders,promos,tiers,lockers,customers,setCustomers,feedback,setFeedback,alerts,setAlerts,tours,signups,setSignups,bookings,setBookings,highlights,setHighlights,broadcasts,cloud,dark,setDark,onLogout,flash}){
  const [view,setView]=useState('order');
  const [readBc,setReadBc]=usePersist('ps.readBc',[]);
  const myOrders=orders.filter(o=>o.by===('c:'+cust.id)).slice(0,20);
  const unread=(broadcasts||[]).filter(b=>!readBc.includes(b.id)).length;
  useEffect(()=>{ if(view==='noti'&&unread>0) setReadBc((broadcasts||[]).map(b=>b.id)); },[view,broadcasts]);
  const myBook=bookings.filter(b=>b.custId===cust.id);
  const bookNews=myBook.filter(b=>b.status!=='pending'&&b.decidedTs&&Date.now()-b.decidedTs<86400000).length;
  const myHl=(highlights||[]).filter(h=>h.custId===cust.id);
  const hlNews=myHl.filter(h=>h.status!=='pending'&&h.doneTs&&Date.now()-h.doneTs<86400000).length; // video/ phản hồi mới trong 24h
  const NAV=[{id:'order',label:'Đặt món',icon:'ti-glass-full'},{id:'book',label:'Đặt bàn',icon:'ti-calendar-event',badge:bookNews},
    {id:'hl',label:'Highlight',icon:'ti-video',badge:hlNews},
    {id:'tour',label:'Giải đấu',icon:'ti-trophy'},{id:'points',label:'Hạng',icon:'ti-star',badge:unusedRewards(cust).length},
    {id:'fb',label:'Góp ý',icon:'ti-message-2'}];
  const TITLES={order:['Đặt món','Chọn bàn & gọi đồ'],book:['Đặt bàn','Giữ bàn trước'],tour:['Giải đấu','Sắp diễn ra & đăng ký'],
    hl:['Highlight','Xin cắt clip pha bóng đẹp'],
    points:['Hạng của tôi','Giờ chơi · ưu đãi · quà'],noti:['Thông báo','Khuyến mãi & giải đấu'],fb:['Góp ý','Đánh giá quán']};
  const t=TITLES[view];
  return (
    <div className="app">
      <main className="main padbnav">
        <header className="topbar">
          <div><h1>{t[0]}</h1><div className="sub">Xin chào, {cust.name} · {t[1]}</div></div>
          <div className="spacer"/>
          <CloudDot status={cloud}/>
          <button className="iconbtn" onClick={()=>setView('noti')} title="Thông báo">
            <i className="ti ti-bell"/>{unread>0&&<span className="dot">{unread}</span>}</button>
          <button className="iconbtn" onClick={()=>setDark(!dark)}><i className={'ti '+(dark?'ti-sun':'ti-moon')}/></button>
          <button className="iconbtn" onClick={onLogout} title="Đăng xuất"><i className="ti ti-logout"/></button>
        </header>
        <div className="content">
          {view==='order'&&<CustOrder cust={cust} tables={tables} menu={menu} promos={promos} orders={myOrders} setOrders={setOrders} alerts={alerts} setAlerts={setAlerts} flash={flash}/>}
          {view==='book'&&<CustBooking cust={cust} tables={tables} bookings={myBook} setBookings={setBookings} flash={flash}/>}
          {view==='hl'&&<CustHighlight cust={cust} tables={tables} mine={myHl} setHighlights={setHighlights} flash={flash}/>}
          {view==='tour'&&<CustTours cust={cust} tours={tours} signups={signups} setSignups={setSignups} flash={flash}/>}
          {view==='points'&&<CustPoints cust={cust} promos={promos} tiers={tiers} locker={lockerOfCust(lockers,cust.id)}/>}
          {view==='noti'&&<CustNoti broadcasts={broadcasts}/>}
          {view==='fb'&&<CustFeedback cust={cust} setFeedback={setFeedback} flash={flash}/>}
        </div>
      </main>
      <nav className="bnav always">
        {NAV.map(n=>(<button key={n.id} className={view===n.id?'on':''} onClick={()=>setView(n.id)}>
          <i className={'ti '+n.icon}/>{n.label}{n.badge>0&&<span className="bd">{n.badge}</span>}</button>))}
      </nav>
    </div>
  );
}
function CustNoti({broadcasts}){
  const sorted=[...(broadcasts||[])].sort((a,b)=>b.ts-a.ts);
  if(sorted.length===0) return <Empty icon="ti-bell-off" text="Chưa có thông báo nào từ quán"/>;
  return (
    <div>
      {sorted.map(b=>{const k=BC_KINDS[b.kind]||BC_KINDS.promo;return (
        <div className="card" key={b.id} style={{marginBottom:11,borderLeft:'4px solid '+(b.kind==='tour'?'var(--blue)':'var(--amber)')}}>
          <div style={{display:'flex',gap:9,alignItems:'flex-start'}}>
            <span style={{fontSize:22}}>{k.icon}</span>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontWeight:700,fontSize:14.5,fontFamily:'"Baloo 2"'}}>{b.title}</div>
              {b.body&&<div style={{fontSize:13,color:'var(--muted)',marginTop:3,lineHeight:1.5,whiteSpace:'pre-wrap'}}>{b.body}</div>}
              <div className="hint" style={{marginTop:5}}>{new Date(b.ts).toLocaleString('vi',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</div>
            </div>
            <span className={'chip '+k.chip}>{k.label}</span>
          </div>
        </div>
      );})}
    </div>
  );
}
function CustBooking({cust,tables,bookings,setBookings,flash}){
  const types=[...new Set(tables.map(t=>t.type).filter(Boolean))];
  const [f,setF]=useState(()=>({date:today(),time:'19:00',hours:2,people:2,tableType:types[0]||'Tiêu chuẩn',note:''}));
  const priceOf=(ty)=>{const t=tables.find(x=>x.type===ty);return t?t.price:0;};
  const est=(Number(f.hours)||0)*priceOf(f.tableType);
  const send=()=>{
    if(!f.date||!f.time){flash('Chọn ngày & giờ');return;}
    if(f.date<today()){flash('Không đặt được ngày đã qua');return;}
    setBookings(v=>[{id:uid(),custId:cust.id,custName:cust.name,phone:cust.phone||'',date:f.date,time:f.time,
      hours:Number(f.hours)||1,people:Number(f.people)||1,tableType:f.tableType,note:f.note.trim(),
      status:'pending',ts:Date.now()},...v]);
    setF({...f,note:''});flash('Đã gửi yêu cầu đặt bàn — quán sẽ xác nhận sớm ⏳');
  };
  const cancel=(id)=>{if(confirm('Huỷ yêu cầu đặt bàn này?'))setBookings(v=>v.filter(b=>b.id!==id));};
  const mine=[...bookings].sort((a,b)=>b.ts-a.ts);
  return (
    <div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-calendar-plus lead"/><b>Đặt bàn trước</b></div>
        <div className="panel-b">
          <div style={{display:'flex',gap:9,flexWrap:'wrap'}}>
            <label className="fld" style={{flex:1,minWidth:130}}><span>Ngày</span><input className="inp" type="date" min={today()} value={f.date} onChange={e=>setF({...f,date:e.target.value})}/></label>
            <label className="fld" style={{width:110}}><span>Giờ tới</span><input className="inp" type="time" value={f.time} onChange={e=>setF({...f,time:e.target.value})}/></label>
          </div>
          <div style={{display:'flex',gap:9,flexWrap:'wrap'}}>
            <label className="fld" style={{flex:1,minWidth:100}}><span>Số giờ chơi</span><input className="inp" type="number" min="1" max="12" value={f.hours} onChange={e=>setF({...f,hours:e.target.value})}/></label>
            <label className="fld" style={{flex:1,minWidth:100}}><span>Số người</span><input className="inp" type="number" min="1" max="20" value={f.people} onChange={e=>setF({...f,people:e.target.value})}/></label>
          </div>
          <label className="fld"><span>Loại bàn</span>
            <div className="rowbtns">{types.map(ty=>(
              <button key={ty} className={'btn sm '+(f.tableType===ty?'':'ghost')} onClick={()=>setF({...f,tableType:ty})}>{ty} · {fmtVnd(priceOf(ty))}/h</button>
            ))}</div>
          </label>
          <label className="fld"><span>Ghi chú</span><input className="inp" value={f.note} onChange={e=>setF({...f,note:e.target.value})} placeholder="VD: cần bàn gần cửa sổ"/></label>
          {est>0&&<div className="chip g" style={{marginBottom:10}}>Tạm tính tiền bàn: {fmtVnd(est)}</div>}
          <button className="btn block wide" onClick={send}><i className="ti ti-send"/>Gửi yêu cầu đặt bàn</button>
          <p className="hint" style={{marginTop:8}}>Quán sẽ xác nhận hoặc báo lại nếu kín bàn. Kết quả hiện ngay bên dưới.</p>
        </div>
      </div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-history lead"/><b>Đặt bàn của tôi</b></div>
        <div className="panel-b" style={{paddingTop:6}}>
          {mine.length===0&&<Empty icon="ti-calendar-off" text="Bạn chưa đặt bàn lần nào"/>}
          {mine.map(b=>{const st=BK_ST[b.status]||BK_ST.pending;return (
            <div className="row" key={b.id}>
              <span style={{fontSize:20}}>📅</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:600}}>{fmtDateVN(b.date)} · {b.time} · {b.hours}h</div>
                <div className="hint">{b.tableType} · {b.people} người{b.reason?' · '+b.reason:''}</div>
              </div>
              <span className={'chip '+st.chip}>{st.label}</span>
              {b.status==='pending'&&<button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>cancel(b.id)}><i className="ti ti-trash" style={{fontSize:16}}/></button>}
            </div>
          );})}
        </div>
      </div>
    </div>
  );
}
function CustTours({cust,tours,signups,setSignups,flash}){
  const up=[...tours].filter(t=>!t.date||t.date>=today()).sort((a,b)=>(a.date||'').localeCompare(b.date||''));
  const past=[...tours].filter(t=>t.date&&t.date<today()).sort((a,b)=>(b.date||'').localeCompare(a.date||'')).slice(0,5);
  const regOf=(t)=>signups.filter(s=>s.tourId===t.id);
  const mine=(t)=>signups.find(s=>s.tourId===t.id&&s.custId===cust.id);
  const join=(t)=>{
    const regs=regOf(t);
    if(regs.length>=(Number(t.players)||0)){flash('Giải đã đủ người rồi 😢');return;}
    setSignups(v=>[{id:uid(),tourId:t.id,custId:cust.id,custName:cust.name,phone:cust.phone||'',checkedIn:false,paid:false,ts:Date.now()},...v]);
    flash('Đăng ký thành công! Tới quán đóng lệ phí nhé 🏆');
  };
  const leave=(t)=>{const m=mine(t);if(!m)return;if(confirm('Huỷ đăng ký giải này?')){setSignups(v=>v.filter(x=>x.id!==m.id));flash('Đã huỷ đăng ký');}};
  const card=(t,isPast)=>{
    const regs=regOf(t);const slots=Number(t.players)||0;const me=mine(t);const full=regs.length>=slots;
    return (
      <div className="card" key={t.id} style={{marginBottom:11,borderLeft:'4px solid '+(isPast?'var(--border)':'var(--amber)')}}>
        <div style={{display:'flex',alignItems:'flex-start',gap:8,marginBottom:6}}>
          <span style={{fontSize:22}}>🏆</span>
          <b style={{flex:1,fontSize:15,fontFamily:'"Baloo 2"'}}>{t.name}</b>
          {me&&!isPast&&<span className="chip gr"><i className="ti ti-check"/>Đã đăng ký</span>}
        </div>
        <div className="hint"><i className="ti ti-calendar"/> {t.date?fmtDateVN(t.date):'—'}{t.time?' · '+t.time:''} · {t.mode||'8 bi'}</div>
        <div className="hint"><i className="ti ti-tournament"/> {TOUR_FORMATS[t.format]||'—'} · race to {t.raceTo}</div>
        <div className="hint" style={{marginBottom:10}}><i className="ti ti-users"/> {regs.length}/{slots} người{full&&!me?' · ĐÃ ĐỦ':''}</div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,textAlign:'center',marginBottom:10}}>
          <div style={{background:'var(--bg)',borderRadius:10,padding:'8px 4px'}}><div className="hint">Lệ phí</div><b style={{fontFamily:'"Baloo 2"'}}>{fmtVnd(t.entryFee)}</b></div>
          <div style={{background:'var(--amber-lt)',borderRadius:10,padding:'8px 4px'}}><div className="hint">Giải thưởng</div><b style={{fontFamily:'"Baloo 2"',color:'var(--amber)'}}>{fmtVnd(t.prizePool)}</b></div>
        </div>
        {!isPast&&(me
          ? <button className="btn ghost block" onClick={()=>leave(t)}><i className="ti ti-x"/>Huỷ đăng ký</button>
          : <button className="btn block wide" disabled={full} onClick={()=>join(t)}><i className="ti ti-user-plus"/>{full?'Đã đủ người':'Đăng ký thi đấu'}</button>)}
      </div>
    );
  };
  return (
    <div>
      {up.length===0&&past.length===0&&<Empty icon="ti-trophy" text="Chưa có giải nào. Theo dõi thông báo của quán nhé!"/>}
      {up.length>0&&<div style={{fontSize:13,fontWeight:700,color:'var(--amber)',margin:'2px 2px 10px'}}><i className="ti ti-flame"/> Sắp diễn ra ({up.length})</div>}
      {up.map(t=>card(t,false))}
      {past.length>0&&<div style={{fontSize:13,fontWeight:700,color:'var(--muted)',margin:'16px 2px 10px'}}>Đã tổ chức</div>}
      {past.map(t=>card(t,true))}
    </div>
  );
}
function qrTableNo(){ try{ return new URLSearchParams(location.search).get('table'); }catch(e){ return null; } }
function CustOrder({cust,tables,menu,promos,orders,setOrders,alerts,setAlerts,flash}){
  const qrNo=qrTableNo();
  const findQr=(list)=>{ if(!qrNo)return null; const t=(list||[]).find(x=>String(x.no)===String(qrNo)); return t?t.id:null; };
  const [sel,setSel]=useState(()=>findQr(tables));
  const [cart,setCart]=useState({});
  const [note,setNote]=useState('');
  const [showPromo,setShowPromo]=useState(false);
  // bàn có thể tải từ cloud sau khi mount → chọn lại theo QR khi có
  const qrDone=useRef(false);
  useEffect(()=>{ if(qrNo&&!qrDone.current){ const id=findQr(tables); if(id){setSel(id);qrDone.current=true;} } },[tables]);
  const live=(promos||[]).filter(promoActive);
  const count=Object.values(cart).reduce((a,b)=>a+b,0);
  const cartTotal=Object.entries(cart).reduce((a,[n,q])=>a+q*priceOfItem(menu,n),0);
  const add=n=>setCart(c=>({...c,[n]:(c[n]||0)+1}));
  const dec=n=>setCart(c=>{const q=(c[n]||0)-1;const nc={...c};if(q<=0)delete nc[n];else nc[n]=q;return nc;});
  const send=()=>{
    if(!sel){flash('Chọn bàn bạn đang ngồi');return;}
    if(count===0){flash('Chọn món đã nhé');return;}
    const tbl=tables.find(t=>t.id===sel);
    const items=Object.entries(cart).map(([name,qty])=>({name,qty,price:priceOfItem(menu,name)}));
    setOrders(v=>[{id:uid(),table:tbl.no,items,note:note.trim(),by:'c:'+cust.id,byName:cust.name,source:'customer',status:'pending',ts:Date.now()},...v]);
    setCart({});setNote('');flash('Đã gửi order về quầy, nhân viên mang ra ngay 🎱'); // giữ nguyên bàn đang ngồi
  };
  // Gọi nhân viên: báo đã chơi xong (tắt bàn) / xin xếp bi
  const myOpen=(kind)=>{const tbl=tables.find(t=>t.id===sel);return tbl&&(alerts||[]).some(a=>a.status==='open'&&!alertExpired(a)&&a.kind===kind&&a.table===tbl.no&&a.by===('c:'+cust.id));};
  const CALL_MSG={end:'Đã báo nhân viên ra tắt bàn ✓',rack:'Đã báo nhân viên ra xếp bi ✓',remind:'Đã nhắc quầy mang đồ ra ✓'};
  const callStaff=(kind)=>{
    if(!sel){flash('Chọn bàn bạn đang ngồi trước nhé');return;}
    if(myOpen(kind)){flash('Đã báo rồi, nhân viên đang tới nhé ⏳');return;}
    const tbl=tables.find(t=>t.id===sel);
    setAlerts(v=>[{id:uid(),kind,table:tbl.no,by:'c:'+cust.id,byName:cust.name,source:'customer',status:'open',ts:Date.now()},...v]);
    flash(CALL_MSG[kind]||'Đã báo nhân viên ✓');
  };
  return (
    <div>
      {live.length>0&&(
        <div className="card" style={{marginBottom:14,padding:0,overflow:'hidden'}}>
          <button style={{display:'flex',alignItems:'center',gap:9,padding:'12px 15px',width:'100%',textAlign:'left'}} onClick={()=>setShowPromo(v=>!v)}>
            <span style={{fontSize:20}}>🎁</span><b style={{flex:1,fontFamily:'"Baloo 2"',fontSize:14}}>{live.length} ưu đãi hôm nay</b>
            <i className={'ti '+(showPromo?'ti-chevron-up':'ti-chevron-down')} style={{color:'var(--muted)',fontSize:20}}/>
          </button>
          {showPromo&&<div style={{padding:'0 15px 12px'}}>{live.map(p=>(
            <div key={p.id} style={{padding:'8px 0',borderTop:'1px solid var(--border)'}}>
              <div style={{display:'flex',gap:8,alignItems:'center'}}><b style={{fontSize:13.5}}>{p.title}</b>{p.percent>0&&<span className="chip a">-{p.percent}%</span>}</div>
              <div className="hint" style={{marginTop:2}}>{p.desc}</div>
            </div>
          ))}</div>}
        </div>
      )}
      <div className="panel">
        <div className="panel-h"><i className="ti ti-layout-grid lead"/><b>Bàn bạn đang ngồi</b>{sel&&<span className="chip g">Bàn {tables.find(t=>t.id===sel).no}</span>}</div>
        <div className="panel-b">
          <div className="tablegrid">
            {tables.map(t=>(
              <button key={t.id} className={'tbl'+(sel===t.id?' on':'')} onClick={()=>setSel(t.id)}>
                <span className="ty">Bàn</span><span className="no">{t.no}</span>
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h"><i className="ti ti-bell lead"/><b>Gọi nhân viên</b></div>
        <div className="panel-b">
          <div className="rowbtns">
            <button className={'btn wide '+(myOpen('rack')?'ghost':'')} style={{flex:1,flexDirection:'column',gap:3,minWidth:96}} onClick={()=>callStaff('rack')}>
              <span style={{fontSize:24}}>🎱</span><span>Xếp bi</span>
              {myOpen('rack')&&<span style={{fontSize:11,opacity:.8}}>đang tới…</span>}
            </button>
            <button className={'btn wide '+(myOpen('remind')?'ghost':'')} style={{flex:1,flexDirection:'column',gap:3,minWidth:96,background:myOpen('remind')?null:'linear-gradient(135deg,#f59e0b,#d97706)',boxShadow:myOpen('remind')?null:'0 4px 12px rgba(217,119,6,.3)'}} onClick={()=>callStaff('remind')}>
              <span style={{fontSize:24}}>⏰</span><span>Đồ chưa mang ra</span>
              {myOpen('remind')&&<span style={{fontSize:11,opacity:.8}}>đang tới…</span>}
            </button>
            <button className={'btn wide '+(myOpen('end')?'ghost':'red')} style={{flex:1,flexDirection:'column',gap:3,minWidth:96}} onClick={()=>callStaff('end')}>
              <span style={{fontSize:24}}>🏁</span><span>Đã chơi xong</span>
              {myOpen('end')&&<span style={{fontSize:11,opacity:.8}}>đang tới…</span>}
            </button>
          </div>
          <p className="hint" style={{marginTop:9}}>“Xếp bi” — nhân viên ra xếp bi. “Đồ chưa mang ra” — nhắc quầy món của bạn. “Đã chơi xong” — nhân viên ra tắt bàn & chốt tiền giờ.</p>
        </div>
      </div>

      <div className="panel">
        <div className="panel-h"><i className="ti ti-glass-full lead"/><b>Chọn món</b>{count>0&&<span className="chip a">{count} món</span>}</div>
        <div className="panel-b">
          {menu.map(g=>(
            <div className="menugrp" key={g.grp}>
              <div className="gh">{g.grp}</div>
              <div className="mitems">
                {g.items.map(it=>(
                  <button key={it.name} className="mitem" onClick={()=>add(it.name)}>{cart[it.name]>0&&<span className="q">{cart[it.name]}</span>}{it.name}
                    <em style={{fontStyle:'normal',fontSize:11,color:'var(--muted)',fontWeight:600}}>{fmtVnd(it.price)}</em></button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
      {count>0&&(
        <div className="panel">
          <div className="panel-h"><i className="ti ti-shopping-cart lead"/><b>Đơn của bạn</b></div>
          <div className="panel-b">
            {Object.entries(cart).map(([n,q])=>(
              <div className="row" key={n}><div style={{flex:1,minWidth:0}}><div style={{fontWeight:600}}>{n}</div>
                <div className="hint">{fmtVnd(priceOfItem(menu,n))} × {q} = <b>{fmtVnd(q*priceOfItem(menu,n))}</b></div></div>
                <div className="stepper"><button onClick={()=>dec(n)}>−</button><b>{q}</b><button onClick={()=>add(n)}>+</button></div></div>
            ))}
            <div className="row" style={{borderTop:'2px solid var(--border)'}}>
              <span style={{flex:1,fontWeight:700}}>Tạm tính</span>
              <b style={{fontFamily:'"Baloo 2"',fontSize:18,color:'var(--g)'}}>{fmtVnd(cartTotal)}</b>
            </div>
            <label className="fld" style={{marginTop:12}}><span>Ghi chú (ít đá, không đường…)</span><input className="inp" value={note} onChange={e=>setNote(e.target.value)} placeholder="Tuỳ chọn"/></label>
          </div>
        </div>
      )}
      <button className="btn wide block" onClick={send} disabled={!sel||count===0} style={{marginBottom:16}}>
        <i className="ti ti-send"/>Gửi order{sel?` · Bàn ${tables.find(t=>t.id===sel).no}`:''}{count>0?` · ${count} món · ${fmtVnd(cartTotal)}`:''}
      </button>

      {orders.length>0&&(
        <div className="panel">
          <div className="panel-h"><i className="ti ti-receipt lead"/><b>Đơn đã gửi</b></div>
          <div className="panel-b" style={{paddingTop:6}}>
            {orders.map(o=>(
              <div className="row" key={o.id}>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:600}}>Bàn {o.table} · {o.items.map(i=>i.qty+'× '+i.name).join(', ')}</div>
                  <div className="hint">{new Date(o.ts).toLocaleTimeString('vi',{hour:'2-digit',minute:'2-digit'})}{o.note?' · '+o.note:''}</div>
                </div>
                <span className={'chip '+(o.status==='done'?'gr':'a')}>{o.status==='done'?'Đã phục vụ':'Đang chờ'}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
function CustPoints({cust,promos,tiers,locker}){
  const live=(promos||[]).filter(promoActive);
  const L=tierLevels(tiers);
  const tier=tierOf(tiers,cust.hours), nx=nextTier(tiers,cust.hours);
  const base=Number(tier?tier.hours:0)||0;
  const pct=nx?Math.min(100,Math.round(((cust.hours||0)-base)/Math.max(1,(Number(nx.hours)||0)-base)*100)):100;
  const gifts=(cust.rewards||[]);
  const openGifts=unusedRewards(cust);
  return (
    <div>
      <div className="card" style={{textAlign:'center',marginBottom:16}}>
        <CustPic c={cust} size={64}/>
        <div style={{fontWeight:700,fontSize:17,marginTop:8}}>{cust.name} {cust.vip&&<i className="ti ti-crown" style={{color:'var(--amber)'}}/>}</div>
        <div className="hint">{cust.phone}</div>
        {tier&&<div style={{marginTop:9}}><TierChip t={tier} big/></div>}
        <div style={{fontFamily:'"Baloo 2"',fontSize:40,fontWeight:800,color:'var(--g)',marginTop:8}}>{fmtHours(cust.hours)}</div>
        <div className="hint">tổng giờ chơi · {cust.points} điểm · {cust.visits} lượt đến</div>
        {cust.games&&cust.games.length>0&&<div className="rowbtns" style={{justifyContent:'center',marginTop:10}}>{cust.games.map(g=><span key={g} className="chip g">{g}</span>)}</div>}
      </div>

      <div className="panel">
        <div className="panel-h"><i className="ti ti-stairs-up lead"/><b>Tiến trình lên hạng</b></div>
        <div className="panel-b">
          <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:7,fontSize:13,fontWeight:600}}>
            <span>{tier?tier.icon+' '+tier.name:'—'}</span>
            <div className="spacer" style={{flex:1}}/>
            <span style={{color:'var(--muted)'}}>{nx?nx.icon+' '+nx.name:'cao nhất 🏆'}</span>
          </div>
          <div className={'prog'+(nx?'':' full')}><i style={{width:pct+'%'}}/></div>
          <div className="hint" style={{marginTop:7}}>
            {nx
              ?<>Chơi thêm <b style={{color:'var(--g)'}}>{fmtHours(Math.max(0,(Number(nx.hours)||0)-(cust.hours||0)))}</b> nữa là lên hạng <b>{nx.name}</b> —
                 giảm {Number(nx.discount)||0}% tiền bàn{nx.gift?', tặng '+nx.gift:''}.</>
              :<>Bạn đang ở hạng cao nhất của quán 🎉</>}
          </div>
          {tier&&(Number(tier.discount)||tier.perks)&&<div className="card" style={{background:'var(--bg)',marginTop:12,marginBottom:0}}>
            <div style={{fontWeight:700,fontSize:13,marginBottom:4}}>Quyền lợi hạng {tier.name}</div>
            <div className="hint">{Number(tier.discount)>0?'Giảm '+tier.discount+'% tiền bàn mỗi lượt chơi':'Tích điểm mỗi giờ chơi'}{tier.perks?' · '+tier.perks:''}</div>
          </div>}
          <p className="hint" style={{marginTop:10}}>Giờ chơi được cộng khi quán chốt bill có gắn tên bạn. Mỗi giờ chơi = {tiers.ptsPerHour||0} điểm.</p>
        </div>
      </div>

      {locker&&(()=>{const d=dueChip(locker.dueDate);return (
        <div className="panel">
          <div className="panel-h"><i className="ti ti-lock lead"/><b>Tủ gậy của tôi</b>{d&&<span className={'chip '+d.chip}>{d.label}</span>}</div>
          <div className="panel-b">
            <div style={{display:'flex',alignItems:'center',gap:12}}>
              <div style={{fontFamily:'"Baloo 2"',fontSize:34,fontWeight:800,color:'var(--g)'}}>#{locker.no}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:600}}>Tủ {locker.size?locker.size.toLowerCase():''} · {fmtVnd(locker.fee)}/tháng</div>
                <div className="hint">{locker.cue?'🎱 '+locker.cue:'Chưa ghi gậy gửi'}</div>
              </div>
            </div>
            <p className="hint" style={{marginTop:9}}>{d&&d.late
              ?'Tủ đã quá hạn — báo quầy đóng phí để giữ tủ nhé.'
              :'Cần lấy gậy hoặc gia hạn thì báo quầy.'}</p>
          </div>
        </div>
      );})()}

      <div className="panel">
        <div className="panel-h"><i className="ti ti-gift lead"/><b>Quà của tôi</b>
          {openGifts.length>0&&<span className="chip a">{openGifts.length} chưa nhận</span>}</div>
        <div className="panel-b" style={{paddingTop:6}}>
          {gifts.length===0&&<Empty icon="ti-gift-off" text="Chưa có quà — lên hạng là có quà ngay"/>}
          {gifts.slice(0,10).map(r=>(
            <div className="row" key={r.id}>
              <span style={{fontSize:20}}>{r.used?'✅':'🎁'}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:600,textDecoration:r.used?'line-through':'none'}}>{r.label}</div>
                <div className="hint">quà lên hạng {r.tier} · {new Date(r.ts).toLocaleDateString('vi')}</div>
              </div>
              <span className={'chip '+(r.used?'':'gr')}>{r.used?'đã nhận':'còn hiệu lực'}</span>
            </div>
          ))}
          {openGifts.length>0&&<p className="hint" style={{marginTop:8}}>Báo nhân viên để nhận quà — quán sẽ tick vào hồ sơ của bạn.</p>}
        </div>
      </div>

      <div className="panel">
        <div className="panel-h"><i className="ti ti-list-numbers lead"/><b>Các hạng của quán</b></div>
        <div className="panel-b" style={{paddingTop:6}}>
          {L.map(lv=>{const got=(cust.hours||0)>=(Number(lv.hours)||0);return (
            <div className="row" key={lv.id} style={{opacity:got?1:.62}}>
              <span style={{fontSize:20}}>{lv.icon||'⭐'}</span>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontWeight:600}}>{lv.name} <span className="hint">· từ {fmtHours(lv.hours)}</span></div>
                <div className="hint">Giảm {Number(lv.discount)||0}% tiền bàn{lv.gift?' · 🎁 '+lv.gift:''}{lv.perks?' · '+lv.perks:''}</div>
              </div>
              {got&&<span className="chip gr"><i className="ti ti-check"/>đã đạt</span>}
            </div>
          );})}
        </div>
      </div>
      {live.length>0&&(
        <div className="panel">
          <div className="panel-h"><i className="ti ti-gift lead"/><b>Ưu đãi đang có</b></div>
          <div className="panel-b" style={{paddingTop:6}}>
            {live.map(p=>(<div className="row" key={p.id}><div style={{flex:1,minWidth:0}}><div style={{fontWeight:600}}>{p.title}</div><div className="hint">{p.desc}</div></div>{p.percent>0&&<span className="chip a">-{p.percent}%</span>}</div>))}
          </div>
        </div>
      )}
      <div className="panel">
        <div className="panel-h"><i className="ti ti-history lead"/><b>Lịch sử điểm</b></div>
        <div className="panel-b" style={{paddingTop:6}}>
          {(!cust.history||cust.history.length===0)&&<Empty icon="ti-star-off" text="Chưa có giao dịch điểm"/>}
          {(cust.history||[]).slice(0,20).map((h,i)=>(
            <div className="row" key={i}><div style={{flex:1,minWidth:0}}><div style={{fontWeight:600,fontSize:13}}>{h.reason}</div><div className="hint">{new Date(h.ts).toLocaleString('vi',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</div></div>
              <div style={{fontWeight:700,fontFamily:'"Baloo 2"',color:h.delta>0?'var(--grn)':'var(--red)'}}>{h.delta>0?'+':''}{h.delta}</div></div>
          ))}
        </div>
      </div>
    </div>
  );
}
function CustFeedback({cust,setFeedback,flash}){
  const [rating,setRating]=useState('good');
  const [tags,setTags]=useState([]);
  const [comment,setComment]=useState('');
  const [sent,setSent]=useState(false);
  const toggleTag=(t)=>setTags(v=>v.includes(t)?v.filter(x=>x!==t):[...v,t]);
  const submit=()=>{
    if(tags.length===0&&!comment.trim()){flash('Chọn vài mục hoặc viết góp ý nhé');return;}
    setFeedback(v=>[{id:uid(),custId:cust.id,custName:cust.name,rating,tags,comment:comment.trim(),ts:Date.now()},...v]);
    setSent(true);setTags([]);setComment('');flash('Cảm ơn bạn đã góp ý! 🙏');
  };
  if(sent) return (
    <div className="card" style={{textAlign:'center',padding:'40px 20px'}}>
      <div style={{fontSize:48}}>🙏</div>
      <div style={{fontWeight:700,fontSize:16,marginTop:8}}>Cảm ơn bạn đã góp ý!</div>
      <p className="hint" style={{marginTop:6}}>Quán sẽ tiếp thu để phục vụ tốt hơn.</p>
      <button className="btn ghost" style={{marginTop:14}} onClick={()=>setSent(false)}>Gửi góp ý khác</button>
    </div>
  );
  return (
    <div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-mood-smile lead"/><b>Bạn thấy quán thế nào?</b></div>
        <div className="panel-b">
          <div className="rowbtns" style={{marginBottom:14}}>
            {Object.entries(FB_RATING).map(([k,v])=>(
              <button key={k} className={'btn '+(rating===k?'':'ghost')} style={{flex:1,flexDirection:'column',padding:'12px 6px'}} onClick={()=>setRating(k)}>
                <span style={{fontSize:24}}>{v.icon}</span><span style={{fontSize:12}}>{v.label}</span>
              </button>
            ))}
          </div>
          <div style={{fontWeight:700,fontSize:13,color:'var(--grn)',marginBottom:8}}>👍 Điểm hài lòng</div>
          <div className="rowbtns" style={{marginBottom:14}}>
            {FB_GOOD.map(t=><button key={t} className={'btn sm '+(tags.includes(t)?'':'ghost')} onClick={()=>toggleTag(t)}>{t}</button>)}
          </div>
          <div style={{fontWeight:700,fontSize:13,color:'var(--red)',marginBottom:8}}>⚠️ Cần cải thiện</div>
          <div className="rowbtns" style={{marginBottom:14}}>
            {FB_BAD.map(t=><button key={t} className={'btn sm '+(tags.includes(t)?'':'ghost')} onClick={()=>toggleTag(t)}>{t}</button>)}
          </div>
          <label className="fld"><span>Nhận xét thêm</span><textarea className="inp" value={comment} onChange={e=>setComment(e.target.value)} placeholder="Chia sẻ thêm cảm nhận của bạn…"/></label>
          <button className="btn block wide" onClick={submit}><i className="ti ti-send"/>Gửi góp ý</button>
        </div>
      </div>
    </div>
  );
}

/* ================= Highlight: khách xin cắt clip, quản lý gửi link video =================
   Khách chọn bàn + mốc thời gian chính xác (giờ:phút:giây) → quán cắt cam → dán link video.
   Video gửi về nằm luôn trong tab Highlight của khách (đồng bộ cloud qua ps_highlights).
*/
const HL_ST={pending:{label:'Chờ cắt clip',chip:'a'},done:{label:'Đã có video',chip:'gr'},rejected:{label:'Không cắt được',chip:'r'}};
const nowHMS=()=>{const d=new Date();return pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());};
const hmsToSec=t=>{const p=String(t||'').split(':').map(Number);return (p[0]||0)*3600+(p[1]||0)*60+(p[2]||0);};
const secToHMS=s=>{s=((Math.round(s)%86400)+86400)%86400;return pad(Math.floor(s/3600))+':'+pad(Math.floor(s/60)%60)+':'+pad(s%60);};
// Khoảng cam cần cắt: mốc pha bóng lùi/tiến vài giây
const hlFrom=h=>secToHMS(hmsToSec(h.at)-(Number(h.before)||0));
const hlTo=h=>secToHMS(hmsToSec(h.at)+(Number(h.after)||0));
const hlRange=h=>hlFrom(h)+' → '+hlTo(h);
const hlLen=h=>(Number(h.before)||0)+(Number(h.after)||0);
const safeUrl=u=>/^https?:\/\//i.test(String(u||'').trim())?String(u).trim():'';
const ytId=u=>{const m=/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/|live\/))([\w-]{11})/.exec(u||'');return m?m[1]:'';};
const isVidFile=u=>/\.(mp4|webm|ogg|mov)(\?.*)?$/i.test(u||'');
function VideoBox({url}){
  const u=safeUrl(url); if(!u)return null;
  const yt=ytId(u);
  if(yt) return <div className="vidwrap"><iframe src={'https://www.youtube.com/embed/'+yt} title="Highlight" allowFullScreen
    allow="accelerometer; encrypted-media; picture-in-picture; fullscreen"/></div>;
  if(isVidFile(u)) return <div className="vidwrap"><video src={u} controls playsInline preload="metadata"/></div>;
  return <a className="btn block wide" href={u} target="_blank" rel="noopener noreferrer" style={{marginTop:9}}><i className="ti ti-external-link"/>Mở video</a>;
}

/* ----- App khách: xin cắt clip + kho video của mình ----- */
function CustHighlight({cust,tables,mine,setHighlights,flash}){
  const qrNo=qrTableNo();
  const findQr=(list)=>{ if(!qrNo)return ''; const t=(list||[]).find(x=>String(x.no)===String(qrNo)); return t?t.id:''; };
  const [sel,setSel]=useState(()=>findQr(tables));
  const [tab,setTab]=useState('new'); // new | vid
  const [f,setF]=useState(()=>({date:today(),at:nowHMS(),before:30,after:15,note:''}));
  const qrDone=useRef(false);
  useEffect(()=>{ if(qrNo&&!qrDone.current){ const id=findQr(tables); if(id){setSel(id);qrDone.current=true;} } },[tables]);
  const list=[...(mine||[])].sort((a,b)=>b.ts-a.ts);
  const vids=list.filter(h=>h.status==='done'&&safeUrl(h.videoUrl));
  const send=()=>{
    if(!sel){flash('Chọn bàn bạn đang chơi');return;}
    if(!f.at){flash('Nhập thời điểm pha bóng');return;}
    if(f.date>today()){flash('Không chọn được ngày ở tương lai');return;}
    const tbl=tables.find(t=>t.id===sel); if(!tbl){flash('Bàn không còn tồn tại');return;}
    setHighlights(v=>[{id:uid(),custId:cust.id,custName:cust.name,phone:cust.phone||'',
      table:tbl.no,date:f.date,at:f.at,before:Number(f.before)||0,after:Number(f.after)||0,
      note:f.note.trim(),status:'pending',ts:Date.now()},...v]);
    setF({...f,note:''});
    flash('Đã gửi yêu cầu cắt clip — quán sẽ gửi video sớm 🎬');
  };
  const quick=(back)=>setF(x=>({...x,date:today(),at:secToHMS(hmsToSec(nowHMS())-back)}));
  const cancel=(id)=>{ if(confirm('Huỷ yêu cầu cắt clip này?')) setHighlights(v=>v.filter(h=>h.id!==id)); };
  return (
    <div>
      <div className="seg">
        <button className={tab==='new'?'on':''} onClick={()=>setTab('new')}><i className="ti ti-scissors"/>Xin cắt clip</button>
        <button className={tab==='vid'?'on':''} onClick={()=>setTab('vid')}><i className="ti ti-player-play"/>Video của tôi {vids.length>0&&`(${vids.length})`}</button>
      </div>

      {tab==='new'&&<div>
        <div className="panel">
          <div className="panel-h"><i className="ti ti-video lead"/><b>Xin cắt clip pha bóng đẹp</b></div>
          <div className="panel-b">
            <label className="fld"><span>Bàn bạn đang chơi</span>
              <select className="inp" value={sel} onChange={e=>setSel(e.target.value)}>
                <option value="">— Chọn bàn —</option>
                {tables.map(t=><option key={t.id} value={t.id}>Bàn {t.no} · {t.type}</option>)}
              </select>
            </label>
            <div style={{display:'flex',gap:9,flexWrap:'wrap'}}>
              <label className="fld" style={{flex:1,minWidth:130}}><span>Ngày</span>
                <input className="inp" type="date" max={today()} value={f.date} onChange={e=>setF({...f,date:e.target.value})}/></label>
              <label className="fld" style={{width:135}}><span>Lúc mấy giờ (giờ:phút:giây)</span>
                <input className="inp" type="time" step="1" value={f.at} onChange={e=>setF({...f,at:e.target.value})}/></label>
            </div>
            <div className="rowbtns" style={{marginBottom:12}}>
              <button className="btn ghost sm" onClick={()=>quick(20)}>Vừa xong (20 giây trước)</button>
              <button className="btn ghost sm" onClick={()=>quick(60)}>1 phút trước</button>
              <button className="btn ghost sm" onClick={()=>quick(300)}>5 phút trước</button>
            </div>
            <div style={{display:'flex',gap:9,flexWrap:'wrap'}}>
              <label className="fld" style={{flex:1,minWidth:110}}><span>Lấy trước (giây)</span>
                <input className="inp" type="number" min="0" max="300" value={f.before} onChange={e=>setF({...f,before:e.target.value})}/></label>
              <label className="fld" style={{flex:1,minWidth:110}}><span>Lấy sau (giây)</span>
                <input className="inp" type="number" min="0" max="300" value={f.after} onChange={e=>setF({...f,after:e.target.value})}/></label>
            </div>
            <label className="fld"><span>Mô tả pha bóng</span>
              <input className="inp" value={f.note} onChange={e=>setF({...f,note:e.target.value})} placeholder="VD: cú đi 3 băng ăn bi 8"/></label>
            <div className="chip b" style={{marginBottom:10}}><i className="ti ti-clock"/>Cắt đoạn {hlRange(f)} · dài ~{hlLen(f)} giây</div>
            <button className="btn block wide" onClick={send}><i className="ti ti-send"/>Gửi yêu cầu cắt clip</button>
            <p className="hint" style={{marginTop:8}}>Ghi đúng giờ:phút:giây thì quán tìm trên camera nhanh hơn. Xong quán gửi link video vào mục <b>Video của tôi</b>.</p>
          </div>
        </div>
        <div className="panel">
          <div className="panel-h"><i className="ti ti-history lead"/><b>Yêu cầu của tôi</b></div>
          <div className="panel-b" style={{paddingTop:6}}>
            {list.length===0&&<Empty icon="ti-video-off" text="Bạn chưa xin cắt clip lần nào"/>}
            {list.map(h=>{const st=HL_ST[h.status]||HL_ST.pending;return (
              <div className="row" key={h.id}>
                <span style={{fontSize:20}}>🎬</span>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:600}}>Bàn {h.table} · {fmtDateVN(h.date)} · {h.at}</div>
                  <div className="hint">{h.note||'—'}{h.reason?' · '+h.reason:''}</div>
                </div>
                <span className={'chip '+st.chip}>{st.label}</span>
                {h.status==='pending'&&<button className="iconbtn" style={{padding:6,border:0,background:'none'}} onClick={()=>cancel(h.id)}><i className="ti ti-trash" style={{fontSize:16}}/></button>}
              </div>
            );})}
          </div>
        </div>
      </div>}

      {tab==='vid'&&<div>
        {vids.length===0&&<Empty icon="ti-player-play" text="Chưa có video nào — xin cắt clip rồi quán sẽ gửi vào đây"/>}
        {vids.map(h=>(
          <div className="panel" key={h.id}>
            <div className="panel-h"><i className="ti ti-player-play lead"/><b>{h.videoTitle||('Bàn '+h.table+' · '+fmtDateVN(h.date))}</b></div>
            <div className="panel-b">
              <VideoBox url={h.videoUrl}/>
              <div className="hint" style={{marginTop:4}}>
                Bàn {h.table} · {fmtDateVN(h.date)} · {h.at}{h.note?' · '+h.note:''}
                {h.doneTs?' · quán gửi '+new Date(h.doneTs).toLocaleString('vi',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}):''}
              </div>
              <a className="btn ghost sm" href={safeUrl(h.videoUrl)} target="_blank" rel="noopener noreferrer" style={{marginTop:9}}><i className="ti ti-external-link"/>Mở / tải về</a>
            </div>
          </div>
        ))}
      </div>}
    </div>
  );
}

/* ----- Quản lý: xử lý yêu cầu & gửi link video ----- */
function HighlightMgr({highlights,setHighlights,customers,me,flash}){
  const [edit,setEdit]=useState(null);  // yêu cầu đang gán link
  const [url,setUrl]=useState('');
  const [title,setTitle]=useState('');
  const [openNew,setOpenNew]=useState(false);
  const [nf,setNf]=useState({custId:'',url:'',title:'',note:''});
  const all=highlights||[];
  const pending=all.filter(h=>h.status==='pending').sort((a,b)=>a.ts-b.ts);
  const rest=all.filter(h=>h.status!=='pending').sort((a,b)=>(b.doneTs||b.ts)-(a.doneTs||a.ts)).slice(0,20);
  const openSend=(h)=>{setEdit(h);setUrl(h.videoUrl||'');setTitle(h.videoTitle||'');};
  const save=()=>{
    const u=safeUrl(url);
    if(!u){flash('Dán link bắt đầu bằng http(s): YouTube, Drive, file .mp4…');return;}
    setHighlights(v=>v.map(h=>h.id===edit.id?{...h,videoUrl:u,videoTitle:title.trim(),status:'done',
      doneTs:Date.now(),doneBy:me.name,reason:''}:h));
    setEdit(null);setUrl('');setTitle('');flash('Đã gửi video cho khách ✓');
  };
  const reject=(h)=>{
    const r=prompt('Lý do (khách sẽ thấy):','Camera không lưu được đoạn đó');
    if(r===null)return;
    setHighlights(v=>v.map(x=>x.id===h.id?{...x,status:'rejected',doneTs:Date.now(),doneBy:me.name,reason:r}:x));
    flash('Đã báo lại cho khách');
  };
  const del=(h)=>{ if(confirm('Xoá hẳn mục highlight này?')) setHighlights(v=>v.filter(x=>x.id!==h.id)); };
  const sendNew=()=>{
    const c=(customers||[]).find(x=>x.id===nf.custId);
    if(!c){flash('Chọn khách nhận video');return;}
    const u=safeUrl(nf.url); if(!u){flash('Dán link http(s) hợp lệ');return;}
    setHighlights(v=>[{id:uid(),custId:c.id,custName:c.name,phone:c.phone||'',table:'',date:today(),at:nowHMS(),
      before:0,after:0,note:nf.note.trim(),videoUrl:u,videoTitle:nf.title.trim(),status:'done',
      ts:Date.now(),doneTs:Date.now(),doneBy:me.name},...v]);
    setNf({custId:'',url:'',title:'',note:''});setOpenNew(false);
    flash('Đã gửi video cho '+c.name+' ✓');
  };
  const card=(h)=>{
    const st=HL_ST[h.status]||HL_ST.pending;
    return (
      <div className={'ocard'+(h.status!=='pending'?' done':'')} key={h.id}
        style={h.status==='pending'?{borderLeftColor:'var(--blue)'}:null}>
        <div className="oh">
          <span style={{fontSize:20}}>🎬</span>
          <span className="otbl">{h.table?'Bàn '+h.table:'Gửi trực tiếp'}</span>
          <div className="spacer" style={{flex:1}}/>
          <span className={'chip '+st.chip}>{st.label}</span>
        </div>
        <div style={{fontWeight:600,fontSize:13.5,marginBottom:2}}>{h.custName} · {h.phone||'—'}</div>
        {h.status==='pending'||h.table?(
          <div className="hint" style={{marginBottom:9}}>
            {fmtDateVN(h.date)} · pha bóng lúc <b>{h.at}</b>{hlLen(h)>0&&<> · cắt {hlRange(h)} (~{hlLen(h)}s)</>}
            {h.note?' · '+h.note:''}
          </div>
        ):<div className="hint" style={{marginBottom:9}}>{h.note||'—'}</div>}
        {h.status==='done'&&safeUrl(h.videoUrl)&&<VideoBox url={h.videoUrl}/>}
        {h.status==='rejected'&&h.reason&&<div className="hint" style={{marginBottom:9}}>Lý do: {h.reason}</div>}
        <div style={{display:'flex',alignItems:'center',gap:8,flexWrap:'wrap'}}>
          {h.status!=='pending'&&<span className="hint">{h.doneBy?'bởi '+h.doneBy:''}</span>}
          <div className="spacer" style={{flex:1}}/>
          <button className="btn ghost sm" onClick={()=>del(h)}><i className="ti ti-trash"/></button>
          {h.status==='pending'&&<button className="btn ghost sm" onClick={()=>reject(h)}><i className="ti ti-x"/>Không cắt được</button>}
          <button className="btn sm" onClick={()=>openSend(h)}>
            <i className={'ti '+(h.status==='done'?'ti-edit':'ti-link')}/>{h.status==='done'?'Sửa link':'Gửi link video'}</button>
        </div>
      </div>
    );
  };
  return (
    <div>
      <div className="panel">
        <div className="panel-h"><i className="ti ti-video lead"/><b>Cắt clip cho khách</b>
          <div className="spacer" style={{flex:1}}/>
          <button className="btn ghost sm" onClick={()=>setOpenNew(v=>!v)}><i className="ti ti-plus"/>Gửi video</button>
        </div>
        {openNew&&<div className="panel-b">
          <p className="hint" style={{marginBottom:9}}>Gửi thẳng một video cho khách mà không cần khách phải xin.</p>
          <label className="fld"><span>Khách nhận</span>
            <select className="inp" value={nf.custId} onChange={e=>setNf({...nf,custId:e.target.value})}>
              <option value="">— Chọn khách —</option>
              {(customers||[]).map(c=><option key={c.id} value={c.id}>{c.name}{c.phone?' · '+c.phone:''}</option>)}
            </select>
          </label>
          <label className="fld"><span>Link video</span>
            <input className="inp" value={nf.url} onChange={e=>setNf({...nf,url:e.target.value})} placeholder="https://youtu.be/… hoặc link Drive / .mp4"/></label>
          <label className="fld"><span>Tiêu đề</span>
            <input className="inp" value={nf.title} onChange={e=>setNf({...nf,title:e.target.value})} placeholder="VD: Cú đi 3 băng tối thứ 7"/></label>
          <label className="fld"><span>Ghi chú</span>
            <input className="inp" value={nf.note} onChange={e=>setNf({...nf,note:e.target.value})} placeholder="tuỳ chọn"/></label>
          <button className="btn block wide" onClick={sendNew}><i className="ti ti-send"/>Gửi cho khách</button>
        </div>}
      </div>
      {pending.length===0&&rest.length===0&&<Empty icon="ti-video-off" text="Chưa có yêu cầu cắt clip nào"/>}
      {pending.length>0&&<div style={{fontSize:13,fontWeight:700,color:'var(--blue)',margin:'2px 2px 10px'}}><i className="ti ti-scissors"/> Chờ cắt clip ({pending.length})</div>}
      {pending.map(card)}
      {rest.length>0&&<div style={{fontSize:13,fontWeight:700,color:'var(--muted)',margin:'16px 2px 10px'}}>Đã xử lý</div>}
      {rest.map(card)}
      {edit&&<Modal title={'Gửi video cho '+edit.custName} onClose={()=>setEdit(null)}
        foot={<button className="btn block wide" onClick={save}><i className="ti ti-send"/>Gửi cho khách</button>}>
        <div className="hint" style={{marginBottom:11}}>
          {edit.table?<>Bàn {edit.table} · </>:null}{fmtDateVN(edit.date)} · pha bóng lúc <b>{edit.at}</b>
          {hlLen(edit)>0&&<> · cắt đoạn <b>{hlRange(edit)}</b> (~{hlLen(edit)} giây)</>}
          {edit.note?<><br/>Khách mô tả: {edit.note}</>:null}
        </div>
        <label className="fld"><span>Link video</span>
          <input className="inp" value={url} onChange={e=>setUrl(e.target.value)} placeholder="https://youtu.be/… hoặc link Drive / .mp4"/></label>
        <label className="fld"><span>Tiêu đề (khách nhìn thấy)</span>
          <input className="inp" value={title} onChange={e=>setTitle(e.target.value)} placeholder={'Bàn '+edit.table+' · '+fmtDateVN(edit.date)}/></label>
        {safeUrl(url)&&<VideoBox url={url}/>}
        <p className="hint">Link YouTube hoặc file .mp4 sẽ xem được ngay trong app. Link khác (Drive, Facebook…) hiện nút mở tab mới — nhớ đặt quyền xem công khai.</p>
      </Modal>}
    </div>
  );
}

/* ================= mount ================= */
ReactDOM.createRoot(document.getElementById('root')).render(<App/>);
