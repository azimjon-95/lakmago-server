/*
 * ═══ F-00: BUYURTMA SUMMASI TO'LIQ SERVERDA (MongoDB kerak) ═══   npm run test:server-pricing
 *
 * Haqiqiy orderController.create orqali SOXTA so'rovlar: mijoz yuborgan subtotal, unitPrice, tanlov narxi,
 * miqdor, dishId, deliveryFee/serviceFee/total — hech biri hisobga ta'sir qilmasligi kerak.
 * Tekshiriladi: minimal summa, bepul yetkazish chegarasi, olib ketish chegirmasi, aksiya, variant/qo'shimcha
 * (majburiy ham), menyu narxi = to'lov (butun so'm), bazada yo'q / boshqa restoran taomi rad etiladi.
 */
process.env.MONGO_URI ||= 'mongodb://127.0.0.1:27017/lokma_server_pricing';
if (!/\/lokma_server_pricing/.test(process.env.MONGO_URI)) process.env.MONGO_URI = process.env.MONGO_URI.replace(/\/[^/?]*(\?|$)/, '/lokma_server_pricing$1');
process.env.JWT_SECRET = 'x'.repeat(40); process.env.NODE_ENV = 'development';
process.env.RESTAURANT_BOT_TOKEN = '1:X';
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) });

const mongoose = (await import('mongoose')).default;
await mongoose.connect('mongodb://127.0.0.1:27017/lokma_server_pricing');
await mongoose.connection.db.dropDatabase();

const { Restaurant } = await import('../src/models/Restaurant.js');
const { Dish } = await import('../src/models/Dish.js');
const { User } = await import('../src/models/User.js');
const { Order } = await import('../src/models/Order.js');
const { Promotion } = await import('../src/models/Promotion.js');
const { CommissionAgreement } = await import('../src/models/CommissionAgreement.js');
const { orderController } = await import('../src/controllers/misc.js');
const { reconcile } = await import('../src/services/orderFinance.js');

let fails = 0; let passes = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (c) passes++; else fails++; };
const wait = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const call = async (fn, req) => {
  let status = 200; let body = null;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  await fn(req, res, (e) => { body = { next: e?.message }; status = 500; });
  await wait();
  return { status, body };
};

const LAT = 41.2856; const LNG = 69.2034;
const mkRest = async (name, extra = {}) => {
  const r = await Restaurant.create({
    name, cuisine: 'milliy', category: 'restoran', lat: 41.3111, lng: 69.2797, address: 'Test',
    deliveryEnabled: true, deliveryFee: 0, freeDeliveryThreshold: 200000, minOrderAmount: 50000,
    delivery: { maxDistanceKm: 0, pricingMode: 'perKm', freeKm: 1, perKm: 2000, basePrice: 8000 },
    pickupEnabled: true, pickupDiscountPercent: 10, cashEnabled: true, deliveryMarkupPercent: 10,
    openTime: '00:00', closeTime: '23:59', isActive: true, isApproved: true,
    workingDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'], ...extra,
  });
  await CommissionAgreement.create({ restaurantId: r._id, restaurantCommissionPercent: 5, customerFeePercent: 5, effectiveFrom: new Date(Date.now() - 60000) });
  const plov = await Dish.create({
    restaurantId: r._id, section: 'menu', name: 'Plov', price: 30000,
    optionGroups: [
      { title: 'Hajmi', kind: 'variant', options: [{ name: '0.5 kg', price: 30000 }, { name: '1 kg', price: 55000 }] },
      { title: 'Qo‘shimcha', kind: 'addon', options: [{ name: 'Pishloq', price: 5000 }, { name: 'Non', price: 2000, mandatory: true }] },
    ],
  });
  const choy = await Dish.create({ restaurantId: r._id, section: 'menu', name: 'Choy', price: 3000 });
  return { r, plov, choy };
};

const A = await mkRest('PRICING-A');
const B = await mkRest('PRICING-B');          // aksiya shu restoranda
await Promotion.create({ restaurantId: B.r._id, name: '10%', discountType: 'percent', discountValue: 10, scope: 'all',
  startsAt: new Date(Date.now() - 3600_000), endsAt: new Date(Date.now() + 3600_000), isActive: true });

let uidN = 0;
const newUser = () => User.create({ firstName: 'Test', telegramId: String(9000 + (uidN += 1)), phone: `+9989000000${String(uidN).padStart(2, '0')}`, addresses: [{ label: 'Uy', address: 'Sohil', lat: LAT, lng: LNG }] });

// Halol savat: 1 × Plov (1 kg + Pishloq + majburiy Non) + 2 × Choy
//   menyu (ustama 10% + haq 5%, har qism alohida): 63 250 + 5 750 + 2 300 = 71 300; Choy 3 450 × 2 = 6 900 → 78 200
const MENU = 78200; const BASE = 68000;
const honestItems = (x) => [
  { dishId: String(x.plov._id), name: 'Plov', quantity: 1, unitPrice: 71300,
    selectedOptions: [{ name: '1 kg', price: 63250, variant: true }, { name: 'Pishloq', price: 5750 }, { name: 'Non', price: 2300 }] },
  { dishId: String(x.choy._id), name: 'Choy', quantity: 2, unitPrice: 3450 },
];

const place = async (x, { items, subtotal = MENU, fulfillment = 'delivery', extra = {}, orderExtra = {} } = {}) => {
  const user = await newUser();
  const before = await Order.countDocuments({ restaurantId: x.r._id });
  const req = { userId: String(user._id), user: { _id: user._id }, body: {
    address: 'Uy — Sohil', phone: user.phone, paymentMethod: 'cash', paymentLabel: 'Naqd',
    fulfillment, timingMode: 'asap', addressLat: LAT, addressLng: LNG, ...extra,
    orders: [{ restaurantId: String(x.r._id), restaurantName: x.r.name, subtotal, items: items ?? honestItems(x), ...orderExtra }],
  } };
  const r = await call(orderController.create, req);
  const after = await Order.countDocuments({ restaurantId: x.r._id });
  const order = after > before ? await Order.findOne({ restaurantId: x.r._id, userId: user._id }).lean() : null;
  return { r, order };
};

console.log('\n[P1] Halol buyurtma: menyuda ko‘rgan summa = to‘lov, butun so‘m');
const P1 = await place(A);
{
  ok(P1.r.status < 400 && P1.order, `yaratildi (${P1.r.status} ${JSON.stringify(P1.r.body?.error || '')})`);
  const f = P1.order.finance;
  ok(P1.order.subtotal === MENU, `subtotal = menyu yig‘indisi ${MENU} (${P1.order.subtotal})`);
  ok(f.foodBase === BASE * 100, `restoran bazasi ${BASE} (${f.foodBase / 100})`);
  ok(f.customerFoodTotal === MENU * 100 && f.feeRounding === 'lines', 'snapshot: mijoz taom summasi = menyu, feeRounding=lines');
  ok(P1.order.deliveryFee > 0 && P1.order.total === MENU + P1.order.deliveryFee, `jami = ${MENU} + yetkazish ${P1.order.deliveryFee}`);
  ok(Number.isInteger(P1.order.total), 'jami butun so‘m');
  ok(reconcile(f).ok, 'rekonsiliatsiya');
}

console.log('\n[P2] Minimal summa: real savat 3 450, mijoz subtotal 999 999 yubordi');
{
  const { r, order } = await place(A, { items: [{ dishId: String(A.choy._id), name: 'Choy', quantity: 1, unitPrice: 3450 }], subtotal: 999999 });
  ok(r.status === 400 && r.body?.code === 'MIN_ORDER' && !order, `rad etildi: ${r.status} ${r.body?.code}`);
}

console.log('\n[P3] Bepul yetkazish chegarasi (200 000): real 78 200, mijoz 999 999 yubordi');
{
  const { r, order } = await place(A, { subtotal: 999999 });
  ok(r.status < 400 && order, 'yaratildi');
  ok(order.deliveryFee === P1.order.deliveryFee && order.deliveryFee > 0, `yetkazish bepul bo‘lmadi: ${order.deliveryFee} (halol: ${P1.order.deliveryFee})`);
  ok(order.subtotal === MENU, 'subtotal serverniki');
}

console.log('\n[P4] Olib ketish chegirmasi 10%: mijoz subtotal 999 999 yubordi');
{
  const { r, order } = await place(A, { subtotal: 999999, fulfillment: 'pickup' });
  ok(r.status < 400 && order, `yaratildi (${r.status} ${r.body?.error || ''})`);
  const f = order.finance;
  ok(f.discountAmount === Math.round(MENU * 0.1) * 100, `chegirma serverdan: ${f.discountAmount / 100} (= 10% × ${MENU})`);
  ok(f.foodSubtotal > 0 && f.restaurantFoodPayout > 0, 'taom tekinga tushmadi, restoran ulushi bor');
  ok(order.deliveryFee === 0 && order.total === f.totalCharged / 100 && Number.isInteger(order.total), `jami ${order.total} (butun so‘m)`);
  ok(reconcile(f).ok, 'rekonsiliatsiya');
}

console.log('\n[P5] Aksiya 10% (scope all): mijoz subtotal 999 999 yubordi');
{
  const { r, order } = await place(B, { subtotal: 999999 });
  ok(r.status < 400 && order, 'yaratildi');
  ok(order.finance.discountAmount === Math.round(MENU * 0.1) * 100, `aksiya chegirmasi serverdan: ${order.finance.discountAmount / 100}`);
}

console.log('\n[P6/P7] Narx va tanlovlarni soxtalashtirish');
{
  const items = [
    { dishId: String(A.plov._id), name: 'Arzon plov', quantity: 1, unitPrice: 1,
      selectedOptions: [{ name: '1 kg', price: 1, variant: true }, { name: 'Pishloq', price: 1 }, { name: 'Oltin', price: -50000 }] },   // Non (majburiy) yuborilmadi
    { dishId: String(A.choy._id), name: 'Choy', quantity: 2, unitPrice: 0 },
  ];
  const { r, order } = await place(A, { items, subtotal: 1 });
  ok(r.status < 400 && order, 'yaratildi (narxlar server bo‘yicha tuzatildi)');
  const plov = order.items.find((i) => String(i.dishId) === String(A.plov._id));
  ok(plov.unitPrice === 62000, `Plov bazasi serverdan: 55 000 + 5 000 + majburiy Non 2 000 = ${plov.unitPrice}`);
  ok(plov.name === 'Plov', 'nom bazadan (soxta nom yozilmadi)');
  ok(!plov.selectedOptions.some((o) => o.name === 'Oltin'), 'noma’lum tanlov (manfiy narx) e’tiborsiz');
  ok(plov.selectedOptions.some((o) => o.name === 'Non' && o.mandatory), 'majburiy qo‘shimcha majburan qo‘shildi');
  ok(order.subtotal === MENU && order.finance.foodBase === BASE * 100, `summa halol buyurtma bilan bir xil (${order.subtotal})`);
}

console.log('\n[P8] Miqdor: 0, manfiy, kasr, matn — rad etiladi');
for (const q of [0, -1, 1.5, '2']) {
  const { r, order } = await place(A, { items: [{ dishId: String(A.choy._id), name: 'Choy', quantity: q, unitPrice: 3450 }] });
  ok(r.status === 400 && !order, `quantity ${JSON.stringify(q)} → ${r.status}`);
}
{
  const { r, order } = await place(A, { items: [{ dishId: String(A.choy._id), name: 'Choy', quantity: 20, unitPrice: 1 }], subtotal: 1 });
  ok(r.status < 400 && order && order.subtotal === 3450 * 20, `katta miqdor serverda hisoblanadi: ${order?.subtotal}`);
}

console.log('\n[P9/P10] Bazada yo‘q pozitsiya va boshqa restoran taomi');
{
  const fake = new mongoose.Types.ObjectId();
  let x = await place(A, { items: [...honestItems(A), { dishId: String(fake), name: 'Soxta', quantity: 1, unitPrice: 1 }] });
  ok(x.r.status === 400 && x.r.body?.code === 'DISH_UNAVAILABLE' && !x.order, `mavjud bo‘lmagan dishId → ${x.r.status} ${x.r.body?.code}`);
  x = await place(A, { items: [...honestItems(A), { name: 'dishId yo‘q', quantity: 1, unitPrice: 1 }] });
  ok(x.r.status === 400 && x.r.body?.code === 'DISH_UNAVAILABLE' && !x.order, `dishId'siz pozitsiya → ${x.r.status} ${x.r.body?.code}`);
  x = await place(A, { items: [...honestItems(A), { dishId: String(B.choy._id), name: 'Choy', quantity: 1, unitPrice: 3450 }] });
  ok(x.r.status === 400 && !x.order, `boshqa restoran taomi → ${x.r.status} ${x.r.body?.code}`);
}

console.log('\n[P11] Mijoz deliveryFee / serviceFee / total yuborsa — e’tiborsiz');
{
  const { r, order } = await place(A, { orderExtra: { deliveryFee: 0, serviceFee: 50000, total: 1 } });
  ok(r.status < 400 && order, 'yaratildi');
  ok(order.deliveryFee === P1.order.deliveryFee, `yetkazish serverdan: ${order.deliveryFee}`);
  ok((order.serviceFee || 0) === 0, 'xizmat haqi 0 (v2 da ishlatilmaydi)');
  ok(order.total === P1.order.total, `jami halol buyurtma bilan bir xil: ${order.total}`);
}

console.log('\n[P12] Mijoz pozitsiyaga `category` yuborsa — saqlanmaydi (kategoriya aksiyasini soxtalashtirib bo‘lmaydi)');
{
  const items = honestItems(A).map((i) => ({ ...i, category: 'shirinlik' }));
  const { r, order } = await place(A, { items });
  ok(r.status < 400 && order && order.items.every((i) => i.category === undefined), 'category olib tashlandi');
}

await mongoose.connection.db.dropDatabase();
await mongoose.disconnect();
console.log(`\n${fails ? `✗ ${fails} ta XATO` : '✓ HAMMASI O‘TDI'} (${passes} tekshiruv)`);
process.exit(fails ? 1 : 0);
