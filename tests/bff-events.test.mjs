/*
 * ═══════════════════════════════════════════════════════════
 * BFF HODISALARI — HAMMA YO'L QAMRALGANMI, YETKAZISH TO'G'RIMI
 * ═══════════════════════════════════════════════════════════
 * Haqiqiy funksiyalar (changeOrderStatus, courierDispatch, deliveryCheck,
 * restaurantReminders, controllerlar) chaqiriladi; yuborish HAQIQIY HTTP
 * serverga (soxta BFF). npm run test:bff-events
 */
import http from 'node:http';

const BFF_PORT = 4391;
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/lokma_bff_events';
process.env.BFF_BASE_URL = `http://127.0.0.1:${BFF_PORT}/`; // oxiridagi "/" tozalanishi ham tekshiriladi
process.env.BFF_WEBHOOK_SECRET = 'test-secret-abc123';
process.env.TELEGRAM_BOT_TOKEN = '1:T';
process.env.RESTAURANT_BOT_TOKEN = '1:R';
process.env.JWT_SECRET = 'x'.repeat(40);

/* ── soxta BFF ── */
const received = [];
let bffStatus = 200;
const bff = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let json = null; try { json = JSON.parse(body); } catch { /* bo'sh */ }
    received.push({ method: req.method, url: req.url, headers: req.headers, json, raw: body });
    res.statusCode = bffStatus; res.end('{}');
  });
});
await new Promise((r) => bff.listen(BFF_PORT, '127.0.0.1', r));

/* Telegram — soxta; BFF — haqiqiy */
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  // Lokal (BFF va "yopiq port") — HAQIQIY; Telegram va boshqa tashqi — soxta
  if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, init);
  return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) };
};

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { Order } = await import('../src/models/Order.js');
const { BffEvent } = await import('../src/models/BffEvent.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { User } = await import('../src/models/User.js');
const { Dish } = await import('../src/models/Dish.js');
const { RestaurantTelegramStaff } = await import('../src/models/RestaurantTelegramStaff.js');
const { config } = await import('../src/config/index.js');
const { flushBffEvents, setBffAutoKick, enqueueOrderEvent, isBffEventsEnabled } = await import('../src/services/bffEvents.js');
const { changeOrderStatus } = await import('../src/services/orderFlow.js');
const { createShareLink, acceptShare, deliverShare } = await import('../src/services/courierDispatch.js');
const { confirmOrderDelivered, checkDeliveries } = await import('../src/services/deliveryCheck.js');
const { checkRestaurantReminders } = await import('../src/services/restaurantReminders.js');
const { orderController } = await import('../src/controllers/misc.js');

setBffAutoKick(false); // test o'zi flush qiladi — orqa fondagi yuborish aralashmasin

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const call = async (fn, req) => {
  let status = 200; let body = null;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  await fn(req, res, (e) => { body = { next: e?.message }; status = 500; });
  // asyncHandler promise qaytarmaydi — handler tugashini kutamiz (delivery-baseprice testidagi kabi)
  await sleep(400);
  return { status, body };
};

const R1 = await Restaurant.create({ name: 'R1', cuisine: 'x', category: 'restoran', isActive: true });
const R2 = await Restaurant.create({ name: 'R2', cuisine: 'x', category: 'restoran', isActive: true });
const user = await User.create({ firstName: 'Azim', telegramId: '9001', phone: '+998901112233' });
await RestaurantTelegramStaff.create({ restaurantId: R1._id, telegramUserId: '555', firstName: 'A', username: 'a', isActive: true, connectedAt: new Date() });

const mk = (over = {}) => Order.create({
  userId: user._id, restaurantId: R1._id, restaurantName: 'R1',
  items: [{ name: 'Osh', quantity: 1, unitPrice: 20000 }], subtotal: 20000, total: 20000,
  status: 'accepted', fulfillment: 'delivery', address: 'X', phone: '+998901112233', paymentMethod: 'cash', ...over,
});
const aged = (id, hours, fields = {}) => Order.collection.updateOne(
  { _id: id },
  { $set: { createdAt: new Date(Date.now() - hours * 3_600_000), updatedAt: new Date(Date.now() - hours * 3_600_000), ...fields } },
); // xom yozuv — hook'larni ATAYLAB chetlab o'tadi (holatni tayyorlash uchun)

/** Navbatni bo'shatadi (created 1.5s kechikishi hisobga olinadi) va kelgan hodisalarni qaytaradi */
async function drain(extraMs = 3000) {
  received.length = 0;
  await flushBffEvents({ now: Date.now() + extraMs, limit: 200 });
  await sleep(30);
  return received.map((r) => `${r.json?.event}:${r.json?.orderId}`);
}
const tag = (event, o) => `${event}:${o._id}`;
/*
 * NAQD buyurtma yakunlanganda server avtomatik "to'langan" qiladi (billing.finalizeCashPayment) —
 * bu BFF ga `delivered` dan keyin yana bitta `updated` (isPaid o'zgardi) beradi. Bu to'g'ri:
 * BFF `delivered` da buyurtmani o'qigan paytda to'lov hali yozilmagan bo'lishi mumkin,
 * ikkinchi hodisa uni to'g'rilaydi. Tartib va vaqtga bog'liq emas: to'plam taqqoslanadi.
 */
const sameEvents = (ev, ...tags) => ev.length === tags.length && tags.every((x) => ev.includes(x));
const clearQueue = async () => { await BffEvent.deleteMany({}); received.length = 0; };

console.log('\n[1] Yuborish shakli: aynan {event, restaurantId, orderId}, sarlavhalar, yo‘l');
{
  ok(isBffEventsEnabled() && config.bffBaseUrl === `http://127.0.0.1:${BFF_PORT}`, 'yoqilgan; BFF_BASE_URL oxiridagi "/" tozalandi');
  const o = await mk({ status: 'pending' });
  const notYet = await drain(0);
  ok(notYet.length === 0, '"created" 1.5 soniya kechiktiriladi (buyurtma raqami yozilib bo‘lsin) — darhol yuborilmadi');
  const list = await drain(3000);
  ok(list.length === 1 && list[0] === tag('created', o), `created keldi: ${list[0]}`);
  const r = received[0];
  ok(r.method === 'POST' && r.url === '/internal/orders/events', `POST ${r.url}`);
  ok(r.headers['x-webhook-secret'] === 'test-secret-abc123', 'x-webhook-secret to‘g‘ri');
  ok(Object.keys(r.json).sort().join() === 'event,orderId,restaurantId', `body faqat 3 maydon: ${Object.keys(r.json)}`);
  ok(r.json.restaurantId === String(R1._id) && r.json.orderId === String(o._id), 'restaurantId va orderId to‘g‘ri');
  ok(/^[a-f\d]{24}$/.test(r.headers['x-event-id']) && r.headers['x-event-attempt'] === '1', 'x-event-id va x-event-attempt sarlavhada');
  ok((r.headers['content-type'] || '').includes('application/json'), 'Content-Type: application/json');
}

console.log('\n[2] KO‘RINMAS buyurtmalar hodisa BERMAYDI: zal va to‘lanmagan (awaiting_payment)');
{
  await clearQueue();
  await mk({ status: 'pending', fulfillment: 'dinein' });
  const card = await mk({ status: 'awaiting_payment', paymentMethod: 'click' });
  ok((await drain()).length === 0, 'zal (dinein) va awaiting_payment yaratilganda — hodisa yo‘q');

  // To'lov o'tdi: paymentRecord.js — new:true
  await Order.findOneAndUpdate({ _id: card._id, status: 'awaiting_payment' }, { isPaid: true, paymentMethod: 'click', status: 'pending' }, { new: true });
  const a = await drain();
  ok(a.length === 1 && a[0] === tag('created', card), `to‘lov o‘tgach created: ${a[0]}`);

  // cardPayment.js:244 — new:true YO'Q (eski hujjat qaytadi): baribir hodisa kerak edi — bu yerda esa takror (created bir marta)
  const card2 = await mk({ status: 'awaiting_payment', paymentMethod: 'click' });
  await Order.findByIdAndUpdate(card2._id, { isPaid: true, status: 'pending', paymentLock: null }); // new:true yo'q
  const b = await drain();
  ok(b.length === 1 && b[0] === tag('created', card2), 'new:true BO‘LMAGAN yo‘lda ham created keldi (eski hujjat holatiga aldanmadi)');

  // Takroriy webhook buyurtmani qayta "created" qilmasin
  await Order.findByIdAndUpdate(card2._id, { isPaid: true, status: 'pending', paymentLock: null });
  ok((await drain()).length === 0, 'takroriy to‘lov chaqiruvi — created ikkinchi marta yuborilmadi (dedupe)');

  // Payme perform (payme.js:167) va abandoned updateMany
  const ab = await mk({ status: 'awaiting_payment', paymentMethod: 'payme' });
  await Order.updateMany({ _id: { $in: [ab._id] }, status: 'awaiting_payment', isPaid: false }, { status: 'cancelled', cancelReason: 'To‘lov amalga oshirilmadi', cancelledAt: new Date() });
  ok((await drain()).length === 0, 'abandonedOrders (updateMany awaiting_payment→cancelled) — hech qachon ko‘rinmagan, hodisa YO‘Q');
}

console.log('\n[3] Restoran/bot/Android yo‘li: changeOrderStatus (updated, cancelled, delivered pickup)');
{
  await clearQueue();
  const o = await mk({ status: 'pending' }); await drain();
  await changeOrderStatus({ orderId: o._id, restaurantId: R1._id, status: 'accepted' });
  let ev = await drain(); ok(ev.length === 1 && ev[0] === tag('updated', o), `accepted → updated: ${ev}`);
  await changeOrderStatus({ orderId: o._id, restaurantId: R1._id, status: 'ready' });
  ev = await drain(); ok(ev.length === 1 && ev[0] === tag('updated', o), 'ready → updated');
  await changeOrderStatus({ orderId: o._id, restaurantId: R1._id, status: 'delivering' });
  ev = await drain(); ok(ev.length === 1 && ev[0] === tag('updated', o), 'delivering ("kuryerga topshirildi") → updated');

  const c = await mk({ status: 'pending' }); await drain();
  await changeOrderStatus({ orderId: c._id, restaurantId: R1._id, status: 'cancelled' });
  ev = await drain(); ok(ev.length === 1 && ev[0] === tag('cancelled', c), 'restoran bekor qildi → cancelled');

  const p = await mk({ status: 'ready', fulfillment: 'pickup' });
  await changeOrderStatus({ orderId: p._id, restaurantId: R1._id, status: 'delivered' }); await sleep(600);
  ev = await drain(); ok(sameEvents(ev, tag('delivered', p), tag('updated', p)), `pickup delivered → delivered + naqd to‘lov updated: ${ev}`);

  // ikki marta bir xil status: changed:false — yozuv yo'q — hodisa yo'q
  await changeOrderStatus({ orderId: o._id, restaurantId: R1._id, status: 'delivering' });
  ok((await drain()).length === 0, 'allaqachon shu holatda (changed:false) — hodisa yo‘q');
}

console.log('\n[4] KURYER yo‘li: havola orqali qabul (ready→delivering) va "Topshirdim"');
{
  await clearQueue();
  const o = await mk({ status: 'ready' });
  const link = await createShareLink(o._id);
  const acc = await acceptShare(link.token);
  ok(acc.ok === true, 'kuryer qabul qildi');
  let ev = await drain(); ok(ev.length === 1 && ev[0] === tag('updated', o), `kuryer qabuli (delivering) → updated: ${ev}`);
  const del = await deliverShare(link.token, acc.secret);
  ok(del.ok === true, 'kuryer "Topshirdim" bosdi');
  await sleep(600);
  ev = await drain(); ok(sameEvents(ev, tag('delivered', o), tag('updated', o)), `kuryer topshirdi → delivered + naqd to‘lov updated: ${ev}`);
  await deliverShare(link.token, acc.secret); await sleep(400);
  ok((await drain()).length === 0, 'takroriy "Topshirdim" — ikkinchi delivered yo‘q');
}

console.log('\n[5] MIJOZ yo‘llari: bot "Oldim", ilovadagi "Ha, oldim", mijoz bekor qilishi');
{
  await clearQueue();
  const a = await mk({ status: 'delivering' });
  await confirmOrderDelivered(a._id, 'customer');
  await sleep(600);
  let ev = await drain(); ok(sameEvents(ev, tag('delivered', a), tag('updated', a)), `bot "Oldim" → delivered + naqd to‘lov updated: ${ev}`);

  const b = await mk({ status: 'delivering' });
  const conf = await call(orderController.confirmDelivery, { userId: user._id, params: { id: String(b._id) }, body: { rating: 5, comment: 'zo‘r' } });
  ok(conf.status === 200, 'ilovadagi PATCH /orders/:id/confirm ishladi');
  await sleep(600);
  ev = await drain(); ok(sameEvents(ev, tag('delivered', b), tag('updated', b)), `ilova "Ha, oldim" → delivered + naqd to‘lov updated: ${ev}`);

  const c = await mk({ status: 'pending' }); await drain();
  const cancel = await call(orderController.cancelOrder, { userId: user._id, params: { id: String(c._id) } });
  ok(cancel.status === 200 || cancel.body?.ok !== false, `mijoz bekor qildi (${cancel.status})`);
  ev = await drain(); ok(ev.length === 1 && ev[0] === tag('cancelled', c), `mijoz bekor qilishi (doc.save) → cancelled: ${ev}`);
}

console.log('\n[6] AVTO-YAKUNLASH yo‘llari: 12 soatlik updateMany va restoran eslatmasi (auto)');
{
  await clearQueue();
  // deliveryCheck.checkDeliveries: 12 soatdan oshgan 'delivering' — updateMany
  const stale = await mk({ status: 'delivering' }); await aged(stale._id, 13);
  await checkDeliveries(); await sleep(600);
  let ev = await drain();
  ok(sameEvents(ev, tag('delivered', stale), tag('updated', stale)), `12 soatlik avto-yakunlash (updateMany) → delivered + naqd to‘lov updated: ${ev}`);
  ok((await Order.findById(stale._id).lean()).status === 'delivered', 'buyurtma haqiqatan yakunlangan');

  // restaurantReminders: 2 eslatmadan keyin auto
  await clearQueue();
  const r = await mk({ status: 'ready' });
  await aged(r._id, 20, { readyAt: new Date(Date.now() - 20 * 3_600_000), restaurantReminder: { askedCount: 2, lastAskedAt: new Date(Date.now() - 5 * 3_600_000), forStatus: 'ready' } });
  const res = await checkRestaurantReminders(Date.now());
  ev = await drain(); ok(res.autoCompleted === 1 && ev.includes(tag('delivered', r)), `restoran eslatmasi avto-yakunlashi → delivered: ${ev}`);

  // Eslatma yuborildi (restaurantReminder yoziladi) → updated (ilova "Yetkazildi" tugmasini ko'rsatsin)
  await clearQueue();
  const q = await mk({ status: 'delivering' });
  await aged(q._id, 1, { deliveringAt: new Date(Date.now() - 40 * 60_000) });
  const res2 = await checkRestaurantReminders(Date.now());
  ev = await drain(); ok(res2.sent === 1 && ev.includes(tag('updated', q)), `1-eslatma yuborildi → updated: ${ev}`);
}

console.log('\n[7] To‘lov belgisi va HODISA BERMAYDIGAN yozuvlar');
{
  await clearQueue();
  const o = await mk({ status: 'accepted' });
  await Order.findOneAndUpdate({ _id: o._id }, { isPaid: true, paidAt: new Date() }, { new: true });
  let ev = await drain(); ok(ev.length === 1 && ev[0] === tag('updated', o), 'naqd to‘lov belgisi (markPaid) → updated');

  await Order.updateOne({ _id: o._id }, { paymentLock: 'x' });
  await Order.findByIdAndUpdate(o._id, { dailyNumber: 7 });
  const doc = await Order.findById(o._id); doc.rating = 5; doc.comment = 'yaxshi'; await doc.save();
  await Order.updateOne({ _id: o._id }, { $set: { 'deliveryCheck.askedCount': 2 } });
  await Order.updateMany({ _id: o._id }, { $set: { etaMinutes: 20 } });
  ok((await drain()).length === 0, 'paymentLock, dailyNumber, baho, deliveryCheck hisoblagichi, etaMinutes — hodisa YO‘Q');
}

console.log('\n[8] Naqd buyurtma yaratish (controller) → created');
{
  await clearQueue();
  const dish = await Dish.create({ restaurantId: R1._id, section: 'menu', name: 'Pasta', price: 10000 });
  await Restaurant.updateOne({ _id: R1._id }, {
    lat: 41.3111, lng: 69.2797, deliveryEnabled: true, pickupEnabled: true, cashEnabled: true, deliveryFee: 0, address: 'Sang',
    openTime: '00:00', closeTime: '23:59', workingDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], isApproved: true,
  });
  const { CommissionAgreement } = await import('../src/models/CommissionAgreement.js');
  await CommissionAgreement.create({ restaurantId: R1._id, restaurantCommissionPercent: 10, customerFeePercent: 0, effectiveFrom: new Date() });
  const created = await call(orderController.create, { userId: String(user._id), user: { _id: user._id }, body: {
    address: 'Uy', phone: '+998901112233', paymentMethod: 'cash', paymentLabel: 'Naqd', fulfillment: 'pickup', timingMode: 'asap',
    orders: [{ restaurantId: String(R1._id), restaurantName: 'R1', subtotal: 10000, items: [{ dishId: String(dish._id), name: 'Pasta', quantity: 1, unitPrice: 10000 }] }],
  } });
  ok(created.status === 201, `buyurtma yaratildi (${created.status})`);
  const ord = await Order.findOne({ restaurantId: R1._id, fulfillment: 'pickup', status: 'pending' }).lean();
  const ev = await drain();
  ok(ord && ev.length === 1 && ev[0] === tag('created', ord), `yaratilganda created (haqiqiy POST /orders yo‘li): ${ev}`);
}

console.log('\n[9] Boshqa restoran hodisasi o‘z restaurantId si bilan; bir buyurtma ikki marta delivered/cancelled — bir marta');
{
  await clearQueue();
  const o2 = await mk({ restaurantId: R2._id, restaurantName: 'R2', status: 'ready', fulfillment: 'pickup' });
  await changeOrderStatus({ orderId: o2._id, restaurantId: R2._id, status: 'delivered' });
  await drain();
  ok(received[0]?.json.restaurantId === String(R2._id), 'R2 buyurtmasi — restaurantId R2');

  await clearQueue();
  const d = await mk({ status: 'delivering' });
  await confirmOrderDelivered(d._id, 'customer');
  await Order.findByIdAndUpdate(d._id, { status: 'delivered' }); // yana bir yo'l (masalan legacy)
  await sleep(600);
  const ev = await drain();
  ok(ev.filter((e) => e.startsWith('delivered:')).length === 1, `ikki yo‘ldan delivered — "delivered" hodisasi 1 ta: ${ev}`);
  ok(ev.filter((e) => e.startsWith('updated:')).length <= 1, 'naqd to‘lov "updated"i ko‘pi bilan 1 ta');
}

console.log('\n[10] Birlashtirish: ketma-ket updated — yuborilmagani bitta');
{
  await clearQueue();
  const o = await mk({ status: 'accepted' });
  await Order.findOneAndUpdate({ _id: o._id }, { isPaid: true }, { new: true });
  await Order.findOneAndUpdate({ _id: o._id }, { status: 'preparing' }, { new: true });
  await Order.findOneAndUpdate({ _id: o._id }, { status: 'ready' }, { new: true });
  ok(await BffEvent.countDocuments({ orderId: String(o._id), event: 'updated' }) === 1, '3 ta updated yozuvi → navbatda 1 ta');
  const ev = await drain(); ok(ev.length === 1, 'BFF ga 1 ta yuborildi (u tafsilotni qayta o‘qiydi)');
  await Order.findOneAndUpdate({ _id: o._id }, { status: 'delivering' }, { new: true });
  ok((await drain()).length === 1, 'yuborilgandan keyingi yangi updated qayta navbatga tushadi');
}

console.log('\n[11] BFF yiqilsa: qayta urinish (backoff), keyin yetkazish; 12 urinishdan keyin failed');
{
  await clearQueue();
  const o = await mk({ status: 'accepted' });
  await Order.findOneAndUpdate({ _id: o._id }, { status: 'preparing' }, { new: true });
  bffStatus = 500;
  const T = Date.now() + 1000;
  const r1 = await flushBffEvents({ now: T }); await sleep(20);
  ok(r1.retried === 1 && r1.sent === 0, 'BFF 500 berdi — qayta uriniladi (yo‘qolmadi)');
  let row = await BffEvent.findOne({ orderId: String(o._id) }).lean();
  ok(row.attempts === 1 && row.doneAt === null && row.lastError === 'HTTP 500', `attempts=1, lastError="${row.lastError}"`);
  ok(Math.abs(new Date(row.nextAttemptAt).getTime() - (T + 5000)) < 50, 'keyingi urinish +5 soniyadan keyin');

  const early = await flushBffEvents({ now: T + 2000 });
  ok(early.sent === 0 && early.retried === 0, '5 soniya o‘tmasdan — urinilmadi');
  const r2 = await flushBffEvents({ now: T + 6000 }); await sleep(20);
  ok(r2.retried === 1, '2-urinish ham 500');
  row = await BffEvent.findOne({ orderId: String(o._id) }).lean();
  ok(Math.abs(new Date(row.nextAttemptAt).getTime() - (T + 6000 + 15000)) < 50, 'backoff o‘sdi: +15 soniya');

  bffStatus = 200;
  received.length = 0;
  const r3 = await flushBffEvents({ now: T + 6000 + 16000 }); await sleep(20);
  ok(r3.sent === 1 && received.length === 1 && received[0].headers['x-event-attempt'] === '3', 'BFF tiklandi — 3-urinishda yetkazildi (x-event-attempt: 3)');
  row = await BffEvent.findOne({ orderId: String(o._id) }).lean();
  ok(row.doneAt && row.failed === false, 'yetkazildi deb belgilandi');
  received.length = 0;
  await flushBffEvents({ now: T + 999_000 });
  ok(received.length === 0, 'yetkazilgan hodisa qayta yuborilmaydi');

  // 12-urinish — failed
  const o2 = await mk({ status: 'accepted' });
  await Order.findOneAndUpdate({ _id: o2._id }, { status: 'ready' }, { new: true });
  await BffEvent.updateOne({ orderId: String(o2._id) }, { attempts: 11 });
  bffStatus = 503;
  const rf = await flushBffEvents({ now: Date.now() + 1000 }); await sleep(20);
  row = await BffEvent.findOne({ orderId: String(o2._id) }).lean();
  ok(rf.failed === 1 && row.failed === true && row.doneAt, '12-urinishdan keyin failed (abadiy takrorlanmaydi)');
  bffStatus = 200;
}

console.log('\n[12] BFF ulanmagan (port yopiq) — xato tashlamaydi, keyin yetkazadi');
{
  await clearQueue();
  const o = await mk({ status: 'accepted' });
  await Order.findOneAndUpdate({ _id: o._id }, { status: 'ready' }, { new: true });
  const saved = config.bffBaseUrl;
  config.bffBaseUrl = 'http://127.0.0.1:1'; // hech kim tinglamaydi
  const r = await flushBffEvents({ now: Date.now() + 1000 });
  ok(r.retried === 1 && r.sent === 0, 'ulanish rad etildi — qayta uriniladi');
  config.bffBaseUrl = saved;
  const row = await BffEvent.findOne({ orderId: String(o._id) }).lean();
  ok(row.doneAt === null && row.lastError.length > 0, `xato yozildi: "${row.lastError.slice(0, 40)}"`);
}

console.log('\n[13] O‘CHIQ holat va navbat xatosi buyurtma yozuvini BUZMAYDI');
{
  await clearQueue();
  const saved = { u: config.bffBaseUrl, s: config.bffWebhookSecret };
  config.bffBaseUrl = ''; 
  const o = await mk({ status: 'pending' });
  await changeOrderStatus({ orderId: o._id, restaurantId: R1._id, status: 'accepted' });
  ok(await BffEvent.countDocuments({}) === 0, 'BFF sozlanmagan — navbatga HECH NARSA yozilmaydi (yuk yo‘q)');
  config.bffBaseUrl = saved.u;
  config.bffWebhookSecret = '';
  await changeOrderStatus({ orderId: o._id, restaurantId: R1._id, status: 'ready' });
  ok(await BffEvent.countDocuments({}) === 0, 'sir bo‘sh — ham o‘chiq');
  config.bffWebhookSecret = saved.s;

  // Navbat yozilmasa ham status o'zgaradi
  const origCreate = BffEvent.create.bind(BffEvent);
  BffEvent.create = async () => { throw new Error('baza xatosi (sinov)'); };
  const p = await mk({ status: 'accepted' });
  let threw = false; let result;
  try { result = await changeOrderStatus({ orderId: p._id, restaurantId: R1._id, status: 'ready' }); } catch { threw = true; }
  BffEvent.create = origCreate;
  ok(!threw && result.order.status === 'ready' && (await Order.findById(p._id).lean()).status === 'ready', 'navbat xatosi — buyurtma holati baribir o‘zgardi');
  ok(await enqueueOrderEvent('updated', { orderId: '', restaurantId: '' }) === false, 'bo‘sh id — jimgina rad');
}

stop: {
  bff.close();
  console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
  await mongoose.disconnect();
  process.exit(fails ? 1 : 0);
}
