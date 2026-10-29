/*
 * "MIJOZ VOZ KECHDI" so'rovi → ADMIN GURUHI: xabar yo'qolmasligi. Soxta Telegram + xotiradagi model. Baza KERAK EMAS.
 * npm run test:incident-group
 */
import http from 'node:http';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
// Bu test TASDIQ KUTUVCHI rejim uchun (CANCEL_APPROVAL_REQUIRED=true). Standart ("darhol bekor") rejim — tests/incident-post-mode.test.mjs
process.env.CANCEL_APPROVAL_REQUIRED = 'true';
const calls = []; let mode = 'ok'; let msgId = 500; let rlOnce = true;
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => { b += c; });
  req.on('end', () => {
    const method = req.url.split('/').pop(); const data = b ? JSON.parse(b) : {}; calls.push({ method, data });
    const reply = (o, st = 200) => { res.statusCode = st; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(o)); };
    if (mode === 'notfound') return reply({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }, 400);
    if (mode === 'kicked') return reply({ ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' }, 403);
    if (mode === 'ratelimit' && rlOnce && method === 'sendMessage') { rlOnce = false; return reply({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } }, 429); }
    if (mode === 'migrate') { if (String(data.chat_id) === '-100777') return reply({ ok: true, result: { message_id: ++msgId } }); return reply({ ok: false, error_code: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -100777 } }, 400); }
    reply({ ok: true, result: { message_id: ++msgId } });
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${server.address().port}`;
process.env.TELEGRAM_BOT_TOKEN = '1:TEST';
process.env.ADMIN_ALERTS_CHAT_ID = '-100111';

const { CustomerIncident } = await import('../src/models/CustomerIncident.js');
const { config } = await import('../src/config/index.js');
const mon = await import('../src/services/adminOrderMonitor.js');
const inc = await import('../src/services/customerIncidents.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const logs = []; const origErr = console.error; console.error = (...a) => { logs.push(a.join(' ')); };

// xotiradagi so'rovlar
let rows = [];
const mk = (n, o = {}) => ({ _id: String(n).padStart(24, 'a'), status: 'pending', orderLabel: `#${n}`, restaurantName: 'TOTLI', reason: 'Mijoz fikrini o‘zgartirdi', createdAt: new Date(), groupPostAttempts: 0,
  snapshot: { firstName: 'Ali', phone: '+998901112233' }, order: { items: [{ name: 'Tort', qty: 1 }], total: 150_000, paymentMethod: 'cash' }, ...o });
CustomerIncident.updateOne = async (f, u) => { const r = rows.find((x) => x._id === f._id); if (r) { if (u.$inc) for (const [k, v] of Object.entries(u.$inc)) r[k] = (r[k] || 0) + v; if (u.$set) Object.assign(r, u.$set); } return {}; };
CustomerIncident.find = (f) => ({ sort() { return this; }, limit() { return this; }, lean: async () => structuredClone(rows.filter((r) => r.status === f.status && !r.groupPost?.messageId && (r.groupPostAttempts || 0) < f.groupPostAttempts.$lt)) });
const sends = () => calls.filter((c) => c.method === 'sendMessage');
const reset = () => { calls.length = 0; logs.length = 0; rows = []; mode = 'ok'; rlOnce = true; mon._resetChatOverride(); config.adminAlertsChatId = '-100111'; };
const post = async (r) => { rows.push(r); await mon.sendAlert({ text: 'x' }); };

console.log('\n[1] Guruh sozlangan, Telegram ishlaydi — keladi');
reset(); rows.push(mk(1));
let n = await inc.catchUpIncidentPosts();
ok(n === 1 && sends().length === 1 && sends()[0].data.chat_id === '-100111', 'so‘rov guruhga yuborildi');
ok(/Mijoz buyurtmadan voz kechdi/.test(sends()[0].data.text) && /TOTLI/.test(sends()[0].data.text) && /150 000/.test(sends()[0].data.text.replace(/\u00a0/g, ' ')), 'matnda restoran, summa va sarlavha bor');
ok(rows[0].groupPost?.messageId > 0 && rows[0].groupPostAttempts === 1, 'xabar ID saqlandi (keyin tahrirlanadi)');
calls.length = 0; n = await inc.catchUpIncidentPosts();
ok(n === 0 && sends().length === 0, 'yuborilgan so‘rov qayta yuborilmaydi (dublikat yo‘q)');

console.log('\n[2] Guruh SOZLANMAGAN — jim emas, sababi logda; tuzalgach o‘zi keladi');
reset(); config.adminAlertsChatId = ''; rows.push(mk(2));
n = await inc.catchUpIncidentPosts();
ok(n === 0 && sends().length === 0, 'ID yo‘q — yuborilmadi');
ok(logs.some((l) => /ADMIN_ALERTS_CHAT_ID/.test(l) && /yuborilmadi/.test(l)), 'logda aniq sabab: ADMIN_ALERTS_CHAT_ID sozlanmagan');
config.adminAlertsChatId = '-100111'; n = await inc.catchUpIncidentPosts();
ok(n === 1 && rows[0].groupPost?.messageId, 'guruh sozlangach so‘rov O‘ZI guruhga tushdi (yo‘qolmadi)');

console.log('\n[3] Telegram xatolari');
reset(); mode = 'notfound'; rows.push(mk(3));
await inc.catchUpIncidentPosts();
ok(logs.some((l) => /chat not found/.test(l)), '"chat not found" — logda sababi');
ok(rows[0].groupPostAttempts === 1 && !rows[0].groupPost, 'urinish hisoblandi, xabar ID yo‘q');
mode = 'ok'; n = await inc.catchUpIncidentPosts();
ok(n === 1, 'Telegram tuzalgach — keyingi tekshiruvda yuborildi');
reset(); mode = 'kicked'; rows.push(mk(4)); await inc.catchUpIncidentPosts();
ok(logs.some((l) => /kicked/.test(l)), 'bot guruhdan chiqarilgan — sababi logda');
reset(); mode = 'ratelimit'; rows.push(mk(5)); n = await inc.catchUpIncidentPosts();
ok(n === 1 && sends().length >= 2, '429 (juda tez) — qayta urinib yuborildi');
reset(); mode = 'migrate'; rows.push(mk(6)); n = await inc.catchUpIncidentPosts();
ok(n === 1 && rows[0].groupPost?.chatId === '-100777', 'guruh supergruppaga ko‘chgan — yangi ID’ga yuborildi va saqlandi');

console.log('\n[4] Urinishlar cheklangan, eski/hal qilingan so‘rovlar yuborilmaydi');
reset(); rows.push(mk(7, { groupPostAttempts: 60 }), mk(8, { status: 'approved' }), mk(9, { groupPost: { chatId: '-100111', messageId: 5 } }));
n = await inc.catchUpIncidentPosts();
ok(n === 0 && sends().length === 0, '60 urinishdan keyin, hal qilingan va allaqachon yuborilganlar — tegilmaydi');

console.log('\n[5] HAQIQIY createCancelRequest (restoran "Bekor qilish" tugmasi) → guruhga tushadi');
{
  const { Order } = await import('../src/models/Order.js');
  const ORD = String(70).padStart(24, 'b'); const RST = String(9).padStart(24, 'a');
  const order = { _id: ORD, status: 'accepted', restaurantId: { _id: RST, name: 'TOTLI Tortlari' }, restaurantName: 'TOTLI Tortlari', userId: { _id: 'u'.padStart(24, 'c'), firstName: 'Ali', phone: '+998901112233' }, total: 150000, paymentMethod: 'cash', items: [{ name: 'Rafaelo', quantity: 1, unitPrice: 150000 }], address: 'Namangan', phone: '+998901112233', createdAt: new Date(), dailyNumber: 1 };
  const chain = (v) => ({ populate() { return this; }, select() { return this; }, lean: async () => v, then: (a, b) => Promise.resolve(v).then(a, b) });
  Order.findOne = () => chain(order);
  Order.countDocuments = async () => 3;
  Order.findOneAndUpdate = async () => ({ ...order, _id: ORD, cancelRequest: { status: 'pending' } });
  Order.findById = () => chain(null);
  let created = null;
  CustomerIncident.countDocuments = async () => 0;
  CustomerIncident.create = async (d) => { created = { _id: String(1).padStart(24, 'd'), status: 'pending', createdAt: new Date(), groupPostAttempts: 0, ...d }; rows.push(created); return created; };
  CustomerIncident.deleteOne = async () => ({});
  reset();
  const r = await inc.createCancelRequest({ orderId: ORD, restaurantId: RST, reasonCode: 'changed_mind', requestedBy: 'TOTLI bot' });
  ok(r.incident && created, 'so‘rov yaratildi');
  ok(sends().length === 1 && /voz kechdi/.test(sends()[0].data.text) && /TOTLI Tortlari/.test(sends()[0].data.text), 'restoran tugmasi bosilganda admin guruhiga xabar TUSHDI');
  ok(sends()[0].data.reply_markup?.inline_keyboard?.[0]?.[0]?.url?.startsWith('https://') , 'tugma — https havola (Telegram qabul qiladi)');
  ok(created.groupPost?.messageId > 0, 'xabar ID saqlandi');
  // Guruh xato bersa so'rov BARIBIR yaratiladi (restoran "admin qarori kutilmoqda" ni ko'radi) va tiklanadi
  reset(); mode = 'notfound'; created = null;
  const r2 = await inc.createCancelRequest({ orderId: ORD, restaurantId: RST, reasonCode: 'changed_mind', requestedBy: 'TOTLI bot' });
  ok(r2.incident && created && !created.groupPost, 'guruh xatosida ham so‘rov yaratildi (jarayon to‘xtamadi)');
  ok(logs.some((l) => /chat not found/.test(l)), 'sababi logda');
  mode = 'ok'; n = await inc.catchUpIncidentPosts();
  ok(n === 1 && created.groupPost?.messageId, 'guruh tuzalgach so‘rov guruhga o‘zi tushdi');
}

console.error = origErr; server.close();
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
