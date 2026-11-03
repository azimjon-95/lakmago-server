/*
 * ═══════════════════════════════════════════════════════════
 * KURYER ILOVASI (BOSQICH 2): akkaunt, smena, 5 s joylashuv → Redis, takliflar, qabul, topshirish, tarix, push
 * ═══════════════════════════════════════════════════════════
 * HAQIQIY Redis (REDIS_URL) va Mongo bilan; FCM/APNs soxta. Mavjud acceptShare / deliverShare ishlatilgani uchun buyurtma holati
 * va hisob-kitob mantiqi QAYTA TEKSHIRILADI (order → delivering → delivered). npm run test:courier-app
 */
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/lokma_courier_app';
process.env.REDIS_URL = 'redis://127.0.0.1:6390/1';
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.TELEGRAM_BOT_TOKEN = ''; process.env.RESTAURANT_BOT_TOKEN = '';

import jwt from 'jsonwebtoken';
const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();
const { config } = await import('../src/config/index.js');
const cache = await import('../src/services/cache.js');
cache.initCache();
for (let i = 0; i < 40 && !cache.isCacheReady(); i++) await new Promise((r) => setTimeout(r, 100));
const presence = await import('../src/services/courierPresence.js');
const app = await import('../src/services/courierApp.js');
const cpush = await import('../src/services/courierPush.js');
const mpush = await import('../src/services/mobilePush.js');
const { courierAppController, courierAccountAdminController } = await import('../src/controllers/courierApp.js');
const { courierAuth, signCourierToken } = await import('../src/middleware/courierAuth.js');
const { auth, signToken } = await import('../src/middleware/auth.js');
const { CourierAccount } = await import('../src/models/CourierAccount.js');
const { CourierShift } = await import('../src/models/CourierShift.js');
const { CourierDevice } = await import('../src/models/CourierDevice.js');
const { CourierOffer } = await import('../src/models/CourierOffer.js');
const { DeliveryAssignment } = await import('../src/models/DeliveryAssignment.js');
const { Order } = await import('../src/models/Order.js');
await CourierAccount.init(); await CourierDevice.init();
await CourierOffer.init().catch(() => {});
await CourierOffer.collection.createIndex({ assignmentId: 1, courierId: 1 }, { unique: true });   // (FerretDB TTL indeksni qo'llamaydi — unikal indeksni qo'lda quramiz)

let fails = 0;
const ok = (c, m) => { process.stdout.write(`${c ? '  ✓' : '  ✗ FAIL:'} ${m}\n`); if (!c) fails++; };
const quiet = () => { const l = console.log, w = console.warn, e = console.error; console.log = () => {}; console.warn = () => {}; console.error = () => {}; return () => { console.log = l; console.warn = w; console.error = e; }; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const oid = () => new mongoose.Types.ObjectId();
const call = (fn, req) => new Promise((resolve, reject) => {
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; resolve(this); return this; }, end() { resolve(this); return this; } };
  fn(req, res, (e) => (e ? reject(e) : resolve(res)));
});
const mw = (fn, headers) => new Promise((resolve) => {
  const req = { headers }; const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(b) { resolve({ passed: false, status: this.statusCode, body: b, req }); return this; } };
  Promise.resolve(fn(req, res, () => resolve({ passed: true, req }))).catch(() => {});
});
const as = async (id) => ({ courier: await CourierAccount.findById(id).lean(), courierId: String(id) });
const mkCourier = async (login, extra = {}) => (await call(courierAccountAdminController.create, { body: { login, password: 'parol12345', name: `Kuryer ${login}`, phone: '+998901112233', vehicle: 'scooter', ...extra } })).body;

const REST = { lat: 41.3111, lng: 69.2797 };            // restoran
const CUST = { lat: 41.3300, lng: 69.2900 };            // mijoz
const NEAR = { lat: 41.3120, lng: 69.2800 };            // restoranga ~100 m
const FAR = { lat: 41.5000, lng: 69.5000 };             // ~30 km

async function mkOrder(status = 'ready') {
  const id = oid();
  await Order.collection.insertOne({ _id: id, restaurantId: oid(), status, dailyNumber: 7, total: 90000, courierName: '' });
  return id;
}
async function mkOffer(orderId, extra = {}) {
  return DeliveryAssignment.create({
    orderId, restaurantId: oid(), status: 'searching', token: `tok-${oid()}`,
    deliverySnapshot: { orderCode: '7', restaurantName: 'Osh Markazi', restaurantAddress: 'Amir Temur 1', restaurantLat: REST.lat, restaurantLng: REST.lng,
      addressLabel: 'Yunusobod', addressNote: 'Eshik kodi 1234', lat: CUST.lat, lng: CUST.lng, customerPhone: '+998935556677', customerName: 'Mijoz Familiyasi',
      itemsSummary: '2x Osh', items: [{ name: 'Osh', quantity: 2, total: 80000 }], deliveryFee: 12000, total: 92000, isPaid: false, collectAmount: 92000, paymentMethod: 'cash' },
    ...extra,
  });
}

console.log('\n1) Akkaunt va autentifikatsiya: kuryer tokeni boshqa tizimlarga KIRA OLMAYDI');
let A, B, F;
{
  ok((await call(courierAccountAdminController.create, { body: { login: 'ab', password: 'x', name: 'Q' } })).statusCode === 400, 'qisqa login / parol rad etiladi (parol ≥ 8)');
  A = await mkCourier('Anvar'); B = await mkCourier('bobur'); F = await mkCourier('far');
  ok(A.id && !('passwordHash' in A) && A.login === 'anvar', 'yaratildi; login kichik harfda; javobda parol hash\'i YO\'Q');
  ok((await call(courierAccountAdminController.create, { body: { login: 'ANVAR', password: 'parol12345', name: 'Dublikat' } })).statusCode === 409, 'login band (registrdan qat\'i nazar) → 409');
  ok((await call(courierAppController.login, { body: { login: 'anvar', password: 'xato' } })).statusCode === 401, 'noto\'g\'ri parol → 401');
  const lg = await call(courierAppController.login, { body: { login: 'ANVAR', password: 'parol12345' } });
  ok(lg.body.token && lg.body.courier.name === 'Kuryer Anvar', 'to\'g\'ri login → token (login registrga bog\'liq emas)');
  const tokA = lg.body.token;
  ok((await mw(courierAuth, { authorization: `Bearer ${tokA}` })).passed, 'courierAuth kuryer tokenini qabul qiladi');
  const viaOld = await mw(auth, { authorization: `Bearer ${tokA}` });
  ok(!viaOld.passed && viaOld.status === 401, 'MAVJUD auth (mijoz / restoran / admin) kuryer tokenini RAD etadi (boshqa kalit)');
  const restToken = signToken(String(oid()), 'restaurant', String(oid()));
  ok(!(await mw(courierAuth, { authorization: `Bearer ${restToken}` })).passed, 'restoran tokeni kuryer API\'siga kira olmaydi');
  const forged = jwt.sign({ cid: A.id, role: 'courier' }, config.jwtSecret, { expiresIn: '1h' });
  ok(!(await mw(courierAuth, { authorization: `Bearer ${forged}` })).passed, 'asosiy JWT kaliti bilan yasalgan "kuryer" tokeni ishlamaydi');
  await call(courierAccountAdminController.update, { params: { id: F.id }, body: { isActive: false } });
  ok((await mw(courierAuth, { authorization: `Bearer ${signCourierToken(F.id)}` })).status === 403 && (await call(courierAppController.login, { body: { login: 'far', password: 'parol12345' } })).statusCode === 403, 'admin bloklasa: tokeni darhol ishlamaydi va login ham yopiladi (403)');
  await call(courierAccountAdminController.update, { params: { id: F.id }, body: { isActive: true } });
  ok((await call(courierAccountAdminController.update, { params: { id: A.id }, body: { restaurantId: 'x' } })).statusCode === 400, 'update: noma\'lum maydon → 400');
}

console.log('\n2) Smena: «Ishni boshladim / yakunladim»');
{
  const noShift = await call(courierAppController.location, { ...(await as(A.id)), body: NEAR });
  ok(noShift.statusCode === 409, 'smena boshlanmasdan joylashuv qabul qilinmaydi (409)');
  const s1 = await app.startShift(A.id);
  ok(s1.ok && s1.onShift === true && !s1.already, 'ishni boshladi');
  const s2 = await app.startShift(A.id);
  ok(s2.already === true && s2.shift.id === s1.shift.id, 'qayta bosish: idempotent (o\'sha smena)');
  await app.startShift(B.id);
  // (Haqiqiy parallel poyga MongoDB'ning bitta-hujjat atomik yangilanishiga tayanadi: `activeShiftId: null` sharti. Test bazasi FerretDB/SQLite buni
  //  kafolatlamaydi, shuning uchun poygani qayta hosil qilmaymiz — xuddi acceptShare uchun ham shunday.)
  await app.startShift(B.id); await app.startShift(B.id);
  ok(await CourierShift.countDocuments({ accountId: B.id, endedAt: null }) === 1, 'ketma-ket 3 ta «boshladim» → bitta ochiq smena');
  const e = await app.endShift(B.id);
  ok(e.ok && !(await CourierAccount.findById(B.id)).activeShiftId && (await CourierShift.findOne({ accountId: B.id })).endReason === 'courier', 'ishni yakunladi: smena yopildi, sabab = courier');
  ok((await app.endShift(B.id)).already === true, 'qayta yakunlash xato bermaydi');
  await app.startShift(B.id); await app.startShift(F.id);
}

console.log('\n3) Joylashuv har ~5 s → REDIS (TTL), haqiqiy tekshiruv');
{
  ok(cache.isCacheReady(), 'Redis ulangan');
  const r = await call(courierAppController.location, { ...(await as(A.id)), body: { ...NEAR, accuracy: 8, speed: 3.2, heading: 90 } });
  ok(r.statusCode === 204, 'joylashuv qabul qilindi (204)');
  const raw = await cache.getRedis().hgetall(`courier:loc:${A.id}`);
  const ttl = await cache.getRedis().ttl(`courier:loc:${A.id}`);
  ok(Number(raw.lat) === NEAR.lat && Number(raw.lng) === NEAR.lng && raw.acc === '8' && raw.spd === '3.2', 'Redis HASH: lat, lng, aniqlik, tezlik yozilgan');
  ok(ttl > 0 && ttl <= 90, `TTL ${ttl} s (≤ 90): jim qolgan kuryer o'zi yo'qoladi`);
  ok(Math.abs(Number(raw.ts) - Date.now()) < 2000, 'vaqt SERVER soati bilan (telefon soati noto\'g\'ri bo\'lsa ham)');
  ok((await cache.getRedis().sismember('couriers:onshift', A.id)) === 1, 'smenadagilar to\'plamida');
  ok((await call(courierAppController.location, { ...(await as(A.id)), body: { lat: 10, lng: 69 } })).statusCode === 400 && (await call(courierAppController.location, { ...(await as(A.id)), body: { lat: 'x', lng: 2 } })).statusCode === 400, 'chegaradan tashqari / noto\'g\'ri nuqta rad etiladi');
  await call(courierAppController.location, { ...(await as(A.id)), body: { lat: NEAR.lat + 0.0009, lng: NEAR.lng } });   // ~100 m
  const dist = (await CourierShift.findOne({ accountId: A.id, endedAt: null })).distanceM;
  ok(dist > 80 && dist < 120, `bosib o'tilgan masofa hisoblanadi (~100 m → ${Math.round(dist)} m)`);
  await call(courierAppController.location, { ...(await as(A.id)), body: { lat: NEAR.lat + 0.5, lng: NEAR.lng } });   // 55 km «GPS sakrashi»
  ok((await CourierShift.findOne({ accountId: A.id, endedAt: null })).distanceM < 130, 'GPS «sakrashi» (55 km) masofaga qo\'shilmaydi');
  await call(courierAppController.location, { ...(await as(A.id)), body: NEAR });
  await call(courierAppController.location, { ...(await as(B.id)), body: { lat: NEAR.lat + 0.002, lng: NEAR.lng } });
  await call(courierAppController.location, { ...(await as(F.id)), body: FAR });
  const n = await presence.nearby(REST, 5000);
  ok(n.map((x) => x.id).join() === [A.id, B.id].join() && n[0].distanceM < n[1].distanceM, 'nearby: faqat 5 km ichidagilar, eng yaqini birinchi (30 km dagi F yo\'q)');
  await cache.getRedis().pexpire(`courier:loc:${B.id}`, 80); await wait(150);
  const n2 = await presence.nearby(REST, 5000);
  ok(!n2.some((x) => x.id === B.id) && (await cache.getRedis().sismember('couriers:onshift', B.id)) === 0, 'TTL tugadi: kuryer yaqinlar ro\'yxatidan va to\'plamdan o\'zi tushdi');
  await call(courierAppController.location, { ...(await as(B.id)), body: { lat: NEAR.lat + 0.002, lng: NEAR.lng } });
  presence._useRedisForTest(false);
  const where = await presence.setLocation('mem1', { lat: NEAR.lat, lng: NEAR.lng });
  ok(where === 'memory' && (await presence.nearby(REST, 2000)).some((x) => x.id === 'mem1'), 'Redis YO\'Q bo\'lsa: xotiraga yoziladi va ishlayveradi (Redis majburiy emas)');
  await presence.clearLocation('mem1'); presence._useRedisForTest(null);
}

console.log('\n4) Takliflar: mijoz ma\'lumoti yashirin, masofa bo\'yicha');
let asg1, ord1;
{
  ord1 = await mkOrder('ready'); asg1 = await mkOffer(ord1);
  const cancelled = await mkOrder('cancelled'); await mkOffer(cancelled);
  const offers = await app.listOffers(A.id);
  ok(offers.length === 1 && offers[0].id === String(asg1._id), 'faqat haqiqiy ochiq buyurtma (bekor qilinganniki ko\'rinmaydi)');
  ok(offers[0].distanceM > 0 && offers[0].distanceM < 300, `restoranga masofa: ${offers[0].distanceM} m`);
  const js = JSON.stringify(offers);
  ok(!/998935556677|Mijoz Familiyasi|Eshik kodi|"lat":41\.33/.test(js) && offers[0].addressLabel === 'Yunusobod', 'taklifda mijoz telefoni, ismi, aniq manzili va koordinatasi YO\'Q (faqat tuman)');
  ok((await app.listOffers(F.id)).length === 0, '30 km uzoqdagi kuryer taklifni ko\'rmaydi (radius 10 km)');
}

console.log('\n5) Qabul qilish: birinchi olgan oladi, buyurtma holati mavjud mantiq bilan');
{
  const q = quiet();
  const notOnShift = await app.acceptOffer({ ...(await as(B.id)).courier, activeShiftId: null }, asg1._id);   // smenada emas
  const accA = (await as(A.id)).courier, accB = (await as(B.id)).courier;
  const rA = await app.acceptOffer(accA, asg1._id);           // birinchi olgan oladi (poyga atomikligi — acceptShare / MongoDB)
  const rB = await app.acceptOffer(accB, asg1._id);
  q();
  ok(notOnShift.ok === false && notOnShift.status === 409 && /Ishni boshladim/.test(notOnShift.error), 'smenada bo\'lmagan kuryer qabul qila olmaydi («Ishni boshladim» ni bosing»)');
  const winners = [rA, rB].filter((r) => r.ok);
  ok(winners.length === 1 && rA.ok && rB.ok === false && rB.status === 409 && /endi mavjud emas|boshqa kuryer/.test(rB.error), 'birinchi olgan oladi; ikkinchisi 409 (buyurtma allaqachon yo\'lda / boshqa kuryer oldi)');
  const winner = rA.ok ? A : B;
  const winnerName = (await CourierAccount.findById(winner.id)).name;
  const a = await DeliveryAssignment.findById(asg1._id).lean(), o = await Order.collection.findOne({ _id: ord1 });
  ok(String(a.assignedAccountId) === winner.id && a.status === 'assigned' && a.courier.name === winnerName, 'topshiriq g\'olib kuryerga yozildi (akkaunt + ism)');
  ok(o.status === 'delivering' && o.courierName === winnerName, 'buyurtma "delivering" ga o\'tdi (mavjud acceptShare), restoran panelida kuryer nomi');
  const view = winner.id === A.id ? rA.active : rB.active;
  ok(view.customerPhone === '+998935556677' && view.addressNote === 'Eshik kodi 1234' && view.lat === CUST.lat && view.collectAmount === 92000, 'qabul qilgach: mijoz telefoni, aniq manzil, koordinata, olinadigan pul ko\'rinadi');
  const loser = winner.id === A.id ? B : A;
  ok((await app.activeAssignment(loser.id)) === null, 'ikkinchi kuryerda faol buyurtma yo\'q');
  const o2 = await mkOrder('ready'); const asg2 = await mkOffer(o2);
  const busy = await app.acceptOffer((await as(winner.id)).courier, asg2._id);
  ok(busy.ok === false && busy.status === 409 && /topshiring/.test(busy.error), 'faol buyurtma bor: yana olib bo\'lmaydi (COURIER_MAX_ACTIVE=1)');
  const stranger = await app.deliverActive((await as(loser.id)).courier);
  ok(stranger.ok === false && stranger.status === 404, 'boshqa kuryer begona buyurtmani «topshirdim» qila olmaydi');
  ok((await app.endShift(winner.id)).status === 409, 'faol buyurtma bor: ishni yakunlab bo\'lmaydi');
  globalThis.__winner = winner; globalThis.__loser = loser; globalThis.__asg2 = asg2;
}

console.log('\n6) Faol buyurtma: kuryer joylashuvi mijoz kuzatuviga yoziladi, «yetib keldi»');
{
  const w = globalThis.__winner;
  await call(courierAppController.location, { ...(await as(w.id)), body: { lat: CUST.lat + 0.0005, lng: CUST.lng } });   // ~55 m mijozdan
  const a = await DeliveryAssignment.findById(asg1._id).lean(), o = await Order.collection.findOne({ _id: ord1 });
  ok(a.location.lat === CUST.lat + 0.0005 && a.location.at, 'faol buyurtmaning joylashuvi yangilandi (mijoz kuzatuvi ishlaydi)');
  ok(!!o.arrivedAt, 'mijoz manzili 150 m ichida: «yetib keldi» belgilandi');
}

console.log('\n7) Topshirish, tarix, hisobot, izolyatsiya');
{
  const q = quiet(); const w = globalThis.__winner, l = globalThis.__loser;
  const d = await app.deliverActive((await as(w.id)).courier);
  await wait(200); q();
  ok(d.ok === true && (await Order.collection.findOne({ _id: ord1 })).status === 'delivered', 'topshirdi: buyurtma "delivered" (mavjud deliverShare + hisob-kitob)');
  ok((await app.activeAssignment(w.id)) === null && (await CourierShift.findOne({ accountId: w.id, endedAt: null })).deliveries === 1, 'faol buyurtma yo\'q; smenada yetkazishlar = 1');
  const h = await app.history(w.id);
  ok(h.length === 1 && h[0].deliveryFee === 12000 && h[0].minutes >= 1 && h[0].restaurantName === 'Osh Markazi', 'tarix: restoran, yetkazish haqi, davomiyligi');
  ok((await app.history(l.id)).length === 0, 'tarix izolyatsiyasi: boshqa kuryer buni ko\'rmaydi');
  const st = await app.stats(w.id);
  ok(st.today.deliveries === 1 && st.today.deliveryFees === 12000 && st.week.deliveries === 1 && st.today.shifts >= 1 && st.today.distanceKm >= 0, 'hisobot: bugun / 7 kun / 30 kun — yetkazishlar, haq, smenalar, ish vaqti, masofa');
  ok((await app.endShift(w.id)).ok === true && (await presence.getLocation(w.id)) === null, 'topshirgach ishni yakunlay oladi; Redis\'dagi joylashuv o\'chadi');
  await app.startShift(w.id);
  const sh = await app.shiftHistory(w.id);
  ok(sh.length === 2 && sh[1].deliveries === 1, 'smena tarixi');
}

console.log('\n8) Taklif push\'i: yaqin, smenadagi, band emas; dublikatsiz; mijoz ma\'lumotisiz');
{
  const sent = [];
  mpush._setTransportsForTest({
    fcm: async (t, m) => { sent.push({ p: 'android', t, m }); return t.startsWith('dead') ? { ok: false, dead: true, error: 'FCM 404 UNREGISTERED' } : { ok: true }; },
    apns: async (t, p, h) => { sent.push({ p: 'ios', t, payload: p, h }); return { ok: true }; },
  });
  const w = globalThis.__winner, l = globalThis.__loser;
  await DeliveryAssignment.updateMany({ status: 'searching' }, { $set: { status: 'expired' } });     // oldingi bo'limlardagi ochiq takliflar bu bo'limga aralashmasin
  // bu bo'limda 3 kuryer: P (yaqin, android), Q (yaqin, iPhone), R (30 km uzoqda)
  const P = await mkCourier('pushp'), Q = await mkCourier('pushq'), R = await mkCourier('pushr');
  for (const c of [P, Q, R]) await app.startShift(c.id);
  await call(courierAppController.location, { ...(await as(P.id)), body: NEAR }); await call(courierAppController.location, { ...(await as(Q.id)), body: { lat: NEAR.lat + 0.004, lng: NEAR.lng } }); await call(courierAppController.location, { ...(await as(R.id)), body: FAR });
  const reg = (id, token, platform, extra = {}) => call(courierAppController.registerDevice, { courierId: id, body: { token: token.padEnd(40, '0'), platform, ...extra } });
  await reg(P.id, 'tokP', 'android'); await reg(Q.id, 'tokQ', 'ios', { environment: 'development' }); await reg(R.id, 'tokR', 'android');
  // eski kuryerlar (w, l) band yoki jim — ularga bormasin: ularning joylashuvini uzoqqa qo'yamiz
  for (const c of [w, l]) await call(courierAppController.location, { ...(await as(c.id)), body: FAR });
  const q0 = quiet();
  const o3 = await mkOrder('ready'); const asg3 = await mkOffer(o3);
  const t0 = Date.now();
  const n1 = await cpush.dispatchOffers(t0);
  q0();
  const toP = sent.filter((s) => s.t === 'tokP'.padEnd(40, '0')), toQ = sent.filter((s) => s.t === 'tokQ'.padEnd(40, '0'));
  ok(n1 === 2 && toP.length === 1 && toQ.length === 1 && !sent.some((s) => s.t === 'tokR'.padEnd(40, '0')), 'faqat yaqin ikki kuryerga ketdi; 30 km dagi R ga YO\'Q');
  ok(toP[0].m.data.type === 'courier_offer' && toP[0].m.data.assignmentId === String(asg3._id) && toP[0].m.android.priority === 'HIGH', 'Android: data courier_offer, HIGH priority');
  ok(toQ[0].payload.aps.sound === 'courier_alert.wav' && toQ[0].payload.aps['interruption-level'] === 'time-sensitive' && toQ[0].h['apns-push-type'] === 'alert', 'iPhone: alohida melodiya courier_alert.wav (restorannikidan farqli), time-sensitive');
  ok(!/998935556677|Mijoz|Eshik|Yunusobod|41\.33/.test(JSON.stringify(sent)), 'push\'da mijoz telefoni, ismi, manzili YO\'Q');
  const q1 = quiet(); const n2 = await cpush.dispatchOffers(t0 + 1000); q1();
  ok(n2 === 0, 'darhol qayta ishga tushganda dublikat yuborilmaydi (atomik egallash)');
  const q2 = quiet(); const n3 = await cpush.dispatchOffers(t0 + 31_000); const n4 = await cpush.dispatchOffers(t0 + 62_000); const n5 = await cpush.dispatchOffers(t0 + 93_000); q2();
  ok(n3 === 2 && n4 === 2 && n5 === 0, '30 s oralig\'ida 2-, 3-urinish; 3 martadan ortiq YO\'Q');
  ok(await CourierOffer.countDocuments({ assignmentId: asg3._id }) === 2, 'har kuryerga bitta yozuv (jami 2)');
  // band kuryerga yubormaydi
  const o4 = await mkOrder('ready'); const asg4 = await mkOffer(o4);
  const q3 = quiet(); const take = await app.acceptOffer((await as(P.id)).courier, asg3._id); q3();
  ok(take.ok === true, 'P taklifni oldi');
  const closed = sent.length;
  const q4 = quiet(); await cpush.notifyOfferClosed(asg3._id, P.id); q4();
  const closedMsgs = sent.slice(closed);
  ok(closedMsgs.length === 0, 'iPhone\'ga «yopildi» yuborilmaydi (Android uchun alohida)');
  await reg(Q.id, 'tokQ2', 'android');
  const q5 = quiet(); await cpush.notifyOfferClosed(asg3._id, P.id); q5();
  ok(sent.some((s) => s.m?.data?.type === 'courier_offer_closed' && s.t === 'tokQ2'.padEnd(40, '0')), 'qolganlarga (Android) «taklif yopildi» → signal to\'xtaydi');
  const sentBefore = sent.length; const q6 = quiet(); await cpush.dispatchOffers(t0 + 200_000); q6();
  ok(!sent.slice(sentBefore).some((s) => s.t === 'tokP'.padEnd(40, '0') && s.m?.data?.assignmentId === String(asg4._id)), 'band kuryerga (P) yangi taklif yuborilmaydi');
  await reg(Q.id, 'dead1', 'android'); await call(courierAppController.location, { ...(await as(Q.id)), body: { lat: NEAR.lat + 0.004, lng: NEAR.lng } });
  const q7 = quiet(); await cpush.dispatchOffers(t0 + 400_000); q7();
  ok(!(await CourierDevice.exists({ token: 'dead1'.padEnd(40, '0') })), 'yaroqsiz token (FCM UNREGISTERED) o\'chirildi');
  // qurilma boshqaruvi
  ok((await call(courierAppController.unregisterDevice, { courierId: R.id, body: { token: 'tokP'.padEnd(40, '0') } })).statusCode === 204 && await CourierDevice.exists({ token: 'tokP'.padEnd(40, '0') }), 'begona kuryerning tokenini o\'chirib bo\'lmaydi');
  await reg(Q.id, 'tokP', 'android');
  ok(String((await CourierDevice.findOne({ token: 'tokP'.padEnd(40, '0') })).courierId) === Q.id, 'telefon boshqa akkauntga kirsa token o\'shanga ko\'chadi');
  mpush._setTransportsForTest(null);
}

console.log('\n9) Unutilgan smena avtomatik yopiladi');
{
  const X = await mkCourier('stale'); await app.startShift(X.id);
  await call(courierAppController.location, { ...(await as(X.id)), body: NEAR });
  await CourierShift.updateOne({ accountId: X.id, endedAt: null }, { $set: { startedAt: new Date(Date.now() - 17 * 3600_000) } });
  const n = await app.closeStaleShifts();
  ok(n >= 1 && (await CourierShift.findOne({ accountId: X.id })).endReason === 'auto' && !(await CourierAccount.findById(X.id)).activeShiftId && (await presence.getLocation(X.id)) === null, '16 soatdan oshgan smena yopildi (auto), Redis tozalandi');
}

await mongoose.disconnect(); cache.getRedis()?.disconnect();
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ hammasi o\'tdi');
process.exit(fails ? 1 : 0);
