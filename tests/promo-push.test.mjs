/*
 * Mijoz ilovasiga taom takliflari push'i.
 *   [toza]  matnlar bazasi, kirill, tanlash: takrorlanmaslik (14/7 kun), aka-uka qurilmalar, hammaga har xil, vaqt oynalari
 *   [DB]    to'liq tsikl: ro'yxat → tick → FCM/APNs (soxta) → jurnal; kuniga 2 ta, ikkinchi tick dublikat bermaydi,
 *           yopiq restoran/spirtli ichimlik taklif qilinmaydi, o'lik token tozalanadi, iOS sandbox'ga tushish, ochildi belgisi
 * npm run test:promo-push   (DB: TEST_MONGO_URI, standart mongodb://127.0.0.1:27018/)
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { TEMPLATES, GROUPS, EXCLUDED_CATEGORIES } from '../src/lib/promoPushTemplates.js';
import { latinToCyrillic } from '../src/lib/translitUz.js';
import {
  pickPromo, renderTemplate, tashkentParts, isDue, activeSlot, targetMinute, dayShift, TITLE_MAX, BODY_MAX,
} from '../src/lib/promoPushPick.js';

const DAY = '2026-11-26';
const dish = (i, over = {}) => ({
  dishId: `d${i}`, name: `Taom ${i}`, price: 20000 + i * 1000, category: ['osh', 'burger', 'pitsa', 'sup', 'shashlik', 'shirinlik', 'milliy', 'salat'][i % 8],
  restaurantId: `r${i % 5}`, restaurantName: `Restoran ${i % 5}`, imageUrl: i % 2 ? 'https://x/img.jpg' : '', hit: i % 7 === 0, ...over,
});
const DISHES = Array.from({ length: 60 }, (_, i) => dish(i));

/* ───────────────────────── toza ───────────────────────── */
test('matnlar bazasi: noyob id, ikki til, o‘rinbosarlar, guruhlar to‘g‘ri, uzunlik sig‘adi', () => {
  assert.ok(TEMPLATES.length >= 80, `kamida 80 shablon (${TEMPLATES.length})`);
  assert.equal(new Set(TEMPLATES.map((t) => t.id)).size, TEMPLATES.length, 'id noyob');
  const groups = Object.keys(GROUPS);
  for (const t of TEMPLATES) {
    assert.ok(['lunch', 'dinner', 'any'].includes(t.slot), t.id);
    assert.ok(t.cats === null || t.cats.every((c) => groups.includes(c)), `${t.id} guruh`);
    for (const lang of ['uz', 'ru']) {
      const [title, body] = t[lang];
      assert.ok(title && body, `${t.id}.${lang}`);
      assert.ok(`${title}${body}`.includes('{dish}'), `${t.id}.${lang}: {dish} bor`);
      assert.doesNotMatch(`${title}${body}`, /\{(?!dish\}|rest\}|price\})/, `${t.id}.${lang}: noma'lum o'rinbosar`);
    }
    for (const lang of ['uz', 'uzc', 'ru']) {
      const m = renderTemplate(t, lang, { dish: 'Tovuqli pide', rest: 'Ziynat Restaurant', price: 40000 });
      assert.ok(m.title.length <= TITLE_MAX && m.body.length <= BODY_MAX, `${t.id}.${lang} uzunlik`);
      assert.doesNotMatch(m.title + m.body, /\{|\}/, `${t.id}.${lang} to'ldirilgan`);
    }
  }
  for (const slot of ['lunch', 'dinner']) {
    assert.ok(TEMPLATES.filter((t) => t.slot === slot || t.slot === 'any').length >= 40, `${slot}: kamida 40 shablon`);
  }
  assert.ok(EXCLUDED_CATEGORIES.includes('alkogol'));
});

test('kirill: o‘/g‘/sh/ch/yo/ye, so‘z boshidagi e, tutuq; brend va o‘rinbosar tegilmaydi', () => {
  assert.equal(latinToCyrillic('Go‘shtxo‘rlarga xabar'), 'Гўштхўрларга хабар');
  assert.equal(latinToCyrillic('Yo‘q, yengil! Ertaga ochmi?'), 'Йўқ, енгил! Эртага очми?');
  assert.equal(latinToCyrillic('Choy, Shirin, ma\'qul'), 'Чой, Ширин, маъқул');
  assert.equal(latinToCyrillic('Javobini Lokma beradi'), 'Жавобини Lokma беради');
  assert.equal(latinToCyrillic('{dish} tayyor'), '{dish} тайёр');
  const m = renderTemplate(TEMPLATES.find((t) => t.id === 'g01'), 'uzc', { dish: 'Plov', rest: 'Ziynat', price: 45000 });
  assert.match(m.body, /Plov.*«Ziynat».*45 000 сўм/, 'taom/restoran nomi o‘zgarmaydi, narx kirillda');
});

test('narx formati: uz — so‘m, ru — сум, oddiy bo‘shliq', () => {
  const t = TEMPLATES.find((x) => x.id === 'g01');
  assert.match(renderTemplate(t, 'uz', { dish: 'A', rest: 'B', price: 1250000 }).body, /1 250 000 so‘m/);
  assert.match(renderTemplate(t, 'ru', { dish: 'A', rest: 'B', price: 45000 }).body, /45 000 сум/);
});

test('tanlash: deterministik, qurilmalar orasida farqli, spirtli/narxsiz taom yo‘q', () => {
  const dev = { deviceId: 'dev-a', lang: 'uz' };
  const a1 = pickPromo({ device: dev, slot: 'lunch', day: DAY, dishes: DISHES });
  const a2 = pickPromo({ device: dev, slot: 'lunch', day: DAY, dishes: DISHES });
  assert.deepEqual(a1, a2, 'bir xil kirish — bir xil natija');
  const titles = new Set();
  for (let i = 0; i < 40; i++) titles.add(pickPromo({ device: { deviceId: `dev-${i}`, lang: 'uz' }, slot: 'lunch', day: DAY, dishes: DISHES }).title);
  assert.ok(titles.size >= 22, `40 mustaqil qurilma — kamida 22 xil sarlavha (${titles.size}); tick'da usage bilan to'liq teng taqsimlanadi`);
  const bad = [dish(1, { category: 'alkogol' }), dish(2, { price: 0 }), dish(3, { name: '  ' })];
  assert.equal(pickPromo({ device: dev, slot: 'lunch', day: DAY, dishes: bad }), null);
});

test('takrorlanmaslik: 14 kun shablon, 7 kun taom; kechagi xabar bugun kelmaydi', () => {
  const dev = { deviceId: 'dev-hist', lang: 'ru' };
  const history = [];
  for (let k = 13; k >= 1; k--) {
    const day = dayShift(DAY, -k);
    for (const slot of ['lunch', 'dinner']) {
      const p = pickPromo({ device: dev, slot, day, dishes: DISHES, history });
      assert.ok(p, `${day} ${slot}`);
      history.push({ day, templateId: p.templateId, dishId: p.dish.dishId, restaurantId: p.dish.restaurantId });
    }
  }
  const allTpl = history.map((h) => h.templateId);
  assert.equal(new Set(allTpl).size, allTpl.length, '13 kun × 2 — bitta shablon ham takrorlanmadi');
  const today = pickPromo({ device: dev, slot: 'lunch', day: DAY, dishes: DISHES, history });
  assert.ok(!allTpl.includes(today.templateId), 'bugungi shablon oxirgi 14 kunda bo‘lmagan');
  const lastWeekDishes = history.filter((h) => h.day > dayShift(DAY, -7)).map((h) => h.dishId);
  assert.ok(!lastWeekDishes.includes(today.dish.dishId), 'taom 7 kunda takrorlanmadi');
  // 15 kun oldingi shablon yana ishlatilishi mumkin (cheklov abadiy emas)
  const old = [{ day: dayShift(DAY, -15), templateId: today.templateId, dishId: 'x' }];
  assert.ok(pickPromo({ device: dev, slot: 'lunch', day: DAY, dishes: DISHES, history: old }));
});

test('bir mijozning ikki telefoni — bugun bir xil shablon ham, taom ham kelmaydi', () => {
  const user = 'u1';
  const p1 = pickPromo({ device: { deviceId: 'phone-1', userId: user, lang: 'uz' }, slot: 'dinner', day: DAY, dishes: DISHES });
  const p2 = pickPromo({
    device: { deviceId: 'phone-2', userId: user, lang: 'uz' }, slot: 'dinner', day: DAY, dishes: DISHES,
    siblings: [{ templateId: p1.templateId, dishId: p1.dish.dishId }],
  });
  assert.notEqual(p2.templateId, p1.templateId);
  assert.notEqual(p2.dish.dishId, p1.dish.dishId);
});

test('hammaga har xil: bir slotda shablonlar teng taqsimlanadi', () => {
  const usage = new Map();
  for (let i = 0; i < 400; i++) {
    const p = pickPromo({ device: { deviceId: `bulk-${i}`, lang: 'uz' }, slot: 'lunch', day: DAY, dishes: DISHES, usage });
    usage.set(p.templateId, (usage.get(p.templateId) || 0) + 1);
  }
  const counts = [...usage.values()];
  assert.ok(usage.size >= 40, `400 xabar — kamida 40 xil shablon (${usage.size})`);
  assert.ok(Math.max(...counts) - Math.min(...counts) <= 3, `taqsimot teng: max ${Math.max(...counts)}, min ${Math.min(...counts)}`);
});

test('vaqt: Toshkent sanasi, oyna, har qurilmaga o‘z daqiqasi', () => {
  assert.deepEqual(tashkentParts(new Date('2026-11-25T19:30:00Z')), { day: '2026-11-26', minutes: 30 }, 'UTC 19:30 = Toshkent 00:30 ertasi');
  const w = { lunch: { from: 690, to: 750 }, dinner: { from: 1080, to: 1170 } };
  assert.equal(activeSlot(700, w), 'lunch');
  assert.equal(activeSlot(800, w), null);
  assert.equal(activeSlot(1100, w), 'dinner');
  const mins = new Set(Array.from({ length: 50 }, (_, i) => targetMinute(`d${i}`, DAY, 'lunch', 690, 750)));
  assert.ok(mins.size >= 25, 'qurilmalar oyna bo‘ylab tarqalgan');
  for (const m of mins) assert.ok(m >= 690 && m < 750);
  const t = targetMinute('dx', DAY, 'lunch', 690, 750);
  assert.equal(isDue({ deviceId: 'dx', day: DAY, minutes: t - 1, slot: 'lunch', window: w.lunch }), false, 'daqiqasidan oldin — yo‘q');
  assert.equal(isDue({ deviceId: 'dx', day: DAY, minutes: t, slot: 'lunch', window: w.lunch }), true);
  assert.equal(isDue({ deviceId: 'dx', day: DAY, minutes: 750, slot: 'lunch', window: w.lunch }), false, 'oyna yopilgach kech xabar ketmaydi');
});

/* ───────────────────────── DB: to'liq tsikl ───────────────────────── */
const URI = process.env.TEST_MONGO_URI || 'mongodb://127.0.0.1:27018/';
let M; // modullar
const sent = [];

before(async () => {
  await mongoose.connect(URI, { dbName: 'test_promo_push' });
  await mongoose.connection.db.dropDatabase();
  M = {
    ...(await import('../src/services/promoPush.js')),
    ...(await import('../src/models/CustomerDevice.js')),
    ...(await import('../src/models/PromoPushLog.js')),
    ...(await import('../src/models/Restaurant.js')),
    ...(await import('../src/models/Dish.js')),
    ...(await import('../src/models/Settings.js')),
    mp: await import('../src/services/mobilePush.js'),
  };
  await M.PromoPushLog.syncIndexes();
  await M.CustomerDevice.syncIndexes();
  M.mp._setTransportsForTest({
    fcm: async (token, message) => { sent.push({ p: 'android', token, message }); return token === 'dead-token-aaaaaaaaaaaaaaaa' ? { ok: false, dead: true, error: 'FCM 404 UNREGISTERED' } : { ok: true }; },
    apns: async (token, payload, headers, env) => {
      sent.push({ p: 'ios', token, payload, headers, env });
      if (token.startsWith('sandbox') && env === 'production') return { ok: false, dead: true, error: 'APNs 400 BadDeviceToken' };
      return { ok: true };
    },
  });
});
after(async () => { M?.mp?._setTransportsForTest(null); await mongoose.connection.db.dropDatabase(); await mongoose.disconnect(); });

test('DB: kuniga 2 ta, dublikatsiz; yopiq restoran va spirtli taklif qilinmaydi; o‘lik token; iOS sandbox', async () => {
  const s = await M.getSettings();
  s.promoPush = { enabled: true, lunchFrom: '11:30', lunchTo: '12:30', dinnerFrom: '18:00', dinnerTo: '19:30' };
  await s.save();

  const base = { isApproved: true, isActive: true, timezone: 'Asia/Tashkent', workingDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] };
  const open = await M.Restaurant.collection.insertOne({ ...base, name: 'Ochiq Oshxona', openTime: '09:00', closeTime: '23:00' });
  const closed = await M.Restaurant.collection.insertOne({ ...base, name: 'Yopiq Kafe', openTime: '20:00', closeTime: '23:00' });
  const dishDocs = [];
  for (let i = 0; i < 12; i++) dishDocs.push({ restaurantId: open.insertedId, section: 'A', name: `Osh ${i}`, price: 30000 + i, category: 'osh', isAvailable: true, imageUrl: '' });
  dishDocs.push({ restaurantId: open.insertedId, section: 'A', name: 'Pivo', price: 15000, category: 'alkogol', isAvailable: true });
  dishDocs.push({ restaurantId: open.insertedId, section: 'A', name: 'Tugagan', price: 15000, category: 'osh', isAvailable: false });
  dishDocs.push({ restaurantId: closed.insertedId, section: 'A', name: 'Yopiqdagi taom', price: 15000, category: 'osh', isAvailable: true });
  await M.Dish.collection.insertMany(dishDocs);

  const uid = new mongoose.Types.ObjectId();
  const dev = (id, over) => ({ deviceId: id, platform: 'android', token: `tok-${id}-aaaaaaaaaaaaaaaaaaaa`, promoOptIn: true, osPermission: 'granted', lang: 'uz', ...over });
  await M.CustomerDevice.insertMany([
    dev('phone1', { userId: uid }),
    dev('phone2', { userId: uid, platform: 'ios', token: 'sandbox-tok-aaaaaaaaaaaaaaaaaaaa', lang: 'ru' }),
    dev('nooptin', { promoOptIn: false }),
    dev('denied', { osPermission: 'denied' }),
    dev('dead', { token: 'dead-token-aaaaaaaaaaaaaaaa' }),
  ]);

  // 12:29 Toshkent (07:29 UTC) — tushlik oynasining oxiri: hamma qurilmaning daqiqasi o'tgan
  const lunch = new Date('2026-11-26T07:29:00Z');
  const r1 = await M.promoPushTick(lunch);
  assert.equal(r1.slot, 'lunch');
  assert.equal(r1.sent, 2, `2 ta yuborildi (phone1, phone2) — ${JSON.stringify(r1)}`);
  assert.equal(r1.failed, 1, 'o‘lik token — xato');
  const r2 = await M.promoPushTick(lunch);
  assert.equal(r2.due ?? 0, 0, 'ikkinchi tick — hech kimga qayta ketmaydi');

  const logs = await M.PromoPushLog.find({ slot: 'lunch' }).lean();
  assert.equal(logs.length, 3);
  const names = new Set((await M.Dish.find({ _id: { $in: logs.map((l) => l.dishId) } }).lean()).map((d) => d.name));
  for (const bad of ['Pivo', 'Tugagan', 'Yopiqdagi taom']) assert.ok(!names.has(bad), `${bad} taklif qilinmadi`);
  const [p1, p2] = ['phone1', 'phone2'].map((id) => logs.find((l) => l.deviceId === id));
  assert.notEqual(p1.templateId, p2.templateId, 'bir mijozning ikki telefoni — har xil matn');
  assert.notEqual(String(p1.dishId), String(p2.dishId), '… va har xil taom');

  const deadDev = await M.CustomerDevice.findOne({ deviceId: 'dead' }).lean();
  assert.equal(deadDev.token, '', 'o‘lik token tozalandi');
  const ios = await M.CustomerDevice.findOne({ deviceId: 'phone2' }).lean();
  assert.equal(ios.environment, 'development', 'iOS: production rad etdi → sandbox ishladi va saqlandi');
  const iosSend = sent.find((x) => x.p === 'ios' && x.env === 'development');
  assert.equal(iosSend.headers['apns-topic'], 'uz.lokma.go', 'mijoz ilovasi bundle');
  assert.match(iosSend.payload.url, /^\/food\/[a-f0-9]{24}$/, 'bosilganda taom sahifasi');
  assert.match(iosSend.payload.aps.alert.title, /[а-яё]/i, 'ru tilidagi qurilmaga ruscha');
  const android = sent.find((x) => x.p === 'android' && x.token.startsWith('tok-phone1'));
  assert.equal(android.message.android.notification.channel_id, 'promo');
  assert.equal(typeof android.message.data.pp, 'string');

  // Kechki oyna — yana bittadan (kuniga jami 2)
  const dinner = new Date('2026-11-26T14:29:00Z');  // 19:29 Toshkent
  const r3 = await M.promoPushTick(dinner);
  assert.equal(r3.sent, 2);
  const perDevice = await M.PromoPushLog.aggregate([{ $match: { day: '2026-11-26', status: 'sent' } }, { $group: { _id: '$deviceId', n: { $sum: 1 } } }]);
  for (const d of perDevice) assert.equal(d.n, 2, `${d._id}: kuniga 2 ta`);
  const tplPhone1 = (await M.PromoPushLog.find({ deviceId: 'phone1' }).lean()).map((l) => l.templateId);
  assert.equal(new Set(tplPhone1).size, tplPhone1.length, 'tushlik va kechki — har xil matn');

  // Oyna tashqarisida — hech narsa
  const idle = await M.promoPushTick(new Date('2026-11-26T10:00:00Z')); // 15:00
  assert.ok(idle.idle);
  // O'chiq bo'lsa — hech narsa
  s.promoPush.enabled = false; await s.save();
  assert.ok((await M.promoPushTick(lunch)).off);
});

test('DB: ro‘yxatdan o‘tish, rozilik, ochildi belgisi (API)', async () => {
  const { promoPushController } = await import('../src/controllers/promoPush.js');
  const call = (fn, { body = {}, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = { body, headers, get: (n) => headers[n.toLowerCase()] };
    const res = { statusCode: 200, status(c) { this.statusCode = c; return this; }, json(j) { resolve({ status: this.statusCode, body: j }); } };
    fn(req, res, reject);
  });
  const H = { 'x-lokma-client': 'android', 'x-lokma-device': 'REAL-DEVICE-ID-12345', 'x-lokma-app-version': '1.0.2' };
  assert.equal((await call(promoPushController.register, { body: { token: 'abc' }, headers: H })).status, 400, 'qisqa token');
  assert.equal((await call(promoPushController.register, { body: { token: 'x'.repeat(40) }, headers: { 'x-lokma-client': 'web' } })).status, 400, 'saytdan emas');
  const ok = await call(promoPushController.register, { body: { token: 'fcm-token-'.padEnd(60, 'z'), lang: 'uzc', district: 'pop', optIn: true, permission: 'granted' }, headers: H });
  assert.equal(ok.status, 200);
  const d = await M.CustomerDevice.findOne({ token: 'fcm-token-'.padEnd(60, 'z') }).lean();
  assert.match(d.deviceId, /^[a-f0-9]{32}$/, 'xom ID emas — iz');
  assert.ok(d.promoOptIn && d.consentAt && d.lang === 'uzc' && d.district === 'pop' && d.appVersion === '1.0.2' && d.userId === null);

  // Qayta o'rnatish: shu token boshqa qurilmada — eskisidan olinadi
  const H2 = { ...H, 'x-lokma-device': 'OTHER-DEVICE-ID-999' };
  await call(promoPushController.register, { body: { token: 'fcm-token-'.padEnd(60, 'z'), optIn: true, permission: 'granted' }, headers: H2 });
  assert.equal((await M.CustomerDevice.findById(d._id).lean()).token, '', 'token yagona qurilmada');

  // O'chirish (profil tugmasi)
  await call(promoPushController.prefs, { body: { optIn: false }, headers: H2 });
  assert.equal((await M.CustomerDevice.findOne({ token: 'fcm-token-'.padEnd(60, 'z') }).lean()).promoOptIn, false);

  // Ochildi — faqat o'z qurilmasining jurnali
  const log = await M.PromoPushLog.create({ deviceId: d.deviceId, day: DAY, slot: 'test', title: 'x', body: 'y', status: 'sent' });
  await call(promoPushController.opened, { body: { pp: String(log._id) }, headers: H2 });
  assert.equal((await M.PromoPushLog.findById(log._id).lean()).openedAt, null, 'boshqa qurilma belgilay olmaydi');
  await call(promoPushController.opened, { body: { pp: String(log._id) }, headers: H });
  assert.ok((await M.PromoPushLog.findById(log._id).lean()).openedAt, 'o‘z qurilmasi — belgilandi');
});

test('DB: admin sozlamasi tekshiruvi, namuna, statistika', async () => {
  assert.match(M.validatePromoSettings({ lunchFrom: '05:00', lunchTo: '06:00', dinnerFrom: '18:00', dinnerTo: '19:00' }), /08:00/);
  assert.match(M.validatePromoSettings({ lunchFrom: '12:00', lunchTo: '12:05', dinnerFrom: '18:00', dinnerTo: '19:00' }), /15 daqiqa/);
  assert.match(M.validatePromoSettings({ lunchFrom: '12:00', lunchTo: '19:00', dinnerFrom: '18:00', dinnerTo: '19:30' }), /oldin/);
  assert.equal(M.validatePromoSettings({ lunchFrom: '11:30', lunchTo: '12:30', dinnerFrom: '18:00', dinnerTo: '19:30' }), null);
  const pv = await M.previewMessages({ lang: 'uz', count: 6, now: new Date('2026-11-26T07:00:00Z') });
  assert.equal(pv.items.length, 6);
  assert.equal(new Set(pv.items.map((x) => x.title)).size, 6, 'namunalar har xil');
  const st = await M.promoStats(new Date('2026-11-26T15:00:00Z'));
  assert.equal(st.today.lunch.sent, 2);
  assert.equal(st.today.dinner.sent, 2);
  assert.ok(st.devices >= 5);
  assert.equal(M.pushImage('https://res.cloudinary.com/x/image/upload/v1/a.png'), 'https://res.cloudinary.com/x/image/upload/c_fill,w_720,h_360,q_auto,f_jpg/v1/a.png');
  assert.equal(M.pushImage('http://insecure/a.png'), '', 'faqat https');
});
