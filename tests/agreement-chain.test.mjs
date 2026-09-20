/*
 * ═══════════════════════════════════════════════════════════
 * KELISHUV ZANJIRI — FOIZ QAYERDAN OLINADI
 * ═══════════════════════════════════════════════════════════
 *
 * Yagona manba: CommissionAgreement (admin paneldagi "Kelishuv").
 * Undan hamma joyga tarqaladi: mijoz ko'radigan narx, restoran
 * qarzi, moliya bo'limi, daromad hisoboti.
 *
 * Qoidalar:
 *   • foizlar FAQAT taom summasidan olinadi;
 *   • mijoz haqi taom narxi USTIGA qo'shiladi (mijoz ko'radi);
 *   • restoran haqi restoran narxidan YECHILADI;
 *   • yetkazish puli 100% restoranga — undan foiz olinmaydi;
 *   • Click 1.5% jami to'lovdan, LokmaGo ULUSHIDAN qoplanadi.
 *
 * npm run test:agreement
 */
import { computeOrderFinance, reconcile, somToTiyin, tiyinToSom } from '../src/services/orderFinance.js';

let fails = 0;
const ok = (c, m) => { console.log(c ? '  ✓' : '  ✗ FAIL:', m); if (!c) fails++; };
const S = somToTiyin;
const som = (t) => tiyinToSom(t);
const eq = (a, e, l) => ok(som(a) === e, `${l}: ${som(a).toLocaleString('ru-RU')} (kutilgan ${e.toLocaleString('ru-RU')})`);

console.log('\n[1] Restoran 5% · mijoz 0% — faqat restorandan');
{
  const f = computeOrderFinance({
    foodBaseTiyin: S(10000), customerFeePercent: 0, restaurantCommissionPercent: 5,
  });
  eq(f.customerFoodTotal, 10000, 'Mijoz ko‘radigan narx — O‘ZGARMAYDI');
  eq(f.restaurantCommissionAmount, 500, 'Restorandan olinadi');
  eq(f.customerFeeAmount, 0, 'Mijozdan olinmaydi');
  eq(f.restaurantPayout, 9500, 'Restoran oladi');
  eq(f.lokmaGrossCommission, 500, 'LokmaGo daromadi');
}

console.log('\n[2] Restoran 5% · mijoz 8% — jami 13%');
{
  const f = computeOrderFinance({
    foodBaseTiyin: S(10000), customerFeePercent: 8, restaurantCommissionPercent: 5,
  });
  eq(f.foodSubtotal, 10000, 'Restoran narxi');
  eq(f.customerFeeAmount, 800, 'Mijoz haqi (narx USTIGA qo‘shiladi)');
  eq(f.customerFoodTotal, 10800, 'Mijoz ko‘radigan narx');
  eq(f.restaurantCommissionAmount, 500, 'Restoran haqi (narxdan YECHILADI)');
  eq(f.restaurantPayout, 9500, 'Restoran oladi');
  eq(f.lokmaGrossCommission, 1300, 'LokmaGo daromadi — jami 13%');
  ok(reconcile(f).ok, 'rekonsiliatsiya');
}

console.log('\n[3] Yetkazish 100% restoranga — undan foiz olinmaydi');
{
  const withD = computeOrderFinance({
    foodBaseTiyin: S(10000), deliveryFeeTiyin: S(15000),
    customerFeePercent: 8, restaurantCommissionPercent: 5,
  });
  const noD = computeOrderFinance({
    foodBaseTiyin: S(10000), customerFeePercent: 8, restaurantCommissionPercent: 5,
  });
  ok(withD.lokmaGrossCommission === noD.lokmaGrossCommission,
    `yetkazish bilan/siz komissiya BIR XIL: ${som(withD.lokmaGrossCommission)}`);
  eq(withD.restaurantDeliveryPayout, 15000, 'Yetkazishning 100% restoranga');
  eq(withD.restaurantPayout, 24500, 'Restoranga jami (9 500 + 15 000)');
  eq(withD.totalCharged, 25800, 'Mijoz to‘laydi (10 800 + 15 000)');
}

console.log('\n[4] Click 1.5% — LokmaGo ULUSHIDAN chiqadi');
{
  const f = computeOrderFinance({
    foodBaseTiyin: S(10000), deliveryFeeTiyin: S(15000),
    customerFeePercent: 8, restaurantCommissionPercent: 5, paymentFeePercent: 1.5,
  });
  eq(f.totalCharged, 25800, 'Mijoz to‘ladi');
  eq(f.clickFeeAmount, 387, 'Click ushladi (25 800 × 1.5%)');
  eq(f.lokmaGrossCommission, 1300, 'LokmaGo brutto');
  eq(f.lokmaNetCommission, 913, 'LokmaGo sof (1 300 − 387)');
  eq(f.restaurantPayout, 24500, 'Restoran ulushi KAMAYMADI');
  ok(reconcile(f).ok, 'rekonsiliatsiya: restoran + LokmaGo sof + Click = mijoz to‘lovi');
}

console.log('\n[5] Naqd — Click haqi yo‘q');
{
  const f = computeOrderFinance({
    foodBaseTiyin: S(10000), deliveryFeeTiyin: S(15000),
    customerFeePercent: 8, restaurantCommissionPercent: 5, paymentFeePercent: 0,
  });
  eq(f.clickFeeAmount, 0, 'Click haqi');
  eq(f.lokmaNetCommission, 1300, 'sof = brutto');
}

console.log('\n[6] Turli kelishuvlar — har biri o‘zicha');
{
  const cases = [
    [5, 0, 10000, 500, 10000],     // restoran 5% · mijoz 0%
    [10, 0, 10000, 1000, 10000],   // restoran 10% · mijoz 0%
    [6, 0, 10000, 600, 10000],     // restoran 6% · mijoz 0%
    [5, 5, 10000, 1000, 10500],    // 5 + 5
    [5, 8, 10000, 1300, 10800],    // 5 + 8
    [0, 10, 10000, 1000, 11000],   // faqat mijozdan
  ];
  for (const [rest, cust, food, gross, customerPays] of cases) {
    const f = computeOrderFinance({
      foodBaseTiyin: S(food), customerFeePercent: cust, restaurantCommissionPercent: rest,
    });
    ok(som(f.lokmaGrossCommission) === gross && som(f.customerFoodTotal) === customerPays,
      `${rest}% + ${cust}% → LokmaGo ${som(f.lokmaGrossCommission)}, mijoz ${som(f.customerFoodTotal)}`);
    ok(reconcile(f).ok, `  ${rest}+${cust}: rekonsiliatsiya`);
  }
}

console.log('\n[7] Zal va bronda narx o‘zgarmaydi (mijoz haqi qo‘shilmaydi)');
{
  const f = computeOrderFinance({
    foodBaseTiyin: S(10000), customerFeePercent: 0, restaurantCommissionPercent: 5,
  });
  eq(f.customerFoodTotal, 10000, 'zal narxi');
}

console.log(fails ? `\n✗ ${fails} ta xato` : '\n✓ HAMMASI O‘TDI');
process.exit(fails ? 1 : 0);
