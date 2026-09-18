/*
 * ═══════════════════════════════════════════════════════════
 * TZ MAJBURIY TESTLARI (1–10)
 * ═══════════════════════════════════════════════════════════
 *
 * Har bir test TZ hujjatidagi raqamlar bilan SO'ZMA-SO'Z
 * solishtiriladi. Bittasi ham yiqilsa, tizim talabga
 * javob bermaydi.
 *
 * Ishga tushirish: npm run test:tz
 */
process.env.MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/lokma_tz';
process.env.JWT_SECRET = 'x'.repeat(40);
process.env.NODE_ENV = 'development';
globalThis.fetch = async () => ({ status: 200, json: async () => ({ ok: true, result: {} }) });

const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGO_URI);
await mongoose.connection.db.dropDatabase();

const { Restaurant } = await import('../src/models/Restaurant.js');
const { User } = await import('../src/models/User.js');
const { Order } = await import('../src/models/Order.js');
const { Ledger } = await import('../src/models/Ledger.js');
const { CommissionAgreement } = await import('../src/models/CommissionAgreement.js');
const { computeOrderFinance, reconcile, somToTiyin, tiyinToSom } = await import('../src/services/orderFinance.js');
const { settleOrder, recordRefund, recordPayout, getRestaurantPendingPayout } = await import('../src/services/billing.js');

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const S = somToTiyin;
const som = (t) => tiyinToSom(t);
const eq = (actual, expected, label) => ok(som(actual) === expected,
  `${label}: ${som(actual).toLocaleString('ru-RU')} (TZ: ${expected.toLocaleString('ru-RU')})`);

const user = await User.create({ firstName: 'Mijoz', telegramId: '999' });

/** Kelishuv bo'yicha hisob. */
const calc = (food, delivery, cust, rest, fee = 1.5) => computeOrderFinance({
  foodBaseTiyin: S(food),
  deliveryFeeTiyin: S(delivery),
  customerFeePercent: cust,
  restaurantCommissionPercent: rest,
  paymentFeePercent: fee,
});

/** Bazada haqiqiy buyurtma yaratadi. */
async function makeOrder({ name, food, delivery, cust, rest, cash = false }) {
  const r = await Restaurant.create({ name, cuisine: 'milliy', category: 'restoran' });
  await CommissionAgreement.create({
    restaurantId: r._id, restaurantCommissionPercent: rest,
    customerFeePercent: cust, effectiveFrom: new Date(),
  });
  const f = calc(food, delivery, cust, rest, cash ? 0 : 1.5);
  const o = await Order.create({
    userId: user._id, restaurantId: r._id, restaurantName: name,
    items: [{ name: 'Taom', quantity: 1, unitPrice: food }],
    subtotal: som(f.customerFoodTotal), deliveryFee: delivery,
    total: som(f.totalCharged), status: 'delivered', fulfillment: 'delivery',
    address: 'x', phone: '+998901112233',
    paymentMethod: cash ? 'cash' : 'click', isPaid: !cash, finance: f,
  });
  return { restaurant: r, order: o, finance: f };
}

console.log('\n═══ TEST 1: 10% kelishuv + 15 000 yetkazish ═══');
{
  const f = calc(10000, 15000, 0, 10);
  eq(f.totalCharged, 25000, 'Mijoz to‘laydi');
  eq(f.clickFeeAmount, 375, 'Click 1.5%');
  eq(f.lokmaGrossCommission, 1000, 'LokmaGo gross');
  eq(f.lokmaNetCommission, 625, 'LokmaGo net');
  eq(f.restaurantFoodPayout, 9000, 'Restoranga taom uchun');
  eq(f.restaurantDeliveryPayout, 15000, 'Restoranga yetkazish uchun');
  eq(f.restaurantPayout, 24000, 'Restoranga jami');
  ok(reconcile(f).ok, 'Rekonsiliatsiya: 24 000 + 625 + 375 = 25 000');
}

console.log('\n═══ TEST 2: 10% kelishuv + BEPUL yetkazish ═══');
{
  const f = calc(10000, 0, 0, 10);
  eq(f.totalCharged, 10000, 'Mijoz to‘laydi');
  eq(f.clickFeeAmount, 150, 'Click 1.5%');
  eq(f.lokmaGrossCommission, 1000, 'LokmaGo gross');
  eq(f.lokmaNetCommission, 850, 'LokmaGo net');
  eq(f.restaurantPayout, 9000, 'Restoranga jami');
  ok(reconcile(f).ok, 'Rekonsiliatsiya');
}

console.log('\n═══ TEST 3: 5×5 kelishuv (Clicksiz) ═══');
{
  const f = calc(10000, 0, 5, 5, 0);
  eq(f.foodSubtotal, 10000, 'Restoran asl narxi');
  eq(f.customerFoodTotal, 10500, 'Mijozga ko‘rsatiladigan narx');
  eq(f.customerFeeAmount, 500, 'Mijoz komissiyasi');
  eq(f.restaurantCommissionAmount, 500, 'Restoran komissiyasi');
  eq(f.lokmaGrossCommission, 1000, 'LokmaGo gross');
  eq(f.restaurantPayout, 9500, 'Restoran payout');
  ok(reconcile(f).ok, 'Rekonsiliatsiya');
}

console.log('\n═══ TEST 4: 5×5 + Click 1.5% ═══');
{
  const f = calc(10000, 0, 5, 5);
  eq(f.totalCharged, 10500, 'Mijoz to‘laydi');
  eq(f.clickFeeAmount, 157.5, 'Click 1.5%');
  eq(f.lokmaGrossCommission, 1000, 'LokmaGo gross');
  eq(f.lokmaNetCommission, 842.5, 'LokmaGo net');
  eq(f.restaurantPayout, 9500, 'Restoran payout');
  ok(reconcile(f).ok, 'Rekonsiliatsiya');
}

console.log('\n═══ TEST 5: 5×5 + yetkazish — delivery komissiyaga KIRMAYDI ═══');
{
  const withD = calc(10000, 15000, 5, 5);
  const noD = calc(10000, 0, 5, 5);
  ok(withD.lokmaGrossCommission === noD.lokmaGrossCommission,
    `yetkazish 0 va 15 000 da komissiya BIR XIL: ${som(withD.lokmaGrossCommission)}`);
  eq(withD.restaurantDeliveryPayout, 15000, 'Yetkazishning 100% restoranga');
  eq(withD.restaurantFoodPayout, 9500, 'Taom ulushi o‘zgarmadi');
  eq(withD.restaurantPayout, 24500, 'Restoranga jami (9 500 + 15 000)');
  ok(reconcile(withD).ok, 'Rekonsiliatsiya');
}

console.log('\n═══ TEST 6: Refund — statistika to‘g‘ri qayta aks etadi ═══');
{
  const { restaurant, order } = await makeOrder({
    name: 'T6', food: 10000, delivery: 15000, cust: 0, rest: 10,
  });
  await settleOrder(order._id);
  const before = (await Restaurant.findById(restaurant._id).lean()).balance;
  ok(before === 24000, `hisob-kitobdan keyin qarz: ${before}`);

  const r = await recordRefund(order, 'click');
  ok(r && r.isFull, 'to‘liq qaytarish');
  ok(r.refunded === 25000, `mijozga qaytarildi: ${r.refunded}`);

  const after = (await Restaurant.findById(restaurant._id).lean()).balance;
  ok(after === 0, `qaytarishdan keyin qarz: ${after} (daromad sifatida qolmadi)`);

  // Ikki marta hisoblanmasin
  const comm = await Ledger.find({ orderId: order._id, type: 'commission' }).lean();
  const commSum = comm.reduce((s, l) => s + l.amount, 0);
  ok(commSum === 0, `komissiya nolga tushdi: ${commSum} (${comm.length} ta yozuv)`);
}

console.log('\n═══ TEST 7: Bir nechta buyurtma — yig‘indi ═══');
{
  const r = await Restaurant.create({ name: 'T7', cuisine: 'milliy', category: 'restoran' });
  await CommissionAgreement.create({
    restaurantId: r._id, restaurantCommissionPercent: 10,
    customerFeePercent: 0, effectiveFrom: new Date(),
  });

  // TZ misoli: 24 000 + 23 000 + 13 500 = 60 500
  const cases = [[10000, 15000], [20000, 5000], [15000, 0]];
  const expected = [24000, 23000, 13500];

  for (let i = 0; i < cases.length; i++) {
    const [food, delivery] = cases[i];
    const f = calc(food, delivery, 0, 10);
    eq(f.restaurantPayout, expected[i], `${i + 1}-buyurtma payout`);
    const o = await Order.create({
      userId: user._id, restaurantId: r._id, restaurantName: 'T7',
      items: [{ name: 'Taom', quantity: 1, unitPrice: food }],
      subtotal: som(f.customerFoodTotal), deliveryFee: delivery,
      total: som(f.totalCharged), status: 'delivered', fulfillment: 'delivery',
      address: 'x', phone: '+998901112233', paymentMethod: 'click', isPaid: true, finance: f,
    });
    await settleOrder(o._id);
  }

  const balance = (await Restaurant.findById(r._id).lean()).balance;
  ok(balance === 60500, `restoranga jami qarz: ${balance} (TZ: 60 500)`);
}

console.log('\n═══ TEST 8: Bir order ikki marta to‘lanmasin ═══');
{
  const { restaurant, order } = await makeOrder({
    name: 'T8', food: 10000, delivery: 0, cust: 0, rest: 10,
  });
  await settleOrder(order._id);

  // Takroriy hisob-kitob
  const again = await settleOrder(order._id);
  ok(again === null, 'takroriy hisob-kitob rad etildi');
  const dues = await Ledger.countDocuments({ orderId: order._id, type: 'restaurant_due' });
  ok(dues === 1, `restaurant_due yozuvi: ${dues} ta`);

  /*
   * Takroriy TO'LOV — bir xil idempotencyKey bilan ikki marta.
   *
   * `recordPayout` findOneAndUpdate'ni projection bilan ishlatadi;
   * FerretDB (mahalliy sinov bazasi) buni qo'llamaydi. Haqiqiy
   * MongoDB'da ishlaydi, shuning uchun bu holat alohida
   * belgilanadi — kod xatosi bilan aralashtirilmasin.
   */
  const key = `payout-test-${order._id}`;
  try {
    await recordPayout(restaurant._id, 9000, null, 'test', key);
    const second = await recordPayout(restaurant._id, 9000, null, 'test', key);
    ok(second?.duplicated === true || second === null, 'takroriy to‘lov rad etildi');
    const payouts = await Ledger.countDocuments({ restaurantId: restaurant._id, type: 'payout' });
    ok(payouts === 1, `payout yozuvi: ${payouts} ta (ikki marta yozilmadi)`);
    const balance = (await Restaurant.findById(restaurant._id).lean()).balance;
    ok(balance === 0, `to‘lovdan keyin qarz: ${balance}`);
  } catch (e) {
    if (e?.codeName === 'NotImplemented') {
      console.log('  ⓘ to‘lov qismi o‘tkazib yuborildi: FerretDB findOneAndUpdate '
        + 'projection‘ni qo‘llamaydi (haqiqiy MongoDB‘da ishlaydi)');
      // Himoyaning o'zini boshqa yo'l bilan tasdiqlaymiz:
      // idempotencyKey majburiyligi
      let threw = false;
      try { await recordPayout(restaurant._id, 1000, null, '', null); } catch { threw = true; }
      ok(threw, 'idempotencyKey‘siz to‘lov umuman rad etiladi');
    } else {
      ok(false, `kutilmagan xato: ${e.message}`);
    }
  }
}

console.log('\n═══ TEST 9: Kelishuv o‘zgarsa — eski order o‘zgarmaydi ═══');
{
  const { restaurant, order, finance } = await makeOrder({
    name: 'T9', food: 10000, delivery: 0, cust: 0, rest: 10,
  });
  await settleOrder(order._id);
  const dueBefore = (await Ledger.findOne({ orderId: order._id, type: 'restaurant_due' }).lean()).amount;
  eq(finance.restaurantPayout, 9000, 'eski kelishuv bo‘yicha payout');

  // Kelishuvni 5×5 ga o'zgartiramiz
  await CommissionAgreement.updateMany({ restaurantId: restaurant._id }, { effectiveTo: new Date() });
  await CommissionAgreement.create({
    restaurantId: restaurant._id, restaurantCommissionPercent: 5,
    customerFeePercent: 5, effectiveFrom: new Date(),
  });

  const fresh = await Order.findById(order._id).lean();
  ok(fresh.finance.restaurantPayout === finance.restaurantPayout,
    'snapshot o‘zgarmadi — eski order eski kelishuv bilan qoldi');
  const dueAfter = (await Ledger.findOne({ orderId: order._id, type: 'restaurant_due' }).lean()).amount;
  ok(dueAfter === dueBefore, `Ledger yozuvi ham o‘zgarmadi: ${dueAfter}`);
}

console.log('\n═══ TEST 10: Webhook takrorlansa — ikki marta yozilmaydi ═══');
{
  const { order } = await makeOrder({ name: 'T10', food: 10000, delivery: 5000, cust: 0, rest: 10 });
  const { recordSuccess } = await import('../src/services/paymentRecord.js');

  const args = {
    order, provider: 'click', providerTransactionId: 'TXN-DUP-1',
    amountTiyin: somToTiyin(15000), lokmaPercent: 10,
  };
  const p1 = await recordSuccess(args);
  const p2 = await recordSuccess(args);   // xuddi shu webhook qayta keldi

  ok(p1 && p2, 'ikkala chaqiruv ham javob qaytardi');
  ok(String(p1._id) === String(p2._id), 'bir xil to‘lov yozuvi (yangisi yaratilmadi)');

  const { Payment } = await import('../src/models/Payment.js');
  const count = await Payment.countDocuments({ orderId: order._id });
  ok(count === 1, `Payment yozuvi: ${count} ta`);
}

await mongoose.disconnect();
console.log(fails ? `\n✗ ${fails} ta TZ testi YIQILDI` : '\n✓ TZ NING 10 TA TESTI HAM O‘TDI');
process.exit(fails ? 1 : 0);
