/*
 * ═══════════════════════════════════════════════════════════
 * HAJM / RAZMER — NARX TEKSHIRUVI
 * ═══════════════════════════════════════════════════════════
 *
 * XATO: import qilingan taomlarda hajm guruhi oddiy qo'shimcha
 * sifatida hisoblanardi — pitsa 33/40 sm ikkalasi tanlansa narx
 * 61 500 + 61 500 + 76 875 = 199 875 bo'lardi. Server ham shunday
 * hisoblagani uchun mijozdan ortiqcha pul olinardi.
 *
 * npm run test:variants
 */
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_variants';
const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { Dish } = await import('../src/models/Dish.js');
const { verifyItemPrices } = await import('../src/services/priceVerification.js');
const { dishUnitPrice } = await import('../src/services/dishVariants.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const rid = new mongoose.Types.ObjectId();

/* Rasmdagi AYNAN ma'lumot — kind yo'q, multiple: true (import xatosi) */
const pizza = await Dish.create({
  restaurantId: rid, section: 'menu', name: 'Pepperoni kolbasa pitsa', price: 61500,
  optionGroups: [
    { title: 'Porsiya hajmi', required: true, multiple: true,
      options: [{ name: '33 sm', price: 61500 }, { name: '40 sm', price: 76875 }] },
    { title: 'Qo‘shimcha', multiple: true,
      options: [{ name: 'Pishloq', price: 5000 }] },
  ],
});
const item = (opts, qty = 1) => ({ dishId: String(pizza._id), name: 'x', quantity: qty, unitPrice: 1, selectedOptions: opts });

console.log('\n[1] Rasmdagi holat — server endi to‘g‘ri hisoblaydi');
let r = await verifyItemPrices([item([{ name: '33 sm', price: 61500 }])], rid);
ok(r.foodBaseSom === 61500, `33 sm → ${r.foodBaseSom} (avval 123 000)`);
r = await verifyItemPrices([item([{ name: '40 sm', price: 76875 }])], rid);
ok(r.foodBaseSom === 76875, `40 sm → ${r.foodBaseSom} (avval 138 375)`);
r = await verifyItemPrices([item([{ name: '33 sm', price: 61500 }, { name: '40 sm', price: 76875 }])], rid);
ok(r.foodBaseSom === 61500, `ikkalasi yuborilsa → ${r.foodBaseSom} (avval 199 875)`);
ok(r.mismatches.some((m) => /ortiqcha hajm/.test(m.reason)), 'ortiqcha hajm qayd etildi');

console.log('\n[2] Hajm + qo‘shimcha');
r = await verifyItemPrices([item([{ name: '40 sm', price: 76875 }, { name: 'Pishloq', price: 5000 }])], rid);
ok(r.foodBaseSom === 81875, `40 sm + pishloq → ${r.foodBaseSom}`);

console.log('\n[3] Restoranga qaysi hajm borishi');
const opts = r.items[0].selectedOptions;
ok(opts.find((o) => o.name === '40 sm')?.variant === true, '40 sm — hajm deb belgilandi');
ok(opts.find((o) => o.name === 'Pishloq')?.variant === false, 'Pishloq — qo‘shimcha');
ok(opts.find((o) => o.name === '40 sm')?.group === 'Porsiya hajmi', 'guruh nomi saqlandi');

console.log('\n[4] Eski ilova hajm tanlamay yubordi — eng arzoni qo‘llanadi');
r = await verifyItemPrices([item([])], rid);
ok(r.foodBaseSom === 61500, `hajmsiz → ${r.foodBaseSom} (eng arzon 33 sm)`);
ok(r.items[0].selectedOptions[0]?.name === '33 sm', 'restoranga ham 33 sm boradi');

console.log('\n[5] Soxta narx — server bazadan oladi');
r = await verifyItemPrices([item([{ name: '40 sm', price: 1 }])], rid);
ok(r.foodBaseSom === 76875, `mijoz 1 so‘m yubordi → ${r.foodBaseSom}`);

console.log('\n[6] Miqdor');
r = await verifyItemPrices([item([{ name: '40 sm', price: 76875 }], 3)], rid);
ok(r.foodBaseSom === 230625, `3 × 40 sm → ${r.foodBaseSom}`);

console.log('\n[7] Eski taomlar (hajmsiz) buzilmaydi');
const osh = await Dish.create({
  restaurantId: rid, section: 'menu', name: 'Osh', price: 35000,
  optionGroups: [{ title: 'Qo‘shimcha', options: [{ name: 'Qazi', price: 10000 }] }],
});
r = await verifyItemPrices([{ dishId: String(osh._id), quantity: 1, unitPrice: 45000,
  selectedOptions: [{ name: 'Qazi', price: 10000 }] }], rid);
ok(r.foodBaseSom === 45000, `osh + qazi → ${r.foodBaseSom} (avvalgidek qo‘shiladi)`);

console.log('\n[8] Admin aniq belgilagan guruh');
const custom = await Dish.create({
  restaurantId: rid, section: 'menu', name: 'Somsa', price: 8000,
  optionGroups: [{ title: 'Tanlang', kind: 'variant',
    options: [{ name: 'Kichik', price: 6000 }, { name: 'Katta', price: 12000 }] }],
});
r = await verifyItemPrices([{ dishId: String(custom._id), quantity: 1, unitPrice: 12000,
  selectedOptions: [{ name: 'Katta', price: 12000 }] }], rid);
ok(r.foodBaseSom === 12000, `kind=variant, sarlavhada hajm so‘zi yo‘q → ${r.foodBaseSom}`);

console.log('\n[9] Client va server BIR XIL natija beradi');
const doc = pizza.toObject();
const clientLike = { price: doc.price, optionGroups: doc.optionGroups };
for (const sel of [['33 sm'], ['40 sm'], ['40 sm', 'Pishloq'], []]) {
  const chosen = sel.map((n) => doc.optionGroups.flatMap((g) => g.options).find((o) => o.name === n));
  const client = dishUnitPrice(clientLike, chosen);
  const server = (await verifyItemPrices([item(chosen.map((o) => ({ name: o.name, price: o.price })))], rid)).foodBaseSom;
  // Bo'sh tanlovda client baza narxini, server eng arzon variantni oladi — ikkalasi 61 500
  ok(client === server, `[${sel.join(', ') || 'tanlovsiz'}] client ${client} = server ${server}`);
}

await mongoose.disconnect();
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
process.exit(fails ? 1 : 0);
