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
const som = (t) => tiyinToSom(t);

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
  eq(f.restaurantPayout, 14000, 'Restoranga jami (9 000 + 5 000)');
  eq(f.lokmaGrossCommission, 1000, 'LokmaGo gross');
  eq(f.lokmaNetCommission, 775, 'LokmaGo net (1 000 − 225 to‘liq Click haqi)');
  eq(f.restaurantFoodPayout, 9000, 'Restoran — taom ulushi');
  eq(f.restaurantDeliveryPayout, 5000, 'Restoran — yetkazish 100%');
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
  eq(f.restaurantPayout, 14500, 'Restoranga jami (9 500 + 5 000)');
  eq(f.lokmaGrossCommission, 1000, 'LokmaGo gross');
  eq(f.lokmaNetCommission, 767.5, 'LokmaGo net (1 000 − 232.5)');
  eq(f.restaurantFoodPayout, 9500, 'Restoran — taom ulushi');
  eq(f.restaurantDeliveryPayout, 5000, 'Restoran — yetkazish 100%');
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
  eq(cash.lokmaNetCommission, 1000, 'naqd: net = gross (Click haqi yo‘q)');
  eq(cash.restaurantDeliveryPayout, 5000, 'naqd: delivery to‘liq');
  eq(cash.restaurantPayout, 14000, 'naqd: restoranga jami');
  ok(reconcile(cash).ok, 'naqd rekonsiliatsiya');

  // Yetkazish 0 (olib ketish)
  const pickup = computeOrderFinance({
    foodBaseTiyin: S(10000), restaurantCommissionPercent: 10, paymentFeePercent: 1.5,
  });
  eq(pickup.restaurantDeliveryPayout, 0, 'olib ketish: delivery 0');
  eq(pickup.clickDeliveryFeeAmount, 0, 'olib ketish: delivery Click 0');
  ok(reconcile(pickup).ok, 'olib ketish rekonsiliatsiya');

  // Shartnoma yo'q — komissiya 0
  const noAgreement = computeOrderFinance({ foodBaseTiyin: S(10000) });
  eq(noAgreement.restaurantFoodPayout, 10000, 'shartnomasiz: payout = to‘liq');
  eq(noAgreement.lokmaGrossCommission, 0, 'shartnomasiz: komissiya 0');
  ok(reconcile(noAgreement).ok, 'shartnomasiz rekonsiliatsiya');

  // Chegirma — komissiya chegirmadan KEYIN
  const disc = computeOrderFinance({
    foodBaseTiyin: S(10000), discountTiyin: S(2000), restaurantCommissionPercent: 10,
  });
  eq(disc.foodSubtotal, 8000, 'chegirmadan keyingi baza');
  eq(disc.restaurantCommissionAmount, 800, 'komissiya chegirmali summadan');
  eq(disc.restaurantFoodPayout, 7200, 'chegirmali payout');
  ok(reconcile(disc).ok, 'chegirma rekonsiliatsiya');

  // Restoran ustamasi — uning puli, payout'ga qaytadi
  const markup = computeOrderFinance({
    foodBaseTiyin: S(10000), deliveryMarkupPercent: 5, restaurantCommissionPercent: 10,
  });
  eq(markup.foodSubtotal, 10500, 'ustama bilan baza');
  eq(markup.restaurantFoodPayout, 9450, 'ustama restoranga qaytdi (10500 − 1050)');
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
  eq(absorbed.restaurantDeliveryPayout, 5000, 'delivery har doim 100% restoranga');
  ok(reconcile(absorbed).ok, 'rekonsiliatsiya');
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

/* ═══ CHEGIRMA — FAQAT BIR MARTA ═══ */
console.log('\n[G] Chegirma ikki marta ayirilmasligi (regressiya nazorati)');
{
  const f = computeOrderFinance({
    foodBaseTiyin: S(10000),
    discountTiyin: S(2000),
    customerFeePercent: 0,
    restaurantCommissionPercent: 10,
  });

  eq(f.foodBase, 10000, 'asl taom narxi');
  eq(f.discountAmount, 2000, 'chegirma');
  eq(f.foodSubtotal, 8000, 'chegirma BIR MARTA ayirildi (10 000 − 2 000)');
  eq(f.totalCharged, 8000, 'mijoz to‘laydi — ortiqcha chegirma yo‘q');
  eq(f.restaurantCommissionAmount, 800, 'komissiya chegirmali summadan');
  eq(f.restaurantFoodPayout, 7200, 'restoran payout noto‘g‘ri kamaymadi');
  ok(reconcile(f).ok, 'rekonsiliatsiya');

  // Chegirma + mijoz haqi + yetkazish birga
  const full = computeOrderFinance({
    foodBaseTiyin: S(10000), discountTiyin: S(2000), deliveryFeeTiyin: S(5000),
    customerFeePercent: 5, restaurantCommissionPercent: 5, paymentFeePercent: 1.5,
  });
  eq(full.foodSubtotal, 8000, 'chegirmali baza');
  eq(full.customerFeeAmount, 400, 'mijoz haqi chegirmadan KEYIN (8 000 × 5%)');
  eq(full.totalCharged, 13400, 'jami: 8 000 + 400 + 5 000');
  eq(full.restaurantFoodPayout, 7600, 'payout: 8 000 − 400');
  ok(reconcile(full).ok, 'rekonsiliatsiya');

  // Chegirma taom narxidan katta bo'lsa — 0 ga cheklanadi
  const over = computeOrderFinance({ foodBaseTiyin: S(5000), discountTiyin: S(9000) });
  eq(over.foodSubtotal, 0, 'chegirma cheklandi, manfiy bo‘lmadi');
  ok(reconcile(over).ok, 'rekonsiliatsiya');
}

/* ═══ KOMISSIYA MATRITSASI × TO'LOV TURI ═══ */
console.log('\n[H] Komissiya kombinatsiyalari × Click/Naqd');
{
  const combos = [[0, 0], [0, 10], [5, 5], [10, 0], [3, 7]];
  let bad = 0;
  const lines = [];

  for (const [cust, rest] of combos) {
    for (const [label, feePct] of [['Click', 1.5], ['Naqd', 0]]) {
      const f = computeOrderFinance({
        foodBaseTiyin: S(10000), deliveryFeeTiyin: S(5000),
        customerFeePercent: cust, restaurantCommissionPercent: rest,
        paymentFeePercent: feePct,
      });
      const r = reconcile(f);
      if (!r.ok) bad++;

      // Pul ikki marta hisoblanmasligi: gross = mijoz haqi + restoran komissiyasi
      const grossOk = f.lokmaGrossCommission === f.customerFeeAmount + f.restaurantCommissionAmount;
      // Restoran payout hech qachon taom summasidan oshmasin
      const payoutOk = f.restaurantFoodPayout <= f.foodSubtotal;
      /*
       * Komissiya bazasiga YETKAZISH kirmasligi: xuddi shu
       * buyurtma yetkazishsiz hisoblansa, komissiya O'ZGARMASLIGI
       * kerak. Farq chiqsa — demak yetkazishdan ham olinyapti.
       */
      const noDelivery = computeOrderFinance({
        foodBaseTiyin: S(10000), deliveryFeeTiyin: 0,
        customerFeePercent: cust, restaurantCommissionPercent: rest,
        paymentFeePercent: feePct,
      });
      const baseOk = noDelivery.lokmaGrossCommission === f.lokmaGrossCommission;
      if (!grossOk || !payoutOk || !baseOk) bad++;

      lines.push(
        `    ${String(cust).padStart(2)}%+${String(rest).padStart(2)}% ${label.padEnd(6)}`
        + ` mijoz ${String(som(f.totalCharged)).padStart(6)}`
        + ` · restoran ${String(som(f.restaurantPayout)).padStart(5)}`
        + ` · LokmaGo ${String(som(f.lokmaCashNet)).padStart(7)}`
        + ` · delivery ${String(som(f.restaurantDeliveryPayout)).padStart(5)}`
        + ` · shlyuz ${String(som(f.clickFeeAmount)).padStart(6)}`,
      );
    }
  }
  lines.forEach((l) => console.log(l));
  ok(bad === 0, `10 ta kombinatsiya (5 komissiya × 2 to‘lov) — pul yo‘qolmadi, ikki marta hisoblanmadi`);
}

/* ═══ YETKAZISHDAN KOMISSIYA OLINMAYDI ═══ */
console.log('\n[I] Yetkazish komissiya bazasiga kirmaydi');
{
  const noDelivery = computeOrderFinance({
    foodBaseTiyin: S(10000), deliveryFeeTiyin: 0, restaurantCommissionPercent: 10,
  });
  const withDelivery = computeOrderFinance({
    foodBaseTiyin: S(10000), deliveryFeeTiyin: S(50000), restaurantCommissionPercent: 10,
  });
  ok(noDelivery.lokmaGrossCommission === withDelivery.lokmaGrossCommission,
    `yetkazish 0 va 50 000 bo‘lganda komissiya BIR XIL (${som(withDelivery.lokmaGrossCommission)})`);
  ok(noDelivery.restaurantFoodPayout === withDelivery.restaurantFoodPayout,
    'taom ulushi ham o‘zgarmadi');
  ok(withDelivery.restaurantDeliveryPayout === S(50000),
    'yetkazishning 100% restoranga');
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
process.exit(fails ? 1 : 0);
