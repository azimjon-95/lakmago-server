/*
 * ═══════════════════════════════════════════════════════════
 * YETKAZISH — BOSHLANG'ICH NARX (basePrice)
 * ═══════════════════════════════════════════════════════════
 *
 *   narx = basePrice + (masofa − freeKm) × perKm
 *   masofa freeKm ichida bo'lsa — faqat basePrice (0 bo'lsa BEPUL)
 *
 * Tekshiriladi:
 *   [A] sof formula (chegaralar, yaxlitlash, chegara summasi, noma'lum masofa)
 *   [B] panel saqlashi: eski panel (basePrice yubormaydi) uni O'CHIRMASLIGI kerak
 *   [C] narx so'rovi (/maps/delivery-quote) va buyurtma yaratish → moliyaviy
 *       snapshot: pul hisoboti to'g'ri, qo'shimcha summa 100% restoranga
 *
 * npm run test:baseprice
 */
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/lokma_baseprice';
process.env.JWT_SECRET = 'x'.repeat(40); process.env.NODE_ENV = 'development';
process.env.RESTAURANT_BOT_TOKEN = '1:X';
globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, result: { message_id: 1 } }) });

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { calcDeliveryPrice, roadDistanceKm } = await import('../src/services/deliveryEngine.js');
const { Restaurant } = await import('../src/models/Restaurant.js');
const { Dish } = await import('../src/models/Dish.js');
const { User } = await import('../src/models/User.js');
const { Order } = await import('../src/models/Order.js');
const { CommissionAgreement } = await import('../src/models/CommissionAgreement.js');
const { orderController } = await import('../src/controllers/misc.js');
const { restaurantPanelController } = await import('../src/controllers/restaurantPanel.js');
const { mapsController } = await import('../src/controllers/maps.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
const call = async (fn, req) => {
  let status = 200; let body = null;
  const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
  await fn(req, res, (e) => { body = { next: e?.message }; status = 500; });
  await wait(400);
  return { status, body };
};

/* Restoran: perKm rejimi, 1 km / 2 000 so'm, chegara 300 000 */
const R = (delivery = {}, extra = {}) => ({
  deliveryEnabled: true, deliveryFee: 15000, freeDeliveryThreshold: 300000,
  delivery: { maxDistanceKm: 20, pricingMode: 'perKm', freeKm: 1, perKm: 2000, ...delivery },
  ...extra,
});
const price = (d, delivery, subtotal = 50000, extra) => calcDeliveryPrice(d, R(delivery, extra), subtotal).price;

console.log('\n[A1] basePrice 0 (standart) — avvalgi xatti-harakat AYNAN saqlanadi');
{
  ok(price(0.4, { basePrice: 0 }) === 0, '0.4 km → bepul');
  ok(price(1.0, { basePrice: 0 }) === 0, '1 km (chegara) → bepul');
  ok(price(3.0, { basePrice: 0 }) === 4000, '3 km → 4 000 (panel misoli: "Masalan 3 km: 4 000")');
  ok(price(3.0, {}) === 4000, 'basePrice yozilmagan (eski restoran) → xuddi shu');
  ok(price(3.0, { basePrice: undefined }) === 4000 && price(3.0, { basePrice: null }) === 4000, 'undefined/null → 0 deb olinadi');
  ok(calcDeliveryPrice(0.4, R({ basePrice: 0 }), 1000).free === true, 'bepul masofada free: true');
}

console.log('\n[A2] basePrice 5 000, freeKm 1, perKm 2 000 — "1 km ga 5 ming, keyin har km uchun qo‘shiladi"');
{
  const b = { basePrice: 5000 };
  ok(price(0.1, b) === 5000, '0.1 km → 5 000 (masofa ichida qat‘iy)');
  ok(price(0.4, b) === 5000, '0.4 km → 5 000');
  ok(price(1.0, b) === 5000, '1.0 km (aynan chegarada) → 5 000');
  ok(price(1.5, b) === 6000, '1.5 km → 5 000 + 0.5×2 000 = 6 000');
  ok(price(2.0, b) === 7000, '2 km → 5 000 + 1×2 000 = 7 000');
  ok(price(3.0, b) === 9000, '3 km → 5 000 + 2×2 000 = 9 000');
  ok(price(3.3, b) === 9600, '3.3 km → 5 000 + 2.3×2 000 = 9 600');
  ok(price(10.0, b) === 23000, '10 km → 5 000 + 9×2 000 = 23 000');
  const q = calcDeliveryPrice(3.0, R(b), 50000);
  ok(q.free === false && q.breakdown.basePrice === 5000 && q.breakdown.extraFee === 4000, `tafsilot: base ${q.breakdown.basePrice} + km qismi ${q.breakdown.extraFee}`);
}

console.log('\n[A3] Yaxlitlash: faqat km qismi 100 ga; restoran kiritgan basePrice o‘zgarmaydi');
{
  ok(price(2.333, { basePrice: 5000, perKm: 1700 }) === 7300, '5 000 + round100(1.333×1 700 = 2 266) = 7 300');
  ok(price(1.0, { basePrice: 5050 }) === 5050, 'basePrice 5 050 — aynan 5 050 (100 ga yaxlitlanmaydi)');
  ok(price(2.0, { basePrice: 5050 }) === 7050, '5 050 + 2 000 = 7 050');
  ok(price(1.5, { basePrice: 5000.7 }) === 6001, 'kasr basePrice butun so‘mgacha: 5 001 + 1 000');
}

console.log('\n[A4] freeKm = 0: boshlang‘ich narx = "chaqiruv" haqi, ustiga har km');
{
  ok(price(0.2, { freeKm: 0, basePrice: 3000, perKm: 1000 }) === 3200, '0.2 km → 3 000 + 200');
  ok(price(2.0, { freeKm: 0, basePrice: 3000, perKm: 1000 }) === 5000, '2 km → 3 000 + 2 000');
  ok(price(2.0, { freeKm: 0, basePrice: 0, perKm: 1000 }) === 2000, 'basePrice 0 — avvalgidek (birinchi metrdan pullik)');
}

console.log('\n[A5] perKm = 0: basePrice — masofaga bog‘liq bo‘lmagan bitta narx');
{
  ok(price(0.5, { basePrice: 7000, perKm: 0 }) === 7000 && price(9, { basePrice: 7000, perKm: 0 }) === 7000, 'har qanday masofada 7 000');
}

console.log('\n[A6] Bepul chegarasi basePrice bilan ham ishlaydi');
{
  const b = { basePrice: 5000 };
  ok(price(3.0, b, 300000) === 0 && calcDeliveryPrice(3.0, R(b), 300000).free === true, 'summa chegaradan oshdi → bepul');
  ok(price(3.0, b, 299999) === 9000, '1 so‘m kam → pullik (9 000)');
  ok(price(0.4, b, 300000) === 0, 'bepul masofada ham chegaradan oshsa → 0');
}

console.log('\n[A7] Masofa NOMA‘LUM (koordinata yo‘q) — qat‘iy narx, lekin boshlang‘ich narxdan kam emas');
{
  ok(price(NaN, { basePrice: 0 }) === 15000, 'basePrice 0: qat‘iy 15 000 (avvalgidek)');
  ok(price(NaN, { basePrice: 5000 }) === 15000, 'qat‘iy 15 000 ≥ basePrice → 15 000');
  ok(price(NaN, { basePrice: 20000 }) === 20000, 'basePrice 20 000 > qat‘iy → 20 000 (tekin bo‘lib ketmaydi)');
  ok(price(NaN, { basePrice: 5000 }, 50000, { deliveryFee: 0 }) === 5000, 'qat‘iy narx 0, basePrice 5 000 → 5 000 (avval 0 = tekin edi)');
  ok(price(NaN, { basePrice: 0 }, 50000, { deliveryFee: 0 }) === 0, 'ikkalasi 0 → bepul (avvalgidek)');
}

console.log('\n[A8] Qat‘iy narx rejimi basePrice’ga TEGMAYDI; radius va o‘chirish saqlanadi');
{
  ok(price(3.0, { pricingMode: 'flat', basePrice: 5000 }) === 15000, 'flat: basePrice e‘tiborsiz, 15 000');
  const far = calcDeliveryPrice(25, R({ basePrice: 5000 }), 1000);
  ok(far.available === false && far.code === 'OUT_OF_RANGE', 'radiusdan uzoq — baribir rad etiladi');
  ok(calcDeliveryPrice(1, R({ basePrice: 5000 }, { deliveryEnabled: false }), 1000).code === 'DELIVERY_DISABLED', 'yetkazish o‘chirilgan — rad');
}

console.log('\n[A9] Buzuq qiymatlar pulni buzmaydi');
{
  ok(price(3.0, { basePrice: -500 }) === 4000, 'manfiy → 0 (chegirma bo‘lib ketmaydi)');
  ok(price(3.0, { basePrice: '5000' }) === 9000, 'satr "5000" → 5 000');
  ok(price(3.0, { basePrice: 'abc' }) === 4000 && price(3.0, { basePrice: NaN }) === 4000, 'matn/NaN → 0');
  ok(Number.isInteger(price(2.777, { basePrice: 5000, perKm: 1333 })), 'natija doim butun son');
}

/* ═══ [B] PANEL SAQLASHI ═══ */
/*
 * FerretDB (faqat TEST bazasi) findAndModify ichidagi maydon proyeksiyasini
 * ("fields") qo'llamaydi — updateProfile'dagi `.select('-ownerId …')` shu
 * sababli 500 berardi. Real MongoDB'da bu ishlaydi. Test uchun FAQAT shu
 * proyeksiya o'chiriladi: yangilash hujjati (dotted-path'lar, validatorlar)
 * bazaga AYNAN production'dagidek boradi — asl tekshiriladigan narsa shu.
 */
const origFBU = Restaurant.findByIdAndUpdate.bind(Restaurant);
Restaurant.findByIdAndUpdate = (...a) => { const q = origFBU(...a); q.select = () => q; return q; };

const PL = await Restaurant.create({
  name: 'PANEL', cuisine: 'milliy', category: 'restoran', isActive: true, lat: 41.3111, lng: 69.2797,
  delivery: { maxDistanceKm: 10, pricingMode: 'perKm', freeKm: 1, perKm: 2000 },
});
const rawDelivery = async () => (await Restaurant.collection.findOne({ _id: PL._id })).delivery;
const save = (body) => call(restaurantPanelController.updateProfile, { restaurantId: String(PL._id), body });

console.log('\n[B1] Panel basePrice’ni saqlaydi');
{
  const r = await save({ delivery: { maxDistanceKm: 10, pricingMode: 'perKm', freeKm: 1, basePrice: 5000, perKm: 2000 } });
  ok(r.status === 200 && r.body.delivery.basePrice === 5000, `javob: basePrice ${r.body?.delivery?.basePrice}`);
  ok((await rawDelivery()).basePrice === 5000, 'bazada 5 000');
}

console.log('\n[B2] ESKI PANEL (basePrice yubormaydi) saqlasa — boshlang‘ich narx O‘CHMAYDI');
{
  const r = await save({ delivery: { maxDistanceKm: 12, pricingMode: 'perKm', freeKm: 1, perKm: 2000 }, name: 'PANEL (eski)' });
  const d = await rawDelivery();
  ok(r.status === 200 && d.maxDistanceKm === 12, 'yuborilgan maydon (radius 12) yangilandi');
  ok(d.basePrice === 5000, `basePrice saqlanib qoldi: ${d.basePrice} (avval jimgina 0 bo‘lardi → mijozlar tekin oladi)`);
}

console.log('\n[B3] Qisman yangilash — boshqa delivery maydonlari saqlanadi');
{
  await save({ delivery: { perKm: 2500 } });
  const d = await rawDelivery();
  ok(d.perKm === 2500 && d.pricingMode === 'perKm' && d.freeKm === 1 && d.maxDistanceKm === 12 && d.basePrice === 5000,
    `faqat perKm o‘zgardi: ${JSON.stringify(d)}`);
  await save({ name: 'Boshqa nom' });
  ok((await rawDelivery()).basePrice === 5000, 'delivery yuborilmasa umuman tegilmaydi');
  await save({ delivery: { basePrice: 0 } });
  ok((await rawDelivery()).basePrice === 0, 'basePrice ni 0 ga qaytarish mumkin (bepul)');
  await save({ delivery: { basePrice: 5000, perKm: 2000 } });
}

console.log('\n[B4] Noto‘g‘ri qiymat rad etiladi (400), bazaga yozilmaydi');
{
  for (const [name, v] of [['manfiy', -1], ['juda katta', 500001], ['matn', 'abc'], ['NaN', NaN]]) {
    const r = await save({ delivery: { basePrice: v } });
    ok(r.status === 400, `${name} → ${r.status}`);
  }
  ok((await rawDelivery()).basePrice === 5000, 'rad etilgach bazadagi qiymat o‘zgarmadi');
  ok((await save({ delivery: { basePrice: 500000 } })).status === 200, 'chegara (500 000) qabul qilinadi');
  await save({ delivery: { basePrice: 5000 } });
}

/* ═══ [C] NARX SO'ROVI + BUYURTMA + PUL HISOBOTI ═══ */
const LAT = 41.2856; const LNG = 69.2034;   // mijoz
const RLAT = 41.3111; const RLNG = 69.2797; // restoranlar
const mkRest = async (name, basePrice) => {
  const r = await Restaurant.create({
    name, cuisine: 'milliy', category: 'restoran', lat: RLAT, lng: RLNG, deliveryEnabled: true, deliveryFee: 0,
    delivery: { maxDistanceKm: 0, pricingMode: 'perKm', freeKm: 1, perKm: 2000, basePrice },
    address: 'Sang senter', openTime: '00:00', closeTime: '23:59', isActive: true, isApproved: true,
    workingDays: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
  });
  await CommissionAgreement.create({ restaurantId: r._id, restaurantCommissionPercent: 10, customerFeePercent: 0, effectiveFrom: new Date() });
  const dish = await Dish.create({ restaurantId: r._id, section: 'menu', name: 'Pasta', price: 10000 });
  return { r, dish };
};
const A = await mkRest('BASE-5000', 5000);
const B = await mkRest('BASE-0', 0);
const user = await User.create({ firstName: 'Azimjon', telegramId: '55', phone: '+998901112233', addresses: [{ label: 'Uy', address: 'Sohil', lat: LAT, lng: LNG }] });
const DIST = await roadDistanceKm({ lat: RLAT, lng: RLNG }, { lat: LAT, lng: LNG });
const expectedExtra = Math.round((Math.max(0, DIST - 1) * 2000) / 100) * 100;

console.log(`\n[C1] Narx so‘rovi (mijoz savatda ko‘radigan narx) — masofa ${DIST.toFixed(2)} km`);
{
  const q = async (x) => (await call(mapsController.deliveryQuote, { query: { restaurantId: String(x.r._id), lat: String(LAT), lng: String(LNG), subtotal: '10000' } })).body;
  const a = await q(A); const b = await q(B);
  ok(b.deliveryPrice === expectedExtra, `basePrice 0: ${b.deliveryPrice} (= faqat km qismi ${expectedExtra})`);
  ok(a.deliveryPrice === 5000 + expectedExtra, `basePrice 5 000: ${a.deliveryPrice} (= 5 000 + ${expectedExtra})`);
  ok(a.deliveryPrice - b.deliveryPrice === 5000, 'farq aynan 5 000');
  ok(a.breakdown.basePrice === 5000 && a.breakdown.extraFee === expectedExtra, 'javobda tafsilot: basePrice va extraFee');
  ok(a.deliveryFree === false, 'bepul emas');
}

const place = async (x) => {
  const req = { userId: String(user._id), user: { _id: user._id }, body: {
    address: 'Uy — Sohil', phone: '+998901112233', paymentMethod: 'cash', paymentLabel: 'Naqd',
    fulfillment: 'delivery', timingMode: 'asap', addressLat: LAT, addressLng: LNG,
    orders: [{ restaurantId: String(x.r._id), restaurantName: x.r.name, subtotal: 10000,
      items: [{ dishId: String(x.dish._id), name: 'Pasta', quantity: 1, unitPrice: 10000 }] }],
  } };
  const r = await call(orderController.create, req);
  return { r, order: await Order.findOne({ restaurantId: x.r._id }).lean() };
};

console.log('\n[C2] Buyurtma: yetkazish narxi SERVERDA, mijoz yuborgan qiymatga ishonilmaydi');
const oa = await place(A); const ob = await place(B);
{
  ok(oa.r.status < 400 && ob.r.status < 400, `ikkala buyurtma yaratildi (${oa.r.status}/${ob.r.status})`);
  ok(ob.order.deliveryFee === expectedExtra, `basePrice 0 buyurtma: yetkazish ${ob.order.deliveryFee}`);
  ok(oa.order.deliveryFee === 5000 + expectedExtra, `basePrice 5 000 buyurtma: yetkazish ${oa.order.deliveryFee} = 5 000 + ${expectedExtra}`);
  ok(oa.order.total === 10000 + oa.order.deliveryFee, `jami = taom + yetkazish: ${oa.order.total}`);
}

console.log('\n[C3] PUL HISOBOTI: qo‘shimcha 5 000 to‘liq restoranga, komissiya o‘zgarmaydi, hisob tenglashadi');
{
  const fa = oa.order.finance; const fb = ob.order.finance;
  ok(fa?.model === 'v2' && fb?.model === 'v2', 'ikkalasida v2 snapshot bor');
  ok(fa.deliveryFee === oa.order.deliveryFee * 100, `snapshot yetkazish (tiyin): ${fa.deliveryFee}`);
  ok(fa.totalCharged === oa.order.total * 100, `mijozdan yechilgan: ${fa.totalCharged / 100}`);
  ok(fa.totalCharged === fa.foodSubtotal + fa.customerFeeAmount + fa.deliveryFee, 'jami = taom + mijoz haqi + yetkazish (rekonsiliatsiya)');
  ok(fa.restaurantCommissionAmount === fb.restaurantCommissionAmount && fa.lokmaGrossCommission === fb.lokmaGrossCommission,
    `komissiya bir xil (${fa.lokmaGrossCommission / 100}) — yetkazish narxi komissiya bazasiga KIRMAYDI`);
  ok(fa.restaurantPayout - fb.restaurantPayout === 500000, `restoran ulushi aynan +5 000 (${(fa.restaurantPayout - fb.restaurantPayout) / 100})`);
  ok(fa.restaurantPayout === fa.foodSubtotal - fa.restaurantCommissionAmount + fa.deliveryFee, 'restoranga = taom − komissiya + yetkazish (100%)');
}

/* ═══ [D] SERVER ↔ CLIENT PARITY ═══ */
console.log('\n[D] Client nusxasi (lib/pricing.js) serverdagi formula bilan HAR QANDAY kirishda bir xil');
{
  const { existsSync } = await import('node:fs');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const clientPath = fileURLToPath(new URL('../../lakmago-client/src/lib/pricing.js', import.meta.url));
  if (!existsSync(clientPath)) {
    console.log('  – lakmago-client yonma-yon topilmadi — parity tekshiruvi o‘tkazib yuborildi');
  } else {
    const { calcDeliveryFee } = await import(pathToFileURL(clientPath).href);
    const distances = [NaN, 0, 0.3, 1, 1.0001, 1.5, 2.333, 3, 7.77, 15];
    let checked = 0; const diffs = [];
    for (const mode of ['flat', 'perKm']) for (const d of distances) for (const basePrice of [0, 3000, 5000, 5050, 20000])
      for (const freeKm of [0, 1, 2.5]) for (const perKm of [0, 1700, 2000]) for (const deliveryFee of [0, 15000])
        for (const freeDeliveryThreshold of [0, 40000]) for (const subtotal of [10000, 40000, 100000]) {
          const rest = { deliveryEnabled: true, deliveryFee, freeDeliveryThreshold, delivery: { maxDistanceKm: 0, pricingMode: mode, freeKm, perKm, basePrice } };
          const server = calcDeliveryPrice(d, rest, subtotal).price;
          // Masofa noma'lum bo'lganda client'ga null beriladi (CartPage: `distanceKm ?? null`)
          const client = calcDeliveryFee(subtotal, rest, false, Number.isNaN(d) ? null : d);
          checked++;
          if (server !== client && diffs.length < 3) diffs.push({ mode, d, basePrice, freeKm, perKm, deliveryFee, freeDeliveryThreshold, subtotal, server, client });
        }
    ok(diffs.length === 0, `${checked} ta kombinatsiya: server va client narxi bir xil${diffs.length ? ' — FARQ: ' + JSON.stringify(diffs[0]) : ''}`);
    const rest = R({ basePrice: 5000 });
    ok(calcDeliveryFee(50000, rest, false, 3) === 9000, 'client: 3 km, basePrice 5 000 → 9 000');
    ok(calcDeliveryFee(50000, rest, false, null) === 15000 && calcDeliveryFee(50000, rest, false) === 15000, 'client: masofa noma‘lum (null/berilmagan) → qat‘iy narx (avval 0 = "bepul" chiqardi)');
    ok(calcDeliveryFee(50000, rest, true, 3) === 0, 'client: olib ketishda yetkazish yo‘q');

    // Kasr perKm (API orqali kelishi mumkin): server Math.round qiladi — client ham
    const frac = { deliveryEnabled: true, deliveryFee: 0, freeDeliveryThreshold: 0, delivery: { maxDistanceKm: 0, pricingMode: 'perKm', freeKm: 1, perKm: 1700.5, basePrice: 5000 } };
    ok(calcDeliveryPrice(3.3, frac, 1).price === calcDeliveryFee(1, frac, false, 3.3), 'kasr perKm (1 700.5): server = client');
  }

  // Panel "Mijoz nimani ko'radi" misoli ham serverdan farq qilmasin
  const adminPath = fileURLToPath(new URL('../../lakmago-admin/src/lib/deliveryFee.js', import.meta.url));
  if (!existsSync(adminPath)) {
    console.log('  – lakmago-admin yonma-yon topilmadi — panel ko‘rinishi parity tekshiruvi o‘tkazib yuborildi');
  } else {
    const { perKmFee } = await import(pathToFileURL(adminPath).href);
    let checked = 0; let bad = null;
    for (const d of [0, 0.3, 1, 1.5, 2.333, 3, 7.77]) for (const basePrice of [0, 3000, 5000, 5050]) for (const freeKm of [0, 1, 2.5]) for (const perKm of [0, 1700, 2000]) {
      const rest = { deliveryEnabled: true, deliveryFee: 0, freeDeliveryThreshold: 0, delivery: { maxDistanceKm: 0, pricingMode: 'perKm', freeKm, perKm, basePrice } };
      checked++;
      if (calcDeliveryPrice(d, rest, 1).price !== perKmFee(d, { freeKm, perKm, basePrice }) && !bad) bad = { d, basePrice, freeKm, perKm };
    }
    ok(!bad, `panel ko‘rinishi (perKmFee): ${checked} ta kombinatsiya serverga teng${bad ? ' — FARQ ' + JSON.stringify(bad) : ''}`);
  }
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
