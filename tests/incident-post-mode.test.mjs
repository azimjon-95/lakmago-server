/*
 * "MIJOZ RAD ETDI" — STANDART REJIM (CANCEL_APPROVAL_REQUIRED=false): restoran buyurtmani DARHOL bekor qiladi,
 * admin KEYIN ko'rib chiqadi; xabar admin guruhiga ishonchli yetadi (guruh ishlamasa ham buyurtma bekor bo'ladi va
 * keyin tiklanadi). HAQIQIY baza (MONGO_URI) + soxta Telegram.  npm run test:incident-post
 */
import http from 'node:http';
import mongoose from 'mongoose';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
delete process.env.CANCEL_APPROVAL_REQUIRED;
const calls = []; let tgMode = 'ok'; let msgId = 800;
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    const method = req.url.split('/').pop(); const data = b ? JSON.parse(b) : {}; calls.push({ method, data });
    res.setHeader('content-type', 'application/json');
    if (tgMode === 'down') { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' })); }
    res.end(JSON.stringify({ ok: true, result: { message_id: ++msgId } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.TELEGRAM_BOT_TOKEN = '1:TEST';
process.env.ADMIN_ALERTS_CHAT_ID = '-100222';

const { config } = await import('../src/config/index.js');
const { Order } = await import('../src/models/Order.js');
const { User } = await import('../src/models/User.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { CustomerIncident } = await import('../src/models/CustomerIncident.js');
const inc = await import('../src/services/customerIncidents.js');
await mongoose.connect(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_post_mode');
const logs = []; const origErr = console.error; console.error = (...a) => { logs.push(a.join(' ')); };

let fails = 0; const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const sends = () => calls.filter((c) => c.method === 'sendMessage');
const rest = await Restaurant.create({ name: 'POST-MODE Restoran', category: 'restoran', cuisine: 'Milliy', isActive: true });
const user = await User.create({ telegramId: '9100' + Date.now() % 100000, firstName: 'Mijoz', role: 'customer', isActive: true });
const mkOrder = (status, extra = {}) => Order.create({
  userId: user._id, restaurantId: rest._id, restaurantName: rest.name,
  items: [{ name: 'Lorus Set', quantity: 1, unitPrice: 360000 }], subtotal: 360000, deliveryFee: 15000, total: 375000,
  status, fulfillment: 'delivery', paymentMethod: 'cash', address: 'Namangan', phone: '+998901112233', acceptedAt: new Date(), ...extra,
});
const args = (o, code = 'changed_mind') => ({ orderId: String(o._id), restaurantId: String(rest._id), reasonCode: code, requestedBy: 'TOTLI bot' });

console.log('\n[1] Standart rejim: buyurtma DARHOL bekor, admin guruhiga xabar');
ok(config.cancelApprovalRequired === false, 'CANCEL_APPROVAL_REQUIRED berilmagan → tasdiq SHART EMAS (standart)');
let o1 = await mkOrder('accepted'); calls.length = 0;
const r1 = await inc.createCancelRequest(args(o1));
const db1 = await Order.findById(o1._id).lean();
ok(r1.mode === 'post' && r1.incident.mode === 'post', 'rejim: post');
ok(db1.status === 'cancelled' && Boolean(db1.cancelledAt), `buyurtma DARHOL bekor qilindi (status=${db1.status})`);
ok(db1.cancelReasonCode === 'refused_changed_mind' && /Mijoz voz kechdi/.test(db1.cancelReason), `sabab kodi va matni yozildi (${db1.cancelReasonCode})`);
ok(db1.cancelRequest?.status === 'approved', 'cancelRequest = approved (admin keyin ko‘radi)');
const inc1 = await CustomerIncident.findById(r1.incident._id).lean();
ok(inc1.status === 'pending' && inc1.mode === 'post', 'holat qayd etildi: admin ko‘rib chiqishi kutilmoqda');
const g1 = sends().find((c) => String(c.data.chat_id) === '-100222');
ok(g1 && /bekor qilindi/.test(g1.data.text) && /admin ko‘rib chiqishi kutilmoqda/.test(g1.data.text), 'admin guruhiga "bekor qilindi — admin ko‘rib chiqishi kutilmoqda" xabari tushdi');
ok(inc1.groupPost?.messageId > 0, 'guruh xabari ID si saqlandi (keyin tahrirlash uchun)');

console.log('\n[2] Guruh ISHLAMASA: buyurtma BARIBIR bekor, keyin guruhga o‘zi tushadi');
tgMode = 'down'; calls.length = 0; logs.length = 0;
let o2 = await mkOrder('preparing');
const r2 = await inc.createCancelRequest(args(o2, 'no_answer'));
ok((await Order.findById(o2._id).lean()).status === 'cancelled', 'guruh xatosida ham buyurtma bekor qilindi (restoran ishi to‘xtamadi)');
ok(r2.incident && !(await CustomerIncident.findById(r2.incident._id).lean()).groupPost, 'so‘rov yaratildi, guruh xabari hali yo‘q');
ok(logs.some((l) => /chat not found/.test(l)), 'sababi logda');
tgMode = 'ok'; calls.length = 0;
const n = await inc.catchUpIncidentPosts();
ok(n >= 1 && (await CustomerIncident.findById(r2.incident._id).lean()).groupPost?.messageId > 0, 'guruh tuzalgach so‘rov o‘zi yuborildi (tiklash vazifasi standart rejimda ham ishlaydi)');

console.log('\n[3] Bekor qilib bo‘lmasa — hammasi ortga qaytariladi');
const o3 = await mkOrder('delivered');
let e3 = null; try { await inc.createCancelRequest(args(o3)); } catch (e) { e3 = e; }
ok(e3?.code === 'WRONG_STATE', `yakunlangan buyurtma: ${e3?.code}`);
ok((await CustomerIncident.countDocuments({ orderId: o3._id })) === 0, 'qoldiq so‘rov (incident) yo‘q');
ok((await Order.findById(o3._id).lean()).status === 'delivered', 'yakunlangan buyurtma o‘zgarmadi');

console.log('\n[4] Eski rejim (CANCEL_APPROVAL_REQUIRED=true) saqlangan: buyurtma bekor bo‘lmaydi, admin tasdig‘ini kutadi');
config.cancelApprovalRequired = true; calls.length = 0;
const o4 = await mkOrder('accepted');
const r4 = await inc.createCancelRequest(args(o4, 'not_needed'));
const db4 = await Order.findById(o4._id).lean();
ok(r4.mode === 'approval' && db4.status === 'accepted' && db4.cancelRequest?.status === 'pending', `tasdiq rejimi: status=${db4.status}, cancelRequest=${db4.cancelRequest?.status}`);
config.cancelApprovalRequired = false;

await Promise.all([Order.deleteMany({ restaurantId: rest._id }), CustomerIncident.deleteMany({ restaurantId: rest._id }), User.deleteOne({ _id: user._id }), Restaurant.deleteOne({ _id: rest._id })]);
console.error = origErr; server.close(); await mongoose.disconnect();
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
