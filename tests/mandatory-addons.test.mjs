/*
 * ═══════════════════════════════════════════════════════════
 * MAJBURIY QO'SHIMCHA — NARX TEKSHIRUVI
 * ═══════════════════════════════════════════════════════════
 *
 * TZ: restoran bir qo'shimchani "majburiy" deb belgilasa, mijoz
 * uni buyurtmadan OLIB TASHLAY OLMAYDI va narxi HAR DOIM olinadi
 * — mijoz ilovasi buni yubormasa (yoki ataylab tashlab ketsa)
 * ham server MAJBURAN qo'shadi (CLAUDE.md 5-qoida: "server narxga
 * ishonmaydi" — bu yerda "server tanlovga ham ishonmaydi").
 *
 * npm run test:mandatory
 */
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_mandatory';
const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { Dish } = await import('../src/models/Dish.js');
const { verifyItemPrices } = await import('../src/services/priceVerification.js');
const { restaurantPanelController } = await import('../src/controllers/restaurantPanel.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const wait = (ms = 250) => new Promise((r) => setTimeout(r, ms));
function mockRes() {
  return { _c: 200, status(c) { this._c = c; return this; }, json(b) { this._body = b; return this; } };
}

const rid = new mongoose.Types.ObjectId();
const item = (dishId, opts = [], qty = 1) => ({
  dishId: String(dishId), name: 'x', quantity: qty, unitPrice: 1, selectedOptions: opts,
});

/* ═══ Taom: non — bepul, "Sous" majburiy +3000, "Piyoz" ixtiyoriy +1000 ═══ */
const dish = await Dish.create({
  restaurantId: rid, section: 'menu', name: 'Somsa', price: 15000,
  optionGroups: [
    {
      title: 'Qo‘shimchalar', kind: 'addon', required: false, multiple: true,
      options: [
        { name: 'Sous', price: 3000, mandatory: true },
        { name: 'Piyoz', price: 1000, mandatory: false },
      ],
    },
  ],
});

console.log('\n[1] Mijoz HECH NARSA yubormadi — majburiy Sous baribir hisoblanadi');
{
  const r = await verifyItemPrices([item(dish._id, [])], rid);
  ok(r.foodBaseSom === 18000, `15000 (taom) + 3000 (majburiy Sous) = ${r.foodBaseSom}`);
  const sel = r.items[0].selectedOptions;
  ok(sel.length === 1 && sel[0].name === 'Sous', `selectedOptions'da faqat Sous bor: ${JSON.stringify(sel)}`);
  ok(sel[0].mandatory === true, 'Sous mandatory:true bilan belgilangan');
}

console.log('\n[2] Mijoz ATAYLAB Sous\'ni tashlab, faqat Piyoz yubordi — Sous baribir qo‘shiladi');
{
  const r = await verifyItemPrices([item(dish._id, [{ name: 'Piyoz', price: 1000 }])], rid);
  ok(r.foodBaseSom === 19000, `15000 + 1000 (Piyoz) + 3000 (majburiy Sous) = ${r.foodBaseSom}`);
  const names = r.items[0].selectedOptions.map((s) => s.name).sort();
  ok(JSON.stringify(names) === JSON.stringify(['Piyoz', 'Sous']), `ikkalasi ham bor: ${names}`);
}

console.log('\n[3] Mijoz Sous\'ni O‘ZI HAM yubordi — IKKI MARTA hisoblanmaydi');
{
  const r = await verifyItemPrices([item(dish._id, [{ name: 'Sous', price: 3000 }])], rid);
  ok(r.foodBaseSom === 18000, `takror qo‘shilmadi: ${r.foodBaseSom} (18000 bo‘lishi kerak, 21000 emas)`);
  ok(r.items[0].selectedOptions.filter((s) => s.name === 'Sous').length === 1, 'Sous faqat 1 marta ro‘yxatda');
}

console.log('\n[4] Ixtiyoriy qo‘shimcha (Piyoz) — yuborilmasa qo‘shilmaydi (avvalgi xatti-harakat)');
{
  const r = await verifyItemPrices([item(dish._id, [])], rid);
  ok(!r.items[0].selectedOptions.some((s) => s.name === 'Piyoz'), 'Piyoz yo‘q (majburiy emas)');
}

console.log('\n[5] Mijoz narxni SOXTALASHTIRISHGA urindi (unitPrice: 1) — server narxi g‘olib');
{
  const fake = { dishId: String(dish._id), name: 'x', quantity: 1, unitPrice: 1, selectedOptions: [] };
  const r = await verifyItemPrices([fake], rid);
  ok(r.items[0].unitPrice === 18000, `server narxi qo‘llandi (1 emas): ${r.items[0].unitPrice}`);
  // Farq LOGGA yozilishi TO'G'RI xatti-harakat — bu monitoring
  // uchun kerak (client:1 / server:18000 kabi keskin farq
  // firibgarlik urinishidan darak berishi mumkin).
  ok(r.mismatches.some((m) => m.client === 1 && m.server === 18000),
    `farq to‘g‘ri qayd etildi: ${JSON.stringify(r.mismatches)}`);
}

/* ═══ Kombinatsiya: hajm (variant) + majburiy qo‘shimcha bitta taomda ═══ */
const pizza = await Dish.create({
  restaurantId: rid, section: 'menu', name: 'Pitsa', price: 50000,
  optionGroups: [
    { title: 'Porsiya hajmi', kind: 'variant', required: true, multiple: false,
      options: [{ name: '33 sm', price: 61500 }, { name: '40 sm', price: 76875 }] },
    { title: 'Qo‘shimchalar', kind: 'addon', required: false, multiple: true,
      options: [{ name: 'Quti', price: 2000, mandatory: true }] },
  ],
});

console.log('\n[6] Hajm + majburiy qo‘shimcha BIRGA — mijoz hajm tanlamadi (eski ilova)');
{
  const r = await verifyItemPrices([item(pizza._id, [])], rid);
  // Hajm tanlanmagan → eng arzon (33 sm, 61500) + majburiy Quti (2000)
  ok(r.foodBaseSom === 63500, `eng arzon hajm (61500) + majburiy Quti (2000) = ${r.foodBaseSom}`);
  const sel = r.items[0].selectedOptions;
  ok(sel.some((s) => s.name === '33 sm' && s.variant === true), '33 sm variant sifatida qo‘yildi');
  ok(sel.some((s) => s.name === 'Quti' && s.mandatory === true), 'Quti majburiy sifatida qo‘yildi');
}

console.log('\n[7] Hajm + majburiy qo‘shimcha — mijoz 40 sm tanladi');
{
  const r = await verifyItemPrices([item(pizza._id, [{ name: '40 sm', price: 76875 }])], rid);
  ok(r.foodBaseSom === 78875, `40 sm (76875) + majburiy Quti (2000) = ${r.foodBaseSom}`);
}

console.log('\n[8] REGRESSIYA: pitsa 33/40 sm — eski xato (199 875) qaytmaganini tasdiqlash');
{
  const r = await verifyItemPrices([item(pizza._id, [
    { name: '33 sm', price: 61500 }, { name: '40 sm', price: 76875 },
  ])], rid);
  // Ikkinchi hajm rad etiladi, faqat birinchisi + majburiy Quti
  ok(r.foodBaseSom === 63500, `ikkinchi hajm rad etildi, 33 sm + Quti = ${r.foodBaseSom} (199875 EMAS)`);
  ok(r.mismatches.some((m) => m.reason?.includes('ortiqcha hajm')), 'ortiqcha hajm sabab bilan qayd etildi');
}

/* ═══ Admin zod: variant guruhidagi 'mandatory' xavfsizlik uchun tozalanadi ═══ */
console.log('\n[9] Admin: variant guruhidagi mandatory:true serverda false\'ga tushiriladi');
{
  const req = {
    restaurantId: String(rid),
    body: {
      section: 'menu', name: 'Lag‘mon', price: 20000,
      optionGroups: [
        { title: 'Hajmi', kind: 'variant', options: [
          { name: 'Kichik', price: 20000, mandatory: true }, // ← noto'g'ri urinish
          { name: 'Katta', price: 25000 },
        ] },
      ],
    },
  };
  const res = mockRes();
  await restaurantPanelController.createDish(req, res, () => {});
  await wait();
  ok(res._c === 200 || res._c === 201, `taom yaratildi: ${res._c}`);
  const saved = await Dish.findById(res._body?._id).lean();
  ok(saved?.optionGroups?.[0]?.options?.every((o) => o.mandatory === false),
    'variant guruhidagi HAMMA option mandatory:false (xavfsizlik tozalashi ishladi)');
}

console.log('\n[10] Admin: addon guruhidagi mandatory:true TO‘G‘RI saqlanadi');
{
  const req = {
    restaurantId: String(rid),
    body: {
      section: 'menu', name: 'Osh', price: 30000,
      optionGroups: [
        { title: 'Qo‘shimchalar', kind: 'addon', options: [
          { name: 'Salat', price: 5000, mandatory: true },
          { name: 'Choy', price: 0, mandatory: false },
        ] },
      ],
    },
  };
  const res = mockRes();
  await restaurantPanelController.createDish(req, res, () => {});
  await wait();
  const saved = await Dish.findById(res._body?._id).lean();
  const salat = saved?.optionGroups?.[0]?.options?.find((o) => o.name === 'Salat');
  const choy = saved?.optionGroups?.[0]?.options?.find((o) => o.name === 'Choy');
  ok(salat?.mandatory === true, `Salat majburiy saqlandi: ${salat?.mandatory}`);
  ok(choy?.mandatory === false, `Choy ixtiyoriy qoldi: ${choy?.mandatory}`);
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
await mongoose.disconnect();
process.exit(fails ? 1 : 0);
