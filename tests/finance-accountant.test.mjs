/*
 * ═══════════════════════════════════════════════════════════
 * MOLIYA — BUXGALTER HUQUQLARI, DAVR FILTRI, BUYURTMALAR RO'YXATI,
 * TO'LOV REKVIZITI
 * ═══════════════════════════════════════════════════════════
 *
 * HAQIQIY server (src/index.js) ishga tushiriladi va HTTP orqali
 * tekshiriladi — ruxsatlar (route'lardagi AS/A qo'riqchilari)
 * faqat shunday to'g'ri sinaladi.
 *
 * npm run test:finance
 */
import { spawn } from 'node:child_process';

const PORT = 4187;
const MONGO_URI = 'mongodb://127.0.0.1:27017/lokma_finance_accountant';
const JWT_SECRET = 'finance-test-secret-finance-test-secret-xx';
process.env.MONGO_URI = MONGO_URI;
process.env.JWT_SECRET = JWT_SECRET;

const mongoose = (await import('mongoose')).default;
const jwt = (await import('jsonwebtoken')).default;
await mongoose.connect(MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { Restaurant } = await import('../src/models/Restaurant.js');
const { User } = await import('../src/models/User.js');
const { Order } = await import('../src/models/Order.js');
const { Ledger } = await import('../src/models/Ledger.js');
const { CommissionAgreement } = await import('../src/models/CommissionAgreement.js');
const { RestaurantPayoutAudit } = await import('../src/models/RestaurantPayoutAudit.js');
const { RestaurantPayoutSecret } = await import('../src/models/RestaurantPayoutSecret.js');
const { zoneDate, addDaysYmd, zonedToUtc } = await import('../src/services/restaurantTime.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };

/* ═══ Toshkent kunlari ═══ */
const TODAY = zoneDate('Asia/Tashkent', new Date()).ymd;
const YESTERDAY = addDaysYmd(TODAY, -1);
const LONG_AGO = addDaysYmd(TODAY, -40);
const at = (ymd, hhmm) => zonedToUtc(ymd, hhmm);

/* ═══ Ma'lumot ═══ */
const R1 = await Restaurant.create({ name: 'TUTTI FOOD', cuisine: 'x', category: 'restoran', isActive: true });
const R2 = await Restaurant.create({ name: 'Boshqa restoran', cuisine: 'x', category: 'restoran', isActive: true });
await CommissionAgreement.create({
  restaurantId: R1._id, restaurantCommissionPercent: 6, customerFeePercent: 0, totalSplitPercent: 6,
  status: 'ACTIVE', effectiveFrom: new Date(),
});

const accountantUser = await User.create({ firstName: 'Bahrom', lastName: 'Buxgalter', login: 'buxgalter', role: 'admin' });
const customer = await User.create({ firstName: 'Mijoz', lastName: 'Ismli', phone: '+998901112233', telegramId: '9001' });

const tok = (payload) => jwt.sign(payload, JWT_SECRET);
const T = {
  admin: tok({ userId: String(new mongoose.Types.ObjectId()), role: 'admin' }),
  accountant: tok({ userId: String(accountantUser._id), role: 'staff', department: 'accountant' }),
  marketing: tok({ userId: String(new mongoose.Types.ObjectId()), role: 'staff', department: 'marketing' }),
  restaurant: tok({ userId: String(new mongoose.Types.ObjectId()), role: 'restaurant', restaurantId: String(R1._id) }),
};

const baseOrder = (over) => ({
  _id: new mongoose.Types.ObjectId(),
  userId: customer._id, restaurantId: R1._id, restaurantName: 'TUTTI FOOD',
  items: [{ name: 'Osh', quantity: 2, unitPrice: 30000 }, { name: 'Salat', quantity: 1, unitPrice: 15000 }],
  subtotal: 75000, deliveryFee: 15000, serviceFee: 0, total: 90000,
  status: 'delivered', fulfillment: 'delivery', paymentMethod: 'cash', isPaid: true,
  phone: '+998901112233', address: 'Manzil',
  createdAt: at(YESTERDAY, '11:00'), updatedAt: at(YESTERDAY, '12:30'), deliveredAt: at(YESTERDAY, '12:30'),
  ...over,
});
const finance = (food, deliv, custFee, restPct) => {
  const t = (x) => Math.round(x * 100);
  const restCommission = Math.round(food * restPct) / 100;
  return {
    model: 'v2', unit: 'tiyin',
    foodSubtotal: t(food), deliveryFee: t(deliv), customerFeeAmount: t(custFee),
    restaurantCommissionAmount: t(restCommission),
    totalCharged: t(food + deliv + custFee),
    restaurantPayout: t(food - restCommission + deliv),
    lokmaGrossCommission: t(restCommission + custFee),
    clickFeeAmount: t((food + deliv + custFee) * 0.015),
  };
};

const ORD = {
  cashYesterday: baseOrder({}),
  cardYesterday: baseOrder({
    paymentMethod: 'click', subtotal: 100000, deliveryFee: 20000, total: 120000,
    items: [{ name: 'Pitsa', quantity: 1, unitPrice: 100000, selectedOptions: [{ name: '40 sm' }, { name: 'Pishloq' }] }],
    finance: finance(100000, 20000, 0, 6),
  }),
  pickupCashToday: baseOrder({
    fulfillment: 'pickup', deliveryFee: 0, subtotal: 50000, total: 50000,
    items: [{ name: 'Tort', quantity: 1, unitPrice: 50000 }],
    createdAt: at(TODAY, '00:10'), updatedAt: at(TODAY, '00:20'), deliveredAt: at(TODAY, '00:20'),
  }),
  // ESKI buyurtma: deliveredAt yo'q (faqat updatedAt bor)
  legacyLongAgo: baseOrder({
    createdAt: at(LONG_AGO, '10:00'), updatedAt: at(LONG_AGO, '11:00'), deliveredAt: undefined,
  }),
  // Baho keyinroq qoldirilgan: deliveredAt ESKI, updatedAt BUGUN
  ratedLater: baseOrder({
    createdAt: at(LONG_AGO, '09:00'), deliveredAt: at(LONG_AGO, '09:40'), updatedAt: new Date(),
  }),
  cancelled: baseOrder({ status: 'cancelled', deliveredAt: undefined }),
  otherRestaurant: baseOrder({ restaurantId: R2._id, restaurantName: 'Boshqa restoran' }),
};
const docs = Object.values(ORD).map((o) => { const c = { ...o }; if (c.deliveredAt === undefined) delete c.deliveredAt; return c; });
await Order.collection.insertMany(docs);

await Ledger.collection.insertMany([
  { type: 'payment_in', amount: 120000, restaurantId: R1._id, createdAt: at(YESTERDAY, '12:00'), updatedAt: at(YESTERDAY, '12:00') },
  { type: 'commission', amount: 7200, restaurantId: R1._id, createdAt: at(YESTERDAY, '12:31'), updatedAt: at(YESTERDAY, '12:31') },
  { type: 'payout', amount: -100000, restaurantId: R1._id, createdBy: accountantUser._id, meta: { note: 'Kartaga o‘tkazildi' }, createdAt: at(YESTERDAY, '17:00'), updatedAt: at(YESTERDAY, '17:00') },
  { type: 'payout', amount: -30000, restaurantId: R1._id, createdBy: accountantUser._id, createdAt: at(TODAY, '00:30'), updatedAt: at(TODAY, '00:30') },
  { type: 'payout', amount: -777000, restaurantId: R1._id, createdAt: at(LONG_AGO, '10:00'), updatedAt: at(LONG_AGO, '10:00') },
]);

/* ═══ Haqiqiy server ═══ */
const server = spawn('node', ['src/index.js'], {
  env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', MONGO_URI, JWT_SECRET, RESTAURANT_BOT_TOKEN: '', TELEGRAM_BOT_TOKEN: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });
const stop = () => { try { server.kill('SIGKILL'); } catch { /* yo'q */ } };
process.on('exit', stop);

const BASE = `http://127.0.0.1:${PORT}/api`;
for (let i = 0; i < 60; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/health`); if (r.ok) break; } catch { /* hali ishga tushmagan */ }
  await new Promise((r) => setTimeout(r, 300));
}

async function call(token, method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let json = null;
  try { json = await res.json(); } catch { /* bo'sh */ }
  return { status: res.status, json };
}
const rid = String(R1._id);

console.log('\n[1] RUXSATLAR: buxgalter (accountant) Moliya sahifasi ishlatadigan HAMMA narsaga kira oladi');
{
  const paths = [
    ['GET', '/admin/agreements'],
    ['GET', `/admin/agreements/${rid}/history`],
    ['GET', '/admin/billing/overview'],
    ['GET', '/admin/billing/restaurants'],
    ['GET', `/admin/billing/restaurant/${rid}/orders?method=cash`],
    ['GET', '/admin/billing/ledger'],
    ['GET', `/admin/restaurants/${rid}/payout`],
    ['GET', `/admin/restaurants/${rid}/payout/reveal`],
    ['GET', '/admin/expenses'],
  ];
  for (const [m, p] of paths) {
    const r = await call(T.accountant, m, p);
    ok(r.status === 200, `${m} ${p.split('?')[0].replace(rid, ':id')} → ${r.status}`);
  }
  const rev = await call(T.accountant, 'GET', '/admin/revenue');
  ok(rev.status !== 403 && rev.status !== 401, `GET /admin/revenue (Daromad) → ${rev.status} (403 EMAS — ruxsat o'tdi)`);
  const put = await call(T.accountant, 'PUT', `/admin/agreements/${rid}`, { restaurantCommissionPercent: 7, customerFeePercent: 1 });
  ok(put.status === 201, `PUT kelishuv (buxgalter foizni belgilaydi) → ${put.status}`);
  const agr = await CommissionAgreement.findOne({ restaurantId: R1._id, status: 'ACTIVE' }).lean();
  ok(String(agr.createdBy) === String(accountantUser._id), 'kelishuvni KIM o‘zgartirgani yozildi (createdBy)');
  ok(await CommissionAgreement.countDocuments({ restaurantId: R1._id, status: 'ARCHIVED' }) === 1, 'eski kelishuv arxivlandi (tarix saqlandi)');
}

console.log('\n[2] RUXSATLAR: boshqa bo‘lim (marketing) va restoran moliyaga KIRA OLMAYDI');
{
  for (const [m, p] of [
    ['GET', '/admin/agreements'], ['GET', '/admin/revenue'], ['GET', '/admin/billing/restaurants'],
    ['GET', `/admin/billing/restaurant/${rid}/orders`], ['GET', `/admin/restaurants/${rid}/payout/reveal`],
  ]) {
    const r = await call(T.marketing, m, p);
    ok(r.status === 403, `marketing ${p.split('?')[0].replace(rid, ':id')} → ${r.status}`);
  }
  ok((await call(T.marketing, 'PUT', `/admin/agreements/${rid}`, { restaurantCommissionPercent: 1, customerFeePercent: 1 })).status === 403,
    'marketing kelishuvni o‘zgartira olmaydi');
  ok((await call(T.restaurant, 'GET', `/admin/restaurants/${rid}/payout/reveal`)).status === 403, 'restoran o‘z rekvizitini bu yo‘l bilan ocholmaydi');
  ok((await call(null, 'GET', `/admin/restaurants/${rid}/payout/reveal`)).status === 401, 'tokensiz — 401');
  ok((await call(T.accountant, 'GET', '/admin/staff')).status === 403, 'buxgalter Xodimlarni boshqara olmaydi (faqat Super Admin)');
  ok((await call(T.accountant, 'GET', '/admin/orders')).status === 403, 'buxgalter buyurtmalar ro‘yxatini ko‘rmaydi (mijoz ma’lumoti)');
  const adm = await call(T.admin, 'GET', '/admin/agreements');
  ok(adm.status === 200 && Array.isArray(adm.json), 'Super Admin avvalgidek ko‘radi');
}

console.log('\n[3] Davrsiz (hammasi) — avvalgidek: sonlar va period=null');
{
  const r = await call(T.accountant, 'GET', '/admin/billing/restaurants');
  const row = r.json.find((x) => x._id === rid);
  ok(row.period === null, 'davr tanlanmagan — period: null');
  ok(row.cashCount === 4 && row.cardCount === 1, `naqd 4 (kecha, bugun, 2 ta eski), karta 1: ${row.cashCount}/${row.cardCount}`);
  ok(row.komissiya === 7200, 'jami summalar Ledger’dan (o‘zgarmagan)');
}

console.log('\n[4] DAVR: "Kecha" — faqat kechagi buyurtmalar va kechagi o‘tkazma');
{
  const r = await call(T.accountant, 'GET', `/admin/billing/restaurants?from=${YESTERDAY}&to=${YESTERDAY}`);
  ok(r.status === 200, `status ${r.status}`);
  const row = r.json.find((x) => x._id === rid);
  ok(row.cashCount === 1 && row.cardCount === 1, `kecha: naqd 1, karta 1 → ${row.cashCount}/${row.cardCount}`);
  ok(row.period.tolangan === 100000, `KECHA o‘tkazilgan: ${row.period.tolangan} (100 000 bo‘lishi kerak, 30 000 va 777 000 emas)`);
  ok(row.period.tushum === 120000 && row.period.komissiya === 7200, 'kechagi tushum va komissiya');
  ok(row.period.clickFee === 1800, `kechagi Click haqi (120 000 × 1.5%): ${row.period.clickFee}`);
  ok(row.period.sofKomissiya === 5400, `sof daromad = komissiya − Click: ${row.period.sofKomissiya}`);
  const other = r.json.find((x) => x._id === String(R2._id));
  ok(other.period.tolangan === 0, 'boshqa restoranga o‘tkazma aralashmadi');
}

console.log('\n[5] DAVR: "Bugun" — Toshkent kuni chegarasi (00:20 UTC bo‘yicha kecha bo‘lardi)');
{
  const r = await call(T.accountant, 'GET', `/admin/billing/restaurants?from=${TODAY}&to=${TODAY}`);
  const row = r.json.find((x) => x._id === rid);
  ok(row.cashCount === 1 && row.cardCount === 0, `bugun: faqat olib ketish (00:20) → ${row.cashCount}/${row.cardCount}`);
  ok(row.period.tolangan === 30000, `bugun o‘tkazilgan: ${row.period.tolangan}`);
}

console.log('\n[6] BAHO KEYIN QO‘YILSA buyurtma boshqa kunga KO‘CHMAYDI (updatedAt emas, deliveredAt)');
{
  const r = await call(T.accountant, 'GET', `/admin/billing/restaurants?from=${TODAY}&to=${TODAY}`);
  const row = r.json.find((x) => x._id === rid);
  ok(row.cashCount === 1, `updatedAt bugun bo‘lgan ESKI buyurtma bugunga qo‘shilmadi: ${row.cashCount}`);
  const old = await call(T.accountant, 'GET', `/admin/billing/restaurants?from=${LONG_AGO}&to=${LONG_AGO}`);
  const oldRow = old.json.find((x) => x._id === rid);
  ok(oldRow.cashCount === 2, `ikkalasi ham (deliveredAt bor va yo‘q — eski) o‘z kunida: ${oldRow.cashCount}`);
}

console.log('\n[7] Noto‘g‘ri davr — jimgina e’tiborsiz QOLDIRILMAYDI (400)');
{
  const a = await call(T.accountant, 'GET', '/admin/billing/restaurants?from=abc');
  ok(a.status === 400 && /sana/i.test(a.json?.error || ''), `noto‘g‘ri sana: ${a.status} "${a.json?.error}"`);
  const b = await call(T.accountant, 'GET', `/admin/billing/restaurants?from=${TODAY}&to=${YESTERDAY}`);
  ok(b.status === 400, `teskari oraliq: ${b.status}`);
  const c = await call(T.accountant, 'GET', `/admin/billing/restaurant/${rid}/orders?from=zzz`);
  ok(c.status === 400, `buyurtmalar ro‘yxatida ham: ${c.status}`);
}

console.log('\n[8] BUYURTMALAR RO‘YXATI: "Naqd: N ta" ustiga bosilsa — aynan shu N ta');
{
  const period = `from=${YESTERDAY}&to=${YESTERDAY}`;
  const card = (await call(T.accountant, 'GET', `/admin/billing/restaurants?${period}`)).json.find((x) => x._id === rid);
  const cash = await call(T.accountant, 'GET', `/admin/billing/restaurant/${rid}/orders?method=cash&${period}`);
  const cardList = await call(T.accountant, 'GET', `/admin/billing/restaurant/${rid}/orders?method=card&${period}`);
  ok(cash.json.orders.length === card.cashCount && cash.json.count === card.cashCount, `naqd ro‘yxati = kartadagi son (${cash.json.orders.length})`);
  ok(cardList.json.orders.length === card.cardCount, `karta ro‘yxati = kartadagi son (${cardList.json.orders.length})`);
  ok(cash.json.orders.every((o) => o.method === 'cash') && cardList.json.orders.every((o) => o.method === 'card'), 'turlari aralashmagan');

  const c = cash.json.orders[0];
  ok(c.items.length === 2 && c.items[0].name === 'Osh' && c.items[0].quantity === 2 && c.items[0].lineTotal === 60000, 'taomlar: 2× Osh = 60 000');
  ok(c.foodTotal === 75000 && c.deliveryFee === 15000 && c.total === 90000, `taom 75 000 + yetkazish 15 000 = jami 90 000 (${c.foodTotal}+${c.deliveryFee}=${c.total})`);
  ok(c.adjustment === 0, 'chegirma/qo‘shimcha yo‘q — ustunlar jamiga teng');

  const k = cardList.json.orders[0];
  ok(k.foodTotal === 100000 && k.deliveryFee === 20000 && k.total === 120000, `karta: taom 100 000 + yetkazish 20 000 = jami 120 000 (${k.total})`);
  ok(k.items[0].options.join(',') === '40 sm,Pishloq', 'tanlangan variantlar (40 sm, Pishloq) ko‘rsatilgan');
  ok(k.restaurantShare === 114000 && k.lokmaCommission === 6000 && k.clickFee === 1800,
    `restoran ulushi 114 000 (94 000 taom + 20 000 yetkazish), LokmaGo 6 000, Click 1 800: ${k.restaurantShare}/${k.lokmaCommission}/${k.clickFee}`);
  ok(cardList.json.totals.total === 120000 && cash.json.totals.deliveryFee === 15000, 'jami summalar hisoblangan');
  ok(c.restaurantShare === null, 'eski (finance yo‘q) buyurtmada ulush — null (uydirma raqam yo‘q)');
}

console.log('\n[9] Mijoz ma’lumoti: buxgalterga YO‘Q, Super Admin’ga bor');
{
  const acc = await call(T.accountant, 'GET', `/admin/billing/restaurant/${rid}/orders?method=cash&from=${YESTERDAY}&to=${YESTERDAY}`);
  ok(acc.json.orders[0].customer === null, 'buxgalter: mijoz ismi/telefoni ko‘rinmaydi');
  ok(!JSON.stringify(acc.json).includes('998901112233') && !JSON.stringify(acc.json).includes('Manzil'), 'javob ichida telefon ham, manzil ham umuman yo‘q');
  const adm = await call(T.admin, 'GET', `/admin/billing/restaurant/${rid}/orders?method=cash&from=${YESTERDAY}&to=${YESTERDAY}`);
  ok(adm.json.orders[0].customer?.name === 'Mijoz Ismli', 'Super Admin: mijoz ko‘rinadi');
}

console.log('\n[10] Bekor qilingan va boshqa restoran buyurtmalari ro‘yxatga TUSHMAYDI');
{
  const all = await call(T.accountant, 'GET', `/admin/billing/restaurant/${rid}/orders`);
  ok(all.json.orders.length === 5 && all.json.count === 5, `hammasi: 5 ta yetkazilgan (${all.json.orders.length})`);
  ok(!all.json.orders.some((o) => String(o._id) === String(ORD.cancelled._id) || String(o._id) === String(ORD.otherRestaurant._id)), 'bekor qilingan va boshqa restoran yo‘q');
  ok((await call(T.accountant, 'GET', '/admin/billing/restaurant/notanid/orders')).status === 400, 'noto‘g‘ri ID — 400');
  ok((await call(T.accountant, 'GET', `/admin/billing/restaurant/${new mongoose.Types.ObjectId()}/orders`)).status === 404, 'mavjud bo‘lmagan restoran — 404');
}

console.log('\n[11] "KECHA QANCHA O‘TKAZILGAN": jurnal davr bo‘yicha, kim o‘tkazgani bilan');
{
  const r = await call(T.accountant, 'GET', `/admin/billing/ledger?type=payout&restaurantId=${rid}&from=${YESTERDAY}&to=${YESTERDAY}`);
  ok(r.json.length === 1 && r.json[0].amount === -100000, `kecha 1 ta o‘tkazma: ${r.json.length}`);
  ok(r.json[0].createdByName === 'Bahrom Buxgalter', `kim o‘tkazgani: "${r.json[0].createdByName}"`);
  ok(r.json[0].meta?.note === 'Kartaga o‘tkazildi', 'izoh ham bor');
}

console.log('\n[12] TO‘LOV REKVIZITI: to‘liq karta va bank — buxgalter kiritadi va to‘liq ko‘radi');
{
  const CARD = '8600123456789012';
    const revealsBefore = await RestaurantPayoutAudit.countDocuments({ restaurantId: R1._id, field: 'reveal' });
  const upd = await call(T.accountant, 'PATCH', `/admin/restaurants/${rid}/payout`, {
    method: 'card',
    card: { cardNumber: CARD, holderName: 'ALIYEV VALI', bankName: 'Xalq banki' },
    bank: { accountNumber: '20208000123456789001', bankName: 'Xalq banki', mfo: '00014', inn: '303030303', holderName: 'TUTTI FOOD MCHJ' },
  });
  ok(upd.status === 200, `saqlandi: ${upd.status}`);
  ok(upd.json.card.cardMasked === '8600 **** **** 9012' && upd.json.card.hasFullNumber === true, 'ro‘yxat ko‘rinishi hamon MASKALANGAN, lekin to‘liq raqam borligi bilinadi');
  ok(!JSON.stringify(upd.json).includes(CARD), 'tahrir javobida to‘liq karta raqami yo‘q');

  const rev = await call(T.accountant, 'GET', `/admin/restaurants/${rid}/payout/reveal`);
  ok(rev.json.card.number === CARD, `TO‘LIQ karta raqami: ${rev.json.card.number}`);
  ok(rev.json.bank.accountNumber === '20208000123456789001' && rev.json.bank.mfo === '00014' && rev.json.bank.inn === '303030303', 'TO‘LIQ bank hisobi, MFO va STIR');
  ok(rev.json.method === 'card' && rev.json.card.holderName === 'ALIYEV VALI', 'usul va karta egasi');
  ok(rev.json.card.needsFullNumber === false, 'to‘liq raqam bor — "kiriting" talab qilinmaydi');

  // Bazada ochiq holda YO'Q
  const secret = await RestaurantPayoutSecret.findOne({ restaurantId: R1._id }).lean();
  ok(secret.cardNumberEnc.startsWith('v1:') && !secret.cardNumberEnc.includes(CARD), 'bazada SHIFRLANGAN (v1:…), ochiq raqam yo‘q');
  const restRaw = JSON.stringify(await Restaurant.findById(R1._id).lean());
  ok(!restRaw.includes(CARD) && restRaw.includes('9012'), 'Restaurant hujjatida faqat oxirgi 4 xona');
  const rawDump = JSON.stringify(await mongoose.connection.db.collection('restaurantpayoutsecrets').find({}).toArray());
  ok(!rawDump.includes(CARD), 'kolleksiyaning xom ko‘rinishida ham ochiq raqam yo‘q');

  // Restoranning o'z paneli to'liq raqamni ko'rmaydi
  const prof = await call(T.restaurant, 'GET', '/panel/me');
  ok(prof.status === 200 && !JSON.stringify(prof.json).includes(CARD), 'restoran o‘z panelida to‘liq karta raqamini ko‘rmaydi');

  // Audit
  const audit = await RestaurantPayoutAudit.find({ restaurantId: R1._id }).lean();
  const reveals = audit.filter((a) => a.field === 'reveal');
  ok(reveals.length === revealsBefore + 1 && reveals.every((a) => a.changedByName === 'Bahrom Buxgalter'),
    `bu ko‘rish audit’ga yozildi (+1), har biri ism bilan: ${reveals.length - revealsBefore} ta, "${reveals.at(-1)?.changedByName}"`);
  ok(!JSON.stringify(audit).includes(CARD), 'audit tarixining ichida ham to‘liq raqam YO‘Q');
  await call(T.accountant, 'GET', `/admin/restaurants/${rid}/payout/reveal`);
  ok((await RestaurantPayoutAudit.countDocuments({ restaurantId: R1._id, field: 'reveal' })) === revealsBefore + 2, 'ikkinchi ko‘rish ham alohida yozildi');
}

console.log('\n[13] ESKI restoran (faqat oxirgi 4 xona bor) — to‘liq raqam kiritish talab qilinadi');
{
  await Restaurant.updateOne({ _id: R2._id }, { 'payout.method': 'card', 'payout.card.cardLast4': '4455', 'payout.card.holderName': 'ESKI' });
  const rev = await call(T.accountant, 'GET', `/admin/restaurants/${R2._id}/payout/reveal`);
  ok(rev.json.card.number === '' && rev.json.card.needsFullNumber === true && rev.json.card.last4 === '4455',
    'raqam bo‘sh, needsFullNumber: true — interfeys "kiriting" deydi');
}

console.log('\n[14] Rekvizit yangilanmasa (faqat holat) to‘liq raqam saqlanib qoladi');
{
  const upd = await call(T.accountant, 'PATCH', `/admin/restaurants/${rid}/payout`, { status: 'verified' });
  ok(upd.status === 200 && upd.json.card.hasFullNumber === true, 'boshqa maydon o‘zgarganda to‘liq raqam yo‘qolmadi');
  const rev = await call(T.accountant, 'GET', `/admin/restaurants/${rid}/payout/reveal`);
  ok(rev.json.card.number === '8600123456789012', 'hamon to‘liq');
  const bad = await call(T.accountant, 'PATCH', `/admin/restaurants/${rid}/payout`, { card: { cardNumber: '123' } });
  ok(bad.status === 400, 'noto‘g‘ri (16 xona emas) karta rad etildi');
}

stop();
if (fails) console.log('\n--- server logi (oxirgi qism) ---\n' + serverLog.split('\n').slice(-25).join('\n'));
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
