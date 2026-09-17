/*
 * ═══════════════════════════════════════════════════════════
 * MOLIYAVIY HISOB-KITOB — MAJBURIY TESTLAR
 * ═══════════════════════════════════════════════════════════
 *
 * A–D testlari biznes qoidasidan SO'ZMA-SO'Z olingan. Ular
 * yashil bo'lmasa, implementatsiya tugagan hisoblanmaydi.
 *
 * Barcha summalar tiyinda: 10 000 so'm = 1 000 000 tiyin.
 * Test matnida so'mda yoziladi, taqqoslash tiyinda bo'ladi.
 *
 * Ishga tushirish: npm test
 */
import { computeOrderFinance, reconcile, somToTiyin, tiyinToSom } from '../src/services/orderFinance.js';

let fails = 0;
const ok = (cond, msg) => {
  console.log(cond ? '  ✓' : '  ✗ FAIL:', msg);
  if (!cond) fails++;
};
/** Kutilgan qiymat so'mda beriladi, solishtirish tiyinda. */
const eq = (actualTiyin, expectedSom, label) => {
  const expected = somToTiyin(expectedSom);
  ok(actualTiyin === expected,
    `${label}: ${tiyinToSom(actualTiyin).toLocaleString('ru-RU')} (kutilgan ${expectedSom.toLocaleString('ru-RU')})`);
};

const S = somToTiyin;

/* ═══ TEST A — 10% faqat restorandan, yetkazishsiz ═══ */
console.log('\n[A] Taom 10 000 · mijoz 0% · restoran 10% · yetkazish 0');
{
  const f = computeOrderFinance({
    foodBaseTiyin: S(10000),
    customerFeePercent: 0,
    restaurantCommissionPercent: 10,
  });
  eq(f.totalCharged, 10000, 'Mijoz to‘laydi');
  eq(f.restaurantPayout, 9000, 'Restoran payout');
  eq(f.lokmaGrossCommission, 1000, 'LokmaGo gross');
  ok(reconcile(f).ok, 'rekonsiliatsiya');
}

/* ═══ TEST B — 5% + 5%, yetkazishsiz ═══ */
console.log('\n[B] Taom 10 000 · mijoz 5% · restoran 5% · yetkazish 0');
{
  const f = computeOrderFinance({
    foodBaseTiyin: S(10000),
    customerFeePercent: 5,
    restaurantCommissionPercent: 5,
  });
  eq(f.totalCharged, 10500, 'Mijoz to‘laydi');
  eq(f.restaurantPayout, 9500, 'Restoran payout');
  eq(f.lokmaGrossCommission, 1000, 'LokmaGo gross');
  eq(f.customerFeeAmount, 500, 'Mijoz xizmat haqi');
  ok(reconcile(f).ok, 'rekonsiliatsiya');
}

/* ═══ TEST C — 10% restorandan + yetkazish + Click ═══ */
console.log('\n[C] Taom 10 000 · restoran 10% · yetkazish 5 000 · Click 1.5%');
{
  const f = computeOrderFinance({
    foodBaseTiyin: S(10000),
    deliveryFeeTiyin: S(5000),
    customerFeePercent: 0,
    restaurantCommissionPercent: 10,
    paymentFeePercent: 1.5,
  });
  eq(f.totalCharged, 15000, 'Mijoz to‘laydi');
  eq(f.clickFeeAmount, 225, 'Click jami');
  eq(f.restaurantPayout, 9000, 'Restoran payout');
  eq(f.lokmaGrossCommission, 1000, 'LokmaGo gross');
  eq(f.clickFoodFeeAmount, 150, 'Taom Click haqi');
  eq(f.clickDeliveryFeeAmount, 75, 'Delivery Click haqi');
  eq(f.lokmaNetCommission, 850, 'LokmaGo net');
  eq(f.deliveryPayout, 4925, 'Delivery payout');
  eq(f.clickResidualAmount, 0, 'Click residual (mijoz haqi yo‘q)');
  ok(reconcile(f).ok, 'rekonsiliatsiya');
}

/* ═══ TEST D — 5%+5% + yetkazish + Click (residual paydo bo'ladi) ═══ */
console.log('\n[D] Taom 10 000 · mijoz 5% · restoran 5% · yetkazish 5 000 · Click 1.5%');
{
  const f = computeOrderFinance({
    foodBaseTiyin: S(10000),
    deliveryFeeTiyin: S(5000),
    customerFeePercent: 5,
    restaurantCommissionPercent: 5,
    paymentFeePercent: 1.5,
  });
  eq(f.totalCharged, 15500, 'Mijoz to‘laydi');
  eq(f.clickFeeAmount, 232.5, 'Click jami');
  eq(f.restaurantPayout, 9500, 'Restoran payout');
  eq(f.lokmaGrossCommission, 1000, 'LokmaGo gross');
  eq(f.clickFoodFeeAmount, 150, 'Taom Click haqi');
  eq(f.clickDeliveryFeeAmount, 75, 'Delivery Click haqi');
  eq(f.lokmaNetCommission, 850, 'LokmaGo net');
  eq(f.clickResidualAmount, 7.5, 'Click residual (mijoz haqidan)');
  eq(f.deliveryPayout, 4925, 'Delivery payout');
  ok(reconcile(f).ok, 'rekonsiliatsiya');
}

/* ═══ QO'SHIMCHA: chekka holatlar ═══ */
console.log('\n[E] Chekka holatlar');
{
  // Naqd — shlyuz haqi yo'q
  const cash = computeOrderFinance({
    foodBaseTiyin: S(10000), deliveryFeeTiyin: S(5000),
    restaurantCommissionPercent: 10, paymentFeePercent: 0,
  });
  eq(cash.clickFeeAmount, 0, 'naqd: Click haqi yo‘q');
  eq(cash.lokmaNetCommission, 1000, 'naqd: net = gross');
  eq(cash.deliveryPayout, 5000, 'naqd: delivery to‘liq');
  ok(reconcile(cash).ok, 'naqd rekonsiliatsiya');

  // Yetkazish 0 (olib ketish)
  const pickup = computeOrderFinance({
    foodBaseTiyin: S(10000), restaurantCommissionPercent: 10, paymentFeePercent: 1.5,
  });
  eq(pickup.deliveryPayout, 0, 'olib ketish: delivery 0');
  eq(pickup.clickDeliveryFeeAmount, 0, 'olib ketish: delivery Click 0');
  ok(reconcile(pickup).ok, 'olib ketish rekonsiliatsiya');

  // Shartnoma yo'q — komissiya 0
  const noAgreement = computeOrderFinance({ foodBaseTiyin: S(10000) });
  eq(noAgreement.restaurantPayout, 10000, 'shartnomasiz: payout = to‘liq');
  eq(noAgreement.lokmaGrossCommission, 0, 'shartnomasiz: komissiya 0');
  ok(reconcile(noAgreement).ok, 'shartnomasiz rekonsiliatsiya');

  // Chegirma — komissiya chegirmadan KEYIN
  const disc = computeOrderFinance({
    foodBaseTiyin: S(10000), discountTiyin: S(2000), restaurantCommissionPercent: 10,
  });
  eq(disc.foodSubtotal, 8000, 'chegirmadan keyingi baza');
  eq(disc.restaurantCommissionAmount, 800, 'komissiya chegirmali summadan');
  eq(disc.restaurantPayout, 7200, 'chegirmali payout');
  ok(reconcile(disc).ok, 'chegirma rekonsiliatsiya');

  // Restoran ustamasi — uning puli, payout'ga qaytadi
  const markup = computeOrderFinance({
    foodBaseTiyin: S(10000), deliveryMarkupPercent: 5, restaurantCommissionPercent: 10,
  });
  eq(markup.foodSubtotal, 10500, 'ustama bilan baza');
  eq(markup.restaurantPayout, 9450, 'ustama restoranga qaytdi (10500 − 1050)');
  ok(reconcile(markup).ok, 'ustama rekonsiliatsiya');

  // Bepul buyurtma
  const zero = computeOrderFinance({ foodBaseTiyin: 0, restaurantCommissionPercent: 10 });
  eq(zero.totalCharged, 0, 'nol summa');
  ok(reconcile(zero).ok, 'nol rekonsiliatsiya');

  // Manfiy summa — xato
  let threw = false;
  try { computeOrderFinance({ foodBaseTiyin: -100 }); } catch { threw = true; }
  ok(threw, 'manfiy summa rad etiladi');

  // Delivery Click haqini LokmaGo qoplasa
  const absorbed = computeOrderFinance({
    foodBaseTiyin: S(10000), deliveryFeeTiyin: S(5000),
    restaurantCommissionPercent: 10, paymentFeePercent: 1.5,
    deliveryFeeAbsorbedByLokma: true,
  });
  eq(absorbed.deliveryPayout, 5000, 'LokmaGo qopladi: delivery to‘liq');
  ok(reconcile(absorbed).ok, 'qoplangan rekonsiliatsiya');
}

/* ═══ YAXLITLASH: tiyin yo'qolmasligi ═══ */
console.log('\n[F] Yaxlitlash — hech bir tiyin yo‘qolmaydi');
{
  let worst = 0;
  const cases = [];
  for (const food of [333, 999, 1, 7777, 12345, 100000]) {
    for (const [cf, rc] of [[0, 10], [5, 5], [3, 7], [4.5, 5.5], [0, 0], [10, 0]]) {
      for (const delivery of [0, 3333, 5000]) {
        const f = computeOrderFinance({
          foodBaseTiyin: S(food), deliveryFeeTiyin: S(delivery),
          customerFeePercent: cf, restaurantCommissionPercent: rc, paymentFeePercent: 1.5,
        });
        const r = reconcile(f);
        if (!r.ok) cases.push({ food, cf, rc, delivery, diff: r.diff });
        worst = Math.max(worst, Math.abs(r.diff));
      }
    }
  }
  ok(cases.length === 0, `108 ta kombinatsiya rekonsiliatsiyadan o‘tdi (eng katta farq: ${worst} tiyin)`);
  if (cases.length) console.log('    muammoli:', JSON.stringify(cases.slice(0, 3)));
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
process.exit(fails ? 1 : 0);
