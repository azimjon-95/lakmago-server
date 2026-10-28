/*
 * ═══════════════════════════════════════════════════════════
 * MOBIL PUSH: YANGI BUYURTMA TELEFON QULFLANGAN / ILOVA YOPIQ BO'LSA HAM KELADI
 * ═══════════════════════════════════════════════════════════
 * Haqiqiy kod yo'llari: FCM HTTP v1 (Google OAuth JWT RS256 — soxta Google bilan), APNs HTTP/2 (JWT ES256 —
 * lokal HTTP/2 server bilan), qurilma controller'i, emitOrderToRestaurant ulanishi, qayta yuborish taymeri.
 * Haqiqiy telefonga yetishini bu test TEKSHIRA OLMAYDI (bu qurilmada qilinadi). npm run test:mobile-push
 */
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/lokma_mobile_push';
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.TELEGRAM_BOT_TOKEN = '';
process.env.RESTAURANT_BOT_TOKEN = '';

import crypto from 'node:crypto';
import http2 from 'node:http2';

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { config } = await import('../src/config/index.js');
const push = await import('../src/services/mobilePush.js');
const { MobileDevice } = await import('../src/models/MobileDevice.js');
const { OrderPushState } = await import('../src/models/OrderPushState.js');
const { Order } = await import('../src/models/Order.js');
const { mobileDevicesController } = await import('../src/controllers/mobileDevices.js');
const { emitOrderToRestaurant } = await import('../src/services/orderSocket.js');

let fails = 0;
function ok0(c) { if (!c) { console.log('  ✗ FAIL: orderId unique indeks qurilmadi'); fails++; } }
// stdout'ga to'g'ridan: push loglarini o'chirib qo'yganda (quiet) natijalar baribir ko'rinsin
const ok = (c, m) => { process.stdout.write(`${c ? '  ✓' : '  ✗ FAIL:'} ${m}\n`); if (!c) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const quiet = () => { const l = console.log; const w = console.warn; console.log = () => {}; console.warn = () => {}; return () => { console.log = l; console.warn = w; }; };
const oid = () => new mongoose.Types.ObjectId();
const R1 = oid(), R2 = oid();
// asyncHandler promise qaytarmaydi → javob (end/json) yoki next(err) kelguncha kutamiz
const call = (fn, req) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; resolve(this); return this; },
    end() { resolve(this); return this; },
  };
  fn(req, res, (e) => (e ? reject(e) : resolve(res)));
});
const TOK = (s) => `${s}`.padEnd(40, '0');
// FerretDB (test bazasi) TTL indeksini qo'llamaydi — u faqat eski holatni tozalaydi; unique indeks undan OLDIN quriladi.
await MobileDevice.init(); await OrderPushState.init().catch(() => {});
ok0(await OrderPushState.collection.indexExists('orderId_1'));

// ── 1) JWT imzolari ──
console.log('\n1) JWT: RS256 (Google OAuth) va ES256 (APNs) haqiqiy kalitlar bilan tekshiriladi');
{
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const verify = (jwt, pub, alg) => {
    const [h, c, s] = jwt.split('.'); const data = Buffer.from(`${h}.${c}`); const sig = Buffer.from(s, 'base64url');
    return alg === 'RS256' ? crypto.verify('RSA-SHA256', data, pub, sig) : crypto.verify('sha256', data, { key: pub, dsaEncoding: 'ieee-p1363' }, sig);
  };
  const a = push.signJwt({ alg: 'RS256', typ: 'JWT' }, { iss: 'x' }, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }), 'RS256');
  ok(verify(a, rsa.publicKey, 'RS256'), 'RS256 imzosi ochiq kalit bilan tasdiqlanadi');
  const b = push.signJwt({ alg: 'ES256', kid: 'K' }, { iss: 'T' }, ec.privateKey.export({ type: 'pkcs8', format: 'pem' }), 'ES256');
  ok(verify(b, ec.publicKey, 'ES256') && Buffer.from(b.split('.')[2], 'base64url').length === 64, 'ES256 imzosi (64 bayt, ieee-p1363) tasdiqlanadi');
}

// ── 2) Qurilma controller'i ──
console.log('\n2) Qurilma: ro\'yxatga olish, boshqa restoranga ko\'chish, faqat o\'z tokenini o\'chirish');
{
  ok((await call(mobileDevicesController.register, { restaurantId: R1, userId: oid(), body: { token: TOK('a1'), platform: 'android' } })).statusCode === 204, 'Android token qo\'shildi (204)');
  await call(mobileDevicesController.register, { restaurantId: R1, body: { token: TOK('i1'), platform: 'ios' } });
  await call(mobileDevicesController.register, { restaurantId: R2, body: { token: TOK('b1'), platform: 'android' } });
  ok((await call(mobileDevicesController.register, { restaurantId: R1, body: { token: 'short', platform: 'android' } })).statusCode === 400, 'yaroqsiz token rad etiladi (400)');
  ok((await call(mobileDevicesController.register, { restaurantId: R1, body: { token: TOK('zz'), platform: 'windows' } })).statusCode === 400, 'noma\'lum platforma rad etiladi (400)');
  await call(mobileDevicesController.register, { restaurantId: R1, body: { token: TOK('a1'), platform: 'android' } });
  ok(await MobileDevice.countDocuments({ token: TOK('a1') }) === 1, 'qayta ro\'yxat — dublikat yo\'q');
  await call(mobileDevicesController.register, { restaurantId: R2, body: { token: TOK('mv'), platform: 'android' } });
  await call(mobileDevicesController.register, { restaurantId: R1, body: { token: TOK('mv'), platform: 'android' } });
  ok(String((await MobileDevice.findOne({ token: TOK('mv') })).restaurantId) === String(R1), 'telefon boshqa restoranga kirsa token o\'shanga ko\'chadi');
  await call(mobileDevicesController.unregister, { restaurantId: R2, body: { token: TOK('mv') } });
  ok(await MobileDevice.countDocuments({ token: TOK('mv') }) === 1, 'begona restoran bu tokenni o\'chira olmaydi');
  await call(mobileDevicesController.unregister, { restaurantId: R1, body: { token: TOK('mv') } });
  ok(await MobileDevice.countDocuments({ token: TOK('mv') }) === 0, 'o\'z restorani chiqishda o\'chiradi');
  const list = await call(mobileDevicesController.list, { restaurantId: R1 });
  ok(list.body.devices.length === 2 && list.body.devices.every((d) => d.token.startsWith('…') && d.token.length === 7), 'monitoring ro\'yxati: faqat o\'z qurilmalari, token yashirilgan');
}

// ── 3) Sozlanmagan: hech narsa qilmaydi ──
console.log('\n3) Push sozlanmagan bo\'lsa — jim, bazaga ham yozmaydi');
{
  const r = quiet(); push.initMobilePush(); r();
  await push.onOrderEvent('order:new', { _id: oid(), restaurantId: R1, status: 'pending', total: 1 });
  ok(await OrderPushState.countDocuments() === 0, 'OrderPushState yaratilmadi');
}

// ── 4) Haqiqiy FCM yo'li (soxta Google) va haqiqiy APNs yo'li (lokal HTTP/2) ──
console.log('\n4) FCM HTTP v1 va APNs HTTP/2 — haqiqiy yuborish kodi');
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const fcmCalls = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts) => {
  const u = String(url);
  if (u.startsWith('https://oauth2.googleapis.com/')) { fcmCalls.push({ kind: 'oauth', body: String(opts.body) }); return new Response(JSON.stringify({ access_token: 'AT1', expires_in: 3600 }), { status: 200 }); }
  if (u.startsWith('https://fcm.googleapis.com/')) {
    const body = JSON.parse(opts.body);
    if (body.validate_only) { fcmCalls.push({ kind: 'check', body }); return new Response(JSON.stringify({ error: { code: 400, status: 'INVALID_ARGUMENT' } }), { status: 400 }); }   // ishga tushishdagi o'z-o'zini tekshirish
    fcmCalls.push({ kind: 'send', url: u, auth: opts.headers.authorization, body });
    if (body.message.token.startsWith('dead')) return new Response(JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 });
    if (body.message.token.startsWith('flaky')) return new Response(JSON.stringify({ error: { code: 503, status: 'UNAVAILABLE' } }), { status: 503 });
    return new Response('{"name":"projects/p/messages/1"}', { status: 200 });
  }
  return realFetch(url, opts);
};
const apnsSeen = [];
const h2 = http2.createServer();
h2.on('stream', (stream, headers) => {
  let body = ''; stream.setEncoding('utf8');
  stream.on('data', (c) => { body += c; });
  stream.on('end', () => {
    apnsSeen.push({ headers, body: JSON.parse(body || '{}') });
    if (headers[':path'].includes('/dead')) { stream.respond({ ':status': 410 }); stream.end(JSON.stringify({ reason: 'Unregistered' })); }
    else { stream.respond({ ':status': 200 }); stream.end(); }
  });
});
await new Promise((r) => h2.listen(0, '127.0.0.1', r));
config.fcmServiceAccountBase64 = Buffer.from(JSON.stringify({ client_email: 'push@p.iam.gserviceaccount.com', project_id: 'p', private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) })).toString('base64');
config.apnsKeyBase64 = Buffer.from(ec.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
config.apnsKeyId = 'KEY123'; config.apnsTeamId = 'TEAM1'; config.apnsBundleId = 'uz.lokmago.restaurant';
config.apnsHost = `http://127.0.0.1:${h2.address().port}`;
{
  const r = quiet(); const p = push.initMobilePush(); r();
  ok(p.android && p.ios, 'ikkala provayder yoqildi');
  const order = { _id: oid(), restaurantId: R1, status: 'pending', dailyNumber: 125, total: 128000, userId: { phone: '+998900000000' }, finance: { lokmaNetCommission: 99 } };
  const q = quiet(); await push.onOrderEvent('order:new', order); q();
  const oauth = fcmCalls.find((c) => c.kind === 'oauth');
  const assertion = new URLSearchParams(oauth.body).get('assertion');
  const [h, c, s] = assertion.split('.');
  ok(crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), rsa.publicKey, Buffer.from(s, 'base64url')), 'Google OAuth assertion service account kaliti bilan imzolangan');
  ok(JSON.parse(Buffer.from(c, 'base64url')).scope === 'https://www.googleapis.com/auth/firebase.messaging', 'OAuth scope = firebase.messaging');
  const sends = fcmCalls.filter((x) => x.kind === 'send');
  ok(sends.length === 1 && sends[0].url.endsWith('/v1/projects/p/messages:send') && sends[0].auth === 'Bearer AT1', 'FCM v1: to\'g\'ri manzil, Bearer token');
  const m = sends[0].body.message;
  ok(m.token === TOK('a1') && !m.notification && m.data.type === 'order_new' && m.data.orderId === String(order._id), 'Android: faqat data (ilova o\'zi signal chaladi), type=order_new');
  ok(m.android.priority === 'HIGH' && m.android.collapse_key === `order-${order._id}`, 'Android: HIGH priority (Doze\'da ham uyg\'otadi), collapse_key');
  ok(m.data.body === '#125 • 128 000 so\'m', 'matn: raqam va summa');
  ok(!JSON.stringify(m).match(/phone|lokmaNet|finance|998/), 'payloadda mijoz telefoni / moliya YO\'Q');
  ok(!sends.some((x) => x.body.message.token === TOK('b1')), 'boshqa restoranning telefoniga BORMADI');
  const ap = apnsSeen[0];
  ok(apnsSeen.length === 1 && ap.headers[':path'] === `/3/device/${TOK('i1')}`, 'APNs: /3/device/<token>');
  ok(ap.headers['apns-topic'] === 'uz.lokmago.restaurant' && ap.headers['apns-push-type'] === 'alert' && ap.headers['apns-priority'] === '10', 'APNs sarlavhalari: topic, alert, priority 10');
  const jwt = ap.headers.authorization.replace('bearer ', '').split('.');
  ok(crypto.verify('sha256', Buffer.from(`${jwt[0]}.${jwt[1]}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(jwt[2], 'base64url'))
    && JSON.parse(Buffer.from(jwt[0], 'base64url')).kid === 'KEY123', 'APNs JWT ES256 .p8 kaliti bilan imzolangan, kid to\'g\'ri');
  ok(ap.body.aps.sound === 'order_alert.wav' && ap.body.aps['interruption-level'] === 'time-sensitive' && ap.headers['apns-collapse-id'] === `order-${order._id}`, 'iOS: o\'z ovozi, Time Sensitive, bitta buyurtma = bitta xabar');
  ok((await OrderPushState.findOne({ orderId: order._id })).sentCount === 1, 'holat yozildi (1 marta yuborildi)');

  // dublikat
  const n1 = fcmCalls.length, n2 = apnsSeen.length;
  const q2 = quiet(); await push.onOrderEvent('order:new', order); await Promise.all([push.onOrderEvent('order:new', order), push.onOrderEvent('order:new', order)]); q2();
  ok(fcmCalls.length === n1 && apnsSeen.length === n2, 'bir buyurtma uchun takroriy "yangi" (retry / parallel) — qayta yuborilmaydi');

  // 1-QOIDA
  const q3 = quiet();
  await push.onOrderEvent('order:new', { _id: oid(), restaurantId: R1, status: 'awaiting_payment', total: 5 });
  await push.onOrderEvent('order:new', { _id: oid(), restaurantId: R1, status: 'accepted', total: 5 });
  q3();
  ok(fcmCalls.length === n1 && apnsSeen.length === n2, '1-QOIDA: awaiting_payment (va allaqachon qabul qilingan) — push YO\'Q');

  // yaroqsiz va vaqtincha ishlamaydigan tokenlar
  await MobileDevice.create([{ token: TOK('dead_fcm'), platform: 'android', restaurantId: R2 }, { token: TOK('flaky_fcm'), platform: 'android', restaurantId: R2 }, { token: TOK('dead'), platform: 'ios', restaurantId: R2 }]);
  const q4 = quiet(); await push.onOrderEvent('order:new', { _id: oid(), restaurantId: R2, status: 'pending', total: 9 }); q4();
  ok(!(await MobileDevice.exists({ token: TOK('dead_fcm') })) && !(await MobileDevice.exists({ token: TOK('dead') })), 'FCM UNREGISTERED va APNs 410 — token o\'chirildi');
  const flaky = await MobileDevice.findOne({ token: TOK('flaky_fcm') });
  ok(flaky && flaky.failCount === 1 && /503/.test(flaky.lastError), 'vaqtincha xato (503): token qoladi, xato hisoblanadi va monitoringda ko\'rinadi');
  ok(!!(await MobileDevice.findOne({ token: TOK('b1') })).lastSentAt, 'muvaffaqiyatli yuborish vaqti yozildi (monitoring)');
}

// ── 5) Qabul qilinmaguncha qayta yuborish, qabul/bekor bilan to'xtash ──
console.log('\n5) Taymer: qabul qilinmaguncha qayta yuboradi, qabul / bekor bilan to\'xtaydi');
{
  const sent = []; push._setTransportsForTest({ fcm: async (t, m) => { sent.push({ t, m }); return { ok: true }; }, apns: async (t, p, h) => { sent.push({ t, p, h }); return { ok: true }; } });
  const id = oid();
  await Order.collection.insertOne({ _id: id, restaurantId: R1, status: 'pending', dailyNumber: 7, total: 50000 });
  const q = quiet(); await push.onOrderEvent('order:new', { _id: id, restaurantId: R1, status: 'pending', dailyNumber: 7, total: 50000 });
  const base = sent.length;
  ok(base === 2, 'yangi buyurtma: R1 ning 2 ta telefoni (Android + iOS)');
  ok(await push.checkPendingOrderPushes(Date.now()) === 0, 'oraliq o\'tmagan — qayta yuborilmaydi');
  const t1 = Date.now() + 31_000;
  ok(await push.checkPendingOrderPushes(t1) === 1 && sent.length === base + 2, '30 s o\'tdi, hali pending — qayta yuborildi');
  ok(sent.at(-1).m?.data?.sendNo === '2' || sent.at(-2).m?.data?.sendNo === '2', 'qayta yuborish raqami (sendNo=2)');
  ok(await push.checkPendingOrderPushes(t1 + 1000) === 0, 'darhol yana — yo\'q (dublikat yo\'q)');
  // Ikki server nusxasi: B holatni o'qidi, A egallab yubordi, B o'sha eski holat bilan egallamoqchi bo'ladi.
  // (Haqiqiy parallel atomiklikni MongoDB kafolatlaydi; test bazasi FerretDB/SQLite buni qilmaydi — shuning uchun deterministik.)
  const staleB = await OrderPushState.findOne({ orderId: id }).lean();
  const sentA = await push.checkPendingOrderPushes(t1 + 31_000);
  const claimB = await OrderPushState.findOneAndUpdate({ _id: staleB._id, done: false, sentCount: staleB.sentCount }, { $inc: { sentCount: 1 } }, { new: true });
  ok(sentA === 1 && claimB === null, 'ikki server nusxasi: A egalladi, B eski holat bilan egallay olmaydi — bitta yuborish');
  await Order.collection.updateOne({ _id: id }, { $set: { status: 'accepted' } });
  const before = sent.length;
  ok(await push.checkPendingOrderPushes(t1 + 100_000) === 0 && sent.length === before, 'qabul qilingan — taymer to\'xtaydi');
  ok((await OrderPushState.findOne({ orderId: id })).done === true, 'holat yopildi');

  // emitOrderToRestaurant (io yo'q — telefon uxlab yotgandek): push baribir ketadi
  const id2 = oid();
  emitOrderToRestaurant(null, 'order:new', { _id: id2, restaurantId: R1, status: 'pending', total: 1000 });
  await wait(150);
  ok(sent.filter((s) => (s.m?.data?.orderId || s.p?.orderId) === String(id2)).length === 2, 'emitOrderToRestaurant ulanishi: soket bo\'lmasa ham push ketadi');

  // qabul qilindi / bekor → telefonlarga "signalni to'xtat"
  const n = sent.length;
  await push.onOrderEvent('order:update', { _id: id2, restaurantId: R1, status: 'accepted', dailyNumber: 8, total: 1000 });
  const stop = sent.slice(n);
  ok(stop.length === 2 && stop.some((s) => s.m?.data?.type === 'order_updated') && stop.some((s) => s.p?.aps?.['interruption-level'] === 'passive' && !s.p.aps.sound), 'qabul qilindi: Android order_updated, iOS ovozsiz almashtirish');
  await push.onOrderEvent('order:update', { _id: id2, restaurantId: R1, status: 'preparing', total: 1000 });
  ok(sent.length === n + 2, 'keyingi holatlar — qayta bezovta qilmaydi');
  const id3 = oid();
  await push.onOrderEvent('order:new', { _id: id3, restaurantId: R1, status: 'pending', total: 1 });
  const n3 = sent.length;
  await push.onOrderEvent('order:update', { _id: id3, restaurantId: R1, status: 'cancelled', total: 1 });
  ok(sent.slice(n3).some((s) => s.m?.data?.type === 'order_cancelled'), 'bekor qilindi: order_cancelled');
  const n4 = sent.length;
  await push.onOrderEvent('order:update', { _id: oid(), restaurantId: R1, status: 'accepted', total: 1 });
  ok(sent.length === n4, 'biz signal bermagan buyurtmaning yangilanishi — push yo\'q');

  // chegara
  config.mobilePushMaxSends = 3;
  const id4 = oid();
  await Order.collection.insertOne({ _id: id4, restaurantId: R2, status: 'pending', total: 1 });
  await push.onOrderEvent('order:new', { _id: id4, restaurantId: R2, status: 'pending', total: 1 });
  let t = Date.now();
  for (let i = 0; i < 6; i++) { t += 31_000; await push.checkPendingOrderPushes(t); }
  const st = await OrderPushState.findOne({ orderId: id4 });
  ok(st.sentCount === 3 && st.done === true, 'MOBILE_PUSH_MAX_SENDS=3: jami 3 marta, keyin to\'xtaydi');
  q();
}

// ── 6) Test push (diagnostika) ──
console.log('\n6) Test push: har telefon uchun natija va sabab; faqat o\'z telefonlari; tez-tez chaqirib bo\'lmaydi');
{
  const q = quiet();
  const R3 = oid();
  await MobileDevice.create([{ token: TOK('t_and'), platform: 'android', restaurantId: R3 }, { token: TOK('t_ios'), platform: 'ios', restaurantId: R3 }, { token: TOK('t_dead'), platform: 'ios', restaurantId: R3 }]);
  const seen = [];
  push._setTransportsForTest({
    fcm: async (t, m) => { seen.push({ t, m }); return { ok: true }; },
    apns: async (t, p) => { seen.push({ t, p }); return t === TOK('t_dead') ? { ok: false, dead: true, error: 'APNs 410 Unregistered' } : { ok: true }; },
  });
  const r = await call(mobileDevicesController.test, { restaurantId: R3 });
  q();
  ok(r.body.registered === 3 && r.body.results.length === 3, 'ro\'yxatdagi 3 telefonning hammasiga test yuborildi');
  ok(r.body.results.find((x) => x.platform === 'android').ok === true && seen.find((s) => s.m)?.m.data.type === 'test', 'Android: data.type=test (ilova oddiy bildirishnoma ko\'rsatadi)');
  ok(seen.find((s) => s.p && s.t === TOK('t_ios')).p.aps.alert.title.includes('Push ishlayapti'), 'iOS: ko\'rinadigan ovozli xabar');
  const dead = r.body.results.find((x) => x.ok === false);   // (test tokenlari bir xil '000000' bilan tugaydi — shu sabab xato qatori bo'yicha topamiz)
  ok(dead.ok === false && /410/.test(dead.error) && /o'chirildi/.test(dead.error) && !(await MobileDevice.exists({ token: TOK('t_dead') })), 'yaroqsiz token: sabab aytiladi va o\'chiriladi');
  ok(!seen.some((s) => s.t === TOK('a1') || s.t === TOK('i1')), 'boshqa restoranning telefoniga BORMADI');
  ok(r.body.results.every((x) => x.token.startsWith('…') && x.token.length === 7), 'token to\'liq ko\'rsatilmaydi');
  const again = await call(mobileDevicesController.test, { restaurantId: R3 });
  ok(again.statusCode === 429, '10 soniya ichida qayta chaqirish — 429 (suiiste\'moldan himoya)');
  push._setTransportsForTest(null);
  const r2 = quiet(); const p2 = push.initMobilePush(); config.fcmServiceAccountBase64 = ''; config.apnsKeyBase64 = ''; push.initMobilePush(); r2();
  const R4 = oid(); await MobileDevice.create({ token: TOK('u_ios'), platform: 'ios', restaurantId: R4 });
  const nc = await call(mobileDevicesController.test, { restaurantId: R4 });
  ok(nc.body.results[0].ok === false && /APNs sozlanmagan/.test(nc.body.results[0].error) && nc.body.providers.ios === false, 'server sozlanmagan bo\'lsa aynan shu aytiladi: "APNs sozlanmagan"');
}

// 6-bo'lim «sozlanmagan» holatni tekshirish uchun provayderlarni o'chirgan edi — qayta yoqamiz
const enableProviders = () => {
  config.fcmServiceAccountBase64 = Buffer.from(JSON.stringify({ client_email: 'push@p.iam.gserviceaccount.com', project_id: 'p', private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }) })).toString('base64');
  config.apnsKeyBase64 = Buffer.from(ec.privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
  config.apnsKeyId = 'KEY123'; config.apnsTeamId = 'TEAM1';
  const r = quiet(); const p = push.initMobilePush(); r(); return p;
};

// ── 7) Provayder timeout / vaqtinchalik xato ≠ yaroqsiz token ──
console.log('\n7) Timeout va tarmoq xatosi: token SAQLANADI (faqat provayder aniq tasdiqlasa o\'chadi)');
{
  enableProviders();
  const q = quiet();
  const R5 = oid(); await MobileDevice.create([{ token: TOK('to_and'), platform: 'android', restaurantId: R5 }, { token: TOK('to_ios'), platform: 'ios', restaurantId: R5 }]);
  const saveTimeout = config.mobilePushTimeoutMs; config.mobilePushTimeoutMs = 150;
  const hang = http2.createServer(); hang.on('stream', () => { /* javob BERMAYDI */ });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  config.apnsHost = `http://127.0.0.1:${hang.address().port}`;
  const f0 = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { if (String(url).includes('fcm.googleapis.com') && !JSON.parse(opts.body).validate_only) { const e = new Error('The operation was aborted due to timeout'); e.name = 'TimeoutError'; throw e; } return f0(url, opts); };
  push._setTransportsForTest(null);
  const t0 = Date.now();
  const r = await push.sendTestPush(R5);
  q();
  ok(Date.now() - t0 < 2000, 'APNs javob bermasa ham so\'rov timeout bilan tugaydi (osilib qolmaydi)');
  ok(r.every((x) => x.ok === false), 'ikkala provayder xato qaytardi (FCM timeout, APNs timeout)');
  ok(/timeout/i.test(r.find((x) => x.platform === 'ios').error) && /timeout/i.test(r.find((x) => x.platform === 'android').error), 'sabab ko\'rinadi: timeout');
  ok(await MobileDevice.countDocuments({ restaurantId: R5 }) === 2, 'timeout tokenni O\'CHIRMAYDI (yaroqsiz deb hisoblanmaydi)');
  const qq = quiet(); await push.onOrderEvent('order:new', { _id: oid(), restaurantId: R5, status: 'pending', total: 5 }); qq();
  const d = await MobileDevice.findOne({ token: TOK('to_and') });
  ok(d.failCount === 1 && /timeout|aborted/i.test(d.lastError), 'xato monitoringda: failCount=1, lastError');
  globalThis.fetch = f0; config.mobilePushTimeoutMs = saveTimeout; hang.close(); config.apnsHost = `http://127.0.0.1:${h2.address().port}`;
}

// ── 8) Push xatosi buyurtma oqimiga TEGMAYDI ──
console.log('\n8) Push butunlay ishlamay qolsa ham buyurtma xabari (soket) va buyurtma oqimi buzilmaydi');
{
  const q = quiet();
  const origFind = MobileDevice.find, origCreate = OrderPushState.create;
  MobileDevice.find = () => { throw new Error('baza o\'chdi'); };
  OrderPushState.create = async () => { throw new Error('boshqa xato'); };
  const emitted = []; const io = { to: () => ({ emit: (ev, p) => emitted.push({ ev, id: p._id || p }) }), emit() {} };
  let threw = false;
  try { await emitOrderToRestaurant(io, 'order:new', { _id: oid(), restaurantId: R1, status: 'pending', dailyNumber: 9, total: 1, items: [], userId: null }); } catch { threw = true; }
  await wait(120);
  MobileDevice.find = origFind; OrderPushState.create = origCreate;
  q();
  ok(!threw, 'emitOrderToRestaurant push xatosida ISTISNO otmaydi (buyurtma yaratish oqimi buzilmaydi)');
  ok(emitted.some((e) => e.ev === 'order:new'), 'Socket.IO hodisasi baribir yuborildi');
}

// ── 9) Loglarda sir YO'Q ──
console.log('\n9) Loglar: token, JWT, private key, mijoz ma\'lumoti chiqmaydi');
{
  const lines = []; const l = console.log, w = console.warn, e = console.error;
  const cap = (...a) => lines.push(a.map(String).join(' '));
  console.log = cap; console.warn = cap; console.error = cap;
  const SECRET_TOKEN = 'SECRETDEVICETOKEN' + 'f'.repeat(30);
  const R6 = oid(); await MobileDevice.create([{ token: SECRET_TOKEN, platform: 'android', restaurantId: R6 }, { token: 'dead' + SECRET_TOKEN, platform: 'android', restaurantId: R6 }]);
  push._setTransportsForTest({ fcm: async (t) => (t.startsWith('dead') ? { ok: false, dead: true, error: 'FCM 404 UNREGISTERED' } : { ok: false, error: 'FCM 503 UNAVAILABLE' }), apns: async () => ({ ok: true }) });
  await push.onOrderEvent('order:new', { _id: oid(), restaurantId: R6, status: 'pending', dailyNumber: 77, total: 99000, userId: { name: 'Mijoz Familiya', phone: '+998901234567' }, address: 'Chilonzor 5-uy', finance: { net: 1 } });
  config.fcmServiceAccountBase64 = 'not-base64-@@@'; config.apnsKeyBase64 = Buffer.from('-----BEGIN PRIVATE KEY-----\nTOPSECRETKEYBODY\n').toString('base64'); config.apnsKeyId = 'K'; config.apnsTeamId = 'T';
  push.initMobilePush(); await wait(100);
  console.log = l; console.warn = w; console.error = e;
  const all = lines.join('\n');
  ok(!all.includes(SECRET_TOKEN) && !all.includes(SECRET_TOKEN.slice(-12)), 'qurilma tokeni logda yo\'q');
  ok(!/TOPSECRETKEYBODY|BEGIN PRIVATE KEY|not-base64/.test(all), 'private key / sozlama qiymati logda yo\'q (xato matni ham sirni aks ettirmaydi)');
  ok(!/998901234567|Mijoz Familiya|Chilonzor/.test(all), 'mijozning telefoni, ismi, manzili logda yo\'q');
  ok(/#77/.test(all), 'faqat buyurtma raqami va natija soni logga yoziladi');
}

// ── 10) APNs muhiti har qurilma uchun ──
console.log('\n10) iOS muhiti: development → sandbox, production → production, noma\'lum → APNS_PRODUCTION');
{
  const save = config.apnsHost; config.apnsHost = '';
  const sp = config.apnsProduction;
  config.apnsProduction = false;
  ok(push.apnsHostFor('development') === 'https://api.sandbox.push.apple.com' && push.apnsHostFor('production') === 'https://api.push.apple.com', 'development → sandbox, production → production');
  ok(push.apnsHostFor(null) === 'https://api.sandbox.push.apple.com', 'muhit yo\'q (eski ilova), APNS_PRODUCTION=false → sandbox');
  config.apnsProduction = true;
  ok(push.apnsHostFor(null) === 'https://api.push.apple.com' && push.apnsHostFor('development') === 'https://api.sandbox.push.apple.com', 'muhit yo\'q, APNS_PRODUCTION=true → production; lekin development token baribir sandbox');
  config.apnsProduction = sp; config.apnsHost = save;
  const R7 = oid();
  ok((await call(mobileDevicesController.register, { restaurantId: R7, body: { token: TOK('env1'), platform: 'ios', environment: 'development' } })).statusCode === 204
    && (await MobileDevice.findOne({ token: TOK('env1') })).environment === 'development', 'POST /devices {environment} saqlanadi');
  ok((await call(mobileDevicesController.register, { restaurantId: R7, body: { token: TOK('env1'), platform: 'ios' } })).statusCode === 204
    && (await MobileDevice.findOne({ token: TOK('env1') })).environment === 'development', 'environment yubormagan eski ilova mavjud muhitni O\'ZGARTIRMAYDI');
  ok((await call(mobileDevicesController.register, { restaurantId: R7, body: { token: TOK('env2'), platform: 'ios', environment: 'staging' } })).statusCode === 400, 'noma\'lum muhit rad etiladi (400)');
  const seen2 = []; push._setTransportsForTest({ apns: async (t, p, h, env) => { seen2.push(env); return { ok: true }; }, fcm: async () => ({ ok: true }) });
  const qa = quiet(); await push.onOrderEvent('order:new', { _id: oid(), restaurantId: R7, status: 'pending', total: 1 }); qa();
  ok(seen2.length === 1 && seen2[0] === 'development', 'push qurilmaning o\'z muhiti bilan yuboriladi');
}

// ── 11) Ishga tushganda provayderni tekshirish ──
console.log('\n11) Ishga tushganda tekshiruv: noto\'g\'ri kalit logda va GET /devices da ko\'rinadi');
{
  push._setTransportsForTest(null);
  const f1 = globalThis.fetch;
  enableProviders(); config.apnsKeyBase64 = '';
  { const r0 = quiet(); push.initMobilePush(); r0(); }
  globalThis.fetch = async (url, opts) => String(url).includes('oauth2') ? new Response(JSON.stringify({ access_token: 'AT', expires_in: 3600 }), { status: 200 })
    : String(url).includes('fcm.googleapis.com') ? new Response('{"error":{"code":403,"status":"PERMISSION_DENIED"}}', { status: 403 }) : f1(url, opts);
  const q = quiet(); const bad = await push.verifyProviders(); q();
  ok(/xato: FCM 403/.test(bad.android) && bad.ios === 'off', 'FCM 403 (Cloud Messaging API yoqilmagan / noto\'g\'ri loyiha) aniq sabab bilan aytiladi');
  const listed = await call(mobileDevicesController.list, { restaurantId: R1 });
  ok(listed.body.check.android === bad.android, 'GET /api/panel/devices `check` shuni qaytaradi');
  globalThis.fetch = async (url, opts) => String(url).includes('oauth2') ? new Response(JSON.stringify({ access_token: 'AT', expires_in: 3600 }), { status: 200 })
    : String(url).includes('fcm.googleapis.com') ? new Response('{"error":{"code":400,"status":"INVALID_ARGUMENT"}}', { status: 400 }) : f1(url, opts);
  const q2 = quiet(); const good = await push.verifyProviders(); q2();
  ok(good.android === 'ok', 'FCM 400 INVALID_ARGUMENT (soxta token) = autentifikatsiya va loyiha TO\'G\'RI → "ok"');
  globalThis.fetch = f1;
}

push._setTransportsForTest(null); globalThis.fetch = realFetch; h2.close();
await mongoose.disconnect();
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ hammasi o\'tdi');
process.exit(fails ? 1 : 0);
