/*
 * ═══════════════════════════════════════════════════════════
 * MOLIYAVIY OQIM — UCHDAN-UCHGACHA TEST
 * ═══════════════════════════════════════════════════════════
 *
 * Buyurtma yaratish → snapshot → hisob-kitob (Ledger) →
 * shlyuz bo'linishi. Har bosqichda bir xil raqamlar chiqishi
 * tekshiriladi.
 *
 * Baza: FerretDB (mahalliy). Telegram va socket soxtalashtiriladi.
 * Ishga tushirish: npm run test:flow
 */
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_finflow';
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.NODE_ENV = 'development';

globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, result: {} }) });

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { Restaurant } = await import('../src/models/Restaurant.js');
const { Dish } = await import('../src/models/Dish.js');
const { User } = await import('../src/models/User.js');
const { Order } = await import('../src/models/Order.js');
const { Ledger } = await import('../src/models/Ledger.js');
const { CommissionAgreement } = await import('../src/models/CommissionAgreement.js');
const { computeOrderFinance, reconcile, somToTiyin, tiyinToSom } = await import('../src/services/orderFinance.js');
const { verifyItemPrices } = await import('../src/services/priceVerification.js');
const { splitFromFinance } = await import('../src/services/paymentSplit.js');
const { settleOrder } = await import('../src/services/billing.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const som = (t) => tiyinToSom(t);

const user = await User.create({ firstName: 'Mijoz', telegramId: '777' });

/** Bitta test stsenariysi uchun to'liq muhit. */
async function scenario({ name, foodSom, deliverySom, customerPct, restaurantPct, cash = false }) {
  const rest = await Restaurant.create({
    name, cuisine: 'milliy', category: 'restoran', deliveryMarkupPercent: 0,
  });
  await CommissionAgreement.create({
    restaurantId: rest._id,
    restaurantCommissionPercent: restaurantPct,
    customerFeePercent: customerPct,
    effectiveFrom: new Date(),
  });
  const dish = await Dish.create({
    restaurantId: rest._id, section: 'menu', name: 'Taom', price: foodSom,
  });

  // Mijoz SOXTA narx yuboradi — server o'zi hisoblashi kerak
  const check = await verifyItemPrices(
    [{ dishId: String(dish._id), name: 'Taom', quantity: 1, unitPrice: 1 }],
    rest._id,
  );

  const finance = computeOrderFinance({
    foodBaseTiyin: somToTiyin(check.foodBaseSom),
    deliveryFeeTiyin: somToTiyin(deliverySom),
    customerFeePercent: customerPct,
    restaurantCommissionPercent: restaurantPct,
    paymentFeePercent: cash ? 0 : 1.5,
  });

  const order = await Order.create({
    userId: user._id, restaurantId: rest._id, restaurantName: name,
    items: check.items,
    subtotal: som(finance.customerFoodTotal),
    deliveryFee: deliverySom,
    total: som(finance.totalCharged),
    status: 'delivered', fulfillment: 'delivery', address: 'x',
    phone: '+998901112233', paymentMethod: cash ? 'cash' : 'click',
    isPaid: !cash, finance,
  });

  return { rest, order, finance, check };
}

console.log('\n[1] NARX XAVFSIZLIGI — frontend qiymati moliyaviy manba EMAS');
{
  const { check, finance } = await scenario({
    name: 'A', foodSom: 10000, deliverySom: 0, customerPct: 0, restaurantPct: 10,
  });
  // Frontend yuborgan: { unitPrice: 1, quantity: 1, subtotal: 1 }
  // Bazada:            Dish.price = 10 000
  ok(check.foodBaseSom === 10000, `foodSubtotal = ${check.foodBaseSom} (frontend 1 yuborgan)`);
  ok(check.items[0].unitPrice === 10000, `element narxi tuzatildi: ${check.items[0].unitPrice}`);
  ok(check.mismatches.length === 1, 'farq qayd etildi (logga yoziladi)');
  ok(som(finance.totalCharged) === 10000, `mijoz to‘laydi ${som(finance.totalCharged)}`);
  ok(som(finance.restaurantPayout) === 9000, `restoran payout ${som(finance.restaurantPayout)}`);
}

console.log('\n[2] Hisob-kitob → Ledger yozuvlari (10% restorandan, karta)');
{
  const { rest, order, finance } = await scenario({
    name: 'B', foodSom: 10000, deliverySom: 5000, customerPct: 0, restaurantPct: 10,
  });
  const result = await settleOrder(order._id);

  ok(result !== null, 'hisob-kitob bajarildi');
  ok(result.commission === 1000, `komissiya ${result.commission} (kutilgan 1000)`);
  ok(result.restaurantShare === 9000, `restoran ulushi ${result.restaurantShare} (kutilgan 9000)`);
  ok(result.mode === 'agreement', `manba: ${result.mode} (shartnoma)`);

  const due = await Ledger.findOne({ orderId: order._id, type: 'restaurant_due' }).lean();
  ok(due.amount === 9000, `restaurant_due yozuvi: ${due.amount}`);
  ok(due.meta.financeModel === 'v2', 'yozuvda financeModel: v2');

  const updated = await Restaurant.findById(rest._id).lean();
  ok(updated.balance === 9000, `restoran balansi ${updated.balance}`);

  // ENG MUHIM: yetkazish puli restoranga QO'SHILMAGAN
  ok(due.amount < som(finance.totalCharged), 'yetkazish puli restoran qarziga kirmadi');
  ok(som(finance.deliveryPayout) === 4925, `delivery payout ${som(finance.deliveryPayout)}`);
}

console.log('\n[3] Naqd to‘lov — bizga faqat komissiya qarz');
{
  const { rest, order } = await scenario({
    name: 'C', foodSom: 10000, deliverySom: 5000, customerPct: 0, restaurantPct: 10, cash: true,
  });
  await settleOrder(order._id);
  const due = await Ledger.findOne({ orderId: order._id, type: 'restaurant_due' }).lean();
  ok(due.amount === -1000, `naqd: balans −1000 bo‘ldi (${due.amount})`);
  const updated = await Restaurant.findById(rest._id).lean();
  ok(updated.balance === -1000, `restoran balansi ${updated.balance}`);
}

console.log('\n[4] Shlyuz bo‘linishi snapshot‘dan (5% + 5%)');
{
  const { finance } = await scenario({
    name: 'D', foodSom: 10000, deliverySom: 5000, customerPct: 5, restaurantPct: 5,
  });
  const split = splitFromFinance(finance, 'click');
  ok(som(split.total) === 15500, `jami ${som(split.total)}`);
  ok(som(split.restaurantAmount) === 9500, `restoranga ${som(split.restaurantAmount)}`);
  ok(som(split.lokmaGrossCommission) === 1000, `LokmaGo gross ${som(split.lokmaGrossCommission)}`);
  ok(som(split.providerFee) === 232.5, `Click haqi ${som(split.providerFee)}`);
  ok(som(split.lokmaNetCommission) === 850, `LokmaGo net ${som(split.lokmaNetCommission)}`);
  ok(split.financeModel === 'v2', 'snapshot yo‘li ishlatildi');

  // Rekonsiliatsiya
  const r = reconcile(finance);
  ok(r.ok, `rekonsiliatsiya: farq ${r.diff} tiyin`);
  const parts = som(finance.restaurantPayout) + som(finance.lokmaCashNet)
    + som(finance.deliveryPayout) + som(finance.clickFeeAmount);
  ok(parts === 15500, `9 500 + ${som(finance.lokmaCashNet)} + 4 925 + 232.5 = ${parts}`);
}

console.log('\n[5] Eski buyurtma (snapshot yo‘q) — avvalgi mantiq saqlanadi');
{
  const rest = await Restaurant.create({
    name: 'Eski', cuisine: 'milliy', category: 'restoran', commissionPercent: 10, commissionMode: 'deduct',
  });
  const order = await Order.create({
    userId: user._id, restaurantId: rest._id, restaurantName: 'Eski',
    items: [{ name: 'Taom', quantity: 1, unitPrice: 10000 }],
    subtotal: 10000, deliveryFee: 0, total: 10000,
    status: 'delivered', fulfillment: 'pickup', phone: '+998901112233',
    paymentMethod: 'click', isPaid: true,
    // finance YO'Q — eski buyurtma
  });
  const result = await settleOrder(order._id);
  ok(result.mode === 'deduct', `eski mantiq ishladi: ${result.mode}`);
  const due = await Ledger.findOne({ orderId: order._id, type: 'restaurant_due' }).lean();
  ok(due.meta.financeModel === 'legacy', 'yozuv legacy deb belgilandi');
  ok(due.amount === 9000, `eski hisob: ${due.amount}`);
}

console.log('\n[6] Takroriy hisob-kitobdan himoya');
{
  const { order } = await scenario({
    name: 'E', foodSom: 10000, deliverySom: 0, customerPct: 0, restaurantPct: 10,
  });
  await settleOrder(order._id);
  const second = await settleOrder(order._id);
  ok(second === null, 'ikkinchi chaqiruv hech narsa yozmadi');
  const count = await Ledger.countDocuments({ orderId: order._id, type: 'restaurant_due' });
  ok(count === 1, `restaurant_due yozuvi ${count} ta (kutilgan 1)`);
}

console.log('\n[7] Bazada QISMAN qaytarish — asl yozuvlar o‘zgarmaydi');
{
  const { rest, order, finance } = await scenario({
    name: 'F', foodSom: 10000, deliverySom: 5000, customerPct: 5, restaurantPct: 5,
  });
  await settleOrder(order._id);
  const balanceAfterSettle = (await Restaurant.findById(rest._id).lean()).balance;
  ok(balanceAfterSettle === 9500, `hisob-kitobdan keyin balans ${balanceAfterSettle}`);

  const { recordRefund } = await import('../src/services/billing.js');

  // Yarmini qaytaramiz (yetkazishsiz)
  const r1 = await recordRefund(order, 'click', null, {
    foodBaseRefundTiyin: somToTiyin(5000),
  });
  ok(r1 && !r1.isFull, 'qisman qaytarish qayd etildi');
  ok(r1.refunded === 5250, `mijozga qaytarildi ${r1.refunded} (kutilgan 5250)`);

  const balanceAfterRefund = (await Restaurant.findById(rest._id).lean()).balance;
  ok(balanceAfterRefund === 4750, `balans ${balanceAfterRefund} (9500 − 4750)`);

  // ASL snapshot va ASL yozuvlar tegilmagan
  const fresh = await Order.findById(order._id).lean();
  ok(fresh.finance.restaurantPayout === finance.restaurantPayout,
    'Order.finance o‘zgarmadi (immutable)');
  const origDue = await Ledger.findOne({
    orderId: order._id, type: 'restaurant_due', 'meta.note': { $exists: false },
  }).lean();
  ok(origDue && origDue.amount === 9500, 'asl restaurant_due yozuvi o‘zgarmadi');

  // Qolganini ham qaytaramiz
  const r2 = await recordRefund(order, 'click', null, {
    foodBaseRefundTiyin: somToTiyin(5000), refundDelivery: true,
  });
  ok(r2 && r2.refunded === 10250, `qolgani qaytarildi ${r2?.refunded} (5250 + 5000)`);
  const finalBalance = (await Restaurant.findById(rest._id).lean()).balance;
  ok(finalBalance === 0, `yakuniy balans ${finalBalance}`);

  // Ortiqcha qaytarish — rad etiladi
  const r3 = await recordRefund(order, 'click', null, {
    foodBaseRefundTiyin: somToTiyin(1000),
  });
  ok(r3 === null, 'ortiqcha qaytarish rad etildi');

  const refunds = await Ledger.countDocuments({ orderId: order._id, type: 'refund' });
  ok(refunds === 2, `2 ta refund yozuvi (${refunds}) — audit izi saqlandi`);
}

console.log('\n[8] Eski buyurtmada qaytarish — avvalgi mantiq');
{
  const rest = await Restaurant.create({
    name: 'Eski2', cuisine: 'milliy', category: 'restoran',
    commissionPercent: 10, commissionMode: 'deduct',
  });
  const order = await Order.create({
    userId: user._id, restaurantId: rest._id, restaurantName: 'Eski2',
    items: [{ name: 'Taom', quantity: 1, unitPrice: 10000 }],
    subtotal: 10000, deliveryFee: 0, total: 10000,
    status: 'delivered', fulfillment: 'pickup', phone: '+998901112233',
    paymentMethod: 'click', isPaid: true,
  });
  await settleOrder(order._id);
  const { recordRefund } = await import('../src/services/billing.js');
  const r = await recordRefund(order, 'click');
  ok(r && r.refunded === 10000, `eski: to‘liq qaytarildi ${r?.refunded}`);
  const led = await Ledger.findOne({ orderId: order._id, type: 'refund' }).lean();
  ok(led.meta.financeModel === 'legacy', 'legacy deb belgilandi');
}

await mongoose.disconnect();
console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
process.exit(fails ? 1 : 0);
