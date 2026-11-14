/*
 * MIJOZ KO'RGAN NARX = BUYURTMA NARXI (haqiqiy orderController.create, modellar soxta, baza kerak emas).
 * Hodisa (2026-11-14): pitsa 40 sm menyuda 89 100 (81 000 + restoran ustamasi 10%), buyurtmada 81 000 bo'lib qoldi:
 * buyurtma yaratishda restoran `deliveryMarkupPercent` bazadan SO'RALMAGAN (select'da yo'q edi) → ustama 0.
 * Soxta Restaurant.find `.select()` ni HAQIQIY kabi bajaradi — maydon so'ralmasa u yo'q bo'ladi (xato shunday ushlanadi).
 * npm run test:order-price
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'x'.repeat(40);
const mongoose = (await import('mongoose')).default;
mongoose.set('bufferCommands', false);

const { orderController } = await import('../src/controllers/misc.js');
const { Order } = await import('../src/models/Order.js');
const { User } = await import('../src/models/User.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { Dish } = await import('../src/models/Dish.js');
const { GiftBonus } = await import('../src/models/GiftBonus.js');
const { Settings } = await import('../src/models/Settings.js');
const { Promotion } = await import('../src/models/Promotion.js');
const { CommissionAgreement } = await import('../src/models/CommissionAgreement.js');
const { applyPricing, priceContext } = await import('../src/services/customerPricing.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const OID = (n) => String(n).padStart(24, 'a');
const REST = OID(9); const USER = OID(5); const DISH = OID(7);

const pick = (obj, fields) => {
  if (!fields) return obj;
  const keep = String(fields).split(/\s+/).filter(Boolean);
  const out = { _id: obj._id };
  for (const k of keep) if (k in obj) out[k] = obj[k];
  return out;
};
// .select() HAQIQIY: so'ralmagan maydon natijada bo'lmaydi
const chain = (v) => {
  let fields = null;
  const val = () => structuredClone(Array.isArray(v) ? v.map((x) => pick(x, fields)) : (v && pick(v, fields)));
  const c = { select: (f) => { fields = f; return c; }, sort: () => c, limit: () => c, populate: () => c, lean: async () => val(), then: (r, j) => Promise.resolve(val()).then(r, j), catch: (f) => Promise.resolve(val()).catch(f) };
  return c;
};
User.findById = () => chain({ _id: USER, status: 'ACTIVE', addresses: [] });
Settings.findOne = async () => ({ key: 'global', toObject() { return {}; } });
let rest = {};
Restaurant.find = () => chain([rest]);
Restaurant.findById = () => chain(rest);
Promotion.find = () => chain([]);
Promotion.findOne = () => chain(null);
let agreement = null;
CommissionAgreement.findOne = () => chain(agreement);
CommissionAgreement.find = () => chain(agreement ? [agreement] : []);
GiftBonus.find = () => ({ sort() { return this; }, limit() { return this; }, lean: async () => [] });

const pizza = {
  _id: DISH, restaurantId: REST, name: 'PIZZA PEPERONI', price: 51_000, isAvailable: true,
  optionGroups: [{ _id: OID(11), title: 'Hajmi', kind: 'variant', required: true, options: [
    { _id: OID(21), name: '25', price: 51_000 }, { _id: OID(22), name: '30', price: 61_000 }, { _id: OID(23), name: '40', price: 81_000 },
  ] }, { _id: OID(12), title: 'Qo‘shimcha', kind: 'addon', options: [{ _id: OID(24), name: 'Pishloq', price: 5_000 }] }],
};
Dish.find = (q) => chain(q && q.$or ? [] : [pizza]);

let created = [];
Order.create = async (d) => { const doc = { _id: OID(100 + created.length), ...d, toObject() { return { ...d }; } }; created.push(doc); return doc; };
Order.findOne = () => chain(null);
Order.countDocuments = async () => 0;
Order.find = () => chain([]);
Order.findOneAndUpdate = async () => null;
Order.updateOne = async () => ({});
Order.aggregate = async () => [];

const run = (body) => new Promise((resolve) => {
  const res = { code: 200, status(c) { this.code = c; return this; }, json(b) { resolve({ code: this.code, body: b }); return this; }, set() { return this; } };
  orderController.create({ body, userId: USER, headers: {}, ip: '127.0.0.1', user: { _id: USER } }, res, (e) => resolve({ error: e }));
  setTimeout(() => resolve({ timeout: true }), 4000);
});
// Mijoz menyuda ko'rgan narx (catalog → applyPricing) bilan buyurtma qilamiz
const order = async (optNames) => {
  const ctx = await priceContext(rest);
  const shown = applyPricing(structuredClone(pizza), ctx);
  const opts = shown.optionGroups.flatMap((g) => g.options).filter((o) => optNames.includes(o.name));
  const variant = opts.find((o) => ['25', '30', '40'].includes(o.name));
  const unit = (variant ? variant.price : shown.price) + opts.filter((o) => o !== variant).reduce((s, o) => s + o.price, 0);
  created = [];
  const r = await run({
    orders: [{ restaurantId: REST, restaurantName: 'Chinor', items: [{ dishId: DISH, name: shown.name, quantity: 1, unitPrice: unit, selectedOptions: opts.map((o) => ({ name: o.name, price: o.price })) }], subtotal: unit, deliveryFee: 0, serviceFee: 0 }],
    fulfillment: 'pickup', paymentMethod: 'cash', address: '',
  });
  if (r.error || r.timeout || (r.code !== 200 && r.code !== 201)) console.log('   javob:', r.code, r.error?.message || '', JSON.stringify(r.body || '').slice(0, 200));
  return { shownUnit: unit, o: created[0] };
};
const base = (o = {}) => ({ _id: REST, name: 'Chinor Fast food', kind: 'restaurant', isActive: true, isApproved: true, isBlocked: false, pickupEnabled: true, pickupDiscountPercent: 0, cashEnabled: true, deliveryEnabled: true, minOrderAmount: 0, ...o });

console.log('\n[1] Hodisa: restoran ustamasi 10%, pitsa 40 sm — menyuda 89 100, buyurtma ham 89 100');
rest = base({ deliveryMarkupPercent: 10 }); agreement = null;
{
  const { shownUnit, o } = await order(['40']);
  ok(shownUnit === 89_100, `menyuda 40 sm = ${shownUnit}`);
  ok(o?.subtotal === 89_100, `buyurtma taom summasi ${o?.subtotal} (avval 81 000 edi)`);
  ok(o?.total === 89_100, `jami ${o?.total}`);
  ok(o?.items?.[0]?.customerUnitPrice === 89_100, `pozitsiya mijoz narxi ${o?.items?.[0]?.customerUnitPrice}`);
  ok(o?.items?.[0]?.unitPrice === 81_000, 'restoran (baza) narxi saqlangan: 81 000 — moliya shundan');
  ok(o?.items?.[0]?.name === 'PIZZA PEPERONI', `nom bazadan: ${o?.items?.[0]?.name}`);
  const v = o?.items?.[0]?.selectedOptions?.filter((x) => x.variant) || [];
  ok(v.length === 1 && v[0].name === '40', 'tanlangan hajm 40 yozildi (25 emas)');
  ok(o?.finance?.restaurantPayout != null || o?.finance != null, 'moliyaviy snapshot bor');
}

console.log('\n[2] Ustama 10% + mijoz haqi 5% + qo‘shimcha — har joyda menyudagi narx');
rest = base({ deliveryMarkupPercent: 10 });
agreement = { _id: OID(31), restaurantId: REST, customerFeePercent: 5, restaurantCommissionPercent: 10, totalSplitPercent: 15, isActive: true, effectiveFrom: new Date(0) };
{
  const { shownUnit, o } = await order(['30', 'Pishloq']);
  ok(shownUnit === 61_000 * 1.15 + 5_000 * 1.15, `menyuda 30 sm + pishloq = ${shownUnit}`);
  ok(o?.subtotal === shownUnit, `buyurtma ${o?.subtotal} = menyu ${shownUnit}`);
  ok(o?.items?.[0]?.customerUnitPrice === shownUnit, `pozitsiya mijoz narxi ${o?.items?.[0]?.customerUnitPrice}`);
}

console.log('\n[3] Ustamasiz, haqsiz restoran — o‘zgarishsiz (restoran narxi = mijoz narxi)');
rest = base({ deliveryMarkupPercent: 0 }); agreement = null;
{
  const { shownUnit, o } = await order(['25']);
  ok(shownUnit === 51_000 && o?.subtotal === 51_000 && o?.items?.[0]?.customerUnitPrice === 51_000, `25 sm = ${o?.subtotal}`);
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
process.exit(fails ? 1 : 0);
