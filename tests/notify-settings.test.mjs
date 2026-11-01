/*
 * ═══════════════════════════════════════════════════════════
 * BILDIRISHNOMA SOZLAMALARI, JURNAL VA YETIB BORISH TASDIG'I
 * ═══════════════════════════════════════════════════════════
 * Restoran sozlamalari (ovoz, tebranish, takror yoqilgan / interval 30·60·90 s / limit / ovoz turi), har yuborish jurnali
 * (SENT / FAILED / RECEIVED / OPENED), qurilma ma'lumotlari. Soxta FCM/APNs; haqiqiy telefonga yetishini TEKSHIRMAYDI.
 * npm run test:notify-settings
 */
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/lokma_notify_settings';
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.TELEGRAM_BOT_TOKEN = ''; process.env.RESTAURANT_BOT_TOKEN = '';

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { config } = await import('../src/config/index.js');
const push = await import('../src/services/mobilePush.js');
const { clearNotifySettingsCache } = await import('../src/services/notifySettings.js');
const { MobileDevice } = await import('../src/models/MobileDevice.js');
const { OrderPushState } = await import('../src/models/OrderPushState.js');
const { NotificationLog } = await import('../src/models/NotificationLog.js');
const { NotifySettings } = await import('../src/models/NotifySettings.js');
const { Order } = await import('../src/models/Order.js');
const { notifySettingsController } = await import('../src/controllers/notifySettings.js');
const { mobileDevicesController } = await import('../src/controllers/mobileDevices.js');
await MobileDevice.init(); await NotifySettings.init(); await OrderPushState.init().catch(() => {});
// Test bazasi (FerretDB) TTL indeksini qo'llamaydi → Mongoose indekslarni qurishda to'xtaydi. Production MongoDB'da hammasi quriladi;
// bu yerda idempotentlikni ta'minlovchi UNIKAL indeksni qo'lda quramiz.
await NotificationLog.init().catch(() => {});
await NotificationLog.collection.createIndex({ orderId: 1, type: 1, attempt: 1, deviceKey: 1 }, { unique: true });

let fails = 0;
const ok = (c, m) => { process.stdout.write(`${c ? '  ✓' : '  ✗ FAIL:'} ${m}\n`); if (!c) fails++; };
const oid = () => new mongoose.Types.ObjectId();
const quiet = () => { const l = console.log, w = console.warn; console.log = () => {}; console.warn = () => {}; return () => { console.log = l; console.warn = w; }; };
const call = (fn, req) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; resolve(this); return this; }, end() { resolve(this); return this; } };
  fn(req, res, (e) => (e ? reject(e) : resolve(res)));
});
const TOK = (s) => `${s}`.padEnd(40, '0');
const sent = [];
push._setTransportsForTest({
  fcm: async (t, m) => { sent.push({ p: 'android', t, m }); return t.startsWith('bad') ? { ok: false, error: 'FCM 503 UNAVAILABLE' } : { ok: true }; },
  apns: async (t, p, h) => { sent.push({ p: 'ios', t, payload: p, h }); return { ok: true }; },
});
const R1 = oid(), R2 = oid();
await MobileDevice.create([{ token: TOK('a1'), platform: 'android', restaurantId: R1 }, { token: TOK('i1'), platform: 'ios', restaurantId: R1 }, { token: TOK('bad_a'), platform: 'android', restaurantId: R1 }, { token: TOK('b1'), platform: 'android', restaurantId: R2 }]);
const newOrder = (rid, extra = {}) => ({ _id: oid(), restaurantId: rid, status: 'pending', dailyNumber: 5, total: 50000, ...extra });
const put = (rid, body) => call(notifySettingsController.update, { restaurantId: rid, body });

console.log('\n1) Sozlamalar: standart, tekshiruv, saqlash, restoranlar izolyatsiyasi');
{
  const g = await call(notifySettingsController.get, { restaurantId: R1 });
  ok(g.body.sound && g.body.vibration && g.body.repeatEnabled && g.body.repeatIntervalSec === 30 && g.body.repeatLimit === 10 && g.body.soundType === 'custom', 'yozilmagan restoran: standart = hozirgi xatti-harakat (ovozli, 30 s, 10 marta)');
  ok((await put(R1, { repeatIntervalSec: 45 })).statusCode === 400, 'interval faqat 30 / 60 / 90 (45 → 400)');
  ok((await put(R1, { repeatLimit: 25 })).statusCode === 400 && (await put(R1, { repeatLimit: 0 })).statusCode === 400, 'limit 1–20 (25 va 0 → 400)');
  ok((await put(R1, { restaurantId: String(R2) })).statusCode === 400 && (await put(R1, { hack: true })).statusCode === 400, 'noma\'lum maydon (restaurantId ham) → 400: begona restoran sozlamasini yozib bo\'lmaydi');
  ok((await put(R1, { soundType: 'siren' })).statusCode === 400, 'ovoz turi faqat default / custom');
  const u = await put(R1, { repeatIntervalSec: 60, repeatLimit: 3 });
  ok(u.body.repeatIntervalSec === 60 && u.body.repeatLimit === 3 && u.body.sound === true, 'qisman yangilash: yuborilganlari o\'zgaradi, qolganlari saqlanadi');
  ok((await call(notifySettingsController.get, { restaurantId: R2 })).body.repeatIntervalSec === 30, 'boshqa restoran o\'zgarishni ko\'rmaydi');
  ok(await NotifySettings.countDocuments({ restaurantId: R1 }) === 1, 'bitta restoran = bitta yozuv (qayta yozilganda dublikat yo\'q)');
}

console.log('\n2) Interval 60 s va limit 3: server shu qoida bo\'yicha qayta yuboradi');
let o1;
{
  const q = quiet(); sent.length = 0;
  const t0 = Date.now();
  o1 = newOrder(R1); await Order.collection.insertOne(o1);
  await push.onOrderEvent('order:new', o1);
  const first = sent.length;
  ok(first === 3, 'birinchi yuborish: R1 ning 3 ta qurilmasiga');
  ok(await push.checkPendingOrderPushes(t0 + 31_000) === 0, '31 s: hali erta (interval 60 s)');
  ok(await push.checkPendingOrderPushes(t0 + 61_000) === 1 && sent.length === first * 2, '61 s: 2-yuborish');
  ok(await push.checkPendingOrderPushes(t0 + 125_000) === 1 && sent.length === first * 3, '125 s: 3-yuborish');
  ok(await push.checkPendingOrderPushes(t0 + 200_000) === 0 && sent.length === first * 3, 'limit 3 ga yetdi — to\'xtadi');
  const st = await OrderPushState.findOne({ orderId: o1._id });
  ok(st.done === true && st.sentCount === 3 && st.intervalSec === 60 && st.maxSends === 3, 'holatda interval/limit saqlangan va yopildi');
  q();
}

console.log('\n3) Sozlama o\'zgarishi ketayotgan buyurtmaga TA\'SIR QILMAYDI (kelgan paytdagi qoida)');
{
  const q = quiet(); sent.length = 0;
  await put(R1, { repeatIntervalSec: 30, repeatLimit: 10 });
  const o = newOrder(R1); await Order.collection.insertOne(o); const t0 = Date.now();
  await push.onOrderEvent('order:new', o);
  await put(R1, { repeatIntervalSec: 90 });      // admin keyin o'zgartirdi
  ok(await push.checkPendingOrderPushes(t0 + 31_000) === 1, 'buyurtma 30 s qoidasi bilan kelgan — 31 s da takror ketdi');
  const o2 = newOrder(R1); await Order.collection.insertOne(o2); clearNotifySettingsCache();
  await push.onOrderEvent('order:new', o2);
  ok((await OrderPushState.findOne({ orderId: o2._id })).intervalSec === 90, 'yangi buyurtma yangi sozlamani oladi (90 s)');
  q();
}

console.log('\n4) Takror o\'chiq: takrorlanmaydi, lekin qabul qilinganda signalni to\'xtatish xabari ketadi');
{
  const q = quiet(); sent.length = 0;
  await put(R1, { repeatEnabled: false, repeatIntervalSec: 30 });
  const o = newOrder(R1); await Order.collection.insertOne(o); const t0 = Date.now();
  await push.onOrderEvent('order:new', o);
  const n = sent.length;
  await push.checkPendingOrderPushes(t0 + 600_000);      // (oldingi bo'limlardagi buyurtmalar hali pending — ularniki alohida takrorlanadi)
  ok((await OrderPushState.findOne({ orderId: o._id })).sentCount === 1 && !sent.slice(n).some((x) => (x.m?.data?.orderId || x.payload?.orderId) === String(o._id)), '10 daqiqa o\'tsa ham SHU buyurtma qayta yuborilmaydi (takror o\'chiq)');
  await push.onOrderEvent('order:update', { ...o, status: 'accepted' });
  ok(sent.slice(n).some((s) => s.m?.data?.type === 'order_updated') && (await OrderPushState.findOne({ orderId: o._id })).done === true, 'qabul qilindi: Android\'ga order_updated (signal o\'chadi), holat yopildi');
  q();
}

console.log('\n5) Ovoz / tebranish / ovoz turi payload\'da');
{
  const q = quiet(); sent.length = 0;
  await put(R1, { repeatEnabled: true, sound: false, vibration: false });
  await push.onOrderEvent('order:new', newOrder(R1));
  const a = sent.find((s) => s.p === 'android').m.data, i = sent.find((s) => s.p === 'ios').payload;
  ok(a.sound === '0' && a.vibration === '0', 'Android data: sound=0, vibration=0 (ilova ovozsiz / tebranishsiz)');
  ok(!('sound' in i.aps) && i.aps['interruption-level'] === 'time-sensitive', 'iOS: aps.sound YO\'Q (ovozsiz banner), time-sensitive saqlanadi');
  sent.length = 0; await put(R1, { sound: true, vibration: true, soundType: 'default' });
  await push.onOrderEvent('order:new', newOrder(R1));
  ok(sent.find((s) => s.p === 'ios').payload.aps.sound === 'default', 'soundType=default → iOS tizim ovozi');
  sent.length = 0; await put(R1, { soundType: 'custom' });
  const o = newOrder(R1); await push.onOrderEvent('order:new', o);
  const ia = sent.find((s) => s.p === 'ios').payload, aa = sent.find((s) => s.p === 'android').m.data;
  ok(ia.aps.sound === 'order_alert.wav' && ia.attempt === 1 && ia.notificationId === `${o._id}:1`, 'custom → LokmaGo melodiyasi; payload: attempt va notificationId');
  ok(aa.sound === '1' && aa.vibration === '1' && aa.notificationId === `${o._id}:1` && aa.attempt === '1', 'Android: sound=1, vibration=1, notificationId = orderId:attempt');
  q();
}

console.log('\n6) Jurnal: SENT / FAILED har qurilma uchun, idempotent, tokensiz');
{
  // 5 marta ketma-ket xato → token o'lik deb o'chiriladi (mo'ljallangan xatti-harakat; oldingi bo'limlar buni sodir qildi) — yangidan yaratamiz
  await MobileDevice.updateOne({ token: TOK('bad_a') }, { $set: { platform: 'android', restaurantId: R1, failCount: 0 } }, { upsert: true });
  const q = quiet(); sent.length = 0;
  const o = newOrder(R1); await push.onOrderEvent('order:new', o); await new Promise((r) => setTimeout(r, 150));
  const logs = await NotificationLog.find({ orderId: o._id, type: 'NEW_ORDER' }).lean();
  q();
  ok(logs.length === 3 && logs.every((l) => l.attempt === 1 && l.notificationId === `${o._id}:1`), '3 qurilma = 3 yozuv, attempt=1');
  ok(logs.filter((l) => l.status === 'SENT').length === 2 && logs.find((l) => l.status === 'FAILED')?.error.includes('503'), '2 ta SENT, 1 ta FAILED (sabab: FCM 503)');
  ok(!JSON.stringify(logs).includes(TOK('a1')) && !JSON.stringify(logs).includes('50000'), 'jurnalda token ham, summa ham yo\'q');
  await NotificationLog.updateOne({ _id: logs[0]._id }, { $set: { status: 'OPENED' } });
  const q2 = quiet(); await push.onOrderEvent('order:update', { ...o, status: 'accepted' }); await new Promise((r) => setTimeout(r, 100)); q2();
  ok((await NotificationLog.countDocuments({ orderId: o._id, type: 'ORDER_UPDATED' })) === 3, 'qabul qilinganda "to\'xtat" xabarlari ham jurnalda (ORDER_UPDATED)');
}

console.log('\n7) Yetib borish tasdig\'i (ack): received → opened, pasaymaydi, faqat o\'z restoran qurilmasi');
{
  const q = quiet();
  const o = newOrder(R1); await push.onOrderEvent('order:new', o); await new Promise((r) => setTimeout(r, 150)); q();
  const ack = (rid, token, event, attempt = 1, orderId = String(o._id)) => call(notifySettingsController.ack, { restaurantId: rid, body: { token, orderId, attempt, event } });
  const status = async (tok) => (await NotificationLog.findOne({ orderId: o._id, type: 'NEW_ORDER', deviceKey: String((await MobileDevice.findOne({ token: tok }))._id) })).status;
  ok((await ack(R1, TOK('a1'), 'received')).statusCode === 204 && await status(TOK('a1')) === 'RECEIVED', 'received: SENT → RECEIVED');
  await ack(R1, TOK('a1'), 'opened');
  ok(await status(TOK('a1')) === 'OPENED', 'opened: RECEIVED → OPENED');
  await ack(R1, TOK('a1'), 'received');
  ok(await status(TOK('a1')) === 'OPENED', 'keyingi received OPENED ni pasaytirmaydi');
  ok((await ack(R2, TOK('a1'), 'opened', 1)).statusCode === 204 && await status(TOK('i1')) === 'SENT', 'begona restoran bu qurilmani tasdiqlay olmaydi (204, hech narsa o\'zgarmaydi)');
  ok((await ack(R1, TOK('nope'), 'received')).statusCode === 204, 'noma\'lum token — 204 (mavjudligi oshkor qilinmaydi)');
  ok((await ack(R1, TOK('i1'), 'received', 1, '../x')).statusCode === 400 && (await ack(R1, TOK('i1'), 'seen')).statusCode === 400, 'noto\'g\'ri orderId / event → 400');
  const rec = await call(notifySettingsController.recent, { restaurantId: R1, query: { limit: '5' } });
  ok(rec.body.length === 5 && rec.body.every((l) => !('token' in l) && !('deviceKey' in l)), 'recent: tokensiz, limit ishlaydi');
  ok((await call(notifySettingsController.recent, { restaurantId: R2, query: {} })).body.every((l) => l.platform === 'android'), 'recent: boshqa restoran faqat o\'z yozuvlarini ko\'radi');
}

console.log('\n8) Qurilma ma\'lumotlari (versiya, ruxsat holati) saqlanadi va ro\'yxatda ko\'rinadi');
{
  await call(mobileDevicesController.register, { restaurantId: R1, body: { token: TOK('meta'), platform: 'android', deviceId: 'dev-123', appVersion: '1.4.0', notificationsEnabled: false, soundEnabled: true } });
  const l = await call(mobileDevicesController.list, { restaurantId: R1 });
  const d = l.body.devices.find((x) => x.deviceId === 'dev-123');
  ok(d && d.appVersion === '1.4.0' && d.notificationsEnabled === false && d.soundEnabled === true, 'deviceId, appVersion, notificationsEnabled, soundEnabled ro\'yxatda');
  await call(mobileDevicesController.register, { restaurantId: R1, body: { token: TOK('meta'), platform: 'android' } });
  ok((await MobileDevice.findOne({ token: TOK('meta') })).appVersion === '1.4.0', 'ma\'lumot yubormagan eski ilova mavjud qiymatni o\'chirmaydi');
}

push._setTransportsForTest(null);
await mongoose.disconnect();
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ hammasi o\'tdi');
process.exit(fails ? 1 : 0);
