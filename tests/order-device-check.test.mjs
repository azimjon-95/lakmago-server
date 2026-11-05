/*
 * BUYURTMA YARATISH + QURILMA JOYLASHUVI (HAQIQIY orderController.create): mijoz manzildan uzoqda bo'lsa Order.deviceCheck 'far' yoziladi,
 * eski ilova (maydonsiz) va olib ketish buyurtmasi buzilmaydi, xom koordinata saqlanmaydi. Baza KERAK EMAS (modellar soxta).
 * npm run test:order-device
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


Order.findOneAndUpdate = () => chain({ seq: 1, dailyNumber: 1 });   // kunlik raqam hisoblagichi (chain: select/lean qo'llab-quvvatlanadi)
const TARGET = { lat: 40.9983, lng: 71.6726 };
const northOf = (m) => ({ lat: TARGET.lat + m / 111320, lng: TARGET.lng });
restaurants = [restaurant({ lat: 40.9990, lng: 71.6700, deliveryEnabled: true })];
const dBody = (extra = {}) => body(120_000, { fulfillment: 'delivery', address: 'Uy, Tinchlik 6', ...extra });
const withDelivery = (o) => ({ ...o, addressLat: TARGET.lat, addressLng: TARGET.lng });
const fix = (m, acc = 15, ageMs = 30_000) => ({ deviceLat: northOf(m).lat, deviceLng: northOf(m).lng, deviceAccuracy: acc, deviceAt: new Date(Date.now() - ageMs).toISOString() });

async function place(extra) {
  created = [];
  const r = await run(withDelivery(dBody(extra)));
  if (r.error) console.log('   XATO:', String(r.error.stack || r.error).split('\n').slice(0, 3).join(' | '));
  if (r.code && r.code >= 400) console.log('   javob:', r.code, JSON.stringify(r.body).slice(0, 220));
  return r;
}

console.log('\n[1] Mijoz manzildan 8 km uzoqda — far yoziladi, restoran ogohlantiriladi');
{
  await place(fix(8200));
  ok(created.length === 1, 'buyurtma yaratildi');
  const c = lastOrder()?.deviceCheck;
  ok(c?.status === 'far', `deviceCheck.status = far (${c?.status})`);
  ok(Math.abs((c?.distanceM ?? 0) - 8200) < 25, `masofa ~8200 m (${c?.distanceM})`);
  ok(c?.confirmedFar === false && c?.accuracyM === 15, 'tasdiqlanmagan, aniqlik 15 m');
  ok(!JSON.stringify(c).includes(String(northOf(8200).lat).slice(0, 7)), 'XOM KOORDINATA saqlanmadi (maxfiylik)');
}

console.log('\n[2] Mijoz uzoq manzilni o\'zi tasdiqlagan — belgilanadi');
{
  await place({ ...fix(8200), addressConfirmedFar: true });
  ok(lastOrder()?.deviceCheck?.status === 'far' && lastOrder().deviceCheck.confirmedFar === true, 'far + confirmedFar');
}

console.log('\n[3] Manzilda / eski nuqta / aniqligi past / eski ilova (maydonsiz)');
{
  await place(fix(40)); ok(lastOrder()?.deviceCheck?.status === 'match', 'manzilda → match');
  await place(fix(9000, 15, 20 * 60_000)); ok(lastOrder()?.deviceCheck?.status === 'unknown', '20 daqiqa oldingi nuqta → unknown (dalil emas)');
  await place(fix(9000, 400)); ok(lastOrder()?.deviceCheck?.status === 'unknown', 'aniqlik 400 m → unknown (soxta "uzoq" yo\'q)');
  await place({}); ok(created.length === 1 && lastOrder().deviceCheck?.status === 'unknown', 'eski ilova: maydonsiz buyurtma ishlaydi (unknown)');
}

console.log('\n[4] Olib ketish buyurtmasida tekshiruv yo\'q; yaroqsiz maydon rad etiladi');
{
  created = [];
  const r = await run(body(120_000, { fulfillment: 'pickup', ...fix(8200) }));
  ok(created.length === 1 && !lastOrder().deviceCheck, 'pickup: deviceCheck yozilmaydi');
  created = [];
  const bad = await run(withDelivery(dBody({ deviceLat: 123, deviceLng: 71, deviceAt: new Date().toISOString() })));
  ok(bad.code === 400 && created.length === 0, 'noto\'g\'ri kenglik (123) — 400');
  void r;
}

console.log(fails ? `\n${fails} ta xato` : '\nHammasi o‘tdi');
process.exit(fails ? 1 : 0);
