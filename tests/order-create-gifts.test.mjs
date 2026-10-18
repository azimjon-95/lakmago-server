/*
 * BUYURTMA YARATISH (HAQIQIY orderController.create) + SOVG'A-BONUS. Baza KERAK EMAS (modellar soxta).
 * Bu test bugungi xatodan keyin yozilgan: avval test faqat xizmat funksiyasini sinagan, buyurtma yaratish
 * funksiyasining o'zini ISHGA TUSHIRMAGAN — shuning uchun `rest is not defined` ushlanmagan edi.
 * npm run test:order-gifts
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const mongoose = (await import('mongoose')).default;
mongoose.set('bufferCommands', false); // soxtalashtirilmagan har qanday so'rov — darhol xato (ko'rinadi)

const { orderController } = await import('../src/controllers/misc.js');
const { Order } = await import('../src/models/Order.js');
const { User } = await import('../src/models/User.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { GiftBonus } = await import('../src/models/GiftBonus.js');
const { Settings } = await import('../src/models/Settings.js');
const G = await import('../src/services/giftBonus.js');
const { Promotion } = await import('../src/models/Promotion.js');
const { CommissionAgreement } = await import('../src/models/CommissionAgreement.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const OID = (n) => String(n).padStart(24, 'a');
const REST = OID(9); const USER = OID(5);

// ── soxta modellar ──
const chain = (v) => { const c = { select: () => c, sort: () => c, limit: () => c, populate: () => c, lean: async () => structuredClone(v), then: (res, rej) => Promise.resolve(structuredClone(v)).then(res, rej), catch: (f) => Promise.resolve(structuredClone(v)).catch(f) }; return c; };
User.findById = () => chain({ _id: USER, status: 'ACTIVE', addresses: [] });
Settings.findOne = async () => ({ key: 'global', toObject() { return {}; } });
const restaurant = (o = {}) => ({ _id: REST, name: 'TOTLI', kind: 'restaurant', isActive: true, isApproved: true, isBlocked: false, pickupEnabled: true, pickupDiscountPercent: 0, cashEnabled: true, deliveryEnabled: true, minOrder: 0, ...o });
let restaurants = [restaurant()];
Restaurant.find = () => chain(restaurants);
Restaurant.findById = () => chain(restaurants[0]);
Promotion.find = () => chain([]);
Promotion.findOne = () => chain(null);
CommissionAgreement.findOne = () => chain(null);
CommissionAgreement.find = () => chain([]);
let created = [];
Order.create = async (d) => { const doc = { _id: OID(100 + created.length), ...d, toObject() { return { ...d }; } }; created.push(doc); return doc; };
Order.findOne = () => chain(null);
Order.countDocuments = async () => 0;
Order.find = () => chain([]);
Order.findOneAndUpdate = async () => null;
Order.updateOne = async () => ({});
Order.aggregate = async () => [];
let gifts = [];
GiftBonus.find = () => ({ sort() { return this; }, limit() { return this; }, lean: async () => structuredClone(gifts) });

const rule = (o = {}) => ({ _id: OID(1), name: 'Kola', itemName: '1 l Coca-Cola', quantity: 1, reimburse: 12_000, minAmount: 100_000, maxAmount: 0, basis: 'menu', active: true, scope: 'all', restaurantIds: [], kinds: ['restaurant', 'choyxona', 'cafe', 'fastfood', 'club'], fulfillments: ['delivery', 'pickup'], paymentMethods: [], weekdays: [], hourFrom: null, hourTo: null, perCustomerPerDay: 0, perCustomerTotal: 0, dailyLimit: 0, totalLimit: 0, budget: 0, ...o });

/** Haqiqiy create() ni chaqiradi; javob yoki xatoni qaytaradi */
const run = (body) => new Promise((resolve) => {
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; resolve({ code: this.code, body: b }); return this; }, set() { return this; } };
  const req = { body, userId: USER, headers: {}, ip: '127.0.0.1', user: { _id: USER } };
  orderController.create(req, res, (e) => resolve({ error: e }));
  setTimeout(() => resolve({ timeout: true }), 4000);
});
const body = (subtotal, o = {}) => ({
  orders: [{ restaurantId: REST, restaurantName: 'TOTLI', items: [{ name: 'Margarita', quantity: 1, unitPrice: subtotal }], subtotal, deliveryFee: 0, serviceFee: 0 }],
  fulfillment: 'pickup', paymentMethod: 'cash', address: '', ...o,
});
const lastOrder = () => created[created.length - 1];

console.log('\n[0] Asos: sovg‘a qoidasiz buyurtma yaratiladimi (haqiqiy create ishlaydi)');
{
  const r = await run(body(120_000));
  if (r.error) console.log('   XATO:', String(r.error.stack || r.error).split('\n').slice(0, 3).join(' | '));
  if (r.timeout) console.log('   (vaqt tugadi)');
  if (r.code && r.code !== 200 && r.code !== 201) console.log('   javob:', r.code, JSON.stringify(r.body).slice(0, 200));
  ok(created.length === 1, `buyurtma yaratildi (kod ${r.code ?? r.error ?? 'timeout'})`);
  ok(created.length === 1 && !lastOrder().bonusItems, 'sovg‘a qoidasi yo‘q — bonusItems yo‘q');
}

console.log('\n[1] 100 000 va undan oshganlarga sovg‘a');
gifts = [rule()]; G.invalidateGiftCache(); created = [];
{
  await run(body(120_000));
  const o = lastOrder();
  ok(o?.bonusItems?.length === 1 && o.bonusItems[0].itemName === '1 l Coca-Cola', '120 000 — buyurtmaga 1 l Coca-Cola yozildi');
  ok(o?.bonusCost === 12_000 && o.bonusItems[0].reimburse === 12_000, 'qoplash summasi 12 000 muzlatildi');
  ok(o?.total === 120_000 || o?.total > 0, `jami o‘zgarmadi: ${o?.total} (sovg‘a narxga kirmaydi)`);
  created = []; await run(body(100_000)); ok(lastOrder()?.bonusItems?.length === 1, '100 000 (aynan chegara) — sovg‘a bor');
  created = []; await run(body(99_999)); ok(created.length === 1 && !lastOrder().bonusItems, '99 999 — sovg‘a yo‘q, buyurtma yaratildi');
}

console.log('\n[2] Olib ketish chegirmasi va "chegirmadan keyin" hisobi (o‘zgaruvchilar to‘g‘ri uzatilishi)');
{
  restaurants = [restaurant({ pickupDiscountPercent: 10 })];
  gifts = [rule({ basis: 'paid' })]; G.invalidateGiftCache(); created = [];
  await run(body(105_000));
  ok(created.length === 1 && !lastOrder().bonusItems, 'paid: 105 000 − 10% = 94 500 < 100 000 — sovg‘a yo‘q');
  created = []; await run(body(112_000));
  ok(lastOrder()?.bonusItems?.length === 1, 'paid: 112 000 − 10% = 100 800 — sovg‘a bor');
  gifts = [rule({ basis: 'menu' })]; G.invalidateGiftCache(); created = [];
  await run(body(105_000));
  ok(lastOrder()?.bonusItems?.length === 1, 'menu: aksiya/chegirmadan OLDIN 105 000 — sovg‘a bor');
  restaurants = [restaurant()];
}

console.log('\n[3] Bonus XATO bersa — buyurtma BARIBIR yaratiladi (eng muhim)');
{
  gifts = [rule()]; G.invalidateGiftCache(); created = [];
  GiftBonus.find = () => { throw new Error('baza o‘chdi'); };
  const origErr = console.error; console.error = () => {};
  const r = await run(body(150_000));
  console.error = origErr;
  ok(created.length === 1 && !lastOrder().bonusItems, 'GiftBonus.find yiqildi — buyurtma bonussiz yaratildi');
  ok(!r.error, 'create() xato tashlamadi');
}
{
  // Argumentlarni tuzishdagi xato ham buyurtmani to'xtatmasligi kerak (bugungi xato aynan shunday edi)
  GiftBonus.find = () => ({ sort() { return this; }, limit() { return this; }, lean: async () => structuredClone(gifts) });
  G.invalidateGiftCache(); created = [];
  const saved = restaurants; restaurants = []; // restMap bo'sh — birinchi sikl "Restoran topilmadi" deydi
  const r = await run(body(150_000));
  restaurants = saved;
  ok(r.code === 400, 'mavjud bo‘lmagan restoran — 400 (bonus bilan bog‘liq emas)');
}

console.log('\n[4] Karta (click) va ko‘p buyurtma');
{
  gifts = [rule({ paymentMethods: ['click'] })]; G.invalidateGiftCache(); created = [];
  await run(body(150_000, { paymentMethod: 'cash' })); ok(created.length === 1 && !lastOrder().bonusItems, 'qoida faqat Click: naqdda sovg‘a yo‘q');
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ Hammasi o‘tdi');
process.exit(fails ? 1 : 0);
