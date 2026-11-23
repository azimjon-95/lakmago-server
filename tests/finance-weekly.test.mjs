/*
 * Haftalik hisob-kitob ko'rinishi (services/weeklySettlement.js) — sof mantiq + haqiqiy MongoDB.
 *   npm run test:finance-weekly        (MONGO_URI, standart mongodb://127.0.0.1:27017)
 *
 * Isbotlanadi:
 *   • TZ misoli: 250 000 majburiyat → 150 000 → 100 000 qoldiq (60%) → … → 0
 *   • restoran qarzi keyingi karta tushumidan ENG ESKI haftadan (FIFO) yopiladi
 *   • LokmaGo qarzi o'z haftasida turadi, yangi naqd qarz uni "yemaydi"
 *   • haftaga biriktirilgan to'lov avval shu haftani yopadi, qolgani FIFO
 *   • Toshkent vaqti chegarasi (yakshanba 23:59 / dushanba 00:00)
 *   • INVARIANT: barcha haftalar qoldig'i yig'indisi = jurnal bo'yicha balans (tasodifiy 300 ketma-ketlik)
 *   • API: /admin/billing/weeks javobi, payout weekStart jurnal va Payout'ga yoziladi, noto'g'ri hafta — 400
 *   • mavjud hisobot (overview, restaurants) javobi o'zgarmaydi
 */
process.env.JWT_SECRET ||= 'x'.repeat(40);
process.env.NODE_ENV = 'development';

const {
  buildRestaurantWeeks, buildWeekIndex, weekStartOf, isWeekStart, classifyEntry,
} = await import('../src/services/weeklySettlement.js');

let fails = 0; let passes = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (c) passes++; else fails++; };
const eq = (a, b, m) => ok(a === b, `${m} (kutildi ${b}, chiqdi ${a})`);

// Toshkent vaqti: "2026-11-17 10:00" → UTC Date
const T = (ymd, hhmm = '12:00') => new Date(`${ymd}T${hhmm}:00+05:00`);
let seq = 0;
const L = (type, amount, at, extra = {}) => ({ _id: `l${String(++seq).padStart(5, '0')}`, type, amount, createdAt: at, ...extra });
const card = (amount, at) => L('restaurant_due', amount, at, { isCash: false });
const cash = (amount, at) => L('restaurant_due', -amount, at, { isCash: true, meta: { note: 'Naqd to‘lov — komissiya qarzi' } });
const payout = (amount, at, weekStart) => L('payout', -amount, at, { meta: { note: 'Bank', ...(weekStart ? { weekStart } : {}) } });
const NOW = T('2026-11-25', '15:00');   // chorshanba, joriy hafta 2026-11-23
const wk = (res, ws) => res.weeks.find((w) => w.weekStart === ws);
const sumRemaining = (res) => Math.round(res.weeks.reduce((a, w) => a + w.remaining * 100, 0)) / 100;

console.log('\n[1] Hafta chegarasi (Toshkent)');
{
  eq(weekStartOf(T('2026-11-22', '23:59')), '2026-11-16', 'yakshanba 23:59 — oldingi hafta');
  eq(weekStartOf(T('2026-11-23', '00:00')), '2026-11-23', 'dushanba 00:00 — yangi hafta');
  eq(weekStartOf(new Date('2026-11-22T19:30:00Z')), '2026-11-23', 'UTC 19:30 yakshanba = Toshkent dushanba 00:30');
  eq(weekStartOf(T('2026-11-01')), '2026-10-26', 'oy chegarasidan o‘tadigan hafta');
  ok(isWeekStart('2026-11-23') && !isWeekStart('2026-11-24') && !isWeekStart('2026-02-30') && !isWeekStart('x'), 'isWeekStart: faqat to‘g‘ri dushanba');
}

console.log('\n[2] TZ misoli: aktiv haftada qisman to‘lovlar');
{
  const base = [card(250000, T('2026-11-23', '10:00'))];
  let r = buildRestaurantWeeks(base, { now: NOW });
  let w = wk(r, '2026-11-23');
  ok(w.current && w.obligation === 250000 && w.paid === 0 && w.payable === 250000 && w.status === 'open', 'majburiyat 250 000, to‘lanmagan');

  r = buildRestaurantWeeks([...base, payout(150000, T('2026-11-24'), '2026-11-23')], { now: NOW });
  w = wk(r, '2026-11-23');
  ok(w.obligation === 250000 && w.paid === 150000 && w.payable === 100000 && w.paidPercent === 60 && w.status === 'partial', '150 000 → qoldiq 100 000, 60%');

  r = buildRestaurantWeeks([...base, payout(150000, T('2026-11-24'), '2026-11-23'), payout(50000, T('2026-11-25'), '2026-11-23')], { now: NOW });
  w = wk(r, '2026-11-23');
  ok(w.paid === 200000 && w.payable === 50000, 'yana 50 000 → qoldiq 50 000');

  r = buildRestaurantWeeks([...base, payout(150000, T('2026-11-24')), payout(50000, T('2026-11-25')), payout(50000, T('2026-11-25', '13:00'))], { now: NOW });
  w = wk(r, '2026-11-23');
  ok(w.paid === 250000 && w.payable === 0 && w.status === 'settled' && w.payments.length === 3, 'yana 50 000 → qoldiq 0, yopildi, 3 ta to‘lov tarixi');
  eq(r.ledgerBalance, 0, 'jurnal balansi 0');
}

console.log('\n[3] Restoran qarzi keyingi karta tushumidan FIFO bilan yopiladi');
{
  const rows = [
    cash(100000, T('2026-11-03')),            // 1-hafta qarzi
    cash(50000, T('2026-11-10')),             // 2-hafta qarzi
    card(500000, T('2026-11-17')),            // 3-hafta karta tushumi
  ];
  const r = buildRestaurantWeeks(rows, { now: NOW });
  const w1 = wk(r, '2026-11-02'); const w2 = wk(r, '2026-11-09'); const w3 = wk(r, '2026-11-16');
  ok(w1.debt === 100000 && w1.receivable === 0 && w1.status === 'settled' && w1.debtClosings[0].fromWeek === '2026-11-16', '1-hafta qarzi 100 000 yopildi (3-hafta tushumidan)');
  ok(w2.debt === 50000 && w2.receivable === 0, '2-hafta qarzi 50 000 yopildi');
  ok(w3.cardShare === 500000 && w3.payable === 350000 && w3.coveredOldDebts.length === 2, '3-hafta: 500 000 dan 150 000 eski qarzga, 350 000 restoranga');
  eq(r.ledgerBalance, 350000, 'jurnal balansi 350 000');
}

console.log('\n[4] Qisman yopilish: tushum yetmasa qarz qisman ochiq qoladi');
{
  const r = buildRestaurantWeeks([cash(100000, T('2026-11-03')), card(30000, T('2026-11-10'))], { now: NOW });
  const w1 = wk(r, '2026-11-02');
  ok(w1.receivable === 70000 && w1.debtClosed === 30000 && w1.debtClosedPercent === 30 && w1.status === 'debt_closing', '100 000 dan 30 000 yopildi (30%), 70 000 qoldi');
  ok(wk(r, '2026-11-09').payable === 0, 'karta tushumi to‘liq eski qarzga ketdi');
  eq(r.ledgerBalance, -70000, 'jurnal balansi −70 000');
}

console.log('\n[5] LokmaGo qarzi o‘z haftasida turadi');
{
  const r = buildRestaurantWeeks([card(120000, T('2026-11-03')), cash(7000, T('2026-11-10'))], { now: NOW });
  ok(wk(r, '2026-11-02').payable === 120000 && wk(r, '2026-11-02').status === 'open', '1-hafta LokmaGo qarzi 120 000 — tegilmagan');
  ok(wk(r, '2026-11-09').receivable === 7000, '2-hafta restoran qarzi 7 000 — alohida');
  ok(r.openPayable === 120000 && r.openReceivable === 7000 && r.ledgerBalance === 113000, 'ochiq: 120 000 / 7 000, sof balans 113 000');
}

console.log('\n[6] Bir hafta ichida naqd qarz shu haftaning ulushi bilan qoplanadi');
{
  const r = buildRestaurantWeeks([card(1000, T('2026-11-17', '10:00')), cash(300, T('2026-11-18'))], { now: NOW });
  const w = wk(r, '2026-11-16');
  ok(w.payable === 700 && w.receivable === 0 && w.obligation === 700 && w.cardShare === 1000 && w.cashDebt === 300, 'sof 700 (1 000 − 300)');
}

console.log('\n[7] Haftaga biriktirilgan to‘lov');
{
  const rows = [card(100, T('2026-11-03')), card(200, T('2026-11-10'))];
  let r = buildRestaurantWeeks([...rows, payout(200, T('2026-11-20'), '2026-11-09')], { now: NOW });
  ok(wk(r, '2026-11-09').payable === 0 && wk(r, '2026-11-09').payments[0].targeted, 'tanlangan hafta (2-hafta) yopildi');
  ok(wk(r, '2026-11-02').payable === 100, 'eski hafta (1-hafta) ochiq qoldi');
  r = buildRestaurantWeeks([...rows, payout(150, T('2026-11-20'))], { now: NOW });
  ok(wk(r, '2026-11-02').payable === 0 && wk(r, '2026-11-09').payable === 150, 'hafta tanlanmasa — FIFO (avval 1-hafta)');
  r = buildRestaurantWeeks([...rows, payout(250, T('2026-11-20'), '2026-11-09')], { now: NOW });
  ok(wk(r, '2026-11-09').payable === 0 && wk(r, '2026-11-02').payable === 50, 'tanlangan hafta yopilib, qolgani eng eski haftaga');
}

console.log('\n[8] Promo qarzi (payout’dan ushlangan) va ortiqcha to‘lov');
{
  const promo = L('adjustment', 3000, T('2026-11-20'), { meta: { note: 'Mijozlarni jalb qilish qarzi — delivery tushumidan' } });
  const manual = L('adjustment', 999999, T('2026-11-20'), { meta: { note: 'qo‘lda tuzatish' } });
  ok(classifyEntry(manual) === null, 'qo‘lda adjustment balansga tegmaydi — hisobga olinmaydi');
  let r = buildRestaurantWeeks([card(10000, T('2026-11-17')), promo, payout(7000, T('2026-11-20'))], { now: NOW });
  ok(wk(r, '2026-11-16').payable === 0 && wk(r, '2026-11-16').payments.some((p) => p.kind === 'promo'), 'promo 3 000 + payout 7 000 haftani yopdi');
  eq(r.ledgerBalance, 0, 'balans 0');
  r = buildRestaurantWeeks([card(5000, T('2026-11-10')), payout(8000, T('2026-11-17')), card(10000, T('2026-11-24'))], { now: NOW });
  ok(wk(r, '2026-11-16').overpaid === 3000 && wk(r, '2026-11-16').receivable === 0 && wk(r, '2026-11-23').payable === 7000, 'ortiqcha 3 000 keyingi tushumdan yopildi');
}

console.log('\n[9] Kasr summalar (Click 943,5) tiyinda aniq');
{
  const r = buildRestaurantWeeks([card(943.5, T('2026-11-17')), card(2095.5, T('2026-11-18')), payout(1000.25, T('2026-11-19'))], { now: NOW });
  eq(wk(r, '2026-11-16').payable, 2038.75, '943,5 + 2 095,5 − 1 000,25 = 2 038,75');
}

console.log('\n[10] Qaytarish (restaurant_due teskari) turi');
{
  const ref = L('restaurant_due', -40000, T('2026-11-18'), { meta: { note: 'Qaytarish sababli bekor qilindi' } });
  ok(classifyEntry(ref).kind === 'refund', 'qaytarish — refund');
  const r = buildRestaurantWeeks([card(40000, T('2026-11-17')), ref], { now: NOW });
  ok(wk(r, '2026-11-16').payable === 0 && wk(r, '2026-11-16').refunds === -40000, 'karta ulushi qaytarish bilan bekor');
}

console.log('\n[11] INVARIANT: haftalar qoldig‘i yig‘indisi = jurnal balansi (300 tasodifiy ketma-ketlik)');
{
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  let bad = 0;
  for (let i = 0; i < 300; i++) {
    const rows = [];
    let bal = 0;
    const start = T('2026-08-03').getTime();
    for (let j = 0; j < 40; j++) {
      const at = new Date(start + Math.floor(rnd() * 110 * 86400000));
      const x = rnd();
      const amt = Math.round(rnd() * 20000000) / 100;
      if (x < 0.45) { rows.push(card(amt, at)); } else if (x < 0.75) { rows.push(cash(amt / 10, at)); } else if (x < 0.95) {
        rows.push(payout(amt / 2, at, rnd() < 0.3 ? weekStartOf(at) : undefined));
      } else rows.push(L('adjustment', amt / 20, at, { meta: { note: 'x — delivery tushumidan' } }));
    }
    const r = buildRestaurantWeeks(rows, { now: NOW });
    for (const l of rows) {
      const ev = classifyEntry(l);
      if (ev) bal += ev.sign === 'accrual' ? ev.tiyin : -ev.tiyin;
    }
    const neg = r.weeks.some((w) => w.payable < 0 || w.receivable < 0 || (w.payable > 0 && w.receivable > 0));
    if (sumRemaining(r) !== bal / 100 || r.ledgerBalance !== bal / 100 || neg) bad++;
  }
  ok(bad === 0, `300/300 ketma-ketlikda yig‘indi = balans, manfiy qoldiq yo‘q, bir haftada ikki tomon birga ochiq emas (xato: ${bad})`);
}

console.log('\n[12] Hafta ro‘yxati (navigatsiya)');
{
  const a = buildRestaurantWeeks([card(100, T('2026-11-03'))], { now: NOW });
  const idx = buildWeekIndex([a], { now: NOW });
  ok(idx[0].weekStart === '2026-11-23' && idx[0].current, 'birinchi — joriy hafta');
  ok(idx.map((w) => w.weekStart).join() === '2026-11-23,2026-11-16,2026-11-09,2026-11-02', 'bo‘sh haftalar ham tushib qolmaydi, ketma-ket');
  ok(idx[3].payable === 100 && idx[3].openRestaurants === 1, 'eski hafta: ochiq 100, 1 restoran');
}

/* ═══ HAQIQIY MONGODB: API va payout ═══ */
const RAW = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const mongoose = (await import('mongoose')).default;
// Har ishga tushishda alohida test bazasi (finance-concurrency.test.mjs bilan bir xil yondashuv)
await mongoose.connect(RAW, { dbName: `lokma_weekly_${Date.now()}` });

const { Ledger } = await import('../src/models/Ledger.js');
const { Payout } = await import('../src/models/Payout.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { billingController } = await import('../src/controllers/billing.js');
await Promise.all([Ledger.init(), Payout.init()]);

const call = (handler, req) => new Promise((resolve, reject) => {
  const res = {
    statusCode: 200,
    status(c) { this.statusCode = c; return this; },
    json(body) { resolve({ status: this.statusCode, body }); return this; },
  };
  handler({ query: {}, body: {}, params: {}, ...req }, res, reject);
});

console.log('\n[13] API: /admin/billing/weeks');
try {
  const rest = await Restaurant.create({ name: 'HAFTA-R', cuisine: 'milliy', category: 'restoran', balance: 113000 });
  const other = await Restaurant.create({ name: 'BOSHQA-R', cuisine: 'milliy', category: 'restoran', balance: 5 });
  const now = Date.now();
  const ago = (days) => new Date(now - days * 86400000);
  await Ledger.insertMany([
    { type: 'restaurant_due', amount: 120000, restaurantId: rest._id, createdAt: ago(15) },
    { type: 'restaurant_due', amount: -7000, isCash: true, restaurantId: rest._id, createdAt: ago(1) },
    { type: 'commission', amount: 6000, restaurantId: rest._id, createdAt: ago(15) },
    { type: 'payment_in', amount: 126000, restaurantId: rest._id, createdAt: ago(15) },
    { type: 'restaurant_due', amount: 5, restaurantId: other._id, createdAt: ago(2) },
  ]);

  const before = {
    overview: (await call(billingController.overview, {})).body,
    restaurants: (await call(billingController.byRestaurant, {})).body,
  };

  const { status, body } = await call(billingController.weeks, {});
  ok(status === 200 && body.timezone === 'Asia/Tashkent' && body.weekStartsOn === 'monday', '200, Toshkent, dushanba');
  ok(body.weeks[0].current && body.weeks[0].weekStart === weekStartOf(new Date()), 'birinchi hafta — joriy');
  const hr = body.restaurants.find((x) => x.name === 'HAFTA-R');
  ok(hr.ledgerBalance === 113000 && hr.storedBalance === 113000 && hr.driftAmount === 0, 'jurnal balansi = Restaurant.balance (farq 0)');
  ok(hr.openPayable === 120000 && hr.openReceivable === 7000, 'ochiq: LokmaGo 120 000, restoran 7 000');
  ok(hr.weeks.every((w) => !('commission' in w)), 'komissiya/payment_in balansga ta‘sir qilmaydi — hisobga olinmagan');

  await Restaurant.updateOne({ _id: other._id }, { $set: { balance: 105 } });
  const drift = (await call(billingController.weeks, { query: { restaurantId: String(other._id) } })).body;
  ok(drift.restaurants.length === 1 && drift.restaurants[0].driftAmount === 100, 'farq yashirilmaydi: balans 105, jurnal 5 → drift 100');
  ok((await call(billingController.weeks, { query: { restaurantId: 'xx' } })).status === 400, 'noto‘g‘ri restoran ID — 400');

  console.log('\n[14] Payout: weekStart jurnal va Payout’ga yoziladi');
  const oldWeek = weekStartOf(ago(15));
  const p = await call(billingController.payout, {
    userId: new mongoose.Types.ObjectId(),
    body: { restaurantId: String(rest._id), amount: 50000, idempotencyKey: 'weekly-test-0001', weekStart: oldWeek },
  });
  ok(p.status === 200 && p.body.paidOut === 50000, `payout qayd etildi (${JSON.stringify(p.body)})`);
  const pl = await Ledger.findOne({ restaurantId: rest._id, type: 'payout' }).lean();
  ok(pl?.meta?.weekStart === oldWeek, 'Ledger payout meta.weekStart saqlandi');
  ok((await Payout.findOne({ idempotencyKey: 'weekly-test-0001' }).lean())?.snapshot?.weekStart === oldWeek, 'Payout.snapshot.weekStart saqlandi');
  ok((await Restaurant.findById(rest._id).lean()).balance === 63000, 'balans avvalgidek kamaydi (113 000 − 50 000)');
  const after = (await call(billingController.weeks, { query: { restaurantId: String(rest._id) } })).body.restaurants[0];
  const ow = after.weeks.find((w) => w.weekStart === oldWeek);
  ok(ow.paid === 50000 && ow.payable === 70000 && ow.paidPercent === 42 && ow.payments[0].targeted, 'eski hafta: to‘langan 50 000, qoldiq 70 000');

  const bad = async (weekStart, key) => (await call(billingController.payout, {
    userId: null, body: { restaurantId: String(rest._id), amount: 10, idempotencyKey: key, weekStart },
  })).status;
  ok(await bad('2026-11-24', 'weekly-bad-0001') === 400, 'dushanba emas — 400');
  ok(await bad('2099-01-05', 'weekly-bad-0002') === 400, 'kelajak haftasi — 400');
  ok(await Payout.countDocuments({ idempotencyKey: /weekly-bad/ }) === 0, 'rad etilganda Payout yaratilmadi');

  const p2 = await call(billingController.payout, {
    userId: null, body: { restaurantId: String(rest._id), amount: 1000, idempotencyKey: 'weekly-test-0002' },
  });
  ok(p2.status === 200 && !(await Ledger.findOne({ restaurantId: rest._id, type: 'payout', 'meta.weekStart': { $exists: false } }).lean())?.meta?.weekStart, 'hafta berilmasa — avvalgi xulq (meta.weekStart yo‘q)');

  console.log('\n[15] Mavjud hisobot o‘zgarmagan (payout’dan oldingi javoblar bilan solishtirish)');
  // Payout'dan oldin olingan javoblarni payout'siz qayta hisoblab bo'lmaydi — shuning uchun mavjud
  // hisobotning MAYDONLAR TO'PLAMI va payout'ga bog'liq bo'lmagan raqamlari tekshiriladi.
  const ov = (await call(billingController.overview, {})).body;
  ok(JSON.stringify(Object.keys(ov).sort()) === JSON.stringify(Object.keys(before.overview).sort()), 'overview maydonlari o‘zgarmagan');
  ok(ov.tushum === before.overview.tushum && ov.komissiya === before.overview.komissiya, 'overview tushum/komissiya o‘zgarmagan');
  const rs = (await call(billingController.byRestaurant, {})).body;
  ok(JSON.stringify(Object.keys(rs[0]).sort()) === JSON.stringify(Object.keys(before.restaurants[0]).sort()), 'restaurants javobi maydonlari o‘zgarmagan');
} catch (e) {
  ok(false, `DB qismi yiqildi: ${e.stack || e.message}`);
} finally {
  await mongoose.connection.db.dropDatabase().catch(() => {});
  await mongoose.disconnect();
}

console.log(`\n${fails === 0 ? '✓ HAMMASI O‘TDI' : `✗ ${fails} TA XATO`} (${passes} tekshiruv)`);
process.exit(fails === 0 ? 0 : 1);
