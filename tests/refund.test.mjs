/*
 * ═══════════════════════════════════════════════════════════
 * REFUND VA QISMAN REFUND — TESTLAR
 * ═══════════════════════════════════════════════════════════
 *
 * Asosiy da'volar:
 *  1. `Order.finance` qaytarish sababli HECH QACHON o'zgarmaydi;
 *  2. qisman qaytarishda barcha qismlar PROPORSIONAL bo'linadi;
 *  3. faqat taom qaytarilsa yetkazish haqi qaytarilmaydi;
 *  4. qaytarish asl summadan oshib keta olmaydi;
 *  5. har qaytarishning o'zi ham rekonsiliatsiyadan o'tadi.
 *
 * Bonus/promo tizimi mavjud emas — testlarda ham yo'q.
 */
import { computeOrderFinance, reconcile, somToTiyin, tiyinToSom } from '../src/services/orderFinance.js';
import { computeRefund, validateRefund } from '../src/services/refund.js';

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const S = somToTiyin;
const som = (t) => tiyinToSom(t);
const eq = (actual, expectedSom, label) => ok(actual === S(expectedSom),
  `${label}: ${som(actual).toLocaleString('ru-RU')} (kutilgan ${expectedSom.toLocaleString('ru-RU')})`);

/** Standart buyurtma: 2 ta taom × 5 000 + yetkazish 5 000 */
const order = computeOrderFinance({
  foodBaseTiyin: S(10000),
  deliveryFeeTiyin: S(5000),
  customerFeePercent: 5,
  restaurantCommissionPercent: 5,
  paymentFeePercent: 1.5,
});

console.log('\n[1] TO‘LIQ qaytarish');
{
  const { refund, isFull, withDelivery } = computeRefund(order, {});
  ok(isFull, 'to‘liq deb aniqlandi');
  ok(withDelivery, 'yetkazish ham qaytariladi');
  eq(refund.totalCharged, 15500, 'mijozga qaytariladi');
  eq(refund.restaurantPayout, 9500, 'restoran ulushi teskari');
  eq(refund.lokmaGrossCommission, 1000, 'LokmaGo komissiyasi teskari');
  eq(refund.deliveryPayout, 4925, 'delivery teskari');
  ok(reconcile(refund).ok, 'qaytarish rekonsiliatsiyasi');
  ok(validateRefund(order, refund).ok, 'asl summadan oshmadi');
}

console.log('\n[2] QISMAN — 2 ta taomdan bittasi (5 000), yetkazishsiz');
{
  const { refund, isFull, withDelivery, remaining } = computeRefund(order, {
    foodBaseRefundTiyin: S(5000),
  });
  ok(!isFull, 'qisman deb aniqlandi');
  ok(!withDelivery, 'yetkazish QAYTARILMADI (kuryer ishini bajargan)');
  eq(refund.foodSubtotal, 5000, 'qaytarilgan taom summasi');
  eq(refund.customerFeeAmount, 250, 'mijoz haqi proporsional (5% dan yarmi)');
  eq(refund.restaurantCommissionAmount, 250, 'restoran komissiyasi proporsional');
  eq(refund.restaurantPayout, 4750, 'restoran ulushi proporsional');
  eq(refund.totalCharged, 5250, 'mijozga qaytariladi (yetkazishsiz)');
  eq(refund.deliveryFee, 0, 'yetkazish 0');
  eq(refund.deliveryPayout, 0, 'delivery payout 0');
  ok(remaining.foodBase === S(5000), `qolgan taom summasi ${som(remaining.foodBase)}`);
  ok(reconcile(refund).ok, 'rekonsiliatsiya');
  ok(validateRefund(order, refund).ok, 'asl summadan oshmadi');
}

console.log('\n[3] QISMAN — taom + yetkazish birga');
{
  const { refund, withDelivery } = computeRefund(order, {
    foodBaseRefundTiyin: S(5000), refundDelivery: true,
  });
  ok(withDelivery, 'yetkazish ham qaytarildi');
  eq(refund.totalCharged, 10250, 'mijozga qaytariladi (5 250 + 5 000)');
  eq(refund.deliveryPayout, 4925, 'delivery payout teskari');
  ok(reconcile(refund).ok, 'rekonsiliatsiya');
}

console.log('\n[4] FAQAT yetkazish qaytariladi (taom mijozda qoldi)');
{
  const { refund } = computeRefund(order, {
    foodBaseRefundTiyin: 0, refundDelivery: true,
  });
  eq(refund.foodSubtotal, 0, 'taom qaytarilmadi');
  eq(refund.restaurantPayout, 0, 'restoran ulushi tegilmadi');
  eq(refund.lokmaGrossCommission, 0, 'komissiya tegilmadi');
  eq(refund.totalCharged, 5000, 'faqat yetkazish qaytarildi');
  ok(reconcile(refund).ok, 'rekonsiliatsiya');
}

console.log('\n[5] Ketma-ket qisman qaytarishlar — jami asldan oshmaydi');
{
  const first = computeRefund(order, { foodBaseRefundTiyin: S(4000) });
  const second = computeRefund(order, {
    foodBaseRefundTiyin: S(6000),
    alreadyRefundedFoodBaseTiyin: S(4000),
  });
  eq(first.refund.foodSubtotal, 4000, '1-qaytarish');
  eq(second.refund.foodSubtotal, 6000, '2-qaytarish');
  ok(second.remaining.foodBase === 0, 'qoldiq 0');

  const totalRefunded = first.refund.foodSubtotal + second.refund.foodSubtotal;
  ok(totalRefunded === order.foodSubtotal,
    `jami qaytarilgan = asl taom summasi (${som(totalRefunded)})`);

  // Uchinchisi — endi mumkin emas
  let threw = false;
  try {
    computeRefund(order, { foodBaseRefundTiyin: S(1), alreadyRefundedFoodBaseTiyin: S(10000) });
  } catch { threw = true; }
  ok(threw, 'ortiqcha qaytarish rad etildi');
}

console.log('\n[6] Asl snapshot O‘ZGARMADI');
{
  const before = JSON.stringify(order);
  computeRefund(order, { foodBaseRefundTiyin: S(5000) });
  computeRefund(order, {});
  ok(JSON.stringify(order) === before, 'Order.finance immutable — qaytarish unga tegmadi');
}

console.log('\n[7] Barcha komissiya kombinatsiyalari × to‘lov turlari');
{
  const combos = [[0, 0], [0, 10], [5, 5], [10, 0], [3, 7]];
  let bad = 0;
  for (const [cust, rest] of combos) {
    for (const feePct of [1.5, 0]) {             // Click va naqd
      const o = computeOrderFinance({
        foodBaseTiyin: S(10000), deliveryFeeTiyin: S(5000),
        customerFeePercent: cust, restaurantCommissionPercent: rest,
        paymentFeePercent: feePct,
      });
      for (const part of [null, S(10000), S(5000), S(3333), 0]) {
        for (const withDel of [true, false, null]) {
          const { refund } = computeRefund(o, {
            foodBaseRefundTiyin: part, refundDelivery: withDel,
          });
          if (!reconcile(refund).ok) bad++;
          if (!validateRefund(o, refund).ok) bad++;
        }
      }
    }
  }
  ok(bad === 0, `150 ta qaytarish stsenariysi rekonsiliatsiyadan o‘tdi (muammo: ${bad})`);
}

console.log('\n[8] Chekka holatlar');
{
  // Chegirmali buyurtmadan qisman qaytarish
  const disc = computeOrderFinance({
    foodBaseTiyin: S(10000), discountTiyin: S(2000),
    customerFeePercent: 5, restaurantCommissionPercent: 5, paymentFeePercent: 1.5,
  });
  const { refund } = computeRefund(disc, { foodBaseRefundTiyin: S(5000) });
  eq(refund.discountAmount, 1000, 'chegirma proporsional teskari');
  eq(refund.foodSubtotal, 4000, 'chegirmadan keyingi qaytarish');
  ok(reconcile(refund).ok, 'chegirmali rekonsiliatsiya');

  // Snapshot'siz buyurtma — refund ishlamaydi
  let threw = false;
  try { computeRefund({ model: 'legacy' }, {}); } catch { threw = true; }
  ok(threw, 'legacy buyurtmada v2 refund rad etiladi');

  // Manfiy summa
  threw = false;
  try { computeRefund(order, { foodBaseRefundTiyin: -1 }); } catch { threw = true; }
  ok(threw, 'manfiy qaytarish rad etiladi');

  // Komissiyasiz buyurtma
  const free = computeOrderFinance({ foodBaseTiyin: S(10000), paymentFeePercent: 1.5 });
  const r = computeRefund(free, {});
  eq(r.refund.restaurantPayout, 10000, 'komissiyasiz: to‘liq qaytariladi');
  ok(reconcile(r.refund).ok, 'komissiyasiz rekonsiliatsiya');
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
process.exit(fails ? 1 : 0);
