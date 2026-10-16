/*
 * MIJOZ BUYURTMALARI → ADMIN TELEGRAM GURUHI: har buyurtma guruhga YETIB BORISHI.
 * Soxta Telegram serveri + xotiradagi modellar. Baza KERAK EMAS.
 * npm run test:admin-order-delivery
 */
import http from 'node:http';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);

const calls = [];
let mode = 'ok';          // ok | telurl | ratelimit | migrate | down | notmodified | notfound
let msgId = 900; let rlOnce = true;
const server = http.createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const method = req.url.split('/').pop();
    const data = body ? JSON.parse(body) : {};
    calls.push({ method, data });
    const reply = (o, st = 200) => { res.statusCode = st; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    const buttons = (data.reply_markup?.inline_keyboard || []).flat();
    if (mode === 'down' && method === 'sendMessage') return reply({ ok: false, error_code: 502, description: 'Bad Gateway' }, 502);
    if (mode === 'telurl' && buttons.some((b) => String(b.url || '').startsWith('tel:'))) return reply({ ok: false, error_code: 400, description: 'Bad Request: wrong HTTP URL: tel:+998901112233' }, 400);
    if (mode === 'ratelimit' && rlOnce && method === 'sendMessage') { rlOnce = false; return reply({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } }, 429); }
    if (mode === 'migrate') {
      if (String(data.chat_id) === '-100222') return reply({ ok: true, result: { message_id: ++msgId } });
      return reply({ ok: false, error_code: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -100222 } }, 400);
    }
    if (method === 'editMessageText' && mode === 'notmodified') return reply({ ok: false, error_code: 400, description: 'Bad Request: message is not modified' }, 400);
    if (method === 'editMessageText' && mode === 'notfound') return reply({ ok: false, error_code: 400, description: 'Bad Request: message to edit not found' }, 400);
    if (method === 'getMe') return reply({ ok: true, result: { id: 777, username: 'lokmabot' } });
    if (method === 'getChat') return reply({ ok: true, result: { id: Number(data.chat_id), type: 'supergroup', title: 'Buyurtmalar' } });
    if (method === 'getChatMember') return reply({ ok: true, result: { status: 'administrator' } });
    reply({ ok: true, result: { message_id: ++msgId } });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.TELEGRAM_BOT_TOKEN = '1:TEST';
process.env.ADMIN_ALERTS_CHAT_ID = '-100111';

const { Order } = await import('../src/models/Order.js');
const { AdminOrderPost } = await import('../src/models/AdminOrderPost.js');
const mon = await import('../src/services/adminOrderMonitor.js');

// ── xotiradagi modellar ──
const orders = new Map(); const posts = new Map();
const mkOrder = (n, over = {}) => { const _id = String(n).padStart(24, '0'); const o = {
  _id, status: 'pending', fulfillment: 'delivery', restaurantName: 'TOTLI', items: [{ name: 'Tort', quantity: 1, unitPrice: 160000 }], subtotal: 160000, deliveryFee: 14500, total: 174500,
  paymentMethod: 'cash', phone: '+998901112233', address: 'Namangan', dailyNumber: n, createdAt: new Date(), userId: { firstName: 'Ali', username: 'ali_u', phone: '+998901112233' }, restaurantId: { name: 'TOTLI', phone: '+998712000000' }, ...over };
  orders.set(_id, o); return o; };
const chain = (v) => ({ populate() { return this; }, select() { return this; }, sort() { return this; }, limit() { return this; }, lean: async () => structuredClone(v) });
Order.findById = (id) => chain(orders.get(String(id)) || null);
Order.find = (f) => { const list = [...orders.values()].filter((o) => (!f.status || f.status.$in.includes(o.status)) && (!f.createdAt || o.createdAt >= f.createdAt.$gte) && (!f.fulfillment || f.fulfillment.$in.includes(o.fulfillment))); return chain(list); };
AdminOrderPost.findOne = (f) => chain(posts.get(String(f.orderId)) || null);
AdminOrderPost.find = (f) => { const ids = f.orderId?.$in?.map(String); return chain([...posts.values()].filter((p) => !ids || ids.includes(String(p.orderId)))); };
AdminOrderPost.findOneAndUpdate = async (f, u) => { const k = String(f.orderId); const cur = posts.get(k) || { _id: `p${k}`, orderId: k }; Object.assign(cur, u.$set); posts.set(k, cur); return cur; };
AdminOrderPost.updateOne = async (f, u) => { const p = [...posts.values()].find((x) => x._id === f._id); if (p && u.$set) Object.assign(p, u.$set); return {}; };

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const reset = () => { calls.length = 0; posts.clear(); orders.clear(); rlOnce = true; mode = 'ok'; };
const sends = () => calls.filter((c) => c.method === 'sendMessage');

console.log('\n[1] Yangi buyurtma — guruhga tushadi');
reset(); let o = mkOrder(1);
await mon.onOrderReleasedToKitchen(o._id);
ok(sends().length === 1 && posts.has(o._id), 'buyurtma posti yuborildi va saqlandi');
const t1 = sends()[0].data.text.replace(/\u00a0/g, ' ');
ok(/Tort/.test(t1) && /174 500/.test(t1) && t1.includes('+998901112233'), 'matnda taom, summa va mijoz telefoni bor');
ok(sends()[0].data.disable_notification !== true, 'bildirishnoma bilan (jim emas)');

console.log('\n[2] Telegram tel: tugmasini rad etadi — buyurtma baribir tushishi kerak');
reset(); mode = 'telurl'; o = mkOrder(2);
await mon.onOrderReleasedToKitchen(o._id);
ok(posts.has(o._id), 'tel: tugmasi rad etilsa ham buyurtma posti yuborildi');
ok(sends().at(-1)?.data.text.includes('+998901112233'), 'telefon matnda qoladi (Telegram uni bosiladigan qiladi)');
ok(!(sends().at(-1)?.data.reply_markup?.inline_keyboard || []).flat().some((b) => String(b.url || '').startsWith('tel:')), 'qayta yuborishda tel: tugmalari olib tashlandi');
ok((sends().at(-1)?.data.reply_markup?.inline_keyboard || []).flat().some((b) => /done:/.test(b.callback_data || '')), 'amal tugmalari (Yakunlandi/Bekor) saqlanib qoldi');

console.log('\n[3] Telegram 429 — qayta uriniladi');
reset(); mode = 'ratelimit'; o = mkOrder(3);
await mon.onOrderReleasedToKitchen(o._id);
ok(posts.has(o._id) && sends().length >= 2, '429 dan keyin yuborildi');

console.log('\n[4] Guruh supergruppaga aylangan');
reset(); mode = 'migrate'; o = mkOrder(4);
await mon.onOrderReleasedToKitchen(o._id);
ok(posts.get(o._id)?.chatId === '-100222', 'yangi guruh ID’siga yuborildi va post shu ID bilan saqlandi');
const o4b = mkOrder(41); calls.length = 0;
await mon.onOrderReleasedToKitchen(o4b._id);
ok(sends()[0]?.data.chat_id === '-100222', 'keyingi buyurtmalar ham yangi ID’ga');

console.log('\n[5] Telegram vaqtincha ishlamadi — keyingi tekshiruvda BUYURTMA YO‘QOLMAYDI (o‘zi yetkaziladi)');
reset(); mode = 'down'; o = mkOrder(5);
await mon.onOrderReleasedToKitchen(o._id);
ok(!posts.has(o._id), 'Telegram ishlamaganda post yo‘q (kutilgan)');
mode = 'ok'; calls.length = 0;
await mon.tickAdminOrderMonitor();
ok(posts.has(o._id) && sends().length === 1, 'tiklangach davriy tekshiruv yetkazilmagan buyurtmani guruhga yubordi');
calls.length = 0;
await mon.tickAdminOrderMonitor();
ok(sends().length === 0, 'qayta tekshiruvda DUBLIKAT yuborilmadi');

console.log('\n[6] Kelmasligi kerak bo‘lganlar');
reset();
const aw = mkOrder(6, { status: 'awaiting_payment' }); const din = mkOrder(7, { fulfillment: 'dinein' }); const old = mkOrder(8, { createdAt: new Date(Date.now() - 6 * 3600e3) }); const done = mkOrder(9, { status: 'delivered' });
await mon.tickAdminOrderMonitor();
ok(sends().length === 0, 'to‘lov kutilayotgan, zal (dine-in), 3 soatdan eski va yakunlangan buyurtmalar guruhga yuborilmadi');

console.log('\n[7] Holat o‘zgarishi — post tahrirlanadi');
reset(); o = mkOrder(10);
await mon.onOrderReleasedToKitchen(o._id);
orders.get(o._id).status = 'accepted'; calls.length = 0;
await mon.refreshAdminOrderPost(o._id);
ok(calls.some((c) => c.method === 'editMessageText') && posts.get(o._id).lastStatus === 'accepted', 'status o‘zgargach post tahrirlandi');
mode = 'notmodified'; orders.get(o._id).status = 'preparing';
await mon.refreshAdminOrderPost(o._id);
ok(posts.get(o._id).orphaned !== true, '"message is not modified" postni YETIMGA aylantirmaydi (keyingi yangilanishlar to‘xtab qolmasin)');
mode = 'notfound'; orders.get(o._id).status = 'ready';
await mon.refreshAdminOrderPost(o._id);
ok(posts.get(o._id).orphaned === true, 'post guruhdan o‘chirilgan bo‘lsa — yetim (admin ataylab tozalagan bo‘lishi mumkin)');

console.log('\n[8] Sozlama bo‘sh bo‘lsa — jim emas, diagnostika aytadi');
{
  const { config } = await import('../src/config/index.js');
  mon._resetChatOverride();
  const saved = config.adminAlertsChatId; config.adminAlertsChatId = '';
  reset(); o = mkOrder(11); await mon.onOrderReleasedToKitchen(o._id);
  ok(sends().length === 0, 'ID bo‘sh — yuborilmaydi (xato emas)');
  const st = await mon.adminOrderGroupStatus();
  ok(!st.ok && st.problems.some((p) => /ADMIN_ALERTS_CHAT_ID|SUPPORT_GROUP_CHAT_ID/.test(p)), 'diagnostika sababini aytadi');
  config.adminAlertsChatId = saved;
  const st2 = await mon.adminOrderGroupStatus();
  ok(st2.ok === true && st2.chat?.title === 'Buyurtmalar', 'to‘g‘ri sozlamada ok');
}

server.close();
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
